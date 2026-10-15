import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export function git(cwd, args, { maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export async function isGitRepo(dir) {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

// 저장소 옆 `<이름>.agenthub/<세션>` 폴더에 HEAD 기준 worktree를 만든다.
// 저장소의 커밋되지 않은 수정은 worktree에 포함되지 않는다.
export async function createWorktree(repo, sessionId) {
  const root = path.join(path.dirname(repo), `${path.basename(repo)}.agenthub`);
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, sessionId);
  const branch = `agenthub/${sessionId}`;
  await git(repo, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { dir, branch };
}

export async function removeWorktree(repo, dir) {
  // 저장소가 사라졌으면(임시 폴더 등) 지울 worktree 기록도 없다.
  if (!fs.existsSync(repo)) return;
  // 폴더를 이미 직접 지웠으면 git에 남은 worktree 기록만 정리한다.
  if (!fs.existsSync(dir)) {
    await git(repo, ["worktree", "prune"]).catch(() => {});
    return;
  }
  // --force를 쓰지 않는다. 커밋하지 않은 변경이 있으면 실패하고 폴더를 남긴다.
  await git(repo, ["worktree", "remove", dir]);
}

export async function headCommit(dir) {
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

const UNTRACKED_FILE_MAX = 100_000; // 새 파일 하나에서 보여 줄 최대 바이트
const UNTRACKED_TOTAL_MAX = 400_000; // 새 파일 전체에서 보여 줄 최대 바이트

// 아직 추적하지 않는 새 파일. -z로 받아야 한글 같은 이름이 따옴표·이스케이프(core.quotePath) 없이 그대로 온다.
async function untrackedFiles(dir) {
  return (await git(dir, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
}

// git diff는 아직 추적하지 않는 새 파일을 보여 주지 않는다. 커밋하면 함께 들어가므로 내용도 diff 모양으로 붙인다.
async function untrackedDiff(dir) {
  const files = await untrackedFiles(dir);
  let budget = UNTRACKED_TOTAL_MAX;
  const parts = [];
  for (const file of files) {
    const header = `diff --git a/${file} b/${file}\nnew file (아직 추적하지 않음)\n--- /dev/null\n+++ b/${file}`;
    let size;
    try {
      size = fs.statSync(path.join(dir, file)).size;
    } catch {
      continue;
    }
    if (size > UNTRACKED_FILE_MAX || size > budget) {
      parts.push(`${header}\n@@ 내용 생략: ${size.toLocaleString()} 바이트로 너무 큽니다 @@`);
      continue;
    }
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    if (text.includes("\0")) {
      parts.push(`${header}\n@@ 바이너리 파일 @@`);
      continue;
    }
    budget -= size;
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
    parts.push(`${header}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`);
  }
  return parts.join("\n");
}

export async function diffSince(dir, base) {
  const [status, diff, untracked] = await Promise.all([
    git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(dir, ["diff", base ?? "HEAD", "--stat", "--patch", "--no-color"]),
    untrackedDiff(dir).catch(() => ""),
  ]);
  return { status, diff: [diff.trimEnd(), untracked].filter(Boolean).join("\n") };
}

// 기준 커밋 이후 바뀐 파일(커밋한 것 + 커밋하지 않은 것 + 새 파일)
export async function changedFiles(dir, base) {
  // 한글 같은 파일 이름이 "\355\225..."로 바뀌지 않게 그대로 받는다(사람과 에이전트가 읽는 목록이다).
  const [tracked, untracked] = await Promise.all([
    git(dir, ["-c", "core.quotePath=false", "diff", "--name-status", base]),
    untrackedFiles(dir),
  ]);
  const lines = [...tracked.trim().split(/\r?\n/), ...untracked.map((f) => `A\t${f}`)].filter(Boolean);
  return lines.length > 80 ? `${lines.slice(0, 80).join("\n")}\n… 외 ${lines.length - 80}개` : lines.join("\n");
}

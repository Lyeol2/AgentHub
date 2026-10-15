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

export async function diffSince(dir, base) {
  const [status, diff] = await Promise.all([
    git(dir, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(dir, ["diff", base ?? "HEAD", "--stat", "--patch", "--no-color"]),
  ]);
  return { status, diff };
}

// 기준 커밋 이후 바뀐 파일(커밋한 것 + 커밋하지 않은 것 + 새 파일)
export async function changedFiles(dir, base) {
  const [tracked, untracked] = await Promise.all([
    git(dir, ["diff", "--name-status", base]),
    git(dir, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const lines = [...tracked.trim().split(/\r?\n/), ...untracked.trim().split(/\r?\n/).map((f) => f && `A\t${f}`)]
    .filter(Boolean);
  return lines.length > 80 ? `${lines.slice(0, 80).join("\n")}\n… 외 ${lines.length - 80}개` : lines.join("\n");
}

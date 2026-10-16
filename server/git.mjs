import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { withGitRepoLock } from "./git-lock.mjs";

export function git(cwd, args, { maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    // status의 선택적 갱신과 diff의 stat 캐시 갱신을 모두 끄고 index 읽기 경쟁을 막는다.
    // add·commit 등 명시적으로 요청한 쓰기의 필수 잠금은 그대로 유지한다.
    // core.longpaths: 워크트리는 원본보다 경로가 길어 Windows의 260자 제한에 먼저 걸린다.
    execFile("git", ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", "-c", "core.longpaths=true", "-C", cwd, ...args], { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
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

// 폴더명과 Git 브랜치에 함께 쓰므로 경로 구분자·Git 특수문자·Windows 예약명을 받지 않는다.
export function validateWorktreeName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("워크트리 이름을 입력하세요.");
  if (!/^[A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ][A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ_-]{0,63}$/u.test(name)) {
    throw new Error("워크트리 이름은 1~64자의 영문·숫자·한글·하이픈·밑줄만 쓸 수 있으며, 영문·숫자·한글로 시작해야 합니다.");
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error("워크트리 이름으로 Windows 예약어를 사용할 수 없습니다.");
  }
  return name;
}

// 저장소 옆 `<저장소>.agenthub/<이름>` 폴더에 `agenthub/<이름>` 브랜치로 HEAD 기준 worktree를 만든다.
// 이름은 사용자가 반드시 정한다. 저장소의 커밋되지 않은 수정은 worktree에 포함되지 않는다.
export async function checkWorktreeAvailable(repo, name) {
  name = validateWorktreeName(name);
  const root = path.join(path.dirname(repo), `${path.basename(repo)}.agenthub`);
  const dir = path.join(root, name);
  const branch = `agenthub/${name}`;
  if (fs.existsSync(dir)) throw new Error(`작업 폴더 ${dir}가 이미 있습니다. 다른 이름을 쓰세요.`);
  const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists) throw new Error(`브랜치 ${branch}가 이미 있습니다. 다른 이름을 쓰세요.`);
  return { dir, branch };
}

export async function createWorktree(repo, name) {
  const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  return withGitRepoLock(common, async () => {
    const { dir, branch } = await checkWorktreeAvailable(repo, name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ["worktree", "add", "-b", branch, dir, "HEAD"]);
    return { dir, branch };
  });
}

export async function removeWorktree(repo, dir) {
  // 저장소가 사라졌으면(임시 폴더 등) 지울 worktree 기록도 없다.
  if (!fs.existsSync(repo)) return;
  const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  return withGitRepoLock(common, async () => {
    // 폴더를 이미 직접 지웠으면 git에 남은 worktree 기록만 정리한다.
    if (!fs.existsSync(dir)) {
      await git(repo, ["worktree", "prune"]).catch(() => {});
      return;
    }
    // --force를 쓰지 않는다. 커밋하지 않은 변경이 있으면 실패하고 폴더를 남긴다.
    await git(repo, ["worktree", "remove", dir]);
  });
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
    untrackedDiff(dir),
  ]);
  return { status, diff: [diff.trimEnd(), untracked].filter(Boolean).join("\n") };
}

// 기준 커밋 이후 바뀐 파일(커밋한 것 + 커밋하지 않은 것 + 새 파일)
export async function changedFiles(dir, base) {
  // 한글 같은 파일 이름이 "\355\225..."로 바뀌지 않게 그대로 받는다(사람과 에이전트가 읽는 목록이다).
  const [tracked, stats, untracked] = await Promise.all([
    git(dir, ["diff", "--name-status", "-z", base]),
    git(dir, ["diff", "--numstat", "-z", base]),
    untrackedFiles(dir),
  ]);
  // autoRefreshIndex=false인 구버전 Git은 name-status에 stat만 바뀐 파일도 넣는다.
  // numstat은 실제 내용·모드·이름 변경을 검사하므로 인덱스를 쓰지 않고 걸러 낸다.
  const actualPaths = new Set();
  const counts = stats.split("\0");
  for (let i = 0; i < counts.length; i++) {
    const entry = counts[i].match(/^[^\t]+\t[^\t]+\t([\s\S]*)$/);
    if (!entry) continue;
    if (entry[1]) actualPaths.add(entry[1]);
    else { i++; actualPaths.add(counts[++i]); } // 이름 변경·복사는 이전 이름 다음에 새 이름이 온다.
  }
  const names = tracked.split("\0");
  const lines = [];
  for (let i = 0; i < names.length && names[i];) {
    const status = names[i++];
    const from = names[i++];
    const to = /^[RC]/.test(status) ? names[i++] : null;
    if (actualPaths.has(to ?? from)) lines.push([status, from, ...(to ? [to] : [])].join("\t"));
  }
  lines.push(...untracked.map((file) => `A\t${file}`));
  return lines.length > 80 ? `${lines.slice(0, 80).join("\n")}\n… 외 ${lines.length - 80}개` : lines.join("\n");
}

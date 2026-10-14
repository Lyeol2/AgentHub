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

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const key = (value) => {
  const real = fs.realpathSync(value);
  return process.platform === "win32" ? real.toLowerCase() : real;
};
const git = (cwd, args) => execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
  encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
}).trim();

// Revalidate persisted contexts at launch; a missing worktree must never fall back to the original folder.
export function verifyGitContext(context, projectPath) {
  try {
    if (!context || typeof context.cwd !== "string" || !path.isAbsolute(context.cwd) || typeof context.repoCommonDir !== "string" || typeof context.branch !== "string") throw new Error("invalid context");
    const [top, common, gitDir] = git(context.cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"]).split(/\r?\n/);
    if (key(top) !== key(context.cwd) || key(common) !== key(context.repoCommonDir)) throw new Error("changed repository");
    const projectCommon = git(projectPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (key(common) !== key(projectCommon)) throw new Error("different project");
    const branch = git(context.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch !== context.branch) throw new Error("changed branch");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
      if (fs.existsSync(path.join(gitDir, marker))) throw new Error("Git operation in progress");
    }
    const head = git(context.cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
    return { repoCommonDir: common, branch, cwd: top, head };
  } catch {
    throw new Error("Git 작업 폴더가 없거나 저장소·브랜치 상태가 바뀌었습니다. 진행 중인 Git 작업을 확인하고 Git 노드를 다시 실행하세요.");
  }
}

export function assertSessionGitContext(session) {
  if (!session.gitContext) return;
  if (key(session.cwd) !== key(session.gitContext.cwd)) throw new Error("세션의 Git 작업 폴더 설정이 변경됐습니다.");
  verifyGitContext(session.gitContext, session.projectPath);
}

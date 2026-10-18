import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { logTiming } from "./timing.mjs";

// 프로젝트 저장소 위치는 거의 바뀌지 않으므로 잠깐 기억한다. 작업 폴더의 브랜치·진행 중인 Git 작업은 매번 확인한다.
const PROJECT_COMMON_TTL_MS = 30_000;
const projectCommons = new Map(); // 프로젝트 경로 → { value, at }

const key = (value) => {
  const real = fs.realpathSync(value);
  return process.platform === "win32" ? real.toLowerCase() : real;
};
const git = (cwd, args) => execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
  encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
}).trim();

function projectCommon(projectPath, now = Date.now()) {
  const cached = projectCommons.get(projectPath);
  if (cached && now - cached.at < PROJECT_COMMON_TTL_MS) return cached.value;
  const value = git(projectPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  projectCommons.set(projectPath, { value, at: now });
  return value;
}

// 기억한 확인 결과를 비운다(테스트, 저장소를 바꾼 직후).
export function clearGitContextCache() {
  projectCommons.clear();
}

// Revalidate persisted contexts at launch; a missing worktree must never fall back to the original folder.
// 작업 폴더는 git 한 번으로 확인한다(최상위·공통·Git 폴더·HEAD 커밋·브랜치). 분리된 HEAD는 브랜치가 "HEAD"로 나와 맞지 않는다.
export function verifyGitContext(context, projectPath) {
  const started = performance.now();
  try {
    if (!context || typeof context.cwd !== "string" || !path.isAbsolute(context.cwd) || typeof context.repoCommonDir !== "string" || typeof context.branch !== "string") throw new Error("invalid context");
    const [top, common, gitDir, head, ref] = git(context.cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir", "HEAD^{commit}", "--symbolic-full-name", "HEAD"]).split(/\r?\n/);
    if (key(top) !== key(context.cwd) || key(common) !== key(context.repoCommonDir)) throw new Error("changed repository");
    if (key(common) !== key(projectCommon(projectPath))) throw new Error("different project");
    const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    if (branch !== context.branch) throw new Error("changed branch");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
      if (fs.existsSync(path.join(gitDir, marker))) throw new Error("Git operation in progress");
    }
    return { repoCommonDir: common, branch, cwd: top, head };
  } catch {
    throw new Error("Git 작업 폴더가 없거나 저장소·브랜치 상태가 바뀌었습니다. 진행 중인 Git 작업을 확인하고 Git 노드를 다시 실행하세요.");
  } finally {
    logTiming("git-context", "verify", performance.now() - started);
  }
}

// 요청을 보낼 때마다 확인한다. 바깥에서 브랜치를 바꿨으면 바로 막아야 하므로 결과를 기억하지 않는다.
export function assertSessionGitContext(session) {
  if (!session.gitContext) return;
  if (key(session.cwd) !== key(session.gitContext.cwd)) throw new Error("세션의 Git 작업 폴더 설정이 변경됐습니다.");
  verifyGitContext(session.gitContext, session.projectPath);
}

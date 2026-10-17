import fs from "node:fs";
import path from "node:path";
import { githubCredentialArgs, runGitHubCommand } from "./github.mjs";
import { gitErrorDetails } from "./git-errors.mjs";
import { HttpError } from "./application/errors.mjs";
import { normalizeGitflowSettings } from "./gitflow-settings.mjs";

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const clean = (value) => String(value ?? "").replace(/https?:\/\/[^/\s@]+@/g, "https://[credentials]@").slice(0, 1600);
export const sameTaskPath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// 실제 경로 기준으로 child가 parent 폴더이거나 그 안에 있는지 본다.
// 정션·subst 드라이브·8.3 짧은 이름으로 등록한 프로젝트도 Git이 돌려주는 경로와 맞춰 비교한다.
const realPath = (value) => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
export function insideTaskPath(child, parent) {
  if (!child || !parent) return false;
  const relative = path.relative(realPath(parent).toLowerCase(), realPath(child).toLowerCase());
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// All arguments are passed directly to Git; authentication prompts must never hang the server.
export async function taskGit(cwd, args, { write = false, ...options } = {}) {
  try {
    return await runGitHubCommand("git", ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", "-c", "core.longpaths=true", "-C", cwd, ...args],
      { cwd, timeout: write ? 60_000 : 20_000, ...options });
  } catch (error) {
    const known = !error.timedOut && gitErrorDetails(clean(error.stderr || error.message));
    if (known) throw new HttpError(known.status, known.message, known.reason, { hint: known.hint, raw: known.raw });
    throw new HttpError(error.timedOut ? 504 : 409, clean(error.message), error.timedOut ? "git-timeout" : "git-error",
      { outcomeUnknown: write && !!(error.timedOut || error.overflow) });
  }
}

// 두 값을 git 한 번으로 받는다. 출력 줄 순서는 인자 순서와 같다.
export async function taskRepo(dir, git = taskGit) {
  try {
    const [top, common] = (await git(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"])).split(/\r?\n/);
    return { top: top.trim(), common: common.trim() };
  } catch { throw new HttpError(400, "작업은 커밋이 있는 Git 저장소에서 만들 수 있습니다.", "not-git"); }
}

export async function taskRef(dir, ref) {
  try { const value = (await taskGit(dir, ["rev-parse", "--verify", ref])).trim(); return SHA.test(value) ? value : null; }
  catch (error) { if (error.reason === "git-timeout") throw error; return null; }
}

export async function taskAncestor(dir, ancestor, descendant) {
  try { await taskGit(dir, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch (error) { if (error.reason === "git-timeout") throw error; return false; }
}

export async function taskRemote(dir, selected, main = "main") {
  const names = (await taskGit(dir, ["remote"])).trim().split(/\r?\n/).filter(Boolean);
  const remote = selected ?? (names.includes("origin") ? "origin" : names.length === 1 ? names[0] : null);
  if (!remote || !names.includes(remote)) throw new HttpError(409, `최신 ${main}을 확인할 원격 저장소를 연결하세요. 여러 원격이 있으면 origin을 지정하세요.`, "gitflow-remote");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote)) throw new HttpError(409, "원격 저장소 이름을 확인하세요.", "gitflow-remote");
  return remote;
}

async function mainChangesMissing(dir, mainSha, developSha) {
  if (await taskAncestor(dir, mainSha, developSha)) return false;
  // GitFlow can merge the same hotfix/release into both branches with different
  // merge SHAs. A virtual merge checks whether main would add any content, without
  // touching either branch, worktree, or index. Conflicts are conservatively pending.
  try {
    const [merged, tree] = await Promise.all([
      taskGit(dir, ["merge-tree", "--write-tree", developSha, mainSha]),
      taskGit(dir, ["rev-parse", `${developSha}^{tree}`]),
    ]);
    return merged.trim().split(/\r?\n/)[0] !== tree.trim();
  } catch (error) { if (error.reason === "git-timeout") throw error; return true; }
}

export async function gitflowContext(dir, selected, value) {
  const settings = normalizeGitflowSettings(value);
  const { main, develop } = settings;
  const remote = await taskRemote(dir, selected, main);
  // Explicit refspec ignores narrow fetch configuration; prune removes deleted remote branches.
  await taskGit(dir, [...githubCredentialArgs(), "fetch", "--prune", "--no-tags", "--", remote, `+refs/heads/*:refs/remotes/${remote}/*`]);
  // rev-parse can resolve the wrong case on Windows filesystems. Enumerate refs
  // and compare their literal names so Main/Develop settings stay exact.
  const refs = new Map((await taskGit(dir, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/remotes/${remote}/`]))
    .trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(" ")));
  const mainSha = refs.get(`refs/remotes/${remote}/${main}`) ?? null;
  const developSha = refs.get(`refs/remotes/${remote}/${develop}`) ?? null;
  if (!mainSha) throw new HttpError(409, `원격 ${main} 브랜치가 없습니다. GitFlow 설정에서 기준 브랜치 이름을 확인하세요.`, "gitflow-main");
  const mainMissing = !!developSha && await mainChangesMissing(dir, mainSha, developSha);
  const warnings = !developSha ? [`${develop} 브랜치가 없어 최신 ${main}에서 시작합니다. 첫 PR 준비 시 ${develop}을 생성합니다.`]
    : mainMissing ? [`${main}의 변경이 ${develop}에 반영되지 않았습니다. ${develop}에 먼저 반영하세요.`] : [];
  return { state: mainMissing ? "needs-update" : "current", checkedAt: new Date().toISOString(), remote,
    main: { branch: main, sha: mainSha }, develop: { branch: develop, sha: developSha }, mainSha, developSha, settings,
    mainMissing, needsSetup: !developSha, warnings };
}

export async function assertTaskWorktree(task) {
  if (!fs.existsSync(task.cwd)) throw new HttpError(409, "작업 폴더가 없습니다. 원본 폴더에서 작업을 대신 실행하지 않습니다.", "task-worktree");
  const repo = await taskRepo(task.cwd);
  if (!sameTaskPath(repo.top, task.cwd) || !sameTaskPath(repo.common, task.gitCommonDir))
    throw new HttpError(409, "작업 폴더의 Git 저장소가 바뀌었습니다.", "task-worktree");
  const branch = (await taskGit(task.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  if (branch !== task.branch) throw new HttpError(409, "작업 폴더가 다른 브랜치에 있습니다. 작업 브랜치로 돌아온 뒤 진행하세요.", "task-branch");
  return taskRef(task.cwd, "HEAD");
}

export function readTaskBranch(cwd) {
  try {
    const dotgit = path.join(cwd, ".git");
    const gitdir = fs.statSync(dotgit).isDirectory() ? dotgit : path.resolve(cwd, fs.readFileSync(dotgit, "utf8").match(/^gitdir: (.+)\s*$/m)[1].trim());
    return fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim().replace(/^ref: refs\/heads\//, "");
  } catch { return null; }
}

export async function taskDirty(task) {
  return !!(await taskGit(task.cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).trim();
}

export async function assertTaskGitIdle(task) {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    const file = (await taskGit(task.cwd, ["rev-parse", "--git-path", marker])).trim();
    if (fs.existsSync(path.resolve(task.cwd, file)))
      throw new HttpError(409, "작업 폴더에서 병합·리베이스 등 Git 작업이 진행 중입니다. 먼저 완료하거나 취소하세요.", "task-git-operation");
  }
}

// name은 사용자가 지정한 작업 폴더 이름이다. 없으면 task-<작업ID>를 쓴다.
export function taskWorktreeLocation(repo, id, name) {
  const source = path.basename(repo.common).toLowerCase() === ".git" ? path.dirname(repo.common) : repo.top;
  const root = path.join(path.dirname(source), `${path.basename(source)}.agenthub`);
  return { root, cwd: path.join(root, name || `task-${id}`) };
}

// 작업 폴더 이름은 <프로젝트>.agenthub/ 바로 아래 한 단계 폴더만 허용한다.
export function validTaskWorktreeName(name) {
  return /^[A-Za-z0-9가-힣_][A-Za-z0-9가-힣._-]{0,79}$/u.test(name) && !/\.$/.test(name)
    && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name);
}

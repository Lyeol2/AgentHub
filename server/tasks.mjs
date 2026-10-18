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

// main에만 있는 변경 중 develop에 실제로 없는 것이 있는지 본다. 브랜치·작업 폴더·index는 건드리지 않는다.
// GitFlow는 같은 hotfix·release를 두 브랜치에 다른 SHA로 병합하므로 조상 관계만으로는 판단하지 않는다.
// 1) 가상 병합 결과가 develop 트리와 같으면 반영됨. 충돌하거나 git이 merge-tree --write-tree(2.38+)를 모르면 다음 단계로 간다.
// 2) main 쪽 커밋 중 develop에 patch-id가 같은 커밋이 있으면 반영됨(cherry-pick한 hotfix, develop에서 반영 뒤 되돌린 경우 포함).
// 3) 남은 커밋은 그 커밋이 바꾼 파일 내용이 develop에 있거나 develop 기록에 한 번이라도 들어갔는지,
//    develop 위에 다시 적용해도 바뀌는 것이 없는지 본다. 하나라도 확인되지 않으면 미반영이다.
export async function mainChangesMissing(dir, mainSha, developSha, git = taskGit) {
  const soft = (error) => { if (error.reason === "git-timeout") throw error; return null; };
  let cwd = dir;
  const read = (args) => git(cwd, args).then((out) => out.trim(), soft);
  if (await git(dir, ["merge-base", "--is-ancestor", mainSha, developSha]).then(() => true, (error) => soft(error) ?? false)) return false;
  // 하위 폴더를 프로젝트로 등록해도 파일 경로를 저장소 최상위 기준으로 맞춘다.
  cwd = await read(["rev-parse", "--show-toplevel"]) || dir;
  const developTree = await read(["rev-parse", `${developSha}^{tree}`]);
  const merged = await read(["merge-tree", "--write-tree", developSha, mainSha]);
  if (merged && merged.split(/\r?\n/)[0] === developTree) return false;
  const pending = await read(["rev-list", "--cherry-pick", "--right-only", "--no-merges", `${developSha}...${mainSha}`]);
  if (pending === null) return true;
  const commits = pending.split(/\r?\n/).filter(Boolean);
  if (commits.length > 200) return true;
  const blobs = async (rev, paths) => new Map((await read(["--literal-pathspecs", "ls-tree", "-z", rev, "--", ...paths]) ?? "")
    .split("\0").filter(Boolean).map((line) => { const [meta, name] = line.split("\t"); return [name, meta.split(" ")[2]]; }));
  // develop 기록(main에 없는 쪽)에서 각 파일이 거쳐 간 내용. 병합 커밋도 부모별로 본다.
  const history = async (paths) => {
    const seen = new Set();
    for (const line of (await read(["-c", "core.quotePath=false", "--literal-pathspecs", "log", "-m", "--raw", "--no-abbrev", "--no-renames", "--format=", `${mainSha}..${developSha}`, "--", ...paths]) ?? "").split(/\r?\n/)) {
      const match = line.match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) (\w)\d*\t(.*)$/);
      if (match) seen.add(match[2] === "D" ? `D\t${match[3]}` : match[1]);
    }
    return seen;
  };
  for (const commit of commits) {
    const paths = (await read(["diff-tree", "-r", "--root", "--no-renames", "--no-commit-id", "--name-only", "-z", commit]) ?? "").split("\0").filter(Boolean);
    if (!paths.length) continue;
    const few = paths.length <= 500;
    const [wanted, current] = few ? await Promise.all([blobs(commit, paths), blobs(developSha, paths)]) : [null, null];
    const rest = few ? paths.filter((name) => wanted.get(name) !== current.get(name)) : paths;
    if (!rest.length) continue;
    // develop 위에 이 커밋만 다시 적용(가상 cherry-pick)해도 develop 트리가 그대로면 이미 들어 있는 변경이다.
    const parent = await read(["rev-parse", "--verify", "--quiet", `${commit}^`]);
    const picked = parent && await read(["merge-tree", "--write-tree", "--merge-base", parent, developSha, commit]);
    if (picked && picked.split(/\r?\n/)[0] === developTree) continue;
    if (few) {
      const seen = await history(rest);
      if (rest.every((name) => wanted.has(name) ? seen.has(wanted.get(name)) : seen.has(`D\t${name}`))) continue;
    }
    return true;
  }
  return false;
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

// 브랜치 이름을 정하지 않은 작업은 제목을 짧은 소문자 이름으로 바꿔 쓴다. 예: "Login 버튼 수정!" → login-버튼-수정
// 단어 경계에서 40자 안으로 자르고, 쓸 글자가 없으면 work를 쓴다.
export function taskBranchSlug(title, max = 40) {
  const words = String(title ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9가-힣]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > max) { if (!slug) slug = word.slice(0, max); break; }
    slug = next;
  }
  return slug || "work";
}

// 작업 폴더 이름은 <프로젝트>.agenthub/ 바로 아래 한 단계 폴더만 허용한다.
export function validTaskWorktreeName(name) {
  return /^[A-Za-z0-9가-힣_][A-Za-z0-9가-힣._-]{0,79}$/u.test(name) && !/\.$/.test(name)
    && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name);
}

const WORKTREE_DIRTY = /contains modified or untracked files|use --force to delete/i;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function worktreeRegistered(repo, dir, git = taskGit) {
  const list = await git(repo, ["worktree", "list", "--porcelain", "-z"]).catch(() => null);
  return list === null || list.split("\0").some((line) => line.startsWith("worktree ") && sameTaskPath(line.slice(9), dir));
}
// 워크트리 폴더를 지운다. Windows에서는 막 멈춘 CLI·개발 서버·편집기·백신이 파일을 잡고 있으면 한 번에 지워지지 않아
// 잠시 기다리며 다시 시도한다. git이 기록만 지우고 폴더를 남겼으면 남은 폴더를 마저 지우고, 끝에 사라진 폴더의 기록을 prune한다.
// node_modules처럼 큰 폴더도 끝까지 지우도록 시간 제한을 넉넉히 둔다. force가 아니면 커밋하지 않은 변경이 있는 폴더는 바로 멈춘다.
// .git 파일까지 지워져 git이 더는 작업 폴더로 알아보지 못하면 변경 여부를 확인할 수 없으므로 force일 때만 폴더째 지운다.
export async function removeWorktreeDir(repo, dir, { force = false, git = taskGit, attempts = 20, delay = 500, wait = pause } = {}) {
  let error = null;
  for (let attempt = 0; attempt < attempts && fs.existsSync(dir); attempt++) {
    if (attempt) await wait(delay);
    try {
      const broken = !fs.existsSync(path.join(dir, ".git"));
      if (broken && !force && await worktreeRegistered(repo, dir, git))
        throw new HttpError(409, "작업 폴더가 손상되어 커밋하지 않은 변경이 있는지 확인할 수 없습니다. 남은 파일을 확인한 뒤 강제로 지우세요.", "task-dirty");
      if (!broken && await worktreeRegistered(repo, dir, git)) await git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), "--", dir], { write: true, timeout: 10 * 60_000 });
      else fs.rmSync(dir, { recursive: true, force: true });
    } catch (failure) {
      if (failure.reason === "task-dirty") throw failure;
      if (!force && WORKTREE_DIRTY.test(failure.message))
        throw new HttpError(409, "작업 폴더에 커밋하지 않은 변경이나 새 파일이 있어 지우지 않았습니다.", "task-dirty", { raw: failure.message });
      error = failure;
    }
  }
  await git(repo, ["worktree", "prune"], { write: true }).catch(() => {});
  const removed = !fs.existsSync(dir);
  return { removed, registered: !removed && await worktreeRegistered(repo, dir, git), error: removed ? null : error };
}

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execGit } from "./git-execution.mjs";
import { readCommitSummaries, containsAnyCommit } from "./git-history.mjs";
import { HttpError } from "./application/errors.mjs";
import { withGitRepoLock } from "./git-lock.mjs";
import { validateWorktreeName } from "./git.mjs";
import { gitErrorDetails } from "./git-errors.mjs";
import { removeWorktreeDir } from "./tasks.mjs";

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const COMMIT_INPUT = /^[0-9a-f]{7,64}$/i;
const REWRITE = new Set(["uncommit", "reset", "drop", "restore"]);
const MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];
const PREVIEW_TTL = 10 * 60_000;
const error = (message, reason = "git-state", status = 409, details) => new HttpError(status, message, reason, details);
const canonical = (value) => fs.realpathSync.native(value);
const key = (value) => process.platform === "win32" ? value.toLowerCase() : value;
export const sameGitPath = (a, b) => {
  if (!a || !b) return false;
  try { return key(canonical(a)) === key(canonical(b)); }
  catch { return key(path.resolve(a)) === key(path.resolve(b)); }
};
const inside = (child, parent) => {
  const relative = path.relative(key(parent), key(child));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// Git gets separate argv and a non-interactive, repository-independent environment.
export async function clientGit(cwd, args, { write = false, timeout = 30_000 } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[name];
  try { return await execGit(cwd, args, { env, timeout, maxBuffer: 12 * 1024 * 1024 }); }
  catch (failure) {
    const unknown = !!(failure.killed || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    const raw = [failure.stdout, failure.stderr].filter(Boolean).join("\n") || failure.message;
    const message = String(raw).replace(/(https?:\/\/)[^/\s@]+@/g, "$1[credentials]@").trim().slice(0, 4000);
    const known = !unknown && gitErrorDetails(message);
    if (known) throw error(known.message, known.reason, known.status, { hint: known.hint, raw: known.raw, exitCode: failure.code });
    throw error(message, unknown ? "git-outcome-unknown" : "git-error", unknown ? 504 : 409,
      { outcomeUnknown: write && unknown, exitCode: failure.code });
  }
}
const git = clientGit;
const head = async (cwd) => (await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
const branch = async (cwd) => git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(s => s.trim(), e => { if (e.exitCode === 1) return null; throw e; });
const dirty = async (cwd) => (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length > 0;
const ancestor = async (cwd, a, b) => git(cwd, ["merge-base", "--is-ancestor", a, b]).then(() => true, e => { if (e.exitCode === 1) return false; throw e; });

async function worktreeRecords(repo) {
  const output = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  const records = [];
  let current;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) { current = { cwd: path.resolve(field.slice(9)), branch: null, locked: false, prunable: false }; records.push(current); }
    else if (current && field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (current && field.startsWith("branch refs/heads/")) current.branch = field.slice(18);
    else if (current && /^locked(?: |$)/.test(field)) current.locked = true;
    else if (current && /^prunable(?: |$)/.test(field)) current.prunable = true;
    else if (current && field === "bare") current.bare = true;
  }
  return records;
}

// cache는 한 요청 안에서 같은 폴더의 조회 결과를 나눠 쓸 때만 넘긴다(작업 폴더 목록처럼 여러 번 확인하는 경우).
export async function resolveGitContext(projectPath, selectedCwd, cache = new Map()) {
  if (typeof projectPath !== "string" || !projectPath || (selectedCwd !== undefined && (typeof selectedCwd !== "string" || !selectedCwd)))
    throw error("프로젝트와 작업 폴더를 선택하세요.", "git-context", 400);
  let project, cwd;
  try { project = canonical(projectPath); cwd = canonical(selectedCwd ?? projectPath); }
  catch { throw error("프로젝트 또는 작업 폴더가 없습니다.", "git-context", 400); }
  const once = (name, load) => {
    if (!cache.has(name)) cache.set(name, load());
    return cache.get(name);
  };
  // 세 값을 git 한 번으로 받는다. 출력 줄 순서는 인자 순서와 같다.
  const info = (directory) => once("info:" + key(directory), async () => {
    try {
      const [top, common, gitDir] = (await git(directory, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"])).split(/\r?\n/);
      return { top: canonical(top.trim()), common: canonical(common.trim()), gitDir: canonical(gitDir.trim()) };
    } catch { throw error("Git 작업 폴더를 확인할 수 없습니다.", "not-git", 400); }
  });
  const [repository, selected] = await Promise.all([info(project), info(cwd)]);
  if (!sameGitPath(repository.common, selected.common) || !sameGitPath(selected.top, cwd))
    throw error("이 저장소에 등록된 작업 폴더 루트만 선택할 수 있습니다.", "git-context", 400);
  const records = await once("records:" + key(repository.top), () => worktreeRecords(repository.top));
  const entry = records.find(item => sameGitPath(item.cwd, cwd));
  if (!entry || entry.bare || entry.prunable) throw error("등록된 Git 작업 폴더가 아닙니다.", "git-context", 400);
  return { project, repo: repository.top, cwd, common: repository.common, gitDir: selected.gitDir, entry,
    original: records[0]?.cwd, records };
}

async function resolveCommit(cwd, value) {
  if (typeof value !== "string" || !COMMIT_INPUT.test(value)) throw error("목록에서 커밋 해시를 선택하세요.", "git-commit", 400);
  const resolved = (await git(cwd, ["rev-parse", "--verify", "--end-of-options", value + "^{commit}"])).trim();
  if (!SHA.test(resolved)) throw error("커밋을 확인할 수 없습니다.", "git-commit");
  return resolved;
}
async function validateBranch(cwd, name, exists = true) {
  if (typeof name !== "string" || !name || name.startsWith("-") || name.length > 1024) throw error("브랜치 이름을 확인하세요.", "git-branch", 400);
  await git(cwd, ["check-ref-format", "refs/heads/" + name]);
  if ((await git(cwd, ["check-ref-format", "--branch", name])).trim() !== name) throw error("브랜치 축약 표현은 사용할 수 없습니다.", "git-branch", 400);
  return exists ? (await git(cwd, ["rev-parse", "--verify", "refs/heads/" + name])).trim() : name;
}
async function operationIdle(ctx) {
  if (MARKERS.some(marker => fs.existsSync(path.join(ctx.gitDir, marker))))
    throw error("병합·리베이스 등 진행 중인 Git 작업을 먼저 끝내거나 취소하세요.", "git-operation");
  if (fs.existsSync(path.join(ctx.gitDir, "index.lock"))) throw error("다른 Git 작업이 인덱스를 사용 중입니다.", "git-locked");
}
async function statusFingerprint(cwd) {
  const hash = createHash("sha256");
  for (const args of [["status", "--porcelain=v1", "-z", "--untracked-files=all"], ["diff", "--binary", "HEAD"], ["diff", "--cached", "--binary"]]) hash.update(await git(cwd, args));
  // Untracked content also matters when deciding whether a recovery may discard state.
  const paths = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const file of paths) {
    const absolute = path.resolve(cwd, file);
    if (!inside(absolute, cwd)) throw error("작업 파일 경로를 확인할 수 없습니다.");
    hash.update(file); const stat = fs.lstatSync(absolute);
    hash.update(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute));
  }
  return hash.digest("hex");
}
async function protectIgnored(ctx, target, changedCommits = []) {
  const ignored = (await git(ctx.cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  if (!ignored.length) return;
  const affected = new Set(target ? (await git(ctx.cwd, ["ls-tree", "-r", "--name-only", "-z", target])).split("\0").filter(Boolean) : []);
  for (const hash of changedCommits)
    for (const file of (await git(ctx.cwd, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", hash])).split("\0").filter(Boolean)) affected.add(file);
  const collision = ignored.find(file => [...affected].some(tracked => key(file) === key(tracked) || key(file).startsWith(key(tracked) + "/") || key(tracked).startsWith(key(file) + "/")));
  if (collision) throw error("Git에서 무시하는 파일을 덮어쓸 수 있어 중단했습니다. 먼저 다른 곳에 보존하세요: " + collision, "git-ignored-files");
}
async function commits(cwd, range) {
  const values = await readCommitSummaries(cwd, range, { run: git });
  if (values.length > 500) throw error("한 번에 변경할 수 있는 커밋은 500개까지입니다.", "git-limit");
  return values;
}

export function createGitClient({ getSessions = () => [], getTasks = () => [], isRunning = () => false, assertSession = () => {}, assertTaskOperation = () => {} } = {}) {
  const previews = new Map();
  function references(ctx) {
    const sessions = getSessions().filter(s => {
      const cwd = s.cwd ?? s.worktree?.dir ?? s.projectPath;
      try { return cwd && inside(canonical(cwd), ctx.cwd); } catch { return sameGitPath(cwd, ctx.cwd); }
    });
    const tasks = getTasks().filter(t => t.state !== "cleaned" && (sameGitPath(t.cwd, ctx.cwd) || (sameGitPath(t.gitCommonDir, ctx.common) && t.branch === ctx.entry.branch)));
    return { sessions, tasks };
  }
  async function guard(ctx, action, { clean = false } = {}) {
    // PR 병합은 GitHub에서만 실행하며 로컬 파일·index·브랜치를 바꾸지 않는다.
    // 저장소·PR 커밋·보호 규칙은 GitHubPulls.merge가 검사한다.
    if (action === "mergePull") return;
    if (ctx.entry.locked) throw error("잠긴 워크트리는 변경할 수 없습니다.", "git-locked");
    const refs = references(ctx);
    const active = refs.sessions.find(s => isRunning(s.id) || s.state === "running" || s.state === "background");
    if (active) throw error(`"${active.title || active.id}" 세션이 실행 중입니다. 종료하거나 일시중지한 뒤 진행하세요.`, "running");
    await assertTaskOperation(ctx.cwd, action);
    for (const task of refs.tasks) if (task.cwd !== ctx.cwd) await assertTaskOperation(task.cwd, action);
    for (const session of refs.sessions) assertSession(session);
    const task = refs.tasks.find(t => t.pendingAction || ["merged", "cleaned"].includes(t.state));
    if (task) throw error("작업의 완료 또는 이전 Git 요청을 작업 탭에서 먼저 확인하세요.", "task-state");
    if (action === "checkout" && refs.tasks.length)
      throw error("작업에 연결된 브랜치의 체크아웃은 작업 탭에서 관리하세요.", "task-owned");
    if (REWRITE.has(action) && refs.tasks.some(t => t.state !== "working" || t.pull || t.publishedHead))
      throw error("게시 또는 검토 중인 작업의 기록은 바꿀 수 없습니다. Revert로 취소 커밋을 추가하세요.", "task-owned");
    if (action === "checkout" && refs.sessions.some(s => s.worktree || s.gitContext))
      throw error("세션에 연결된 작업 폴더의 브랜치는 바꿀 수 없습니다. 다른 작업 폴더를 선택하세요.", "git-session-owned");
    await operationIdle(ctx);
    if (clean && await dirty(ctx.cwd)) throw error("커밋하지 않은 변경이나 새 파일이 있습니다. 먼저 커밋하거나 정리하세요.", "git-dirty");
  }
  async function write(ctx, action, fn, options) {
    return withGitRepoLock(ctx.common, async () => {
      const actual = await resolveGitContext(ctx.project, ctx.cwd);
      if (!sameGitPath(actual.common, ctx.common)) throw error("저장소 연결이 바뀌었습니다.", "git-context");
      await guard(actual, action, options);
      return fn(actual);
    });
  }
  async function list(ctx) {
    const cache = new Map();
    const rows = await Promise.all(ctx.records.map(async record => {
      const original = sameGitPath(record.cwd, ctx.original), missing = !fs.existsSync(record.cwd);
      const value = { ...record, original, missing, dirty: null, sessionIds: [], taskIds: [], canRemove: false };
      if (!missing && !record.bare) {
        try {
          const target = await resolveGitContext(ctx.project, record.cwd, cache);
          value.dirty = await dirty(target.cwd);
          const refs = references(target);
          value.sessionIds = refs.sessions.map(s => s.id); value.taskIds = refs.tasks.map(t => t.id);
          value.reason = original ? "원본 작업 폴더" : record.locked ? "잠긴 작업 폴더" : value.sessionIds.length || value.taskIds.length ? "세션 또는 작업이 연결되어 있습니다." : value.dirty ? "커밋하지 않은 변경이 있습니다." : null;
          value.canRemove = !value.reason;
        } catch (e) { value.reason = e.message; }
      } else value.reason = missing ? "작업 폴더를 찾을 수 없습니다." : "Bare 저장소";
      return value;
    }));
    return { worktrees: rows, currentCwd: ctx.cwd };
  }
  async function create(ctx, body) {
    return write(ctx, "createWorktree", async actual => {
      const name = validateWorktreeName(body.name);
      const root = path.join(path.dirname(canonical(actual.original)), path.basename(actual.original) + ".agenthub");
      // Reject junction/symlink roots, including aliases to a different output directory.
      if (fs.existsSync(root) && key(canonical(root)) !== key(path.resolve(root))) throw error("작업 폴더 루트에 다른 경로로 연결되는 링크가 있습니다.", "git-path");
      const cwd = path.resolve(root, name);
      if (path.dirname(cwd) !== path.resolve(root) || fs.existsSync(cwd)) throw error("작업 폴더가 이미 있거나 경로가 올바르지 않습니다.", "git-path");
      const existing = body.existingBranch;
      const selectedBranch = existing || body.branch || "agenthub/" + name;
      let start;
      if (existing) start = await validateBranch(actual.cwd, existing);
      else {
        await validateBranch(actual.cwd, selectedBranch, false);
        const exists = await git(actual.cwd, ["show-ref", "--verify", "--quiet", "refs/heads/" + selectedBranch]).then(() => true, e => { if (e.exitCode === 1) return false; throw e; });
        if (exists) throw error("같은 이름의 브랜치가 있습니다. 기존 브랜치 사용을 선택하세요.", "git-branch");
        start = body.startPoint ? (COMMIT_INPUT.test(body.startPoint) ? await resolveCommit(actual.cwd, body.startPoint) : await validateBranch(actual.cwd, body.startPoint)) : await head(actual.cwd);
      }
      if (actual.records.some(w => w.branch === selectedBranch)) throw error("이미 다른 작업 폴더에서 사용하는 브랜치입니다.", "git-branch-used");
      fs.mkdirSync(root, { recursive: true });
      await git(actual.cwd, ["worktree", "add", ...(existing ? [] : ["-b", selectedBranch]), "--", cwd, existing || start], { write: true, timeout: 60_000 });
      const created = await resolveGitContext(actual.project, cwd);
      if (await branch(cwd) !== selectedBranch || await head(cwd) !== start) throw error("생성 후 작업 폴더 상태가 바뀌었습니다. 목록을 새로고침하세요.", "git-state");
      return { ok: true, worktree: { ...created.entry, cwd: created.cwd, original: false, dirty: false } };
    });
  }
  async function remove(ctx, body) {
    return write(ctx, "removeWorktree", async actual => {
      if (body.removeFolder !== true) throw error("작업 폴더 삭제를 명시적으로 선택하세요.", "git-confirm", 400);
      if (sameGitPath(actual.cwd, actual.original)) throw error("원본 작업 폴더는 삭제할 수 없습니다.", "git-original");
      const refs = references(actual);
      if (refs.sessions.length || refs.tasks.length) throw error("연결된 세션 또는 작업을 먼저 정리하세요.", "git-referenced");
      const tip = await head(actual.cwd);
      if (body.expectedHead !== tip) throw error("삭제할 작업 폴더의 커밋이 바뀌었습니다. 다시 확인하세요.", "stale-head");
      const name = await branch(actual.cwd);
      if ((body.deleteBranch === true || body.expectedBranch !== undefined) && body.expectedBranch !== name)
        throw error("삭제할 작업 폴더의 브랜치가 바뀌었습니다. 다시 확인하세요.", "stale-head");
      // node_modules·빌드 결과처럼 Git이 무시하는 파일은 사용자가 함께 지우기로 고른 경우에만 지운다.
      if (body.removeIgnored !== true) {
        const ignored = (await git(actual.cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])).split("\0").filter(Boolean);
        if (ignored.length) throw error(`Git에서 무시하는 파일이 남아 있습니다: ${ignored.slice(0, 5).join(", ")}${ignored.length > 5 ? ` 외 ${ignored.length - 5}개` : ""}. 필요한 파일을 보존한 뒤 "무시하는 파일도 함께 삭제"를 선택하세요.`, "git-ignored-files");
      }
      // 원본 폴더의 현재 브랜치뿐 아니라 다른 로컬·원격 브랜치에 들어 있어도 반영된 것으로 본다(develop에 병합, 원격에 게시 등).
      const originalHead = await head(actual.original);
      const containing = (await git(actual.original, ["for-each-ref", "--contains", tip, "--format=%(refname)", "refs/heads", "refs/remotes"]))
        .split(/\r?\n/).filter((ref) => ref && ref !== "refs/heads/" + name && !ref.endsWith("/HEAD"));
      if (!containing.length && !await ancestor(actual.cwd, tip, originalHead)) throw error("다른 브랜치에 병합되지 않은 커밋이 있어 작업 폴더를 삭제할 수 없습니다.", "git-unmerged");
      if (body.deleteBranch === true && !name) throw error("삭제할 로컬 브랜치가 없습니다.", "git-branch");
      const removed = await removeWorktreeDir(actual.original, actual.cwd);
      if (!removed.removed) throw error(`작업 폴더를 모두 지우지 못했습니다. 그 폴더를 연 편집기·탐색기·터미널을 닫고 다시 시도하세요.${removed.error ? "\n" + removed.error.message : ""}`, "git-worktree-locked");
      let branchRemoved = false, warning;
      if (body.deleteBranch === true) {
        try {
          if ((await worktreeRecords(actual.original)).some(w => w.branch === name)) throw error("브랜치가 다른 작업 폴더에서 사용 중입니다.");
          await git(actual.original, ["update-ref", "-d", "refs/heads/" + name, tip], { write: true });
          branchRemoved = true;
        } catch (e) { warning = "폴더는 삭제했지만 브랜치는 남았습니다: " + e.message; }
      }
      return { ok: true, worktreeRemoved: true, branchRemoved, warning };
    }, { clean: true });
  }
  async function remotes(ctx, selected) {
    const names = (await git(ctx.cwd, ["remote"])).trim().split(/\r?\n/).filter(Boolean);
    const rows = await Promise.all(names.map(async name => {
      const fetchUrls = (await git(ctx.cwd, ["remote", "get-url", "--all", name])).trim().split(/\r?\n/).filter(Boolean);
      const pushUrls = (await git(ctx.cwd, ["remote", "get-url", "--push", "--all", name])).trim().split(/\r?\n/).filter(Boolean);
      return { name, fetchUrl: fetchUrls[0], pushUrl: pushUrls[0], pushUrls };
    }));
    const currentBranch = await branch(ctx.cwd);
    const tip = await head(ctx.cwd).catch(() => null);
    const upstream = (await git(ctx.cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "")).trim() || null;
    const remote = selected ?? (names.includes("origin") ? "origin" : names[0]);
    if (selected && !names.includes(selected)) throw error("선택한 원격 저장소가 없습니다.", "git-remote", 400);
    let remoteHead = null, ahead = null, behind = null;
    if (remote && currentBranch) {
      const selected = rows.find(item => item.name === remote);
      remoteHead = await readRemoteHead(ctx.cwd, selected.pushUrls.length === 1 ? selected.pushUrl : remote, currentBranch);
      if (!remoteHead) { ahead = tip ? Number((await git(ctx.cwd, ["rev-list", "--count", tip])).trim()) : 0; behind = 0; }
      else {
        try { const counts = (await git(ctx.cwd, ["rev-list", "--left-right", "--count", tip + "..." + remoteHead])).trim().split(/\s+/).map(Number); [ahead, behind] = counts; } catch { /* Fetch is needed before comparison. */ }
      }
    }
    return { remotes: rows, remote, currentBranch, upstream, head: tip, remoteHead, newBranch: !!currentBranch && !remoteHead, ahead, behind };
  }
  async function selectedRemote(ctx, selected) {
    const names = (await git(ctx.cwd, ["remote"])).trim().split(/\r?\n/).filter(Boolean);
    const name = selected ?? (names.includes("origin") ? "origin" : names.length === 1 ? names[0] : null);
    if (!name || !names.includes(name) || name.startsWith("-") || /[\s\0]/.test(name)) throw error("원격 저장소를 선택하세요.", "git-remote", 400);
    return name;
  }
  async function readRemoteHead(cwd, remote, name) {
    const output = (await git(cwd, ["ls-remote", "--heads", "--", remote, "refs/heads/" + name], { timeout: 30_000 })).trim();
    return output.split(/\r?\n/).map(line => line.split(/\s+/)).find(parts => parts[1] === "refs/heads/" + name)?.[0] ?? null;
  }
  async function fetchRemote(ctx, body) {
    return write(ctx, "fetch", async actual => {
      const remote = await selectedRemote(actual, body.remote);
      const result = await git(actual.cwd, ["fetch", "--no-recurse-submodules", "--", remote], { write: true, timeout: 90_000 });
      return { ok: true, result: result.trim() || "원격 기록을 가져왔습니다.", remote };
    });
  }
  async function pushState(ctx, body) {
    const remote = await selectedRemote(ctx, body.remote);
    const name = await branch(ctx.cwd), tip = await head(ctx.cwd);
    if (!name || (body.branch && body.branch !== name)) throw error("현재 브랜치만 게시할 수 있습니다.", "git-branch");
    const urls = (await git(ctx.cwd, ["remote", "get-url", "--push", "--all", remote])).trim().split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1) throw error("푸시 주소가 여러 개인 원격은 지원하지 않습니다.", "git-remote");
    const remoteHead = await readRemoteHead(ctx.cwd, urls[0], name);
    if (remoteHead && remoteHead !== tip) {
      try { if (!await ancestor(ctx.cwd, remoteHead, tip)) throw error("원격에 다른 커밋이 있습니다. 가져온 뒤 병합하세요. 강제 푸시는 지원하지 않습니다.", "git-non-fast-forward"); }
      catch (e) { if (e.reason === "git-non-fast-forward") throw e; throw error("원격 기록을 먼저 가져온 뒤 병합 여부를 확인하세요.", "git-fetch-required"); }
    }
    return { remote, pushUrl: urls[0], branch: name, head: tip, remoteHead, setUpstream: body.setUpstream === true };
  }
  async function push(ctx, body) {
    return write(ctx, "push", async actual => {
      const state = await pushState(actual, body);
      if (state.head !== body.expectedHead) throw error("게시할 커밋이 바뀌었습니다. 다시 확인하세요.", "stale-head");
      if (body.expectedRemoteHead !== undefined && state.remoteHead !== body.expectedRemoteHead) throw error("원격 브랜치가 바뀌었습니다. 다시 확인하세요.", "stale-head");
      if (body.expectedPushUrl && state.pushUrl !== body.expectedPushUrl) throw error("푸시 주소가 바뀌었습니다.", "git-remote");
      const result = await git(actual.cwd, ["-c", "remote." + state.remote + ".mirror=false", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--", state.pushUrl, state.head + ":refs/heads/" + state.branch], { write: true, timeout: 90_000 });
      let warning;
      if (state.setUpstream) {
        try {
          // Pushing a pinned SHA to the verified URL bypasses Git's normal remote-tracking update.
          const fetchSpecs = (await git(actual.cwd, ["config", "--get-all", "remote." + state.remote + ".fetch"]).catch(() => "")).trim().split(/\r?\n/);
          const standard = "+refs/heads/*:refs/remotes/" + state.remote + "/*";
          if (fetchSpecs.includes(standard) || fetchSpecs.includes(standard.slice(1)))
            await git(actual.cwd, ["update-ref", "refs/remotes/" + state.remote + "/" + state.branch, state.head], { write: true });
          await git(actual.cwd, ["config", "branch." + state.branch + ".remote", state.remote], { write: true });
          await git(actual.cwd, ["config", "branch." + state.branch + ".merge", "refs/heads/" + state.branch], { write: true });
        } catch (e) { warning = "게시했지만 upstream 설정을 저장하지 못했습니다: " + e.message; }
      }
      return { ok: true, result: result.trim() || "브랜치를 게시했습니다.", warning, head: state.head };
    });
  }
  // Pull 미리보기. 추적 중인 원격 브랜치와 마지막으로 받은 기록 기준의 앞섬·뒤처짐을 돌려준다.
  async function pullState(ctx) {
    const name = await branch(ctx.cwd);
    if (!name) throw error("브랜치가 아닌 커밋을 보고 있어 받을 수 없습니다. 브랜치로 전환하세요.", "git-detached");
    const upstream = (await git(ctx.cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim();
    if (!upstream) throw error("이 브랜치가 따라갈 원격 브랜치가 정해지지 않았습니다.", "git-no-upstream", 409, { hint: "먼저 Push로 원격에 브랜치를 게시하면서 추적을 설정하세요." });
    const remote = (await git(ctx.cwd, ["config", "--get", "branch." + name + ".remote"]).catch(() => "")).trim();
    const merge = (await git(ctx.cwd, ["config", "--get", "branch." + name + ".merge"]).catch(() => "")).trim();
    if (!remote || remote === "." || !merge.startsWith("refs/heads/")) throw error("로컬 브랜치를 추적하는 브랜치는 Pull을 지원하지 않습니다.", "git-no-upstream");
    const tip = await head(ctx.cwd);
    const upstreamHead = (await git(ctx.cwd, ["rev-parse", "--verify", upstream]).catch(() => "")).trim() || null;
    let ahead = null, behind = null;
    if (upstreamHead) [ahead, behind] = (await git(ctx.cwd, ["rev-list", "--left-right", "--count", tip + "..." + upstreamHead])).trim().split(/\s+/).map(Number);
    return { branch: name, remote, remoteBranch: merge.slice("refs/heads/".length), upstream, head: tip, upstreamHead, ahead, behind, dirty: await dirty(ctx.cwd) };
  }
  // 원격 변경을 받는다. 기본은 앞으로 감기만 하고, 갈라졌으면 사용자가 고른 병합·리베이스로 합친다.
  // 충돌하면 진행 중인 병합·리베이스를 취소해 실행 전 상태로 돌려놓는다.
  async function pull(ctx, body = {}) {
    const strategy = body.strategy ?? "ff-only";
    if (!["ff-only", "merge", "rebase"].includes(strategy)) throw error("받기 방식을 선택하세요.", "git-pull", 400);
    return write(ctx, "pull", async actual => {
      const state = await pullState(actual);
      if (body.expectedHead && body.expectedHead !== state.head) throw error("현재 커밋이 바뀌었습니다. 다시 확인하세요.", "stale-head");
      const mode = strategy === "ff-only" ? ["--ff-only"] : strategy === "merge" ? ["--no-rebase", "--no-edit"] : ["--rebase"];
      try {
        const result = await git(actual.cwd, ["-c", "core.editor=true", "pull", "--no-recurse-submodules", ...mode, "--", state.remote, state.remoteBranch], { write: true, timeout: 120_000 });
        return { ok: true, result: result.trim() || "원격 변경을 받았습니다.", head: await head(actual.cwd), strategy };
      } catch (failure) {
        if (failure.outcomeUnknown) throw failure;
        let restored = true, aborted = false;
        for (const [marker, args] of [["MERGE_HEAD", ["merge", "--abort"]], ["rebase-merge", ["rebase", "--abort"]], ["rebase-apply", ["rebase", "--abort"]]]) {
          if (!fs.existsSync(path.join(actual.gitDir, marker))) continue;
          aborted = true;
          try { await git(actual.cwd, args, { write: true }); } catch { restored = false; }
        }
        if (!restored) throw error("받는 중 충돌이 나서 취소하려 했지만 작업 폴더를 원래대로 돌리지 못했습니다. 진행 중인 병합·리베이스를 확인하세요.", "git-recovery-required", 409, { raw: failure.raw || failure.message });
        if (aborted || failure.reason === "git-conflict") throw error("받은 변경과 같은 부분이 바뀌어 충돌이 났습니다. 받기를 취소하고 실행 전 상태로 되돌렸습니다.", "git-conflict", 409, { hint: "충돌할 파일을 먼저 커밋하거나 세션에 충돌 해결을 요청한 뒤 다시 받으세요.", raw: failure.raw });
        throw failure;
      }
    });
  }
  // 새 로컬 브랜치를 만든다. checkout이면 만든 뒤 그 브랜치로 전환한다.
  async function createBranch(ctx, body = {}) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 200 || name.startsWith("-")) throw error("새 브랜치 이름을 입력하세요.", "git-branch", 400);
    try {
      if ((await git(ctx.cwd, ["check-ref-format", "--branch", name])).trim() !== name) throw Error("shorthand");
    } catch { throw error("브랜치 이름이 올바르지 않습니다: " + name, "git-branch", 400, { hint: "공백, ~ ^ : ? * [ \\ 와 .. 은 쓸 수 없습니다." }); }
    const checkout = body.checkout === true;
    return write(ctx, checkout ? "checkout" : "branch", async actual => {
      if (await git(actual.cwd, ["rev-parse", "--verify", "--quiet", "refs/heads/" + name]).then(() => true, () => false))
        throw error("같은 이름의 브랜치가 이미 있습니다: " + name, "git-branch-exists");
      const start = body.startPoint ? (await git(actual.cwd, ["rev-parse", "--verify", "--end-of-options", String(body.startPoint) + "^{commit}"]).catch(() => { throw error("시작할 커밋이나 브랜치를 찾지 못했습니다.", "git-branch", 400); })).trim() : await head(actual.cwd);
      if (checkout) await git(actual.cwd, ["switch", "--no-guess", "--no-track", "-c", name, start], { write: true });
      else await git(actual.cwd, ["branch", "--no-track", "--", name, start], { write: true });
      return { ok: true, branch: name, head: start, checkedOut: checkout, result: (checkout ? "새 브랜치로 전환했습니다: " : "새 브랜치를 만들었습니다: ") + name };
    });
  }
  async function publishedReason(ctx, affected) {
    if (!affected.length) return null;
    const tips = new Set((await git(ctx.cwd, ["for-each-ref", "--format=%(objectname)", "refs/remotes/"])).trim().split(/\r?\n/).filter(Boolean));
    const names = (await git(ctx.cwd, ["remote"])).trim().split(/\r?\n/).filter(Boolean);
    const urls = new Set();
    for (const remote of names) {
      for (const args of [["remote", "get-url", "--all", remote], ["remote", "get-url", "--push", "--all", remote]])
        for (const url of (await git(ctx.cwd, args)).trim().split(/\r?\n/).filter(Boolean)) urls.add(url);
    }
    for (const remote of urls) {
      let output;
      try { output = await git(ctx.cwd, ["ls-remote", "--heads", "--tags", "--", remote]); }
      catch { return "원격 게시 상태를 확인할 수 없어 기록 변경을 막았습니다. 연결을 확인하거나 Revert를 사용하세요."; }
      for (const line of output.trim().split(/\r?\n/)) if (line) tips.add(line.split(/\s+/)[0]);
    }
    try {
      if (await containsAnyCommit(ctx.cwd, tips, new Set(affected.map(commit => commit.hash))))
        return "이미 원격에 게시된 커밋의 기록 변경은 지원하지 않습니다. Revert로 취소 커밋을 추가하세요.";
    } catch { return "원격 커밋을 먼저 Fetch한 뒤 게시 여부를 다시 확인하세요. Revert도 사용할 수 있습니다."; }
    return null;
  }
  async function preview(ctx, body) {
    return withGitRepoLock(ctx.common, async () => {
      ctx = await resolveGitContext(ctx.project, ctx.cwd);
      const action = body.action;
      if (!["merge", "revert", "uncommit", "reset", "drop", "push"].includes(action)) throw error("지원하지 않는 Git 작업입니다.", "git-action", 400);
      const tip = await head(ctx.cwd), name = await branch(ctx.cwd);
      if (!name) throw error("브랜치를 선택한 작업 폴더에서 실행하세요.", "git-detached");
      const value = { previewId: randomUUID(), action, cwd: ctx.cwd, branch: name, head: tip, targetBranch: name,
        affectedCommits: [], files: [], diff: "", diffTruncated: false, published: false, expiresAt: new Date(Date.now() + PREVIEW_TTL).toISOString() };
      let before = tip, after = tip;
      if (action === "merge") {
        value.sourceBranch = body.branch; value.sourceHead = await validateBranch(ctx.cwd, body.branch);
        if (body.branch === name) throw error("현재 브랜치와 다른 브랜치를 선택하세요.", "git-same-branch");
        value.affectedCommits = await commits(ctx.cwd, tip + ".." + value.sourceHead);
        const base = (await git(ctx.cwd, ["merge-base", tip, value.sourceHead])).trim();
        before = base; after = value.sourceHead;
        value.summary = body.branch + " → " + name + " 병합 · 커밋된 변경만 포함";
      } else if (action === "push") {
        const state = await pushState(ctx, body);
        Object.assign(value, state);
        value.summary = state.branch + " → " + state.remote + " 게시";
        value.affectedCommits = await commits(ctx.cwd, state.remoteHead ? state.remoteHead + ".." + tip : tip);
        before = state.remoteHead; after = tip;
      } else {
        value.commit = await resolveCommit(ctx.cwd, body.commit ?? body.hash);
        if (!await ancestor(ctx.cwd, value.commit, tip)) throw error("현재 브랜치 기록에 포함된 커밋을 선택하세요.", "git-commit");
        const parents = (await git(ctx.cwd, ["show", "-s", "--format=%P", value.commit])).trim().split(" ").filter(Boolean);
        if (action !== "reset" && (parents.length > 1 || (parents.length === 0 && action !== "revert"))) throw error("루트 커밋이나 병합 커밋은 이 작업으로 변경할 수 없습니다.", "git-complex-history");
        value.parent = parents[0];
        if (action === "uncommit" && value.commit !== tip) throw error("커밋 해제는 가장 최근 커밋에서만 사용할 수 있습니다. 중간 커밋은 삭제 기능을 사용하세요.", "git-not-head");
        if (action === "reset" && value.commit === tip) throw error("이미 현재 커밋입니다.", "git-no-change");
        if (action === "revert" || action === "uncommit") value.affectedCommits = await commits(ctx.cwd, value.parent ? value.parent + ".." + value.commit : value.commit);
        else value.affectedCommits = await commits(ctx.cwd, (action === "reset" ? value.commit : value.parent) + ".." + tip);
        if (action === "drop") {
          const merges = (await git(ctx.cwd, ["rev-list", "--min-parents=2", value.parent + ".." + tip])).trim();
          if (merges) throw error("병합 커밋이 포함된 기록의 중간 삭제는 지원하지 않습니다. Revert를 사용하세요.", "git-complex-history");
          value.descendants = (await git(ctx.cwd, ["rev-list", "--reverse", value.commit + ".." + tip])).trim().split(/\r?\n/).filter(Boolean);
        }
        before = action === "revert" || action === "drop" ? value.commit : tip;
        after = action === "reset" ? value.commit : value.parent;
        value.summary = ({ revert: "선택 커밋의 반대 변경을 새 커밋으로 추가", uncommit: "마지막 커밋을 해제하고 파일 변경 보존", reset: "선택 커밋으로 되돌리고 이후 커밋의 파일 변경 제거", drop: "선택 커밋을 삭제하고 이후 커밋을 순서대로 다시 적용" })[action];
        if (REWRITE.has(action)) {
          value.blockedReason = await publishedReason(ctx, value.affectedCommits);
          value.published = !!value.blockedReason;
        }
      }
      try {
        await guard(ctx, action, { clean: action !== "push" });
        if (action === "merge") {
          const source = ctx.records.find(w => w.branch === value.sourceBranch);
          if (source) await guard(await resolveGitContext(ctx.project, source.cwd), "mergeSource");
        }
      } catch (e) { value.blockedReason ??= e.message; }
      if (!value.blockedReason && action !== "push" && action !== "uncommit") {
        try {
          await protectIgnored(ctx, action === "reset" ? value.commit : action === "drop" ? value.parent : action === "merge" ? value.sourceHead : null,
            action === "revert" ? [value.commit] : action === "drop" ? value.descendants : []);
        } catch (e) { value.blockedReason = e.message; }
      }
      if (before) {
        const full = await git(ctx.cwd, after ? ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", "--patch", before, after, "--"]
          : ["show", "--format=", "--root", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", "--patch", "-R", before, "--"]);
        value.diff = full.slice(0, 300_000); value.diffTruncated = full.length > 300_000;
        value.files = (await git(ctx.cwd, after ? ["diff", "--name-only", "-z", before, after, "--"]
          : ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", before])).split("\0").filter(Boolean);
      } else {
        value.files = (await git(ctx.cwd, ["ls-tree", "-r", "--name-only", "-z", after])).split("\0").filter(Boolean);
      }
      for (const [id, item] of previews) if (Date.parse(item.expiresAt) < Date.now()) previews.delete(id);
      if (previews.size >= 100) previews.delete(previews.keys().next().value);
      previews.set(value.previewId, { ...value, common: ctx.common, project: ctx.project });
      return value;
    });
  }
  const recoveryDirectory = ctx => path.join(ctx.common, "agenthub-recovery");
  function recoveryFile(ctx, id) {
    if (typeof id !== "string" || !/^[0-9]{13}-[0-9a-f-]{36}$/.test(id)) throw error("복구 항목을 선택하세요.", "git-recovery", 400);
    return path.join(recoveryDirectory(ctx), id + ".json");
  }
  async function recovery(ctx, action) {
    const id = Date.now() + "-" + randomUUID(), tip = await head(ctx.cwd), name = await branch(ctx.cwd);
    const item = { id, ref: "refs/agenthub/recovery/" + id, head: tip, branch: name, cwd: ctx.cwd, action, createdAt: new Date().toISOString() };
    await git(ctx.cwd, ["update-ref", item.ref, tip, "0".repeat(tip.length)], { write: true });
    fs.mkdirSync(recoveryDirectory(ctx), { recursive: true });
    fs.writeFileSync(recoveryFile(ctx, id), JSON.stringify(item), { flag: "wx" });
    return item;
  }
  function saveRecovery(ctx, item) { fs.writeFileSync(recoveryFile(ctx, item.id), JSON.stringify(item)); }
  async function recoveryList(ctx) {
    let names;
    try { names = fs.readdirSync(recoveryDirectory(ctx)); } catch (e) { if (e.code === "ENOENT") return { recoveries: [] }; throw e; }
    const items = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const item = JSON.parse(fs.readFileSync(recoveryFile(ctx, name.slice(0, -5)), "utf8"));
        if (sameGitPath(item.cwd, ctx.cwd) && item.ref === "refs/agenthub/recovery/" + item.id && SHA.test(item.head)) items.push(item);
      } catch { /* Ignore incomplete metadata; the Git recovery ref remains available. */ }
    }
    return { recoveries: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) };
  }
  async function rollback(ctx, item, action, failure) {
    if (failure.outcomeUnknown) throw error("Git 작업 완료 여부를 확인할 수 없습니다. 복구 지점은 보존했습니다.", "git-outcome-unknown", 409, { outcomeUnknown: true, recoveryId: item.id });
    const marker = action === "merge" ? "MERGE_HEAD" : action === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD";
    try {
      if (fs.existsSync(path.join(ctx.gitDir, marker)) || (action === "drop" && fs.existsSync(path.join(ctx.gitDir, "sequencer"))))
        await git(ctx.cwd, [action === "drop" ? "cherry-pick" : action, "--abort"], { write: true });
      if (action === "drop") await git(ctx.cwd, ["reset", "--hard", item.head], { write: true });
      await operationIdle(ctx);
      if (await head(ctx.cwd) !== item.head || await dirty(ctx.cwd)) throw error("실행 전 상태와 다릅니다.");
    } catch { throw error("자동 복원을 확인하지 못했습니다. 추가 작업을 멈추고 복구 지점을 확인하세요.", "git-recovery-required", 409, { recoveryId: item.id }); }
    throw error("작업을 취소하고 실행 전 상태로 복원했습니다.\n" + failure.message, "git-conflict", 409, { recoveryId: item.id, hint: failure.hint, raw: failure.raw });
  }
  async function execute(ctx, body) {
    const stored = previews.get(body.previewId);
    if (!stored || Date.parse(stored.expiresAt) < Date.now() || !sameGitPath(stored.cwd, ctx.cwd) || !sameGitPath(stored.common, ctx.common))
      throw error("미리보기가 만료되었거나 작업 폴더가 바뀌었습니다. 다시 확인하세요.", "git-preview-stale");
    return write(ctx, stored.action, async actual => {
      if (await head(actual.cwd) !== stored.head || await branch(actual.cwd) !== stored.branch)
        throw error("확인한 뒤 브랜치나 커밋이 바뀌었습니다. 다시 미리보기를 확인하세요.", "stale-head");
      if (stored.blockedReason) throw error(stored.blockedReason, "git-blocked");
      if (REWRITE.has(stored.action)) {
        const reason = await publishedReason(actual, stored.affectedCommits);
        if (reason) throw error(reason, "git-published");
      }
      if (stored.action === "push") {
        previews.delete(stored.previewId);
        return push(actual, { ...stored, expectedHead: stored.head, expectedRemoteHead: stored.remoteHead, expectedPushUrl: stored.pushUrl });
      }
      if (stored.action === "merge") {
        if (await validateBranch(actual.cwd, stored.sourceBranch) !== stored.sourceHead) throw error("병합할 브랜치에 새 커밋이 있습니다. 다시 확인하세요.", "stale-head");
        const source = actual.records.find(w => w.branch === stored.sourceBranch);
        if (source) await guard(await resolveGitContext(actual.project, source.cwd), "mergeSource");
      }
      if (stored.action !== "uncommit") await protectIgnored(actual,
        stored.action === "reset" ? stored.commit : stored.action === "drop" ? stored.parent : stored.action === "merge" ? stored.sourceHead : null,
        stored.action === "revert" ? [stored.commit] : stored.action === "drop" ? stored.descendants : []);
      previews.delete(stored.previewId);
      const item = await recovery(actual, stored.action);
      try {
        if (stored.action === "merge") await git(actual.cwd, ["merge", "--no-ff", "--no-edit", "--no-overwrite-ignore", stored.sourceHead], { write: true, timeout: 60_000 });
        else if (stored.action === "revert") await git(actual.cwd, ["revert", "--no-edit", stored.commit], { write: true, timeout: 60_000 });
        else if (stored.action === "uncommit") await git(actual.cwd, ["reset", "--mixed", stored.parent], { write: true });
        else if (stored.action === "reset") await git(actual.cwd, ["reset", "--hard", stored.commit], { write: true });
        else if (stored.action === "drop") {
          await git(actual.cwd, ["reset", "--hard", stored.parent], { write: true });
          if (stored.descendants.length) await git(actual.cwd, ["cherry-pick", "--allow-empty", "--keep-redundant-commits", "--no-edit", ...stored.descendants], { write: true, timeout: 90_000 });
        }
      } catch (e) { return rollback(actual, item, stored.action, e); }
      try {
        await operationIdle(actual);
        if (await branch(actual.cwd) !== stored.branch) throw error("작업 중 브랜치가 바뀌었습니다.");
        if (stored.action !== "uncommit" && await dirty(actual.cwd)) throw error("작업 후 예상하지 않은 파일 변경이 있습니다.");
        item.afterHead = await head(actual.cwd); item.afterFingerprint = await statusFingerprint(actual.cwd); saveRecovery(actual, item);
      } catch (e) { throw error("Git 변경 후 상태 확인 또는 복구 정보 저장에 실패했습니다. 다시 실행하지 말고 복구 지점을 확인하세요.\n" + e.message,
        "git-recovery-required", 409, { recoveryId: item.id, outcomeUnknown: true }); }
      return { ok: true, head: item.afterHead, recoveryId: item.id, result: stored.summary + " 완료" };
    }, { clean: stored.action !== "push" });
  }
  async function restore(ctx, body) {
    return write(ctx, "restore", async actual => {
      let item;
      try { item = JSON.parse(fs.readFileSync(recoveryFile(actual, body.recoveryId), "utf8")); }
      catch { throw error("복구 지점을 찾을 수 없습니다.", "git-recovery"); }
      const tip = await head(actual.cwd), name = await branch(actual.cwd);
      if (!sameGitPath(item.cwd, actual.cwd) || item.branch !== name || body.expectedHead !== tip || (item.afterHead && item.afterHead !== tip))
        throw error("복구 지점 이후 브랜치나 커밋이 바뀌었습니다. 기록을 다시 확인하세요.", "stale-head");
      if (item.ref !== "refs/agenthub/recovery/" + item.id || !SHA.test(item.head) || (await git(actual.cwd, ["rev-parse", "--verify", item.ref])).trim() !== item.head)
        throw error("복구 지점의 Git 참조가 바뀌었습니다.", "git-recovery");
      if (await dirty(actual.cwd) && !(item.action === "uncommit" && item.afterFingerprint && await statusFingerprint(actual.cwd) === item.afterFingerprint))
        throw error("복구 이후에 지워질 파일 변경이 있습니다. 먼저 보존하세요.", "git-dirty");
      const affected = await commits(actual.cwd, item.head + ".." + tip);
      const reason = await publishedReason(actual, affected);
      if (reason) throw error(reason, "git-published");
      await protectIgnored(actual, item.head);
      const rescue = await recovery(actual, "restore");
      try {
        await git(actual.cwd, ["reset", "--hard", item.head], { write: true });
        if (await head(actual.cwd) !== item.head || await dirty(actual.cwd)) throw error("복구 결과를 확인하지 못했습니다.");
        rescue.afterHead = item.head; rescue.afterFingerprint = await statusFingerprint(actual.cwd); saveRecovery(actual, rescue);
      } catch (e) { throw error("복구 실행 후 결과를 확인하지 못했습니다. 다시 실행하지 말고 복구 지점을 확인하세요.\n" + e.message,
        "git-recovery-required", 409, { recoveryId: rescue.id, outcomeUnknown: true }); }
      return { ok: true, head: item.head, recoveryId: rescue.id, result: "복구 지점으로 돌아왔습니다." };
    });
  }
  // 폴더가 이미 사라진 워크트리 기록만 지운다. 남아 있는 폴더와 브랜치는 건드리지 않는다.
  async function prune(ctx) {
    return withGitRepoLock(ctx.common, async () => {
      const missing = (await worktreeRecords(ctx.original)).filter(w => !fs.existsSync(w.cwd)).length;
      await git(ctx.original, ["worktree", "prune"], { write: true });
      return { ok: true, pruned: missing };
    });
  }
  return { context: resolveGitContext, write, guard, list, create, remove, prune, remotes, fetch: fetchRemote, push, pullState, pull, createBranch, preview, execute, recovery: recoveryList, restore };
}

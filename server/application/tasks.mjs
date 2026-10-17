import fs from "node:fs";
import path from "node:path";
import { withGitRepoLock } from "../git-lock.mjs";
import { createHash, randomBytes } from "node:crypto";
import { githubCredentialArgs, githubPulls, normalizePull } from "../github.mjs";
import { GitHubIssues, githubIssues, normalizeIssue } from "../issues.mjs";
import { summary } from "../store.mjs";
import { listWorkbranches, resolveWorkbranch } from "../workbranches.mjs";
import { HttpError } from "./errors.mjs";
import { readJsonFile, writeJsonAtomic } from "../infrastructure/persistence/json-file.mjs";
import { taskGit, taskRepo, taskRef, taskAncestor, gitflowContext, assertTaskWorktree, readTaskBranch,
  taskDirty, taskWorktreeLocation, validTaskWorktreeName, sameTaskPath, insideTaskPath, assertTaskGitIdle, taskBranchSlug, removeWorktreeDir, worktreeRegistered } from "../tasks.mjs";
import { normalizeGitflowSettings, projectGitflowSettings, gitflowSettingsKey, gitflowBranches } from "../gitflow-settings.mjs";
import { reviewSnapshot, commitReviewedFiles, assertReviewed } from "../task-review.mjs";
import { fileDiff, parseStatus } from "../gitpanel.mjs";
import { runGitNode } from "../git-nodes.mjs";

// 설정한 배포·개발 브랜치인지(대소문자를 구분한다)
const isGitflowBase = (flow, branch) => branch === flow.main || branch === flow.develop;

const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const remoteFingerprint = (value) => createHash("sha256").update(value).digest("hex");
// 사용자가 접두어까지 적은 브랜치 이름(feature/login)에 접두어를 한 번 더 붙이지 않는다.
// 다른 유형의 접두어로 시작하면 기준·대상 브랜치가 어긋나므로 받지 않는다.
export function taskBranchName(flow, type, value = "") {
  const prefix = flow[`${type}Prefix`];
  if (!value) return "";
  if (value.startsWith(prefix)) {
    const rest = value.slice(prefix.length);
    if (!rest) throw new HttpError(400, `브랜치 이름에 ${prefix} 뒤의 이름을 입력하세요.`, "task-branch-name");
    return rest;
  }
  const other = ["featurePrefix", "hotfixPrefix", "releasePrefix"].map((key) => flow[key]).find((item) => item !== prefix && value.startsWith(item));
  if (other) throw new HttpError(400, `브랜치 이름이 다른 작업 유형의 접두어(${other})로 시작합니다. 작업 유형을 바꾸거나 접두어를 빼고 입력하세요.`, "task-branch-name");
  return value;
}
const failure = (error) => error instanceof HttpError ? error : new HttpError(error.status ?? 409, error.message, error.reason ?? "task-error", { outcomeUnknown: !!error.outcomeUnknown, hint: error.hint, raw: error.raw });
// 카드에 남기는 오류. 해결 방법(hint)이 있으면 함께 보관한다.
const recordError = (task, error) => {
  task.error = error.message; task.errorReason = error.reason;
  if (typeof error.hint === "string" && error.hint) task.errorHint = error.hint; else delete task.errorHint;
};

const emptyDir = (dir) => { try { return fs.statSync(dir).isDirectory() && !fs.readdirSync(dir).length; } catch { return false; } };
// git worktree add가 실패한 원인을 사용자가 알 수 있는 문장으로 바꾼다. 원문은 raw로 남긴다.
const WORKTREE_FAILURES = [
  [/invalid path|Filename too long|cannot create directory|unable to create file/i, "저장소에 이 컴퓨터에서 만들 수 없는 파일 이름이나 너무 긴 경로가 있어 작업 폴더를 만들지 못했습니다.",
    "파일 이름에 : * ? \" < > | 같은 문자가 있는지, 경로가 너무 길지 않은지 확인하세요. 원본 폴더에서 작업하는 방법도 있습니다."],
  [/already registered worktree|already checked out|is already used by worktree/i, "같은 경로나 브랜치가 다른 워크트리에 등록되어 있어 작업 폴더를 만들지 못했습니다.",
    "Git 패널의 워크트리 목록에서 남은 항목을 정리한 뒤 다시 시도하세요."],
  [/Permission denied|Access is denied|EPERM|EACCES/i, "작업 폴더를 만들 권한이 없습니다.", "<프로젝트>.agenthub 폴더의 권한과 다른 프로그램이 폴더를 잡고 있는지 확인하세요."],
];
function worktreeFailure(error) {
  if (error.outcomeUnknown || error.reason !== "git-error") return failure(error);
  const raw = String(error.raw ?? error.message);
  const [, message, hint] = WORKTREE_FAILURES.find(([test]) => test.test(raw)) ?? [null, "작업 폴더를 만들지 못했습니다.", ""];
  const cause = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(fatal|error):/i.test(line)).at(0);
  return new HttpError(409, cause ? `${message} (${cause})` : message, "task-worktree-create", { hint, raw: raw.slice(0, 1600) });
}

// 배포 준비·긴급 수정은 main에 반영한 뒤 develop에도 반영해야 끝난다.
const needsDevelop = (task) => ["hotfix", "release"].includes(task.type);
const ISSUE_NUMBER = /^[1-9][0-9]{0,8}$/;
const issueSummary = (issue) => ({ repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, state: issue.state,
  stateReason: issue.stateReason ?? null, checkedAt: new Date().toISOString() });

export function createTaskService({ dataDir, store, runner, sessions, projects, graphTabs, notify = () => {}, github = githubPulls,
  issues = github === githubPulls ? githubIssues : new GitHubIssues({ pulls: github }), config = {}, saveConfig = () => {} }) {
  const directory = path.join(dataDir, "tasks");
  fs.mkdirSync(directory, { recursive: true });
  const records = new Map();
  const queue = new Map();
  const busy = new Set();
  for (const file of fs.readdirSync(directory).filter((name) => /^[a-z0-9-]+\.json$/i.test(name))) {
    const task = readJsonFile(path.join(directory, file), { dataDir, fallback: () => null, valid: (value) => value !== null && typeof value === "object" });
    if (task?.id && task.projectPath && task.cwd) records.set(task.id, task);
  }
  const sessionService = () => typeof sessions === "function" ? sessions() : sessions;
  const projectService = () => typeof projects === "function" ? projects() : projects;
  function save(task) {
    if (!task.error) { delete task.errorReason; delete task.errorHint; }
    task.updatedAt = now();
    const file = path.join(directory, `${task.id}.json`);
    writeJsonAtomic(file, task);
    records.set(task.id, task);
    notify("tasks", { projectPath: task.projectPath, taskId: task.id });
    return task;
  }
  function get(id) {
    const task = records.get(id);
    if (!task) throw new HttpError(404, "작업이 없습니다.", "task-missing");
    return task;
  }
  async function locked(key, action) {
    const previous = queue.get(key) ?? Promise.resolve();
    // 저장소 폴더가 사라진 작업도 삭제할 수 있도록, 잠글 Git 폴더가 없으면 이 서비스의 대기열만 쓴다.
    const current = previous.catch(() => {}).then(() => key === "gitflow-settings" || !fs.existsSync(key) ? action() : withGitRepoLock(key, action));
    queue.set(key, current);
    try { return await current; }
    finally { if (queue.get(key) === current) queue.delete(key); }
  }
  function taskSessions(task) {
    return store.list().filter((session) => (task.id && session.taskId === task.id) || insideTaskPath(session.cwd, task.cwd));
  }
  function assertIdle(task, except) {
    if (taskSessions(task).some((session) => session.id !== except && runner.isRunning(session.id)))
      throw new HttpError(409, "이 작업 폴더에서 실행 중인 세션을 먼저 중지하세요.", "running");
  }
  // 원본 폴더를 새 작업 브랜치로 바꿔도 되는지 확인하고 지금 브랜치 이름을 돌려준다.
  async function assertInPlaceReady(repo) {
    const cwd = path.resolve(repo.top);
    const other = [...records.values()].find((task) => task.inPlace && task.state !== "cleaned" && sameTaskPath(task.gitCommonDir, repo.common));
    if (other) throw new HttpError(409, `원본 폴더는 이미 "${other.title}" 작업에서 쓰고 있습니다. 그 작업을 정리하거나 워크트리를 만들어 진행하세요.`, "task-in-place");
    // 저장소 하위 폴더를 프로젝트로 등록한 세션도 원본 폴더에서 일하는 세션이다.
    if (store.list().some((session) => runner.isRunning(session.id) && insideTaskPath(session.cwd, cwd)))
      throw new HttpError(409, "이 작업 폴더에서 실행 중인 세션을 먼저 중지하세요.", "running");
    await assertTaskGitIdle({ cwd });
    if (await taskDirty({ cwd })) throw new HttpError(409, "원본 폴더에 커밋하지 않은 변경이 있습니다. 커밋하거나 워크트리를 만들어 진행하세요.", "task-dirty");
    return (await taskGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() || null;
  }
  // 새 작업을 원본 폴더에서 바로 시작할 수 있는지 미리 본다. 쓸 수 없으면 화면이 워크트리로 진행할지 묻는다.
  const IN_PLACE_BUSY = ["task-in-place", "running", "task-dirty", "task-git-operation"];
  async function inPlaceStatus(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const repo = await taskRepo(projectPath);
    try { await assertInPlaceReady(repo); return { available: true }; }
    catch (error) {
      if (!IN_PLACE_BUSY.includes(error.reason)) throw error;
      return { available: false, reason: error.reason, message: error.reason === "running" ? "원본 폴더에서 실행 중인 세션이 있습니다." : error.message };
    }
  }
  // 정리할 때 원본 폴더를 작업 전 브랜치(없으면 PR 대상 브랜치)로 되돌려 작업 브랜치를 지울 수 있게 한다.
  async function leaveInPlaceBranch(task) {
    for (const branch of [task.previousBranch, task.targetBranch]) {
      if (!branch || branch === task.branch || !await taskRef(task.projectPath, `refs/heads/${branch}`)) continue;
      try { await taskGit(task.cwd, ["switch", "--no-guess", branch], { write: true }); return; }
      catch (error) { if (error.outcomeUnknown) throw error; }
    }
    await taskGit(task.cwd, ["switch", "--detach", "HEAD"], { write: true });
  }
  const sessionBusy = (session) => runner.isRunning(typeof session === "string" ? session : session.id);
  function assertActive(task) {
    if (["merged", "cleaned"].includes(task.state)) throw new HttpError(409, "병합이 완료된 작업입니다. 새 작업에서 이어서 진행하세요.", "task-completed");
  }
  function assertSession(session) {
    if (!session.taskId) {
      if (session.worktree) {
        if (!sameTaskPath(session.cwd, session.worktree.dir) || readTaskBranch(session.cwd) !== session.worktree.branch)
          throw new HttpError(409, "선택한 작업 브랜치의 폴더 또는 브랜치가 바뀌었습니다.", "workbranch-changed");
        assertIdle({ cwd: session.cwd }, session.id);
      }
      return;
    }
    const task = get(session.taskId);
    assertActive(task);
    if (busy.has(task.id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
    if (!task.sessionIds.includes(session.id) || !sameTaskPath(task.cwd, session.cwd) || !sameTaskPath(task.cwd, session.worktree?.dir)
      || readTaskBranch(task.cwd) !== task.branch)
      throw new HttpError(409, "작업 폴더 또는 브랜치가 바뀌었습니다. 작업 탭에서 확인하세요.", "task-worktree");
    assertIdle(task, session.id);
  }
  async function assertGitOperation(cwd, action) {
    for (const task of records.values()) {
      if (!sameTaskPath(task.cwd, cwd) || task.state === "cleaned") continue;
      if (busy.has(task.id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
      if (task.pendingAction) throw new HttpError(409, "작업 탭에서 이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown");
      assertActive(task);
      assertIdle(task);
      await assertTaskWorktree(task);
      if (["checkout", "remove", "removeWorktree"].includes(action))
        throw new HttpError(409, "작업에 연결된 폴더입니다. 작업 탭에서 정리하세요.", "task-worktree");
      if (["uncommit", "reset", "drop", "restore"].includes(action) && (task.pull || task.publishedHead))
        throw new HttpError(409, "이미 게시한 작업입니다. 기록을 유지하는 변경 되돌리기를 사용하세요.", "task-published");
    }
  }
  function list(projectPath) {
    return { tasks: [...records.values()].filter((task) => !projectPath || sameTaskPath(task.projectPath, projectPath))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone) };
  }
  const taskSettings = (task) => normalizeGitflowSettings(task.gitflow);
  function selectFinishMode(task, body) {
    const mode = body.mode ?? task.finishMode ?? "pr";
    if (!["pr", "local"].includes(mode)) throw new HttpError(400, "작업 반영 방식을 선택하세요.");
    if (mode === "local" && task.pull) throw new HttpError(409, "이미 PR이 있는 작업입니다. PR에서 병합을 완료하세요.", "task-pull");
    task.finishMode = mode;
    return mode;
  }
  const finishModeFor = (projectPath) => config.taskFinish?.[gitflowSettingsKey(projectPath)] === "local" ? "local" : "pr";
  async function settings(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const repo = await taskRepo(projectPath);
    return { projectPath: repo.top, settings: projectGitflowSettings(config, repo.top), finishMode: finishModeFor(repo.top) };
  }
  async function updateSettings(projectPath, body = {}) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    if (!body?.settings || typeof body.settings !== "object" || Array.isArray(body.settings))
      throw new HttpError(400, "GitFlow 설정을 입력하세요.", "gitflow-settings");
    const value = normalizeGitflowSettings(body.settings);
    if (body.finishMode !== undefined && !["pr", "local"].includes(body.finishMode)) throw new HttpError(400, "작업 반영 방식을 선택하세요.");
    const repo = await taskRepo(projectPath);
    for (const branch of [value.main, value.develop, ...[value.featurePrefix, value.hotfixPrefix, value.releasePrefix].map((prefix) => `${prefix}agenthub-check`)]) {
      try {
        await taskGit(repo.top, ["check-ref-format", "--branch", branch]);
        // --branch expands checkout shorthands such as @{-1}; settings must name
        // literal refs, so validate the full ref as well.
        await taskGit(repo.top, ["check-ref-format", `refs/heads/${branch}`]);
      }
      catch (error) {
        if (error.reason === "git-timeout") throw error;
        throw new HttpError(400, `Git 브랜치 이름이 올바르지 않습니다: ${branch}`, "gitflow-settings");
      }
    }
    return locked("gitflow-settings", async () => {
      const previous = config.gitflow;
      const previousFinish = config.taskFinish;
      config.gitflow = { ...previous, [gitflowSettingsKey(repo.top)]: value };
      if (body.finishMode) config.taskFinish = { ...previousFinish, [gitflowSettingsKey(repo.top)]: body.finishMode };
      try { await saveConfig(config); }
      catch (error) {
        if (previous === undefined) delete config.gitflow;
        else config.gitflow = previous;
        if (previousFinish === undefined) delete config.taskFinish;
        else config.taskFinish = previousFinish;
        throw error;
      }
      notify("tasks", { projectPath: repo.top });
      return { projectPath: repo.top, settings: clone(value), finishMode: finishModeFor(repo.top) };
    });
  }
  function branchOwner(common, branch) {
    return [...records.values()].find((task) => task.state !== "cleaned" && task.branch === branch && sameTaskPath(task.gitCommonDir, common));
  }
  async function workbranches(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const repo = await taskRepo(projectPath);
    const result = await listWorkbranches(projectPath);
    const flow = projectGitflowSettings(config, repo.top);
    return { ...result, branches: result.branches.map((branch) => {
      // 설정한 배포·개발 브랜치는 이름을 바꿨어도 작업 브랜치로 고를 수 없다.
      if (isGitflowBase(flow, branch.name)) return { ...branch, selectable: false, selectableForTask: false, selectableForSession: false, reason: `${flow.main}과 ${flow.develop}은 작업 브랜치로 선택할 수 없습니다.` };
      const owner = branchOwner(repo.common, branch.name);
      return { ...branch, taskId: owner?.id, taskState: owner?.state,
        selectableForTask: branch.selectable && !owner,
        selectableForSession: branch.selectable && (!owner || !["merged", "cleaned"].includes(owner.state)),
        ...(owner ? { reason: owner.state === "merged" ? "병합된 작업입니다. 작업 탭에서 먼저 정리하세요." : "이미 작업에 연결된 브랜치입니다. 세션을 추가할 수 있습니다." } : {}),
      };
    }) };
  }
  function shareFolder(dir, task) {
    for (const session of store.list()) {
      if (!sameTaskPath(session.cwd, dir)) continue;
      if (session.worktree) session.worktree.shared = true;
      if (task && (!session.taskId || session.taskId === task.id)) {
        session.taskId = task.id;
        if (!task.sessionIds.includes(session.id)) task.sessionIds.push(session.id);
      }
      store.touch?.(session);
      // Folder ownership must survive a restart as soon as branch selection succeeds.
      store.flush?.(session.id);
    }
  }
  async function createBranchSession(body) {
    if (body.chat) throw new HttpError(400, "일반 채팅에서는 작업 브랜치를 선택할 수 없습니다.");
    sessionService().checkSessionOptions(body);
    const project = projectService().ensureProject(body.projectPath);
    graphTabs?.resolve(project.path, body.tabId, body.connectFrom ?? body.createdBy);
    const repo = await taskRepo(project.path);
    const flow = projectGitflowSettings(config, repo.top);
    if (isGitflowBase(flow, body.workBranch)) throw new HttpError(409, `${flow.main}과 ${flow.develop}은 작업 브랜치로 선택할 수 없습니다.`, "workbranch-protected");
    return locked(repo.common, async () => {
      const candidates = await listWorkbranches(project.path);
      const candidate = candidates.branches.find((branch) => branch.name === body.workBranch);
      if (!candidate?.selectable) throw new HttpError(409, candidate?.reason ?? "선택한 작업 브랜치를 사용할 수 없습니다.", "workbranch-unavailable");
      const owner = branchOwner(repo.common, body.workBranch);
      if (owner) {
        assertActive(owner);
        assertIdle(owner);
        if (busy.has(owner.id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
        return (await attach(owner, body)).session;
      }
      const selected = await resolveWorkbranch(project.path, body.workBranch);
      const session = await sessionService().createSession({ ...body, project, isolate: false },
        { worktree: { dir: selected.dir, branch: selected.branch, shared: true } });
      shareFolder(selected.dir);
      notify("sessions", {});
      return summary(session);
    });
  }
  async function context(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    let valueSettings = projectGitflowSettings(config, projectPath);
    try {
      const repo = await taskRepo(projectPath);
      valueSettings = projectGitflowSettings(config, repo.top);
      const value = await gitflowContext(repo.top, undefined, valueSettings);
      return { ...value, settings: valueSettings, finishMode: finishModeFor(repo.top), mainInDevelop: !value.mainMissing, freshness: { state: value.state, checkedAt: value.checkedAt } };
    } catch (error) {
      return { state: "error", checkedAt: now(), mainSha: null, developSha: null, warnings: [error.message],
        settings: valueSettings, freshness: { state: "error", checkedAt: now(), message: error.message }, error: error.message, reason: error.reason };
    }
  }
  async function freshness(task) {
    try {
      const gitflow = taskSettings(task);
      const value = await gitflowContext(task.projectPath, task.remote, gitflow);
      const url = (await taskGit(task.projectPath, ["remote", "get-url", task.remote])).trim();
      if (remoteFingerprint(url) !== task.remoteFingerprint) throw new HttpError(409, "작업 생성 후 원격 주소가 바뀌었습니다. 기존 원격을 복원하세요.", "task-remote");
      const targetSha = task.targetBranch === gitflow.main ? value.mainSha : value.developSha ?? value.mainSha;
      const head = task.state === "cleaned" ? task.publishedHead
        : !task.inPlace && !fs.existsSync(task.cwd) ? await taskRef(task.projectPath, `refs/heads/${task.branch}`) : await assertTaskWorktree(task);
      const behind = !!head && !await taskAncestor(task.projectPath, targetSha, head);
      task.freshness = { ...value, targetSha, behind, state: behind || (task.type !== "hotfix" && value.mainMissing) ? "needs-update" : "current" };
      delete task.error;
      save(task);
      return value;
    } catch (error) {
      task.freshness = { state: "error", checkedAt: now(), message: error.message };
      recordError(task, error);
      save(task);
      throw error;
    }
  }
  function requireFresh(task) {
    if (task.type !== "hotfix" && task.freshness.mainMissing) {
      const { main, develop } = taskSettings(task);
      throw new HttpError(409, `${main}의 변경을 ${develop}에 먼저 반영하세요. 기능 브랜치에 ${main}을 직접 병합하지 않습니다.`, "gitflow-develop-behind");
    }
    if (task.freshness.behind) throw new HttpError(409, "기준 브랜치가 변경됐습니다. 최신화 버튼으로 반영한 뒤 작업을 마무리하세요.", "task-behind");
  }
  // 작업 폴더를 워크트리로 만든다. 이전 시도가 남긴 빈 폴더나 지워진 폴더의 워크트리 등록이 같은 경로를 막고 있으면 먼저 치운다.
  async function addWorktree(task, branchExists) {
    if (emptyDir(task.cwd)) fs.rmdirSync(task.cwd);
    if (!fs.existsSync(task.cwd) && await worktreeRegistered(task.projectPath, task.cwd))
      await taskGit(task.projectPath, ["worktree", "prune"], { write: true });
    await taskGit(task.projectPath, branchExists ? ["worktree", "add", task.cwd, task.branch]
      : ["worktree", "add", "-b", task.branch, task.cwd, task.baseCommit], { write: true });
  }
  // 새 작업 폴더를 만들다 실패하면 이번 시도가 만든 폴더·브랜치·작업 기록을 되돌린다. 다시 시도할 때 남은 브랜치나 폴더에 막히지 않게 한다.
  // 폴더가 작업 브랜치로 준비됐거나(체크아웃 뒤 훅 실패 등) 브랜치에 새 커밋이 생겼으면 지우지 않고 false를 돌려준다.
  async function discardFailedWorktree(task, root) {
    try {
      if (fs.existsSync(task.cwd)) {
        if (readTaskBranch(task.cwd) === task.branch && await worktreeRegistered(task.projectPath, task.cwd)) return false;
        if (!(await removeWorktreeDir(task.projectPath, task.cwd, { force: true, attempts: 5 })).removed) return false;
      } else await taskGit(task.projectPath, ["worktree", "prune"], { write: true });
      const head = await taskRef(task.projectPath, `refs/heads/${task.branch}`);
      if (head && head !== task.baseCommit) return false;
      if (head) await taskGit(task.projectPath, ["branch", "-D", task.branch], { write: true });
      if (root && emptyDir(root)) fs.rmdirSync(root);
      fs.rmSync(path.join(directory, `${task.id}.json`), { force: true }); records.delete(task.id);
      notify("tasks", { projectPath: task.projectPath, taskId: task.id });
      return true;
    } catch { return false; }
  }
  async function attach(task, body) {
    assertActive(task);
    graphTabs?.resolve(task.projectPath, body.tabId, body.connectFrom ?? body.createdBy);
    if (task.provisioning && (!fs.existsSync(task.cwd) || emptyDir(task.cwd))) {
      const expected = taskWorktreeLocation({ common: task.gitCommonDir, top: task.projectPath }, task.id, task.worktreeName);
      if (!sameTaskPath(expected.cwd, task.cwd)) throw new HttpError(409, "작업 폴더 경로를 확인할 수 없습니다.", "task-worktree");
      try { await addWorktree(task, !!await taskRef(task.projectPath, `refs/heads/${task.branch}`)); }
      catch (error) { throw worktreeFailure(error); }
    }
    await assertTaskWorktree(task);
    if (task.provisioning) { delete task.provisioning; delete task.error; save(task); }
    const session = await sessionService().createSession({ project: projectService().ensureProject(task.projectPath),
      tabId: body.tabId, connectFrom: body.connectFrom, createdBy: body.createdBy,
      title: body.title ?? task.title, roleName: body.roleName, orchestrator: body.orchestrator,
      role: body.role ?? task.role, agent: body.agent ?? task.agent ?? "claude",
      model: body.model ?? task.model, effort: body.effort ?? task.effort, permission: body.permission ?? task.permission },
    { worktree: { dir: task.cwd, branch: task.branch }, taskId: task.id });
    task.sessionIds.push(session.id);
    Object.assign(task, { agent: session.agent, model: session.model, effort: session.effort, permission: session.permission, role: session.role });
    save(task);
    notify("sessions", {});
    return { task: clone(task), session: summary(session) };
  }
  async function create(body) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 160) throw new HttpError(400, "작업 제목을 1~160자로 입력하세요.");
    const content = String(body.content ?? "").trim(), acceptance = String(body.acceptance ?? "").trim();
    if (body.start !== undefined && typeof body.start !== "boolean") throw new HttpError(400, "작업 시작 여부는 true 또는 false여야 합니다.");
    if (content.length > 12_000 || acceptance.length > 8_000) throw new HttpError(400, "작업 내용은 12,000자, 완료 기준은 8,000자까지 입력하세요.");
    const requestId = body.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)))
      throw new HttpError(400, "작업 생성 요청 ID가 올바르지 않습니다.");
    if (body.start === true && !requestId) throw new HttpError(400, "만들고 시작하려면 요청 ID가 필요합니다.");
    if (body.start === true && body.session === false) throw new HttpError(400, "세션 없이 작업을 시작할 수 없습니다.");
    const requestFingerprint = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId").sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
    const type = body.type ?? "feature";
    if (!["feature", "hotfix", "release"].includes(type)) throw new HttpError(400, "작업 유형이 올바르지 않습니다.");
    const selectedBranch = body.workBranch;
    if (selectedBranch !== undefined && (typeof selectedBranch !== "string" || !selectedBranch.trim())) throw new HttpError(400, "작업 브랜치를 선택하세요.");
    // worktree:false는 워크트리를 만들지 않고 원본 폴더를 새 작업 브랜치로 바꿔 그 자리에서 작업한다.
    const inPlace = body.worktree === false;
    if (inPlace && selectedBranch !== undefined) throw new HttpError(400, "원본 폴더에서 작업할 때는 새 작업 브랜치만 만들 수 있습니다.");
    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (!selectedBranch && type === "release" && !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version))
      throw new HttpError(400, "배포 버전을 입력하세요. 예: 1.2.0");
    // branchName은 유형 접두어 뒤에 붙는 이름, worktreeName은 <프로젝트>.agenthub/ 아래 작업 폴더 이름이다. 비우면 자동으로 정한다.
    const branchName = typeof body.branchName === "string" ? body.branchName.trim() : "";
    const worktreeName = typeof body.worktreeName === "string" ? body.worktreeName.trim() : "";
    if ((branchName || worktreeName) && selectedBranch !== undefined) throw new HttpError(400, "기존 작업 브랜치를 선택하면 브랜치와 작업 폴더 이름을 바꿀 수 없습니다.");
    if (branchName.length > 200) throw new HttpError(400, "브랜치 이름이 너무 깁니다.", "task-branch-name");
    if (worktreeName && inPlace) throw new HttpError(400, "원본 폴더에서 작업할 때는 작업 폴더 이름을 정할 수 없습니다.");
    if (worktreeName && !validTaskWorktreeName(worktreeName))
      throw new HttpError(400, "작업 폴더 이름은 80자 이내의 영문·한글·숫자와 . _ - 만 쓸 수 있습니다.", "task-worktree-name");
    sessionService().checkSessionOptions?.({ ...body, agent: body.agent ?? "claude" });
    const project = projectService().ensureProject(body.projectPath);
    graphTabs?.resolve(project.path, body.tabId, body.connectFrom ?? body.createdBy);
    const repo = await taskRepo(project.path);
    return locked(repo.common, async () => {
      const previous = requestId && [...records.values()].find((task) => task.requestId === requestId && sameTaskPath(task.projectPath, project.path));
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) throw new HttpError(409, "같은 요청의 작업 내용이 변경됐습니다. 이미 만든 작업을 먼저 확인하세요.", "task-request-changed");
        const session = store.get?.(previous.initialStart?.sessionId ?? previous.sessionIds.at(-1));
        return { task: clone(previous), ...(session ? { session: summary(session) } : {}), reused: true,
          ...(previous.initialStart?.state !== "sent" && body.start ? { startError: previous.initialStart?.error || "작업은 이미 생성됐습니다. 세션 기록을 확인한 뒤 이어서 요청하세요." } : {}) };
      }
      const gitflow = projectGitflowSettings(config, repo.top);
      const current = await gitflowContext(project.path, undefined, gitflow);
      if (type !== "hotfix" && current.mainMissing) throw new HttpError(409, `새 작업을 만들기 전에 ${gitflow.main}의 변경을 ${gitflow.develop}에 반영하세요.`, "gitflow-develop-behind");
      const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
      const flowBranches = gitflowBranches(type, gitflow);
      const prefix = flowBranches.prefix;
      const name = taskBranchName(gitflow, type, branchName);
      // 이름을 정하지 않으면 제목으로 만든 이름을 쓰고, 이미 있는 브랜치와 겹치면 -2, -3을 붙인다.
      const taken = async (candidate) => !!branchOwner(repo.common, candidate) || !!await taskRef(project.path, `refs/heads/${candidate}`)
        || !!await taskRef(project.path, `refs/remotes/${current.remote}/${candidate}`);
      let branch = selectedBranch ?? (name || type === "release" ? `${prefix}${name || version}` : null);
      if (!branch) {
        const slug = taskBranchSlug(title);
        for (let n = 1; n <= 50 && !branch; n++) {
          const candidate = `${prefix}${slug}${n > 1 ? `-${n}` : ""}`;
          if (!await taken(candidate)) branch = candidate;
        }
        branch ??= `${prefix}${slug}-${id.split("-")[0]}`;
      }
      try {
        await taskGit(project.path, ["check-ref-format", "--branch", branch]);
        if (branchName) await taskGit(project.path, ["check-ref-format", `refs/heads/${branch}`]);
      } catch (error) {
        if (!branchName || error.reason === "git-timeout") throw error;
        throw new HttpError(400, `Git 브랜치 이름이 올바르지 않습니다: ${branch}`, "task-branch-name");
      }
      if (branchName && isGitflowBase(gitflow, branch)) throw new HttpError(409, `${gitflow.main}과 ${gitflow.develop}은 작업 브랜치로 쓸 수 없습니다.`, "workbranch-protected");
      if (branchOwner(repo.common, branch)) throw new HttpError(409, "이미 작업에 연결된 브랜치입니다. 해당 작업에서 세션을 추가하세요.", "task-branch-exists");
      if (selectedBranch && isGitflowBase(gitflow, branch)) throw new HttpError(409, `${gitflow.main}과 ${gitflow.develop}은 작업 브랜치로 선택할 수 없습니다.`, "workbranch-protected");
      const branchType = branch.startsWith(gitflow.hotfixPrefix) ? "hotfix" : branch.startsWith(gitflow.releasePrefix) ? "release" : "feature";
      if (selectedBranch && branchType !== type) throw new HttpError(400, "선택한 브랜치와 작업 유형이 다릅니다.", "workbranch-type");
      if (!selectedBranch && (await taskRef(project.path, `refs/heads/${branch}`) || await taskRef(project.path, `refs/remotes/${current.remote}/${branch}`)))
        throw new HttpError(409, "해당 작업 브랜치가 이미 있습니다.", "task-branch-exists");
      const baseBranch = flowBranches.base;
      const baseCommit = type === "hotfix" ? current.mainSha : current.developSha ?? current.mainSha;
      const selected = selectedBranch ? await resolveWorkbranch(project.path, branch) : null;
      if (selected) assertIdle({ cwd: selected.dir });
      const previousBranch = inPlace ? await assertInPlaceReady(repo) : null;
      const location = inPlace ? { cwd: path.resolve(repo.top), root: null } : selected ? { cwd: selected.dir, root: path.dirname(selected.dir) } : taskWorktreeLocation(repo, id, worktreeName);
      // 이전 시도가 남긴 빈 폴더는 그대로 쓸 수 있으므로 막지 않는다.
      if (worktreeName && ((fs.existsSync(location.cwd) && !emptyDir(location.cwd)) || [...records.values()].some((other) => other.state !== "cleaned" && sameTaskPath(other.cwd, location.cwd))))
        throw new HttpError(409, `같은 이름의 작업 폴더가 이미 있습니다: ${worktreeName}`, "task-worktree-exists");
      const targetSha = type === "feature" ? current.developSha ?? current.mainSha : current.mainSha;
      const behind = !!selected && !await taskAncestor(project.path, targetSha, await taskRef(selected.dir, "HEAD"));
      // 기존 배포 준비 브랜치를 고르면 접두어 뒤 이름이 버전이다.
      const releaseVersion = version || (selectedBranch && branch.startsWith(gitflow.releasePrefix) ? branch.slice(gitflow.releasePrefix.length) : "");
      const task = { id, projectPath: project.path, title, content, acceptance, type, version: type === "release" ? releaseVersion || undefined : undefined,
        ...(requestId ? { requestId, requestFingerprint } : {}),
        finishMode: finishModeFor(repo.top),
        agent: body.agent ?? "claude", model: body.model, effort: body.effort, permission: body.permission, role: body.role,
        branch, baseBranch, targetBranch: flowBranches.target, baseCommit, gitflow: clone(gitflow),
        cwd: location.cwd, worktreeRoot: location.root, gitCommonDir: repo.common, ...(worktreeName ? { worktreeName } : {}),
        ownsWorktree: !inPlace && (!selected || selected.created), ownsBranch: !selected,
        ...(selected ? { selectedWorkBranch: true } : {}),
        ...(inPlace ? { inPlace: true, previousBranch } : {}),
        remote: current.remote, remoteFingerprint: remoteFingerprint((await taskGit(project.path, ["remote", "get-url", current.remote])).trim()),
        sessionIds: [], state: "working", pull: null, createdAt: now(), updatedAt: now(),
        freshness: { ...current, targetSha, behind, state: behind ? "needs-update" : current.state },
        needsDevelopSetup: !current.developSha };
      // Record intent before Git changes: retrying a lost creation response must
      // reuse this task even if the process died just after worktree creation.
      task.provisioning = true;
      save(task);
      if (inPlace) {
        // 실패하면 원본 폴더는 그대로이므로 작업 기록을 남기지 않는다.
        try { await taskGit(project.path, ["switch", "--no-guess", "-c", branch, baseCommit], { write: true }); }
        catch (error) {
          if (!error.outcomeUnknown && !await taskRef(project.path, `refs/heads/${branch}`)) {
            fs.rmSync(path.join(directory, `${id}.json`), { force: true }); records.delete(id);
          } else { task.error = `작업 브랜치 준비 결과를 확인하세요: ${error.message}`; save(task); }
          throw failure(error);
        }
        delete task.provisioning;
        save(task);
        if (body.session === false) return { task: clone(task) };
        try { return await attachAndStart(task, body); }
        catch (error) { task.error = `작업은 생성됐지만 세션을 만들지 못했습니다: ${error.message}`; save(task); throw failure(error); }
      }
      const createdRoot = !fs.existsSync(location.root);
      fs.mkdirSync(location.root, { recursive: true });
      try { if (!selected) await addWorktree(task, false); }
      catch (error) {
        const reported = worktreeFailure(error);
        if (error.outcomeUnknown || !await discardFailedWorktree(task, createdRoot && location.root)) {
          task.provisioning = true;
          task.error = `작업 폴더 준비를 완료하지 못했습니다. 상태를 확인한 뒤 새 세션을 연결하면 이어서 준비합니다: ${reported.message}`;
          save(task);
        }
        throw reported;
      }
      if (selected) shareFolder(selected.dir, task);
      delete task.provisioning;
      save(task);
      if (body.session === false) return { task: clone(task) };
      try { return await attachAndStart(task, body); }
      catch (error) { task.error = `작업은 생성됐지만 세션을 만들지 못했습니다: ${error.message}`; save(task); throw failure(error); }
    });
  }
  async function attachAndStart(task, body) {
    let result;
    try { result = await attach(task, body); }
    catch (error) {
      if (body.start !== true) throw error;
      task.initialStart = { state: "failed", error: `작업은 생성됐지만 세션을 만들지 못했습니다: ${error.message}` };
      save(task);
      return { task: clone(task), startError: task.initialStart.error };
    }
    if (body.start !== true) return result;
    const prompt = [task.title, task.content, task.acceptance ? `완료 기준:\n${task.acceptance}` : ""].filter(Boolean).join("\n\n");
    // Persist intent before dispatch: a lost response/restart must never send twice.
    task.initialStart = { state: "sending", sessionId: result.session.id, startedAt: now() };
    save(task);
    try {
      await sessionService().sendMessage(result.session.id, { prompt });
      task.initialStart.state = "sent";
    } catch (error) {
      task.initialStart.state = "failed";
      task.initialStart.error = `작업은 생성됐지만 시작 요청을 완료하지 못했습니다. 세션 기록을 확인하고 이어서 요청하세요: ${error.message}`;
    }
    save(task);
    return { ...result, task: clone(task), ...(task.initialStart.error ? { startError: task.initialStart.error } : {}) };
  }
  function mutate(id, action) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      assertIdle(task);
      busy.add(id);
      try { return await action(task); }
      catch (error) { recordError(task, error); save(task); throw failure(error); }
      finally { busy.delete(id); }
    });
  }
  // 작업 폴더가 이미 사라졌으면 원본 폴더에서 GitHub를 조회한다.
  const taskDir = (task) => fs.existsSync(task.cwd) ? task.cwd : task.projectPath;
  async function githubTarget(task) {
    const target = await github.target(taskDir(task), task.remote);
    if (target.name !== task.remote || (task.repo && task.repo.toLowerCase() !== target.repo.toLowerCase()))
      throw new HttpError(409, "작업에 연결된 GitHub 저장소가 바뀌었습니다.", "task-remote");
    task.repo = target.repo;
    save(task);
    return target;
  }
  async function findPull(task, target, state = "all") {
    const [owner] = target.repo.split("/");
    const raw = await github.api(target, "GET", `repos/${target.repo}/pulls?state=${state}&head=${encodeURIComponent(`${owner}:${task.branch}`)}&base=${encodeURIComponent(task.targetBranch)}&per_page=100`);
    if (raw.length > 1) throw new HttpError(409, "이 브랜치에 PR이 여러 개 있습니다. GitHub에서 연결할 PR을 확인하세요.", "task-pull-ambiguous");
    return raw.length ? normalizePull(raw[0], target.repo) : null;
  }
  function setPull(task, pull) {
    if (!pull || pull.headRefName !== task.branch || pull.baseRefName !== task.targetBranch)
      throw new HttpError(409, "작업과 PR의 브랜치가 일치하지 않습니다.", "task-pull");
    task.pull = pull;
    task.state = pull.state === "MERGED" ? "merged" : pull.state === "OPEN" ? "review" : "working";
    if (pull.state === "MERGED") task.mergedHead = pull.headRefOid;
    save(task);
  }
  async function externalWrite(task, action, expectedHead, call) {
    task.pendingAction = { action, expectedHead, startedAt: now() };
    save(task);
    try {
      const result = await call();
      delete task.pendingAction;
      save(task);
      return result;
    } catch (error) {
      if (!error.outcomeUnknown) delete task.pendingAction;
      else task.pendingAction.outcomeUnknown = true;
      save(task);
      throw error;
    }
  }
  async function ensureDevelop(task, target) {
    if (task.freshness.developSha) { task.needsDevelopSetup = false; return; }
    const sha = task.freshness.mainSha;
    try {
      await externalWrite(task, "develop", sha, () => github.api(target, "POST", `repos/${target.repo}/git/refs`,
        { ref: `refs/heads/${taskSettings(task).develop}`, sha }, { write: true }));
    } catch (error) {
      if (error.outcomeUnknown) throw error;
      // Another client may have created develop. Fetch and validate it; never update an existing ref.
      const current = await gitflowContext(task.projectPath, task.remote, taskSettings(task));
      if (!current.developSha) throw error;
    }
    await freshness(task);
    task.needsDevelopSetup = false;
    save(task);
  }
  async function review(id) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      const snapshot = await reviewSnapshot(task);
      await freshness(task);
      const localTargetHead = await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`);
      const localBehind = !!localTargetHead && !await taskAncestor(task.cwd, localTargetHead, snapshot.head);
      const commits = (await taskGit(task.cwd, ["log", "--format=%H%x00%s", "-n", "100", `${task.freshness.targetSha}..${snapshot.head}`]))
        .trim().split(/\r?\n/).filter(Boolean).map((line) => { const [hash, subject] = line.split("\0"); return { hash, subject }; });
      return { task: clone(task), ...snapshot, localTargetHead, localBehind, commits, finishMode: task.finishMode || "pr" };
    });
  }
  // 카드의 단계 표시용 가벼운 상태. 네트워크 없이 로컬 Git만 읽고 작업 기록은 바꾸지 않는다.
  async function status(id) {
    const task = get(id);
    const sessions = taskSessions(task);
    const result = { id: task.id, state: task.state, checkedAt: now(), sessions: sessions.length,
      running: sessions.filter((session) => runner.isRunning(session.id)).length,
      behind: !!task.freshness?.behind, head: null, shortHead: null, commits: null, dirty: null, pushed: null, folder: true };
    const count = async (cwd, range) => Number((await taskGit(cwd, ["rev-list", "--count", "--first-parent", "--no-merges", range])).trim());
    const finishedHead = task.mergedHead || task.completion?.sourceHead || task.publishedHead || null;
    const active = task.state === "working" || task.state === "review";
    if (!active || !fs.existsSync(task.cwd) || readTaskBranch(task.cwd) !== task.branch) {
      result.folder = active ? false : fs.existsSync(task.cwd);
      if (finishedHead) {
        result.head = finishedHead;
        result.shortHead = finishedHead.slice(0, 7);
        result.pushed = !!task.publishedHead || task.completion?.publishState === "done";
        try { if (task.baseCommit) result.commits = await count(task.projectPath, `${task.baseCommit}..${finishedHead}`); } catch { /* 정리 후 지워진 커밋은 개수를 모를 수 있다. */ }
      }
      return result;
    }
    const head = await taskRef(task.cwd, "HEAD");
    result.head = head;
    result.shortHead = head?.slice(0, 7) ?? null;
    result.dirty = parseStatus(await taskGit(task.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length;
    const target = task.freshness?.targetSha || task.baseCommit;
    if (head && target) result.commits = await count(task.cwd, `${target}..${head}`);
    const tracked = await taskRef(task.cwd, `refs/remotes/${task.remote}/${task.branch}`);
    result.pushed = !!head && (tracked === head || task.publishedHead === head);
    return result;
  }
  async function reviewDiff(id, file) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      const snapshot = await reviewSnapshot(task);
      if (!snapshot.files.some((changed) => changed.path === file)) throw new HttpError(404, "변경 목록에 없는 파일입니다.");
      return { diff: await fileDiff(task.cwd, file), head: snapshot.head, token: snapshot.token };
    });
  }
  async function commitReview(id, body = {}) {
    return mutate(id, async (task) => {
      assertActive(task);
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown");
      await assertTaskGitIdle(task);
      selectFinishMode(task, body);
      await externalWrite(task, "commit", await assertTaskWorktree(task), () => commitReviewedFiles(task, body));
      task.finishProgress = { ...task.finishProgress, commit: { at: now(), head: await assertTaskWorktree(task) } };
      save(task);
      return { task: clone(task) };
    });
  }
  async function finishLocal(task, body, head) {
    if (task.pull) throw new HttpError(409, "이미 PR이 있는 작업입니다. PR에서 병합을 완료하세요.", "task-pull");
    const targetRef = `refs/heads/${task.targetBranch}`;
    const beforeHead = await taskRef(task.projectPath, targetRef);
    if (body.reviewToken && body.expectedTargetHead !== beforeHead)
      throw new HttpError(409, "대상 브랜치가 변경됐습니다. 변경 목록을 다시 확인하세요.", "task-stale-review");
    if (beforeHead && !await taskAncestor(task.cwd, beforeHead, head))
      throw new HttpError(409, "대상 브랜치 변경을 먼저 반영하고 검증하세요.", "task-behind");
    if (!beforeHead) await taskGit(task.projectPath, ["branch", task.targetBranch, task.freshness.targetSha], { write: true });
    const targetHead = beforeHead || task.freshness.targetSha;
    const result = await externalWrite(task, "local-merge", head, async () => {
      const merged = await runGitNode({ command: { projectPath: task.projectPath, gitAction: "merge", branch: task.branch, targetBranch: task.targetBranch,
        expectedSourceHead: head, expectedTargetHead: targetHead, removeTemporaryTarget: true }, sessions: store.list(), isSessionBusy: sessionBusy });
      if (!merged.ok) throw new HttpError(409, merged.output || "병합하지 못했습니다.", merged.reason, { outcomeUnknown: !!merged.recoveryRequired });
      return merged;
    });
    task.finishMode = "local";
    task.mergedHead = head;
    task.state = "merged";
    task.completion = { kind: "local", sourceHead: head, beforeHead: targetHead, targetHead: result.afterHead, cwd: result.cwd, mergedAt: now(), publishState: body.push === true ? "pending" : "not-requested" };
    task.finishProgress = { ...task.finishProgress, merge: { at: now(), head: result.afterHead } };
    save(task);
    if (needsDevelop(task)) {
      // GitFlow처럼 main 반영에 이어 develop에도 병합한다. 충돌하면 main 반영은 그대로 두고 카드에서 다시 시도한다.
      task.developPending = true;
      try { await mergeLocalDevelop(task); }
      catch (error) {
        if (error.outcomeUnknown) throw error;
        recordError(task, error);
        save(task);
      }
    }
    if (body.push === true) await pushLocalTarget(task);
    return { task: clone(task), merge: result };
  }
  async function mergeLocalDevelop(task) {
    const { develop } = taskSettings(task);
    const source = task.mergedHead;
    let developHead = await taskRef(task.projectPath, `refs/heads/${develop}`);
    if (developHead && await taskAncestor(task.projectPath, source, developHead)) {
      Object.assign(task.completion, { developHead, developPublishState: task.completion.developPublishState ?? "done" });
      task.developPending = false;
      save(task);
      return;
    }
    if (!developHead) {
      // 로컬 develop이 없으면 원격 develop(없으면 방금 반영한 main)에서 만든다.
      developHead = task.freshness?.developSha || task.completion.targetHead;
      await taskGit(task.projectPath, ["branch", develop, developHead], { write: true });
    }
    const result = await externalWrite(task, "develop-merge", source, async () => {
      const merged = await runGitNode({ command: { projectPath: task.projectPath, gitAction: "merge", branch: task.branch, targetBranch: develop,
        expectedSourceHead: source, expectedTargetHead: developHead, removeTemporaryTarget: true }, sessions: store.list(), isSessionBusy: sessionBusy });
      if (!merged.ok) throw new HttpError(409, merged.reason === "git-merge-conflict"
        ? `${task.targetBranch}에는 반영했지만 ${develop}에 병합하다 충돌이 났습니다. 실행 전 상태로 되돌렸습니다. Git 탭에서 ${task.branch}를 ${develop}에 직접 병합해 충돌을 해결한 뒤 최신 확인을 누르세요.\n${merged.output || ""}`.trim()
        : merged.output || `${develop}에 병합하지 못했습니다.`, merged.reason, { outcomeUnknown: !!merged.recoveryRequired });
      return merged;
    });
    Object.assign(task.completion, { developHead: result.afterHead, developPublishState: task.completion.publishState === "not-requested" ? "not-requested" : "pending" });
    task.developPending = false;
    task.finishProgress = { ...task.finishProgress, develop: { at: now(), head: result.afterHead } };
    save(task);
  }
  // PR 방식에서는 main → develop 반영 PR을 연다. 같은 PR이 열려 있으면 다시 쓴다.
  async function openDevelopPull(task) {
    const { main, develop } = taskSettings(task);
    await freshness(task);
    const target = await githubTarget(task);
    if (!task.freshness.developSha) await ensureDevelop(task, target);
    if (!task.freshness.mainMissing) { task.developPending = false; save(task); return; }
    let pull = await findBackMerge(task, target);
    if (!pull) {
      const body = [`${main}에 반영한 ${task.type === "hotfix" ? "긴급 수정" : "배포 준비"}을 ${develop}에도 반영합니다.`,
        `AgentHub 작업: ${task.id}\n작업 브랜치: ${task.branch}${task.pull?.number ? `\n원래 PR: #${task.pull.number}` : ""}`].join("\n\n");
      try {
        const raw = await externalWrite(task, "develop-pull", task.freshness.mainSha, () => github.api(target, "POST", `repos/${target.repo}/pulls`,
          { title: `${main} → ${develop} 반영: ${task.title}`.slice(0, 256), body, head: main, base: develop }, { write: true }));
        pull = normalizePull(raw, target.repo);
      } catch (error) {
        if (error.outcomeUnknown) throw error;
        // 동시에 만든 경우 열린 PR을 다시 찾는다.
        pull = await findBackMerge(task, target);
        if (!pull) throw error;
      }
    }
    task.developPull = pull;
    task.developPending = true;
    save(task);
  }
  async function findBackMerge(task, target) {
    const { main, develop } = taskSettings(task);
    const [owner] = target.repo.split("/");
    const raw = await github.api(target, "GET", `repos/${target.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${main}`)}&base=${encodeURIComponent(develop)}&per_page=10`);
    return raw.length ? normalizePull(raw[0], target.repo) : null;
  }
  const mergeDevelop = (id) => mutate(id, async (task) => {
    if (!needsDevelop(task) || task.state !== "merged")
      throw new HttpError(409, "배포 브랜치에 반영을 마친 배포 준비·긴급 수정만 개발 브랜치에 반영할 수 있습니다.", "task-state");
    if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown");
    await assertTaskWorktree(task);
    if (task.completion?.kind === "local") await mergeLocalDevelop(task);
    else await openDevelopPull(task);
    delete task.error;
    save(task);
    return { task: clone(task) };
  });
  async function pushLocalTarget(task) {
    const completion = task.completion;
    if (task.state !== "merged" || completion?.kind !== "local") throw new HttpError(409, "로컬 반영을 먼저 완료하세요.");
    const fetchUrl = (await taskGit(task.projectPath, ["remote", "get-url", task.remote])).trim();
    const pushes = (await taskGit(task.projectPath, ["remote", "get-url", "--push", "--all", task.remote])).trim().split(/\r?\n/);
    if (remoteFingerprint(fetchUrl) !== task.remoteFingerprint || pushes.length !== 1 || pushes[0] !== fetchUrl)
      throw new HttpError(409, "작업 생성 때의 원격 주소와 푸시 주소가 다릅니다. Git 탭에서 원격 설정을 확인하세요.", "task-remote");
    const push = (cwd, sha, branch) => taskGit(cwd, [...githubCredentialArgs(), "-c", `remote.${task.remote}.mirror=false`, "push", "--no-follow-tags", "--recurse-submodules=no",
      "--", pushes[0], `${sha}:refs/heads/${branch}`], { write: true });
    if (completion.publishState !== "done") {
      // 푸시는 커밋만 보내므로 대상 브랜치를 체크아웃한 작업 폴더를 새로 만들지 않는다. 이미 연 폴더가 있으면 쉬고 있는지만 본다.
      const selected = (await listWorkbranches(task.projectPath, { forTarget: true })).branches.find((branch) => branch.name === task.targetBranch);
      if (selected?.cwd) {
        assertIdle({ cwd: selected.cwd });
        await assertTaskGitIdle({ cwd: selected.cwd });
      }
      if (await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`) !== completion.targetHead) throw new HttpError(409, "반영 후 대상 브랜치가 변경됐습니다. Git 탭에서 새 커밋을 검토한 뒤 푸시하세요.", "task-stale-head");
      completion.publishState = "pending";
      save(task);
      await externalWrite(task, "target-push", completion.targetHead, () => push(task.projectPath, completion.targetHead, task.targetBranch));
      completion.publishState = "done";
      task.finishProgress = { ...task.finishProgress, push: { at: now(), head: completion.targetHead } };
      save(task);
    }
    // 배포 준비·긴급 수정은 develop에 병합한 커밋도 함께 보낸다.
    if (completion.developHead && completion.developPublishState !== "done") {
      const { develop } = taskSettings(task);
      if (await taskRef(task.projectPath, `refs/heads/${develop}`) !== completion.developHead)
        throw new HttpError(409, `반영 후 ${develop} 브랜치가 변경됐습니다. Git 탭에서 새 커밋을 검토한 뒤 푸시하세요.`, "task-stale-head");
      completion.developPublishState = "pending";
      save(task);
      await externalWrite(task, "develop-push", completion.developHead, () => push(task.projectPath, completion.developHead, develop));
      completion.developPublishState = "done";
      save(task);
    }
  }
  const pushTarget = (id) => mutate(id, async (task) => {
    if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown");
    await pushLocalTarget(task); return { task: clone(task) };
  });
  async function finish(id, body = {}) {
    const description = String(body.description ?? get(id).description ?? "").trim();
    const verification = String(body.verification ?? get(id).verification ?? "").trim();
    if (description.length > 40_000 || verification.length > 10_000) throw new HttpError(400, "PR 설명 또는 검증 결과가 너무 깁니다.");
    return mutate(id, async (task) => {
      assertActive(task);
      const message = String(body.message ?? `${task.type === "feature" ? "feat" : task.type === "release" ? "chore" : "fix"}: ${task.title}`).trim();
      if ((!message && await taskDirty(task)) || message.length > 2000) throw new HttpError(400, "커밋 메시지를 1~2000자로 입력하세요.");
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 확인해야 합니다. 먼저 상태를 새로고침하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      const mode = body.mode ?? task.finishMode ?? "pr";
      if (!["pr", "local"].includes(mode)) throw new HttpError(400, "작업 반영 방식을 선택하세요.");
      if (mode === "local" && task.pull) throw new HttpError(409, "이미 PR이 있는 작업입니다. PR에서 병합을 완료하세요.", "task-pull");
      await assertTaskWorktree(task);
      await assertTaskGitIdle(task);
      if (body.reviewToken) {
        const snapshot = await reviewSnapshot(task);
        assertReviewed(snapshot, body);
        if (!snapshot.clean) throw new HttpError(409, "변경 검토에서 먼저 커밋을 완료하세요.", "task-dirty");
      }
      task.description = description;
      task.verification = verification;
      task.finishMode = mode;
      save(task);
      await freshness(task);
      requireFresh(task);
      if (mode === "local") {
        if (await taskDirty(task)) {
          await taskGit(task.cwd, ["add", "--all", "--", "."], { write: true });
          await externalWrite(task, "commit", await taskRef(task.cwd, "HEAD"), () => taskGit(task.cwd, ["commit", "-m", message], { write: true }));
        }
        return finishLocal(task, body, await assertTaskWorktree(task));
      }
      const target = await githubTarget(task);
      const existing = task.pull ? (await github.detail(task.cwd, task.pull.number, { remote: task.remote })).pull : await findPull(task, target);
      if (existing) {
        setPull(task, existing);
        if (existing.state === "MERGED") return { task: clone(task), pull: clone(existing) };
        if (existing.state === "CLOSED") throw new HttpError(409, "이 작업의 PR이 닫혔습니다. 새 작업에서 진행하세요.", "task-pull-closed");
      }
      if (!existing && !await taskDirty(task) && !(await taskGit(task.cwd, ["diff", "--name-only", task.freshness.targetSha, "HEAD"])).trim())
        throw new HttpError(409, "기준 브랜치와 다른 변경이 없습니다.", "task-empty");
      if (task.type !== "hotfix") { await ensureDevelop(task, target); requireFresh(task); }
      if (await taskDirty(task)) {
        await taskGit(task.cwd, ["add", "--all", "--", "."], { write: true });
        await externalWrite(task, "commit", await taskRef(task.cwd, "HEAD"), () => taskGit(task.cwd, ["commit", "-m", message], { write: true }));
      }
      const head = await assertTaskWorktree(task);
      await freshness(task);
      requireFresh(task);
      if (!existing && !(await taskGit(task.cwd, ["diff", "--name-only", task.freshness.targetSha, head])).trim())
        throw new HttpError(409, "기준 브랜치와 다른 변경이 없습니다.", "task-empty");
      const args = { remote: task.remote, repo: target.repo, branch: task.branch, head: task.branch, expectedHead: head };
      await externalWrite(task, "push", head, () => github.push(task.cwd, args));
      task.publishedHead = head;
      task.finishProgress = { ...task.finishProgress, push: { at: now(), head } };
      save(task);
      // Recheck the base after publication; a moving target must be integrated before opening the PR.
      await freshness(task);
      requireFresh(task);
      // 연결한 이슈는 PR이 기본 브랜치에 병합될 때 GitHub가 닫는다.
      const issueLine = task.issue && task.issue.repo.toLowerCase() === target.repo.toLowerCase() ? `\n관련 이슈: Closes #${task.issue.number}` : "";
      const text = [`## 작업\n${description || task.title}`, `## 검증\n${verification || "검증 결과를 입력하지 않았습니다."}`,
        `AgentHub 작업: ${task.id}\n유형: ${task.type}${task.version ? `\n버전: ${task.version}` : ""}\n기준: ${task.baseBranch} → ${task.targetBranch}${issueLine}`].join("\n\n");
      if (!existing) {
        try {
          const result = await externalWrite(task, "pull", head, () => github.create(task.cwd, { ...args, base: task.targetBranch, title: task.title, body: text }));
          setPull(task, result.pull);
        } catch (error) {
          if (error.reason !== "pull-exists") throw error;
          const pull = await findPull(task, target, "open");
          if (!pull) throw error;
          setPull(task, pull);
        }
      } else {
        if ((body.description !== undefined || body.verification !== undefined) && existing.body !== text) {
          await externalWrite(task, "pull-update", head, () => github.api(target, "PATCH", `repos/${target.repo}/pulls/${existing.number}`, { body: text }, { write: true }));
        }
        setPull(task, (await github.detail(task.cwd, existing.number, { remote: task.remote })).pull);
      }
      task.finishProgress = { ...task.finishProgress, pull: { at: now(), head, number: task.pull?.number } };
      task.verification = verification;
      delete task.error;
      save(task);
      return { task: clone(task), pull: clone(task.pull) };
    });
  }
  async function mergePull(id, body = {}) {
    return mutate(id, async (task) => {
      assertActive(task);
      if (!task.pull || task.pendingAction) throw new HttpError(409, "PR 상태를 먼저 확인하세요.", "task-pull");
      const snapshot = await reviewSnapshot(task);
      assertReviewed(snapshot, body);
      if (!snapshot.clean) throw new HttpError(409, "커밋하지 않은 변경이 있습니다. PR 업데이트를 먼저 완료하세요.", "task-dirty");
      await assertTaskGitIdle(task);
      await freshness(task);
      requireFresh(task);
      const target = await githubTarget(task);
      const pull = (await github.detail(task.cwd, task.pull.number, { remote: task.remote })).pull;
      setPull(task, pull);
      if (pull.state === "MERGED") return { task: clone(task) };
      if (pull.headRefOid !== snapshot.head || body.expectedPullHead !== pull.headRefOid)
        throw new HttpError(409, "PR 또는 작업 커밋이 변경됐습니다. PR을 업데이트하고 다시 검토하세요.", "task-stale-head");
      const result = await externalWrite(task, "merge-pull", snapshot.head, () => github.merge(task.cwd, pull.number,
        { remote: task.remote, repo: target.repo, sha: snapshot.head, method: body.method || "merge" }));
      setPull(task, result.pull);
      // main에 막 병합했으므로 develop 반영이 남았다. 최신 확인에서 다시 계산한다.
      if (needsDevelop(task) && task.state === "merged") task.developPending = true;
      task.finishProgress = { ...task.finishProgress, merge: { at: now(), head: snapshot.head } };
      save(task);
      return { task: clone(task), pull: clone(task.pull) };
    });
  }
  async function refresh(id) {
    return mutate(id, async (task) => {
      if (task.state === "cleaned") return { task: clone(task) };
      // A local commit can be reconciled without any GitHub authentication/network.
      if (task.pendingAction?.action === "commit") {
        await assertTaskGitIdle(task);
        const head = await assertTaskWorktree(task), pending = task.pendingAction;
        const resolved = head !== pending.expectedHead;
        task.lastRecovery = { ...pending, checkedAt: now(), result: resolved ? "confirmed" : "not-observed" };
        delete task.pendingAction;
        if (resolved) delete task.error;
        else task.error = "이전 커밋의 결과가 확인되지 않았습니다. 변경 검토에서 현재 파일과 커밋을 확인하세요.";
        save(task);
        return { task: clone(task) };
      }
      if (task.finishMode === "local") {
        // 병합을 마친 작업은 폴더가 이미 사라졌어도 대상 브랜치 기준으로 확인한다.
        if (task.state !== "merged" || fs.existsSync(task.cwd)) {
          await assertTaskWorktree(task);
          await assertTaskGitIdle(task);
        }
        if (task.state !== "merged") await freshness(task);
        const targetHead = await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`);
        const pending = task.pendingAction;
        if (pending) {
          let resolved = false;
          if (pending.action === "local-merge") {
            const target = (await listWorkbranches(task.projectPath, { forTarget: true })).branches.find((branch) => branch.name === task.targetBranch);
            if (target?.cwd) await assertTaskGitIdle({ cwd: target.cwd });
            resolved = !!targetHead && await taskAncestor(task.cwd, pending.expectedHead, targetHead);
            if (resolved) {
              task.state = "merged"; task.mergedHead = pending.expectedHead;
              task.completion = { kind: "local", sourceHead: pending.expectedHead, targetHead, cwd: target?.cwd, mergedAt: now(), publishState: "not-requested" };
            }
          } else if (pending.action === "target-push") {
            const remote = (await taskGit(task.projectPath, ["ls-remote", "--heads", task.remote, `refs/heads/${task.targetBranch}`])).trim().split(/\s+/)[0];
            resolved = remote === pending.expectedHead;
            task.completion.publishState = resolved ? "done" : "pending";
          } else if (pending.action === "develop-merge") {
            const developHead = await taskRef(task.projectPath, `refs/heads/${taskSettings(task).develop}`);
            resolved = !!developHead && await taskAncestor(task.cwd, pending.expectedHead, developHead);
            if (resolved) Object.assign(task.completion, { developHead, developPublishState: task.completion.publishState === "not-requested" ? "not-requested" : "pending" });
          } else if (pending.action === "develop-push") {
            const remote = (await taskGit(task.projectPath, ["ls-remote", "--heads", task.remote, `refs/heads/${taskSettings(task).develop}`])).trim().split(/\s+/)[0];
            resolved = remote === pending.expectedHead;
            task.completion.developPublishState = resolved ? "done" : "pending";
          } else if (pending.action === "commit") resolved = await taskRef(task.cwd, "HEAD") !== pending.expectedHead;
          else throw new HttpError(409, "이전 요청의 종류가 달라 자동 확인할 수 없습니다.", "task-outcome-unknown");
          task.lastRecovery = { ...pending, checkedAt: now(), result: resolved ? "confirmed" : "not-observed" };
          delete task.pendingAction;
        }
        delete task.error;
        if (task.state === "merged" && (!targetHead || !await taskAncestor(task.cwd, task.mergedHead, targetHead)))
          task.error = "대상 브랜치에서 반영한 커밋을 찾지 못했습니다. Git 탭에서 기록을 확인하세요.";
        if (needsDevelop(task) && task.state === "merged") {
          const developHead = await taskRef(task.projectPath, `refs/heads/${taskSettings(task).develop}`);
          task.developPending = !developHead || !await taskAncestor(task.cwd, task.mergedHead, developHead);
        }
        await syncIssue(task);
        save(task);
        return { task: clone(task) };
      }
      await freshness(task);
      const target = await githubTarget(task);
      const pull = task.pull ? (await github.detail(taskDir(task), task.pull.number, { remote: task.remote })).pull : await findPull(task, target);
      if (pull) setPull(task, pull);
      const pending = task.pendingAction;
      if (pending) {
        let resolved = false;
        let checked = false;
        if (pending.action === "pull") { resolved = !!pull && pull.headRefOid === pending.expectedHead; checked = true; }
        else if (pending.action === "pull-update") { resolved = !!pull && pull.body?.includes(task.description || task.title) && pull.body?.includes(task.verification || "검증 결과를 입력하지 않았습니다."); checked = true; }
        else if (pending.action === "merge-pull") { resolved = pull?.state === "MERGED"; checked = true; }
        else if (pending.action === "push") {
          resolved = await github.remoteHead(target, task.branch) === pending.expectedHead;
          checked = true;
          if (resolved) task.publishedHead = pending.expectedHead;
        } else if (pending.action === "develop") { resolved = !!task.freshness.developSha; checked = true; }
        else if (pending.action === "develop-pull") {
          const back = await findBackMerge(task, target);
          if (back) task.developPull = back;
          resolved = !!back || !task.freshness.mainMissing; checked = true;
        }
        else if (pending.action === "commit") {
          await assertTaskGitIdle(task);
          resolved = await taskRef(task.cwd, "HEAD") !== pending.expectedHead; checked = true;
        }
        if (checked) {
          task.lastRecovery = { ...pending, checkedAt: now(), result: resolved ? "confirmed" : "not-observed" };
          delete task.pendingAction;
          if (!resolved) task.error = "이전 요청의 결과가 현재 상태에서 확인되지 않았습니다. 작업 마무리를 다시 누르면 현재 상태를 재검증하고 재시도합니다.";
        }
      }
      if (needsDevelop(task) && task.state === "merged")
        task.developPending = !task.freshness.developSha || task.freshness.mainMissing;
      if (task.developPull?.state === "OPEN") {
        try { task.developPull = normalizePull(await github.api(target, "GET", `repos/${target.repo}/pulls/${task.developPull.number}`), target.repo); }
        catch (error) { if (error.reason === "github-timeout") throw error; }
      }
      await syncIssue(task, target);
      save(task);
      return { task: clone(task) };
    });
  }
  async function sync(id, body = {}) {
    return mutate(id, async (task) => {
      assertActive(task);
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      selectFinishMode(task, body);
      await assertTaskWorktree(task);
      await assertTaskGitIdle(task);
      if (await taskDirty(task)) throw new HttpError(409, "커밋하지 않은 변경이 있습니다. 커밋한 뒤 최신화하세요.", "task-dirty");
      await freshness(task);
      if (task.type !== "hotfix" && task.freshness.mainMissing) requireFresh(task);
      if (body.reviewToken) assertReviewed(await reviewSnapshot(task), body);
      const mode = body.mode ?? task.finishMode ?? "pr";
      const localTarget = mode === "local" ? await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`) : null;
      for (const sha of [...new Set([task.freshness.targetSha, localTarget].filter(Boolean))]) {
        const before = await assertTaskWorktree(task);
        if (await taskAncestor(task.cwd, sha, before)) continue;
        try { await externalWrite(task, "commit", before, () => taskGit(task.cwd, ["merge", "--no-edit", sha], { write: true })); }
        catch (error) {
          if (error.outcomeUnknown) throw error;
          let conflicts = [];
          try {
            const merging = await taskRef(task.cwd, "MERGE_HEAD");
            if (merging && merging !== sha) throw Error("다른 병합이 진행 중입니다.");
            if (merging) {
              conflicts = (await taskGit(task.cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
              await taskGit(task.cwd, ["merge", "--abort"], { write: true });
            }
            await assertTaskGitIdle(task);
            if (await assertTaskWorktree(task) !== before || await taskDirty(task)) throw Error("실행 전 상태로 복원하지 못했습니다.");
          } catch (restore) { throw new HttpError(409, `병합 복원을 확인하지 못했습니다. 작업 폴더를 확인하세요: ${restore.message}`, "task-recovery-required", { outcomeUnknown: true }); }
          // 충돌이 아닌 실패(잠금, 무시한 파일 덮어쓰기 등)는 충돌로 바꾸지 않고 원래 사유를 그대로 알린다.
          if (!conflicts.length && error.reason !== "git-conflict") throw error;
          const files = conflicts.length ? `\n충돌 파일: ${conflicts.slice(0, 10).join(", ")}${conflicts.length > 10 ? ` 외 ${conflicts.length - 10}개` : ""}` : "";
          throw new HttpError(409, `기준 브랜치와 같은 부분이 바뀌어 충돌이 났습니다. 반영을 취소하고 실행 전 상태로 복원했습니다.${files}`, "task-conflict",
            { hint: `세션에 ${task.targetBranch} 브랜치를 병합해 충돌을 해결하도록 요청한 뒤 다시 확인하세요.`, raw: error.raw || error.message, conflicts });
        }
      }
      await freshness(task);
      task.finishProgress = { ...task.finishProgress, sync: { at: now(), head: await assertTaskWorktree(task) } };
      save(task);
      return { task: clone(task) };
    });
  }
  // 시간 초과나 강제 종료로 병합·리베이스가 중간에 멈춰 작업이 막혔을 때 실행 전 상태로 되돌린다.
  // Git이 직접 취소하게 하며, 다른 Git 프로그램이 쓰고 있을 수 있는 잠금 파일(index.lock)은 지우지 않는다.
  const abortOperation = (id) => mutate(id, async (task) => {
    await assertTaskWorktree(task);
    const exists = async (marker) => fs.existsSync(path.resolve(task.cwd, (await taskGit(task.cwd, ["rev-parse", "--git-path", marker])).trim()));
    const command = await exists("rebase-merge") || await exists("rebase-apply") ? ["rebase", "--abort"]
      : await exists("MERGE_HEAD") ? ["merge", "--abort"]
      : await exists("CHERRY_PICK_HEAD") ? ["cherry-pick", "--abort"]
      : await exists("REVERT_HEAD") ? ["revert", "--abort"] : null;
    if (!command) throw new HttpError(409, "작업 폴더에 취소할 병합·리베이스가 없습니다. 최신 상태 확인을 눌러 주세요.", "task-git-idle");
    await taskGit(task.cwd, command, { write: true });
    await assertTaskGitIdle(task);
    delete task.error;
    save(task);
    return { task: clone(task), aborted: command[0] };
  });
  // 이슈 상태는 보조 정보다. 읽지 못해도 작업 최신 확인을 실패로 만들지 않는다.
  async function syncIssue(task, target) {
    if (!task.issue) return;
    try {
      target ??= await github.target(task.projectPath, task.remote);
      const raw = await github.api(target, "GET", `repos/${task.issue.repo}/issues/${task.issue.number}`);
      task.issue = issueSummary(normalizeIssue(raw, task.issue.repo));
    } catch (error) {
      task.issue = { ...task.issue, checkedAt: now(), error: error.message, errorReason: error.reason ?? "github-error" };
    }
  }
  // 작업에 이슈를 연결하거나 작업 내용으로 새 이슈를 만든다. 작업 기록만 바꾸므로 AI 세션이 실행 중이어도 막지 않는다.
  function annotate(id, action) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      if (records.get(id) !== task) throw new HttpError(404, "작업이 없습니다.", "task-missing");
      if (busy.has(id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
      if (task.state === "cleaned") throw new HttpError(409, "정리한 작업의 이슈 연결은 바꿀 수 없습니다.", "task-completed");
      busy.add(id);
      try { return await action(task); }
      catch (error) { throw failure(error); }
      finally { busy.delete(id); }
    });
  }
  const linkIssue = (id, body = {}) => annotate(id, async (task) => {
    const create = body.create === true;
    const number = String(body.number ?? "").trim().replace(/^#/, "");
    if (!create && !ISSUE_NUMBER.test(number)) throw new HttpError(400, "연결할 이슈 번호를 입력하세요.", "task-issue");
    const target = await github.target(task.projectPath, task.remote);
    if (target.name !== task.remote || (task.repo && task.repo.toLowerCase() !== target.repo.toLowerCase()))
      throw new HttpError(409, "작업에 연결된 GitHub 저장소가 바뀌었습니다.", "task-remote");
    let issue;
    if (create) {
      const title = String(body.title ?? task.title).trim();
      const text = [task.content, task.acceptance ? `## 완료 기준\n${task.acceptance}` : "", `AgentHub 작업 브랜치: ${task.branch} → ${task.targetBranch}`].filter(Boolean).join("\n\n");
      try {
        // 이슈 메타데이터에 작업 브랜치와 커밋이 남도록 작업 폴더에서 만든다.
        ({ issue } = await issues.create(fs.existsSync(task.cwd) ? task.cwd : task.projectPath, { title, body: text, assignee: await issues.viewer(target), remote: task.remote, repo: target.repo }));
      } catch (error) {
        // 같은 이슈를 두 번 만들지 않도록 자동으로 다시 시도하지 않는다.
        if (error.outcomeUnknown) throw new HttpError(504, "이슈를 만들었는지 확인하지 못했습니다. GitHub에서 이슈가 생겼는지 확인한 뒤 번호로 연결하세요.", "github-timeout");
        throw error;
      }
    } else {
      const other = [...records.values()].find((item) => item.id !== task.id && item.state !== "cleaned" && item.issue?.number === Number(number)
        && item.issue.repo.toLowerCase() === target.repo.toLowerCase());
      if (other) throw new HttpError(409, `이슈 #${number}은 이미 "${other.title}" 작업에 연결되어 있습니다.`, "task-issue-linked");
      let raw;
      try { raw = await github.api(target, "GET", `repos/${target.repo}/issues/${number}`); }
      catch (error) {
        if (/\bHTTP 404\b/.test(error.message)) throw new HttpError(404, `${target.repo}에 #${number} 이슈가 없습니다. 번호를 확인하세요.`, "task-issue");
        throw error;
      }
      if (raw.pull_request) throw new HttpError(400, `#${number}은 Pull Request입니다. 이슈 번호를 입력하세요.`, "task-issue");
      issue = normalizeIssue(raw, target.repo);
    }
    task.repo = target.repo;
    task.issue = issueSummary(issue);
    save(task);
    return { task: clone(task) };
  });
  const unlinkIssue = (id) => annotate(id, async (task) => {
    delete task.issue;
    save(task);
    return { task: clone(task) };
  });
  // 작업 브랜치의 내용이 이미 대상에 모두 들어 있는지 본다. 병합한 뒤 기준 브랜치를 받아온 병합 커밋만 더 붙었거나
  // 하나로 합치기(squash)로 병합했어도, 작업 브랜치를 대상에 다시 합친 결과가 대상과 같으면 정리해도 잃는 내용이 없다.
  async function contentInTarget(task, head, target) {
    if (!head || !target) return false;
    if (await taskAncestor(task.projectPath, head, target)) return true;
    try {
      const merged = (await taskGit(task.projectPath, ["merge-tree", "--write-tree", target, head])).trim().split(/\r?\n/)[0];
      return merged === (await taskGit(task.projectPath, ["rev-parse", `${target}^{tree}`])).trim();
    } catch (error) { if (error.reason === "git-timeout") throw error; return false; }
  }
  // 정리를 막은 커밋을 보여 준다. 무엇이 남았는지 보고 판단할 수 있게 한다.
  async function extraCommits(task, from, head) {
    if (!from || !head) return undefined;
    const lines = (await taskGit(task.projectPath, ["log", "--format=%h %s", "-n", "11", `${from}..${head}`]).catch(() => "")).trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return undefined;
    return `남은 커밋:\n${lines.slice(0, 10).join("\n")}${lines.length > 10 ? "\n…" : ""}`;
  }
  async function cleanup(id) {
    return mutate(id, async (task) => {
      if (task.state === "cleaned") {
        // 정리는 끝났지만 잠긴 파일 때문에 폴더가 남았으면 다시 누를 때 남은 폴더만 지운다.
        if (task.folderLeft) {
          await removeTaskWorktree(task);
          if (!task.folderLeft) delete task.cleanupWarning;
          save(task);
        }
        return { task: clone(task) };
      }
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      // 작업 폴더가 이미 사라졌으면 로컬 작업 브랜치로 병합 여부를 확인하고 남은 기록과 브랜치만 정리한다.
      const present = task.inPlace || fs.existsSync(task.cwd);
      const head = present ? await assertTaskWorktree(task) : await taskRef(task.projectPath, `refs/heads/${task.branch}`);
      if (!head) throw new HttpError(409, "작업 폴더와 로컬 작업 브랜치가 모두 없습니다. 작업 삭제로 기록을 지우세요.", "task-worktree");
      if (present) {
        await assertTaskGitIdle(task);
        if (await taskDirty(task)) throw new HttpError(409, "커밋하지 않은 변경이나 새 파일이 남아 있어 정리할 수 없습니다.", "task-dirty");
      }
      if (task.completion?.kind === "local") {
        const targetHead = await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`);
        if (task.state !== "merged" || !task.mergedHead || !targetHead || !await taskAncestor(task.projectPath, task.mergedHead, targetHead)
          || (head !== task.mergedHead && !await contentInTarget(task, head, targetHead)))
          throw new HttpError(409, "대상 브랜치에 반영되지 않은 커밋이 있어 정리할 수 없습니다.", "task-unmerged-commits", { hint: await extraCommits(task, task.mergedHead, head) });
        if (task.completion.publishState === "pending") throw new HttpError(409, "대상 브랜치 푸시를 먼저 완료하세요.", "task-unpushed");
        if (task.completion.developPublishState === "pending") throw new HttpError(409, `${taskSettings(task).develop} 브랜치 푸시를 먼저 완료하세요.`, "task-unpushed");
        if (["hotfix", "release"].includes(task.type)) {
          const developHead = await taskRef(task.projectPath, `refs/heads/${taskSettings(task).develop}`);
          if (!developHead || !await contentInTarget(task, head, developHead)) throw new HttpError(409, "개발 브랜치에도 작업을 반영한 뒤 정리하세요.", "gitflow-develop-pending");
        }
      } else {
      await freshness(task);
      const target = await githubTarget(task);
      // Git 탭에서 만든 PR처럼 작업에 아직 연결되지 않은 PR도 찾아 확인한다.
      const pull = task.pull ? (await github.detail(taskDir(task), task.pull.number, { remote: task.remote })).pull : await findPull(task, target);
      if (!pull) throw new HttpError(409, "PR 병합을 먼저 완료하세요.", "task-unmerged");
      setPull(task, pull);
      if (pull.state !== "MERGED") throw new HttpError(409, "병합이 확인된 작업만 정리할 수 있습니다.", "task-unmerged");
      if (!pull.headRefOid || (head !== pull.headRefOid && !await contentInTarget(task, head, task.freshness.targetSha)))
        throw new HttpError(409, "PR에 병합되지 않은 추가 커밋이 있어 정리할 수 없습니다.", "task-unmerged-commits", { hint: await extraCommits(task, pull.headRefOid, head) });
      const remoteHead = await github.remoteHead(target, task.branch);
      if (remoteHead && remoteHead !== head && remoteHead !== pull.headRefOid && !await contentInTarget(task, remoteHead, task.freshness.targetSha))
        throw new HttpError(409, "원격 작업 브랜치가 달라졌습니다. 추가 변경을 먼저 확인하세요.", "task-unpushed");
      if (["release", "hotfix"].includes(task.type) && (!task.freshness.developSha || task.freshness.mainMissing)) {
        task.developPending = true;
        const { main, develop } = taskSettings(task);
        throw new HttpError(409, `${main}의 배포·긴급 수정을 ${develop}에도 반영한 뒤 정리하세요.`, "gitflow-develop-pending");
      }
      }
      const expected = taskWorktreeLocation({ common: task.gitCommonDir, top: task.projectPath }, task.id, task.worktreeName);
      const ownsWorktree = task.ownsWorktree !== false;
      const ownsBranch = task.ownsBranch !== false;
      const expectedRoot = task.selectedWorkBranch ? task.worktreeRoot : expected.root;
      if (ownsWorktree && ((!task.selectedWorkBranch && !sameTaskPath(expected.cwd, task.cwd)) || !sameTaskPath(path.dirname(task.cwd), expectedRoot)))
        throw new HttpError(409, "AgentHub가 생성한 작업 폴더인지 확인할 수 없습니다.", "task-worktree");
      if (present ? await assertTaskWorktree(task) !== head || await taskDirty(task)
        : fs.existsSync(task.cwd) || await taskRef(task.projectPath, `refs/heads/${task.branch}`) !== head)
        throw new HttpError(409, "정리 확인 중 작업 폴더가 변경됐습니다. 다시 확인하세요.", "task-stale-head");
      if (task.inPlace) await leaveInPlaceBranch(task);
      else if (ownsWorktree) await removeTaskWorktree(task);
      else task.worktreePreserved = true;
      task.localBranchRemoved = false;
      // Compare-and-delete permits squash merges without using a destructive force flag.
      try {
        if (ownsBranch) {
          await taskGit(task.projectPath, ["update-ref", "-d", `refs/heads/${task.branch}`, head], { write: true });
          task.localBranchRemoved = true;
        }
      } catch (error) { task.cleanupWarning = `작업 폴더는 정리됐지만 로컬 브랜치는 남았습니다: ${error.message}`; }
      task.state = "cleaned";
      task.cleanedAt = now();
      task.developPending = false;
      save(task);
      return { task: clone(task) };
    });
  }
  // Windows에서는 편집기·탐색기·백신·남은 개발 서버가 파일을 잡고 있으면 git이 폴더를 다 지우지 못한다.
  // 잠시 기다리며 다시 시도하고, git 기록은 빠졌는데 폴더만 남았으면 정리는 끝내고 남은 폴더를 기록해 다시 지울 수 있게 한다.
  async function removeTaskWorktree(task) {
    const result = await removeWorktreeDir(task.projectPath, task.folderLeft ?? task.cwd);
    if (result.registered) throw new HttpError(409, `작업 폴더를 지우지 못했습니다. 그 폴더를 연 편집기·탐색기·터미널을 닫고 다시 정리하세요.\n${result.error?.message ?? ""}`.trim(), "task-worktree-locked");
    if (result.removed) { delete task.folderLeft; return; }
    task.folderLeft = task.cwd;
    task.cleanupWarning = `작업 폴더 일부가 남았습니다. 파일을 잡고 있는 프로그램을 닫은 뒤 정리를 다시 누르세요: ${task.cwd}`;
  }
  // 작업을 지운다. 연결된 세션을 멈추고 지운 뒤, AgentHub가 만든 작업 폴더를 지우고 작업 기록을 없앤다.
  // 원격 브랜치와 PR은 건드리지 않는다. deleteBranch면 이 작업이 만든 로컬 브랜치도 지운다.
  // force가 없으면 실행 중인 세션이나 커밋하지 않은 변경이 있을 때 멈추고 알린다.
  async function remove(id, { force = false, deleteBranch = false } = {}) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      if (records.get(id) !== task) throw new HttpError(404, "작업이 없습니다.", "task-missing");
      if (busy.has(id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
      const owned = store.list().filter((session) => session.taskId === id || task.sessionIds.includes(session.id));
      if (!force && owned.some((session) => runner.isRunning(session.id)))
        throw new HttpError(409, "이 작업에서 실행 중인 세션이 있습니다.", "running");
      busy.add(id);
      try {
        const live = task.state !== "cleaned";
        const ownsFolder = live && !task.inPlace && task.ownsWorktree !== false;
        const removeFolder = ownsFolder && fs.existsSync(task.cwd);
        if (removeFolder) {
          const expected = taskWorktreeLocation({ common: task.gitCommonDir, top: task.projectPath }, task.id, task.worktreeName);
          const expectedRoot = task.selectedWorkBranch ? task.worktreeRoot : expected.root;
          if ((!task.selectedWorkBranch && !sameTaskPath(expected.cwd, task.cwd)) || !sameTaskPath(path.dirname(task.cwd), expectedRoot))
            throw new HttpError(409, "AgentHub가 생성한 작업 폴더인지 확인할 수 없어 지우지 않았습니다.", "task-worktree");
          // 반쯤 지워져 Git 작업 폴더가 아니게 된 폴더는 변경 여부를 읽을 수 없으므로, 세션을 지우기 전에 강제 삭제 확인을 받는다.
          const dirty = await taskDirty(task).then((value) => value ? "작업 폴더에 커밋하지 않은 변경이나 새 파일이 있습니다." : null,
            () => "작업 폴더가 손상되어 커밋하지 않은 변경이 있는지 확인할 수 없습니다. 남은 파일을 확인한 뒤 강제로 지우세요.");
          if (!force && dirty) throw new HttpError(409, dirty, "task-dirty");
        }
        for (const session of owned) await sessionService().remove(session.id, { force: true });
        let warning;
        if (removeFolder) {
          // 막 멈춘 세션 프로세스가 파일을 잡고 있을 수 있어 잠시 기다리며 다시 시도한다.
          const result = await removeWorktreeDir(task.projectPath, task.cwd, { force });
          if (result.registered) throw new HttpError(409, `세션은 지웠지만 작업 폴더를 지우지 못했습니다. 그 폴더를 연 프로그램을 닫고 다시 삭제하세요.\n${result.error?.message ?? ""}`.trim(), "task-worktree-locked");
          if (!result.removed) warning = `작업 폴더 일부가 남았습니다. 파일을 잡고 있는 프로그램을 닫은 뒤 직접 지우세요: ${task.cwd}`;
        } else if (ownsFolder || task.folderLeft) {
          // 이미 사라진 폴더의 기록을 정리하고, 정리 뒤 남았던 폴더가 있으면 마저 지운다.
          const result = await removeWorktreeDir(task.projectPath, task.folderLeft ?? task.cwd, { force: true });
          if (!result.removed) warning = `작업 폴더 일부가 남았습니다. 직접 지우세요: ${task.folderLeft ?? task.cwd}`;
        }
        // 원본 폴더에서 한 작업은 브랜치를 남기더라도 원본 폴더를 작업 전 브랜치로 되돌린다.
        if (live && task.inPlace && readTaskBranch(task.cwd) === task.branch) {
          try { await leaveInPlaceBranch(task); }
          catch (error) { warning = `원본 폴더를 작업 전 브랜치로 되돌리지 못했습니다: ${error.message}`; }
        }
        let branchRemoved = false;
        if (deleteBranch && live && task.ownsBranch !== false && await taskRef(task.projectPath, `refs/heads/${task.branch}`)) {
          try {
            await taskGit(task.projectPath, ["branch", "-D", task.branch], { write: true });
            branchRemoved = true;
          } catch (error) { warning = `작업은 지웠지만 로컬 브랜치 ${task.branch}는 남았습니다: ${error.message}`; }
        }
        fs.rmSync(path.join(directory, `${id}.json`), { force: true });
        records.delete(id);
        notify("tasks", { projectPath: task.projectPath, taskId: id });
        return { ok: true, sessionIds: owned.map((session) => session.id), worktreeRemoved: removeFolder, branchRemoved, ...(warning ? { warning } : {}) };
      } finally { busy.delete(id); }
    });
  }
  // 작업을 그만둔다. 열린 PR을 닫고, 이 작업이 만든 원격 브랜치를 지우고, 연결된 이슈에서 내 담당을 뺀 뒤
  // 세션·작업 폴더·로컬 브랜치·작업 기록을 모두 지운다. 원격 처리에 실패하면 로컬은 그대로 두고 알린다.
  // 기존 브랜치를 골라 시작한 작업은 그 브랜치를 남긴다.
  async function abandon(id, { force = false } = {}) {
    const task = get(id);
    if (task.state === "merged" || task.state === "cleaned") throw new HttpError(409, "이미 반영한 작업은 그만둘 수 없습니다. 작업 삭제나 정리를 사용하세요.", "task-completed");
    if (busy.has(id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
    if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
    const owned = store.list().filter((session) => session.taskId === id || task.sessionIds.includes(session.id));
    if (!force && owned.some((session) => runner.isRunning(session.id))) throw new HttpError(409, "이 작업에서 실행 중인 세션이 있습니다.", "running");
    if (!force && !task.inPlace && task.ownsWorktree !== false && fs.existsSync(task.cwd) && await taskDirty(task))
      throw new HttpError(409, "작업 폴더에 커밋하지 않은 변경이나 새 파일이 있습니다.", "task-dirty");
    const remote = { pullClosed: null, remoteBranchRemoved: false, issueUnassigned: false };
    const warnings = [];
    await locked(task.gitCommonDir, async () => {
      busy.add(id);
      try {
        if (task.pull?.number && task.pull.state === "OPEN") {
          const target = await githubTarget(task);
          await github.close(task.projectPath, task.pull.number, { remote: task.remote, repo: target.repo });
          remote.pullClosed = task.pull.number;
          task.pull = { ...task.pull, state: "CLOSED" };
          save(task);
        }
        if (task.ownsBranch !== false && task.remote) {
          const url = (await taskGit(task.projectPath, ["remote", "get-url", task.remote])).trim();
          if (remoteFingerprint(url) !== task.remoteFingerprint) throw new HttpError(409, "작업 생성 후 원격 주소가 바뀌었습니다. 원격 브랜치는 Git 탭에서 직접 확인하세요.", "task-remote");
          const line = (await taskGit(task.projectPath, [...githubCredentialArgs(), "ls-remote", "--heads", "--", url, `refs/heads/${task.branch}`])).trim();
          const sha = line.split(/\s+/)[0];
          if (sha) {
            // 확인한 커밋일 때만 지운다. 그사이 누가 올렸으면 거절된다.
            await taskGit(task.projectPath, [...githubCredentialArgs(), "push", `--force-with-lease=refs/heads/${task.branch}:${sha}`, "--", url, `:refs/heads/${task.branch}`], { write: true });
            remote.remoteBranchRemoved = true;
          }
        }
      } catch (error) { recordError(task, error); save(task); throw failure(error); }
      finally { busy.delete(id); }
    });
    if (task.issue?.number) {
      try {
        const target = await githubTarget(task);
        const viewer = await issues.viewer(target);
        await github.api(target, "DELETE", `repos/${task.issue.repo}/issues/${task.issue.number}/assignees`, { assignees: [viewer] }, { write: true });
        remote.issueUnassigned = true;
      } catch (error) { warnings.push(`이슈 #${task.issue.number}의 담당을 해제하지 못했습니다: ${error.message}`); }
    }
    const result = await remove(id, { force: true, deleteBranch: true });
    if (result.warning) warnings.push(result.warning);
    return { ...result, ...remote, ...(warnings.length ? { warning: warnings.join("\n") } : {}) };
  }
  // 흐름의 작업 노드가 만든 작업에 그래프에 놓아 둔 세션을 연결한다. 대화 기록 확인은 호출하는 쪽이 한다.
  function adoptSession(id, session) {
    const task = get(id);
    assertActive(task);
    if (session.chat) throw new HttpError(400, "일반 채팅 세션은 작업에 연결할 수 없습니다.");
    if (session.taskId && session.taskId !== task.id) throw new HttpError(409, "다른 작업에 연결된 세션입니다. 새 세션을 연결하세요.", "task-session-owned");
    if (!sameTaskPath(session.projectPath, task.projectPath)) throw new HttpError(400, "같은 프로젝트의 세션만 작업에 연결할 수 있습니다.");
    if (busy.has(task.id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
    session.cwd = task.cwd;
    session.worktree = { dir: task.cwd, branch: task.branch };
    session.taskId = task.id;
    delete session.gitContext;
    if (!task.sessionIds.includes(session.id)) task.sessionIds.push(session.id);
    save(task);
    store.touch?.(session);
    store.flush?.(session.id);
    notify("sessions", {});
    return clone(task);
  }
  function replaceSession(previous, next) {
    for (const task of records.values()) {
      if (!task.sessionIds.includes(previous)) continue;
      task.sessionIds = [...new Set(task.sessionIds.map((id) => id === previous ? next : id))];
      save(task);
    }
  }
  function detachSession(id) {
    for (const task of records.values()) {
      if (!task.sessionIds.includes(id)) continue;
      task.sessionIds = task.sessionIds.filter((value) => value !== id);
      save(task);
    }
  }
  return { list, get: (id) => clone(get(id)), adoptSession, context, inPlaceStatus, settings, updateSettings, create, finish, review, status, reviewDiff, commitReview, mergePull, pushTarget, refresh, sync, cleanup, remove, abandon, assertSession, assertGitOperation, replaceSession, detachSession, workbranches, createBranchSession,
    mergeDevelop, linkIssue, unlinkIssue, abortOperation,
    addSession: (id, body = {}) => mutate(id, (task) => attach(task, body)) };
}

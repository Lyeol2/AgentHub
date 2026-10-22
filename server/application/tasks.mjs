import fs from "node:fs";
import path from "node:path";
import { withGitRepoLock } from "../git-lock.mjs";
import { githubPulls } from "../github.mjs";
import { GitHubIssues, githubIssues } from "../issues.mjs";
import { HttpError } from "./errors.mjs";
import { readJsonFile, writeJsonAtomic } from "../infrastructure/persistence/json-file.mjs";
import { taskGit, taskRepo, taskRef, assertTaskWorktree, readTaskBranch, taskDirty, sameTaskPath, insideTaskPath, assertTaskGitIdle } from "../tasks.mjs";
import { normalizeGitflowSettings, projectGitflowSettings, gitflowSettingsKey } from "../gitflow-settings.mjs";
import { createTaskWorkspace, changedFiles } from "./task-workspace.mjs";
import { createTaskProvisioning } from "./task-provisioning.mjs";
import { createTaskReviewService } from "./task-review-service.mjs";
import { createTaskPublication } from "./task-publication.mjs";
import { createTaskRecovery } from "./task-recovery.mjs";
import { createTaskIssueLinks } from "./task-issue-links.mjs";
import { createTaskCleanup } from "./task-cleanup.mjs";
export { taskBranchName } from "./task-domain.mjs";
import { clone, now, failure, recordError } from "./task-domain.mjs";

export function createTaskService({ dataDir, store, runner, sessions, projects, graphTabs, notify = () => {}, github = githubPulls,
  issues = github === githubPulls ? githubIssues : new GitHubIssues({ pulls: github }), config = {}, saveConfig = () => {}, workspaceTools = {} }) {
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
  // 원본 폴더에서 결과 확인, 작업 폴더 재사용, 유니티 Library 복사, 폴더 열기
  const workspace = createTaskWorkspace({ dataDir, config, saveConfig, store, runner, records, get, save, locked, notify, tools: workspaceTools });
  // 턴 실행 중이거나 백그라운드 작업 중이다(대체 runner는 isRunning만 있을 수 있다).
  const isBusy = (id) => runner.isBusy?.(id) ?? runner.isRunning(id);
  // 같은 폴더를 함께 쓰는 다른 작업(원본 폴더의 다른 작업 등)의 세션은 그 작업의 세션으로 센다.
  const otherTaskSession = (session, task) => session.taskId !== task.id && ["working", "review", "merged"].includes(records.get(session.taskId)?.state);
  function taskSessions(task) {
    return store.list().filter((session) => (task.id && session.taskId === task.id)
      || (!task.folderHandedTo && insideTaskPath(session.cwd, task.cwd) && !(task.id && task.inPlace && otherTaskSession(session, task))));
  }
  function assertIdle(task, except) {
    if (taskSessions(task).some((session) => session.id !== except && isBusy(session.id)))
      throw new HttpError(409, "이 작업 폴더에서 실행 중인 세션을 먼저 중지하세요.", "running");
  }
  // 원본 폴더는 작업 여러 개가 함께 쓸 수 있다. 폴더가 지금 있는 브랜치의 작업만 진행하고 나머지는 전환을 기다린다.
  const inPlaceTasks = (common) => [...records.values()].filter((task) => task.inPlace && task.state !== "cleaned" && sameTaskPath(task.gitCommonDir, common));
  // 원본 폴더의 브랜치를 바꿔도 되는지 확인하고 지금 브랜치 이름을 돌려준다.
  async function assertInPlaceReady(repo, { switching = false } = {}) {
    const cwd = path.resolve(repo.top);
    for (const other of inPlaceTasks(repo.common)) {
      if (busy.has(other.id)) throw new HttpError(409, `"${other.title}" 작업의 Git 처리가 진행 중입니다.`, "task-busy");
      if (other.pendingAction) throw new HttpError(409, `"${other.title}" 작업에서 이전 요청의 결과를 먼저 확인하세요.`, "task-outcome-unknown");
    }
    const preview = workspace.previewActive(repo.common);
    if (preview) throw new HttpError(409, `원본 폴더에서 "${preview.title}" 작업 결과를 확인하고 있습니다. 확인을 끝낸 뒤 진행하거나 워크트리를 만들어 진행하세요.`, "task-in-place");
    // 저장소 하위 폴더를 프로젝트로 등록한 세션도 원본 폴더에서 일하는 세션이다.
    if (store.list().some((session) => isBusy(session.id) && insideTaskPath(session.cwd, cwd)))
      throw new HttpError(409, "이 작업 폴더에서 실행 중인 세션을 먼저 중지하세요.", "running");
    await assertTaskGitIdle({ cwd });
    if (await taskDirty({ cwd })) throw new HttpError(409, switching ? "원본 폴더에 커밋하지 않은 변경이 있습니다. 지금 진행 중인 작업에서 커밋한 뒤 전환하세요."
      : "원본 폴더에 커밋하지 않은 변경이 있습니다. 커밋하거나 워크트리를 만들어 진행하세요.", "task-dirty", { hint: `바뀐 파일:\n${(await changedFiles(cwd)).join("\n")}` });
    const current = (await taskGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() || null;
    // 지금 브랜치가 다른 작업의 것이면 그 작업이 돌아갈 브랜치를 이어받는다. 정리할 때 남의 작업 브랜치로 돌아가지 않게 한다.
    const owner = current && branchOwner(repo.common, current);
    return owner ? (owner.previousBranch && !branchOwner(repo.common, owner.previousBranch) ? owner.previousBranch : null) : current;
  }
  // 원본 폴더에서 지금 진행 중인 작업(폴더가 그 작업 브랜치에 있다)
  const activeInPlace = (common) => inPlaceTasks(common).find((task) => fs.existsSync(task.cwd) && readTaskBranch(task.cwd) === task.branch);
  // 새 작업을 원본 폴더에서 바로 시작할 수 있는지 미리 본다. 쓸 수 없으면 화면이 워크트리로 진행할지 묻는다.
  // 다른 작업이 원본 폴더에서 진행 중이면 그 작업은 전환을 기다리게 되므로 화면에 알린다.
  const IN_PLACE_BUSY = ["task-in-place", "running", "task-dirty", "task-git-operation", "task-busy", "task-outcome-unknown"];
  // 정리할 때 원본 폴더를 작업 전 브랜치(없으면 PR 대상 브랜치)로 되돌려 작업 브랜치를 지울 수 있게 한다.
  // 이어받은 워크트리는 대상 브랜치를 차지하지 않도록 작업 전 브랜치가 없으면 커밋에 그대로 둔다.
  async function leaveInPlaceBranch(task) {
    // 이미 선택한 브랜치에 있던 원본 폴더는 작업을 정리해도 원래 체크아웃을 유지한다.
    if (task.inPlace && task.selectedWorkBranch && task.previousBranch === task.branch) return;
    for (const branch of task.inPlace ? [task.previousBranch, task.targetBranch] : [task.previousBranch]) {
      if (!branch || branch === task.branch || !await taskRef(task.projectPath, `refs/heads/${branch}`)) continue;
      try { await taskGit(task.cwd, ["switch", "--no-guess", branch], { write: true }); return; }
      catch (error) { if (error.outcomeUnknown) throw error; }
    }
    await taskGit(task.cwd, ["switch", "--detach", "HEAD"], { write: true });
  }
  // 기존 워크트리를 고른 새 작업에 폴더를 넘긴 병합된 작업은 그 폴더를 더 이상 자기 폴더로 보지 않는다.
  const hasFolder = (task) => !task.folderHandedTo && fs.existsSync(task.cwd);
  // 정리하지 않은 작업 중 이 작업 폴더를 쓰는 작업
  const folderOwner = (cwd, common) => [...records.values()].find((task) => task.state !== "cleaned" && !task.folderHandedTo
    && sameTaskPath(task.gitCommonDir, common) && sameTaskPath(task.cwd, cwd));
  // 고른 워크트리를 새 작업 브랜치로 바꿔도 되는지 확인한다. 병합까지 마친 작업의 폴더는 이어받을 수 있다.
  async function assertWorktreeReusable(repo, cwd) {
    const owner = folderOwner(cwd, repo.common);
    if (owner && owner.state !== "merged")
      throw new HttpError(409, `이 워크트리는 "${owner.title}" 작업에서 쓰고 있습니다. 그 작업에서 세션을 추가하거나 병합한 뒤 고르세요.`, "worktree-owned");
    if (store.list().some((session) => isBusy(session.id) && insideTaskPath(session.cwd, cwd)))
      throw new HttpError(409, "이 작업 폴더에서 실행 중인 세션을 먼저 중지하세요.", "running");
    await assertTaskGitIdle({ cwd });
    if (await taskDirty({ cwd })) throw new HttpError(409, "고른 워크트리에 커밋하지 않은 변경이 있습니다. 커밋하거나 정리한 뒤 고르세요.", "task-dirty");
    return owner;
  }
  const sessionBusy = (session) => isBusy(typeof session === "string" ? session : session.id);
  function assertActive(task) {
    if (["merged", "cleaned"].includes(task.state)) throw new HttpError(409, "병합이 완료된 작업입니다. 새 작업에서 이어서 진행하세요.", "task-completed");
  }
  function assertSession(session) {
    if (!session.taskId) {
      if (session.worktree) {
        if (!sameTaskPath(session.cwd, session.worktree.dir) || readTaskBranch(session.cwd) !== session.worktree.branch)
          throw new HttpError(409, "선택한 작업 브랜치의 폴더 또는 브랜치가 바뀌었습니다.", "workbranch-changed");
      }
      return;
    }
    const task = get(session.taskId);
    assertActive(task);
    if (busy.has(task.id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
    if (offBranch(task) && task.sessionIds.includes(session.id)) {
      const active = activeInPlace(task.gitCommonDir);
      throw new HttpError(409, `원본 폴더가 ${active ? `"${active.title}" 작업` : `${readTaskBranch(task.cwd) || "다른"} 브랜치`}에 있어 이 작업을 진행할 수 없습니다. 작업 탭에서 이 작업으로 전환하세요.`, "task-parked");
    }
    if (!task.sessionIds.includes(session.id) || !sameTaskPath(task.cwd, session.cwd) || !sameTaskPath(task.cwd, session.worktree?.dir)
      || readTaskBranch(task.cwd) !== task.branch)
      throw new HttpError(409, "작업 폴더 또는 브랜치가 바뀌었습니다. 작업 탭에서 확인하세요.", "task-worktree");
    // 같은 작업의 다른 세션이 실행 중이어도 함께 실행한다. Git을 바꾸는 작업 동작(마무리·정리 등)만 모두 멈춘 뒤 한다.
  }
  // 이 세션과 같은 작업 폴더에서 실행 중인 다른 세션 수. 함께 실행하면 같은 파일을 고칠 수 있어 화면에 알린다.
  function concurrentSessions(session) {
    if (session.chat) return 0;
    const task = session.taskId ? records.get(session.taskId) : null;
    const scope = task && task.state !== "cleaned" ? task : session.worktree ? { cwd: session.cwd } : null;
    return scope ? taskSessions(scope).filter((other) => other.id !== session.id && runner.isRunning(other.id)).length : 0;
  }
  async function assertGitOperation(cwd, action) {
    for (const task of records.values()) {
      if (!sameTaskPath(task.cwd, cwd) || task.state === "cleaned") continue;
      if (busy.has(task.id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
      // 원본 폴더가 이미 다른 브랜치로 옮겨졌으면 이 작업은 그 폴더를 쓰고 있지 않다. 작업 카드에서 따로 알린다.
      if (offBranch(task)) continue;
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
  // 원본 폴더에서 한 작업인데 원본 폴더가 다른 브랜치로 옮겨졌는지(작업 브랜치를 벗어났는지) 본다.
  const offBranch = (task) => !!task.inPlace && task.state !== "cleaned" && readTaskBranch(task.cwd) !== task.branch;
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
  // Domain factories share one record/lock/workspace policy. Cross-domain callbacks
  // resolve lazily so recovery and publication use the same persisted task objects.
  const taskContext = {
    IN_PLACE_BUSY,
    activeInPlace,
    assertActive,
    assertIdle,
    assertInPlaceReady,
    assertWorktreeReusable,
    backedUp: (...args) => backedUp(...args),
    branchOwner,
    busy,
    config,
    developBehindHint: (...args) => developBehindHint(...args),
    directory,
    externalWrite: (...args) => externalWrite(...args),
    findBackMerge: (...args) => findBackMerge(...args),
    findPull: (...args) => findPull(...args),
    finishModeFor,
    folderOwner,
    freshness: (...args) => freshness(...args),
    get,
    github,
    githubTarget: (...args) => githubTarget(...args),
    graphTabs,
    hasFolder,
    inPlaceTasks,
    isBusy,
    issues,
    leaveInPlaceBranch,
    locked,
    mutate,
    notify,
    offBranch,
    projectService,
    records,
    requireFresh: (...args) => requireFresh(...args),
    runner,
    save,
    selectFinishMode,
    sessionBusy,
    sessionService,
    setPull: (...args) => setPull(...args),
    store,
    syncIssue: (...args) => syncIssue(...args),
    taskDir: (...args) => taskDir(...args),
    taskSessions,
    taskSettings,
    workspace,
  };
  const { inPlaceStatus, workbranches, createBranchSession, activate, attach, create } = createTaskProvisioning(taskContext);
  const { context, freshness, developBehindHint, requireFresh, review, status, reviewDiff, commitReview, recheck, sync, abortOperation } = createTaskReviewService(taskContext);
  const { taskDir, githubTarget, findPull, setPull, externalWrite, findBackMerge, mergeDevelop, backedUp, backup, pushTarget, finish, mergePull } = createTaskPublication(taskContext);
  const { refresh } = createTaskRecovery(taskContext);
  const { syncIssue, linkIssue, unlinkIssue } = createTaskIssueLinks(taskContext);
  const { cleanup, remove, abandon } = createTaskCleanup(taskContext);
  return { list, get: (id) => clone(get(id)), adoptSession, context, inPlaceStatus, settings, updateSettings, create, activate, finish, review, status, reviewDiff, commitReview, mergePull, pushTarget, backup, refresh, recheck, sync, cleanup, remove, abandon, assertSession, assertGitOperation, replaceSession, detachSession, workbranches, createBranchSession,
    mergeDevelop, linkIssue, unlinkIssue, abortOperation,
    workspace: (projectPath, options) => workspace.info(projectPath, options), updateWorkspace: (projectPath, body) => workspace.updateSettings(projectPath, body),
    removeReuse: (projectPath, name) => workspace.removeReuse(projectPath, name), previewStatus: (projectPath) => workspace.previewStatus(projectPath),
    startPreview: (id) => workspace.startPreview(id), endPreview: (projectPath) => workspace.endPreview(projectPath), openTask: (id, target) => workspace.open(id, target),
    concurrentSessions,
    // 다른 세션이 실행 중이어도 세션을 더할 수 있다. 작업의 Git 처리 중에는 기다리지 않고 거절한다.
    addSession: (id, body = {}) => {
      const task = get(id);
      return locked(task.gitCommonDir, async () => {
        if (busy.has(id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
        busy.add(id);
        try { return await attach(task, body); }
        catch (error) { recordError(task, error); save(task); throw failure(error); }
        finally { busy.delete(id); }
      });
    } };
}

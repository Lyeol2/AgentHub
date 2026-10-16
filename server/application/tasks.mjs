import fs from "node:fs";
import path from "node:path";
import { withGitRepoLock } from "../git-lock.mjs";
import { createHash, randomBytes } from "node:crypto";
import { githubPulls, normalizePull } from "../github.mjs";
import { summary } from "../store.mjs";
import { listWorkbranches, resolveWorkbranch } from "../workbranches.mjs";
import { HttpError } from "./errors.mjs";
import { readJsonFile, writeJsonAtomic } from "../infrastructure/persistence/json-file.mjs";
import { taskGit, taskRepo, taskRef, taskAncestor, gitflowContext, assertTaskWorktree, readTaskBranch,
  taskDirty, taskWorktreeLocation, sameTaskPath, insideTaskPath, assertTaskGitIdle } from "../tasks.mjs";
import { normalizeGitflowSettings, projectGitflowSettings, gitflowSettingsKey } from "../gitflow-settings.mjs";

// 설정한 배포·개발 브랜치인지(대소문자를 구분한다)
const isGitflowBase = (flow, branch) => branch === flow.main || branch === flow.develop;

const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const remoteFingerprint = (value) => createHash("sha256").update(value).digest("hex");
const failure = (error) => error instanceof HttpError ? error : new HttpError(error.status ?? 409, error.message, error.reason ?? "task-error", { outcomeUnknown: !!error.outcomeUnknown });

export function createTaskService({ dataDir, store, runner, sessions, projects, notify = () => {}, github = githubPulls,
  config = {}, saveConfig = () => {} }) {
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
    const current = previous.catch(() => {}).then(() => key === "gitflow-settings" ? action() : withGitRepoLock(key, action));
    queue.set(key, current);
    try { return await current; }
    finally { if (queue.get(key) === current) queue.delete(key); }
  }
  function taskSessions(task) {
    return store.list().filter((session) => (task.id && session.taskId === task.id) || sameTaskPath(session.cwd, task.cwd));
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
  // 정리할 때 원본 폴더를 작업 전 브랜치(없으면 PR 대상 브랜치)로 되돌려 작업 브랜치를 지울 수 있게 한다.
  async function leaveInPlaceBranch(task) {
    for (const branch of [task.previousBranch, task.targetBranch]) {
      if (!branch || branch === task.branch || !await taskRef(task.projectPath, `refs/heads/${branch}`)) continue;
      try { await taskGit(task.cwd, ["switch", "--no-guess", branch], { write: true }); return; }
      catch (error) { if (error.outcomeUnknown) throw error; }
    }
    await taskGit(task.cwd, ["switch", "--detach", "HEAD"], { write: true });
  }
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
  function list(projectPath) {
    return { tasks: [...records.values()].filter((task) => !projectPath || sameTaskPath(task.projectPath, projectPath))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone) };
  }
  const taskSettings = (task) => normalizeGitflowSettings(task.gitflow);
  async function settings(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const repo = await taskRepo(projectPath);
    return { projectPath: repo.top, settings: projectGitflowSettings(config, repo.top) };
  }
  async function updateSettings(projectPath, body = {}) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    if (!body?.settings || typeof body.settings !== "object" || Array.isArray(body.settings))
      throw new HttpError(400, "GitFlow 설정을 입력하세요.", "gitflow-settings");
    const value = normalizeGitflowSettings(body.settings);
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
      config.gitflow = { ...previous, [gitflowSettingsKey(repo.top)]: value };
      try { await saveConfig(config); }
      catch (error) {
        if (previous === undefined) delete config.gitflow;
        else config.gitflow = previous;
        throw error;
      }
      notify("tasks", { projectPath: repo.top });
      return { projectPath: repo.top, settings: clone(value) };
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
      return { ...value, settings: valueSettings, mainInDevelop: !value.mainMissing, freshness: { state: value.state, checkedAt: value.checkedAt } };
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
      const head = task.state === "cleaned" ? task.publishedHead : await assertTaskWorktree(task);
      const behind = !!head && !await taskAncestor(task.projectPath, targetSha, head);
      task.freshness = { ...value, targetSha, behind, state: behind || (task.type !== "hotfix" && value.mainMissing) ? "needs-update" : "current" };
      delete task.error;
      save(task);
      return value;
    } catch (error) {
      task.freshness = { state: "error", checkedAt: now(), message: error.message };
      task.error = error.message;
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
  async function attach(task, body) {
    assertActive(task);
    if (task.provisioning && !fs.existsSync(task.cwd)) {
      const expected = taskWorktreeLocation({ common: task.gitCommonDir, top: task.projectPath }, task.id);
      if (!sameTaskPath(expected.cwd, task.cwd)) throw new HttpError(409, "작업 폴더 경로를 확인할 수 없습니다.", "task-worktree");
      const branch = await taskRef(task.projectPath, `refs/heads/${task.branch}`);
      if (branch) await taskGit(task.projectPath, ["worktree", "add", task.cwd, task.branch], { write: true });
      else await taskGit(task.projectPath, ["worktree", "add", "-b", task.branch, task.cwd, task.baseCommit], { write: true });
    }
    await assertTaskWorktree(task);
    if (task.provisioning) { delete task.provisioning; delete task.error; save(task); }
    const session = await sessionService().createSession({ project: projectService().ensureProject(task.projectPath),
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
    sessionService().checkSessionOptions?.({ ...body, agent: body.agent ?? "claude" });
    const project = projectService().ensureProject(body.projectPath);
    const repo = await taskRepo(project.path);
    return locked(repo.common, async () => {
      const gitflow = projectGitflowSettings(config, repo.top);
      const current = await gitflowContext(project.path, undefined, gitflow);
      if (type !== "hotfix" && current.mainMissing) throw new HttpError(409, `새 작업을 만들기 전에 ${gitflow.main}의 변경을 ${gitflow.develop}에 반영하세요.`, "gitflow-develop-behind");
      const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
      const slug = title.normalize("NFKC").replace(/[^A-Za-z0-9가-힣_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "work";
      const branch = selectedBranch ?? `${gitflow[`${type}Prefix`]}${type === "release" ? version : `${id}-${slug}`}`;
      await taskGit(project.path, ["check-ref-format", "--branch", branch]);
      if (branchOwner(repo.common, branch)) throw new HttpError(409, "이미 작업에 연결된 브랜치입니다. 해당 작업에서 세션을 추가하세요.", "task-branch-exists");
      if (selectedBranch && isGitflowBase(gitflow, branch)) throw new HttpError(409, `${gitflow.main}과 ${gitflow.develop}은 작업 브랜치로 선택할 수 없습니다.`, "workbranch-protected");
      const branchType = branch.startsWith(gitflow.hotfixPrefix) ? "hotfix" : branch.startsWith(gitflow.releasePrefix) ? "release" : "feature";
      if (selectedBranch && branchType !== type) throw new HttpError(400, "선택한 브랜치와 작업 유형이 다릅니다.", "workbranch-type");
      if (!selectedBranch && (await taskRef(project.path, `refs/heads/${branch}`) || await taskRef(project.path, `refs/remotes/${current.remote}/${branch}`)))
        throw new HttpError(409, "해당 작업 브랜치가 이미 있습니다.", "task-branch-exists");
      const baseBranch = type === "hotfix" ? gitflow.main : gitflow.develop;
      const baseCommit = type === "hotfix" ? current.mainSha : current.developSha ?? current.mainSha;
      const selected = selectedBranch ? await resolveWorkbranch(project.path, branch) : null;
      if (selected) assertIdle({ cwd: selected.dir });
      const previousBranch = inPlace ? await assertInPlaceReady(repo) : null;
      const location = inPlace ? { cwd: path.resolve(repo.top), root: null } : selected ? { cwd: selected.dir, root: path.dirname(selected.dir) } : taskWorktreeLocation(repo, id);
      const targetSha = type === "feature" ? current.developSha ?? current.mainSha : current.mainSha;
      const behind = !!selected && !await taskAncestor(project.path, targetSha, await taskRef(selected.dir, "HEAD"));
      const task = { id, projectPath: project.path, title, type, version: type === "release" ? version : undefined,
        agent: body.agent ?? "claude", model: body.model, effort: body.effort, permission: body.permission, role: body.role,
        branch, baseBranch, targetBranch: type === "feature" ? gitflow.develop : gitflow.main, baseCommit, gitflow: clone(gitflow),
        cwd: location.cwd, worktreeRoot: location.root, gitCommonDir: repo.common,
        ownsWorktree: !inPlace && (!selected || selected.created), ownsBranch: !selected,
        ...(selected ? { selectedWorkBranch: true } : {}),
        ...(inPlace ? { inPlace: true, previousBranch } : {}),
        remote: current.remote, remoteFingerprint: remoteFingerprint((await taskGit(project.path, ["remote", "get-url", current.remote])).trim()),
        sessionIds: [], state: "working", pull: null, createdAt: now(), updatedAt: now(),
        freshness: { ...current, targetSha, behind, state: behind ? "needs-update" : current.state },
        needsDevelopSetup: !current.developSha };
      if (inPlace) {
        // 실패하면 원본 폴더는 그대로이므로 작업 기록을 남기지 않는다.
        try { await taskGit(project.path, ["switch", "--no-guess", "-c", branch, baseCommit], { write: true }); }
        catch (error) { throw failure(error); }
        save(task);
        try { return await attach(task, body); }
        catch (error) { task.error = `작업은 생성됐지만 세션을 만들지 못했습니다: ${error.message}`; save(task); throw failure(error); }
      }
      fs.mkdirSync(location.root, { recursive: true });
      try { if (!selected) await taskGit(project.path, ["worktree", "add", "-b", branch, task.cwd, baseCommit], { write: true }); }
      catch (error) {
        if (error.outcomeUnknown || fs.existsSync(task.cwd) || await taskRef(project.path, `refs/heads/${branch}`)) {
          task.provisioning = true;
          task.error = `작업 폴더 준비를 완료하지 못했습니다. 상태를 확인한 뒤 새 세션을 연결하면 이어서 준비합니다: ${error.message}`;
          save(task);
        }
        throw failure(error);
      }
      if (selected) shareFolder(selected.dir, task);
      save(task);
      try { return await attach(task, body); }
      catch (error) { task.error = `작업은 생성됐지만 세션을 만들지 못했습니다: ${error.message}`; save(task); throw failure(error); }
    });
  }
  function mutate(id, action) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      assertIdle(task);
      busy.add(id);
      try { return await action(task); }
      catch (error) { task.error = error.message; save(task); throw failure(error); }
      finally { busy.delete(id); }
    });
  }
  async function githubTarget(task) {
    const target = await github.target(task.cwd, task.remote);
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
  async function finish(id, body = {}) {
    const description = String(body.description ?? "").trim();
    const verification = String(body.verification ?? "").trim();
    if (description.length > 40_000 || verification.length > 10_000) throw new HttpError(400, "PR 설명 또는 검증 결과가 너무 깁니다.");
    return mutate(id, async (task) => {
      assertActive(task);
      const message = String(body.message ?? `${task.type === "feature" ? "feat" : "fix"}: ${task.title}`).trim();
      if (!message || message.length > 2000) throw new HttpError(400, "커밋 메시지를 1~2000자로 입력하세요.");
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 확인해야 합니다. 먼저 상태를 새로고침하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      await assertTaskWorktree(task);
      await assertTaskGitIdle(task);
      await freshness(task);
      requireFresh(task);
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
      save(task);
      // Recheck the base after publication; a moving target must be integrated before opening the PR.
      await freshness(task);
      requireFresh(task);
      if (!existing) {
        const text = [`## 작업\n${description || task.title}`, `## 검증\n${verification || "검증 결과를 입력하지 않았습니다."}`,
          `AgentHub 작업: ${task.id}\n유형: ${task.type}\n기준: ${task.baseBranch} → ${task.targetBranch}`].join("\n\n");
        try {
          const result = await externalWrite(task, "pull", head, () => github.create(task.cwd, { ...args, base: task.targetBranch, title: task.title, body: text }));
          setPull(task, result.pull);
        } catch (error) {
          if (error.reason !== "pull-exists") throw error;
          const pull = await findPull(task, target, "open");
          if (!pull) throw error;
          setPull(task, pull);
        }
      } else setPull(task, (await github.detail(task.cwd, existing.number, { remote: task.remote })).pull);
      task.verification = verification;
      delete task.error;
      save(task);
      return { task: clone(task), pull: clone(task.pull) };
    });
  }
  async function refresh(id) {
    return mutate(id, async (task) => {
      if (task.state === "cleaned") return { task: clone(task) };
      await freshness(task);
      const target = await githubTarget(task);
      const pull = task.pull ? (await github.detail(task.cwd, task.pull.number, { remote: task.remote })).pull : await findPull(task, target);
      if (pull) setPull(task, pull);
      const pending = task.pendingAction;
      if (pending) {
        let resolved = false;
        let checked = false;
        if (pending.action === "pull") { resolved = !!pull && pull.headRefOid === pending.expectedHead; checked = true; }
        else if (pending.action === "push") {
          resolved = await github.remoteHead(target, task.branch) === pending.expectedHead;
          checked = true;
          if (resolved) task.publishedHead = pending.expectedHead;
        } else if (pending.action === "develop") { resolved = !!task.freshness.developSha; checked = true; }
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
      if (["hotfix", "release"].includes(task.type) && task.state === "merged")
        task.developPending = !task.freshness.developSha || task.freshness.mainMissing;
      save(task);
      return { task: clone(task) };
    });
  }
  async function sync(id) {
    return mutate(id, async (task) => {
      assertActive(task);
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      await assertTaskWorktree(task);
      await assertTaskGitIdle(task);
      if (await taskDirty(task)) throw new HttpError(409, "커밋하지 않은 변경이 있습니다. 커밋한 뒤 최신화하세요.", "task-dirty");
      await freshness(task);
      if (task.type !== "hotfix" && task.freshness.mainMissing) requireFresh(task);
      const sha = task.freshness.targetSha;
      if (task.freshness.behind) {
        try { await taskGit(task.cwd, ["merge", "--no-edit", sha], { write: true }); }
        catch (error) {
          if (!error.outcomeUnknown) await taskGit(task.cwd, ["merge", "--abort"], { write: true }).catch(() => {});
          throw new HttpError(409, `최신 기준을 병합하지 못했습니다. 작업 폴더에서 충돌을 확인하세요: ${error.message}`, "task-conflict", { outcomeUnknown: error.outcomeUnknown });
        }
      }
      await freshness(task);
      return { task: clone(task) };
    });
  }
  async function cleanup(id) {
    return mutate(id, async (task) => {
      if (task.state === "cleaned") return { task: clone(task) };
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      const head = await assertTaskWorktree(task);
      await assertTaskGitIdle(task);
      if (await taskDirty(task)) throw new HttpError(409, "커밋하지 않은 변경이나 새 파일이 남아 있어 정리할 수 없습니다.", "task-dirty");
      await freshness(task);
      const target = await githubTarget(task);
      if (!task.pull) throw new HttpError(409, "PR 병합을 먼저 완료하세요.", "task-unmerged");
      const pull = (await github.detail(task.cwd, task.pull.number, { remote: task.remote })).pull;
      setPull(task, pull);
      if (pull.state !== "MERGED") throw new HttpError(409, "병합이 확인된 작업만 정리할 수 있습니다.", "task-unmerged");
      if (!pull.headRefOid || head !== pull.headRefOid) throw new HttpError(409, "PR에 병합되지 않은 추가 커밋이 있어 정리할 수 없습니다.", "task-unmerged-commits");
      const remoteHead = await github.remoteHead(target, task.branch);
      if (remoteHead && remoteHead !== head) throw new HttpError(409, "원격 작업 브랜치가 달라졌습니다. 추가 변경을 먼저 확인하세요.", "task-unpushed");
      if (["release", "hotfix"].includes(task.type) && (!task.freshness.developSha || task.freshness.mainMissing)) {
        task.developPending = true;
        const { main, develop } = taskSettings(task);
        throw new HttpError(409, `${main}의 배포·긴급 수정을 ${develop}에도 반영한 뒤 정리하세요.`, "gitflow-develop-pending");
      }
      const expected = taskWorktreeLocation({ common: task.gitCommonDir, top: task.projectPath }, task.id);
      const ownsWorktree = task.ownsWorktree !== false;
      const ownsBranch = task.ownsBranch !== false;
      const expectedRoot = task.selectedWorkBranch ? task.worktreeRoot : expected.root;
      if (ownsWorktree && ((!task.selectedWorkBranch && !sameTaskPath(expected.cwd, task.cwd)) || !sameTaskPath(path.dirname(task.cwd), expectedRoot)))
        throw new HttpError(409, "AgentHub가 생성한 작업 폴더인지 확인할 수 없습니다.", "task-worktree");
      if (await assertTaskWorktree(task) !== head || await taskDirty(task))
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
  // git은 그래도 워크트리 기록은 지우므로, 기록이 빠졌으면 남은 폴더만 잠시 기다리며 마저 지운다.
  async function removeTaskWorktree(task) {
    try {
      await taskGit(task.projectPath, ["worktree", "remove", "--", task.cwd], { write: true });
    } catch (error) {
      const list = await taskGit(task.projectPath, ["worktree", "list", "--porcelain"]).catch(() => null);
      const registered = list === null || list.split(/\r?\n/).some((line) => line.startsWith("worktree ") && sameTaskPath(line.slice(9), task.cwd));
      if (registered) throw new HttpError(409, `작업 폴더를 지우지 못했습니다. 그 폴더를 연 편집기·탐색기·터미널을 닫고 다시 정리하세요.\n${error.message}`, "task-worktree-locked");
      try { fs.rmSync(task.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch { task.cleanupWarning = `작업 폴더 일부가 남았습니다. 파일을 잡고 있는 프로그램을 닫은 뒤 직접 지우세요: ${task.cwd}`; }
    }
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
  return { list, context, settings, updateSettings, create, finish, refresh, sync, cleanup, assertSession, replaceSession, detachSession, workbranches, createBranchSession,
    addSession: (id, body = {}) => mutate(id, (task) => attach(task, body)) };
}

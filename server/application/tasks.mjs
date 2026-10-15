import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { githubPulls, normalizePull } from "../github.mjs";
import { summary } from "../store.mjs";
import { HttpError } from "./errors.mjs";
import { readJsonFile, writeJsonAtomic } from "../infrastructure/persistence/json-file.mjs";
import { taskGit, taskRepo, taskRef, taskAncestor, gitflowContext, assertTaskWorktree, readTaskBranch,
  taskDirty, taskWorktreeLocation, sameTaskPath, assertTaskGitIdle } from "../tasks.mjs";
import { normalizeGitflowSettings, projectGitflowSettings, gitflowSettingsKey } from "../gitflow-settings.mjs";

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
    const current = previous.catch(() => {}).then(action);
    queue.set(key, current);
    try { return await current; }
    finally { if (queue.get(key) === current) queue.delete(key); }
  }
  function taskSessions(task) {
    return store.list().filter((session) => session.taskId === task.id || sameTaskPath(session.cwd, task.cwd));
  }
  function assertIdle(task, except) {
    if (taskSessions(task).some((session) => session.id !== except && runner.isRunning(session.id)))
      throw new HttpError(409, "이 작업 폴더에서 실행 중인 세션을 먼저 중지하세요.", "running");
  }
  function assertActive(task) {
    if (["merged", "cleaned"].includes(task.state)) throw new HttpError(409, "병합이 완료된 작업입니다. 새 작업에서 이어서 진행하세요.", "task-completed");
  }
  function assertSession(session) {
    if (!session.taskId) return;
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
      title: task.title, role: body.role ?? task.role, agent: body.agent ?? task.agent ?? "claude",
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
    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (type === "release" && !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version))
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
      const branch = `${gitflow[`${type}Prefix`]}${type === "release" ? version : `${id}-${slug}`}`;
      await taskGit(project.path, ["check-ref-format", "--branch", branch]);
      if (await taskRef(project.path, `refs/heads/${branch}`) || await taskRef(project.path, `refs/remotes/${current.remote}/${branch}`))
        throw new HttpError(409, "해당 작업 브랜치가 이미 있습니다.", "task-branch-exists");
      const baseBranch = type === "hotfix" ? gitflow.main : gitflow.develop;
      const baseCommit = type === "hotfix" ? current.mainSha : current.developSha ?? current.mainSha;
      const location = taskWorktreeLocation(repo, id);
      const task = { id, projectPath: project.path, title, type, version: type === "release" ? version : undefined,
        agent: body.agent ?? "claude", model: body.model, effort: body.effort, permission: body.permission, role: body.role,
        branch, baseBranch, targetBranch: type === "feature" ? gitflow.develop : gitflow.main, baseCommit, gitflow: clone(gitflow),
        cwd: location.cwd, worktreeRoot: location.root, gitCommonDir: repo.common,
        remote: current.remote, remoteFingerprint: remoteFingerprint((await taskGit(project.path, ["remote", "get-url", current.remote])).trim()),
        sessionIds: [], state: "working", pull: null, createdAt: now(), updatedAt: now(),
        freshness: { ...current, targetSha: type === "hotfix" || type === "release" ? current.mainSha : baseCommit, behind: false },
        needsDevelopSetup: !current.developSha };
      fs.mkdirSync(location.root, { recursive: true });
      try { await taskGit(project.path, ["worktree", "add", "-b", branch, task.cwd, baseCommit], { write: true }); }
      catch (error) {
        if (error.outcomeUnknown || fs.existsSync(task.cwd) || await taskRef(project.path, `refs/heads/${branch}`)) {
          task.provisioning = true;
          task.error = `작업 폴더 준비를 완료하지 못했습니다. 상태를 확인한 뒤 새 세션을 연결하면 이어서 준비합니다: ${error.message}`;
          save(task);
        }
        throw failure(error);
      }
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
      if (!sameTaskPath(expected.cwd, task.cwd) || !sameTaskPath(path.dirname(task.cwd), expected.root))
        throw new HttpError(409, "AgentHub가 생성한 작업 폴더인지 확인할 수 없습니다.", "task-worktree");
      if (await assertTaskWorktree(task) !== head || await taskDirty(task))
        throw new HttpError(409, "정리 확인 중 작업 폴더가 변경됐습니다. 다시 확인하세요.", "task-stale-head");
      await taskGit(task.projectPath, ["worktree", "remove", "--", task.cwd], { write: true });
      // Compare-and-delete permits squash merges without using a destructive force flag.
      try {
        await taskGit(task.projectPath, ["update-ref", "-d", `refs/heads/${task.branch}`, head], { write: true });
        task.localBranchRemoved = true;
      } catch (error) { task.cleanupWarning = `작업 폴더는 정리됐지만 로컬 브랜치는 남았습니다: ${error.message}`; }
      task.state = "cleaned";
      task.cleanedAt = now();
      task.developPending = false;
      save(task);
      return { task: clone(task) };
    });
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
  return { list, context, settings, updateSettings, create, finish, refresh, sync, cleanup, assertSession, replaceSession, detachSession,
    addSession: (id, body = {}) => mutate(id, (task) => attach(task, body)) };
}

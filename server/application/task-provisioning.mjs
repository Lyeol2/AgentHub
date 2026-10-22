import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { summary } from "../store.mjs";
import { listWorkbranches, resolveWorkbranch } from "../workbranches.mjs";
import { HttpError } from "./errors.mjs";
import { taskGit, taskRepo, taskRef, taskAncestor, gitflowContext, GITFLOW_FETCH_REUSE_MS, assertTaskWorktree, readTaskBranch, taskDirty, taskWorktreeLocation, validTaskWorktreeName, sameTaskPath, insideTaskPath, taskBranchSlug, removeWorktreeDir, worktreeRegistered } from "../tasks.mjs";
import { projectGitflowSettings, gitflowBranches } from "../gitflow-settings.mjs";
import { stopwatch } from "../timing.mjs";
import { isGitflowBase, clone, now, remoteFingerprint, taskBranchName, failure, emptyDir, worktreeFailure } from "./task-domain.mjs";

/** Provision tasks and attach sessions; shared ownership and repository locks stay in the service. */
export function createTaskProvisioning({ IN_PLACE_BUSY, activeInPlace, assertActive, assertIdle, assertInPlaceReady, assertWorktreeReusable, branchOwner, busy, config, developBehindHint, directory, finishModeFor, folderOwner, get, graphTabs, inPlaceTasks, locked, notify, projectService, records, runner, save, sessionService, store, workspace }) {
  async function inPlaceStatus(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const repo = await taskRepo(projectPath);
    try {
      await assertInPlaceReady(repo);
      const active = activeInPlace(repo.common);
      return { available: true, ...(active ? { parks: { id: active.id, title: active.title, branch: active.branch } } : {}) };
    }
    catch (error) {
      if (!IN_PLACE_BUSY.includes(error.reason)) throw error;
      return { available: false, reason: error.reason, message: error.reason === "running" ? "원본 폴더에서 실행 중인 세션이 있습니다." : error.message };
    }
  }
  async function workbranches(projectPath, { inPlace = false } = {}) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const repo = await taskRepo(projectPath);
    const result = await listWorkbranches(projectPath, { inPlace });
    const flow = projectGitflowSettings(config, repo.top);
    const worktrees = await Promise.all((result.worktrees ?? []).filter((item) => !item.original).map(async (item) => {
      const owner = folderOwner(item.cwd, repo.common);
      let reason = item.reason ?? (item.bare ? "Bare 저장소는 작업 폴더로 사용할 수 없습니다." : null);
      if (!reason && owner && owner.state !== "merged") reason = `"${owner.title}" 작업에서 쓰는 중입니다. 그 작업에서 세션을 추가하세요.`;
      if (!reason && store.list().some((session) => runner.isRunning(session.id) && insideTaskPath(session.cwd, item.cwd))) reason = "실행 중인 세션이 있습니다.";
      if (!reason) {
        try { if (await taskDirty({ cwd: item.cwd })) reason = "커밋하지 않은 변경이 있습니다."; }
        catch (error) { if (error.reason === "git-timeout") throw error; reason = "작업 폴더의 Git 상태를 확인할 수 없습니다."; }
      }
      return { ...item, taskId: owner?.id, taskState: owner?.state, taskTitle: owner?.title, selectableForTask: !reason, ...(reason ? { reason } : {}) };
    }));
    return { ...result, worktrees, branches: result.branches.map((branch) => {
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
  // 원본 폴더를 이 작업 브랜치로 옮겨 이 작업을 진행한다. 원본 폴더에서 진행하던 작업은 전환을 기다린다.
  // 커밋하지 않은 변경이 있거나 원본 폴더에서 실행 중인 세션·Git 처리가 있으면 옮기지 않는다.
  async function activate(id) {
    const task = get(id);
    if (!task.inPlace) throw new HttpError(400, "원본 폴더에서 하는 작업만 전환할 수 있습니다.", "task-not-in-place");
    assertActive(task);
    return locked(task.gitCommonDir, async () => {
      if (readTaskBranch(task.cwd) === task.branch) return { task: clone(task) };
      if (!await taskRef(task.projectPath, `refs/heads/${task.branch}`))
        throw new HttpError(409, `작업 브랜치 ${task.branch}가 로컬에 없어 전환할 수 없습니다.`, "task-branch-missing");
      const repo = await taskRepo(task.projectPath);
      if (!sameTaskPath(repo.common, task.gitCommonDir) || !sameTaskPath(repo.top, task.cwd)) throw new HttpError(409, "원본 폴더의 Git 저장소가 바뀌었습니다.", "task-worktree");
      await assertInPlaceReady(repo, { switching: true });
      busy.add(task.id);
      try { await taskGit(task.cwd, ["switch", "--no-guess", task.branch], { write: true }); }
      catch (error) { throw failure(error); }
      finally { busy.delete(task.id); }
      save(task);
      // 전환을 기다리던 작업과 방금 비켜 준 작업의 카드·세션을 다시 그린다.
      for (const other of inPlaceTasks(task.gitCommonDir)) if (other.id !== task.id) notify("tasks", { projectPath: other.projectPath, taskId: other.id });
      notify("sessions", {});
      return { task: clone(task) };
    });
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
    // worktree:false는 워크트리를 만들지 않고 원본 폴더에서 선택한 작업 브랜치를 쓴다.
    const inPlace = body.worktree === false;
    // worktreePath는 이미 등록된 워크트리를 골라 그 폴더를 새 작업 브랜치로 바꿔 작업한다.
    const reusePath = body.worktreePath;
    if (reusePath !== undefined && (typeof reusePath !== "string" || !reusePath.trim())) throw new HttpError(400, "작업할 워크트리를 선택하세요.");
    if (reusePath !== undefined && (inPlace || selectedBranch !== undefined || body.worktreeName !== undefined))
      throw new HttpError(400, "기존 워크트리를 고르면 원본 폴더·기존 작업 브랜치·작업 폴더 이름과 함께 쓸 수 없습니다.");
    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (!selectedBranch && type === "release" && !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version))
      throw new HttpError(400, "배포 버전을 입력하세요. 예: 1.2.0");
    // branchName은 유형 접두어 뒤에 붙는 이름, worktreeName은 <프로젝트>.agenthub/ 아래 작업 폴더 이름이다. 비우면 자동으로 정한다.
    const branchName = typeof body.branchName === "string" ? body.branchName.trim() : "";
    const worktreeName = typeof body.worktreeName === "string" ? body.worktreeName.trim() : "";
    if ((branchName || worktreeName) && selectedBranch !== undefined) throw new HttpError(400, "기존 작업 브랜치를 선택하면 브랜치와 작업 폴더 이름을 바꿀 수 없습니다.");
    if (branchName.length > 200) throw new HttpError(400, "브랜치 이름이 너무 깁니다.", "task-branch-name");
    if (worktreeName && inPlace) throw new HttpError(400, "원본 폴더에서 작업할 때는 작업 폴더 이름을 정할 수 없습니다.");
    if (body.copyLibrary !== undefined && typeof body.copyLibrary !== "boolean") throw new HttpError(400, "Library 복사 여부는 true 또는 false여야 합니다.");
    if (worktreeName && !validTaskWorktreeName(worktreeName))
      throw new HttpError(400, "작업 폴더 이름은 80자 이내의 영문·한글·숫자와 . _ - 만 쓸 수 있습니다.", "task-worktree-name");
    sessionService().checkSessionOptions?.({ ...body, agent: body.agent ?? "claude" });
    const project = projectService().ensureProject(body.projectPath);
    graphTabs?.resolve(project.path, body.tabId, body.connectFrom ?? body.createdBy);
    const repo = await taskRepo(project.path);
    // 작업 만들기 단계를 화면에 알리고, 단계별 소요 시간을 디버그 로그로 남긴다.
    const clock = stopwatch("task.create", project.path);
    let stage = "입력 확인";
    const progress = (step) => { clock.step(stage); stage = step; notify("task-progress", { projectPath: project.path, ...(requestId ? { requestId } : {}), step }); };
    return locked(repo.common, async () => {
      const previous = requestId && [...records.values()].find((task) => task.requestId === requestId && sameTaskPath(task.projectPath, project.path));
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) throw new HttpError(409, "같은 요청의 작업 내용이 변경됐습니다. 이미 만든 작업을 먼저 확인하세요.", "task-request-changed");
        const session = store.get?.(previous.initialStart?.sessionId ?? previous.sessionIds.at(-1));
        return { task: clone(previous), ...(session ? { session: summary(session) } : {}), reused: true,
          ...(previous.initialStart?.state !== "sent" && body.start ? { startError: previous.initialStart?.error || "작업은 이미 생성됐습니다. 세션 기록을 확인한 뒤 이어서 요청하세요." } : {}) };
      }
      const gitflow = projectGitflowSettings(config, repo.top);
      progress("원격 최신 상태 확인 중");
      // 작업 탭을 열 때 받은 fetch가 방금 것이면 다시 쓴다.
      const current = await gitflowContext(project.path, undefined, gitflow, { maxAge: GITFLOW_FETCH_REUSE_MS });
      progress("작업 브랜치 정하는 중");
      if (type !== "hotfix" && current.mainMissing) throw new HttpError(409, `새 작업을 만들기 전에 ${gitflow.main}의 변경을 ${gitflow.develop}에 반영하세요.`, "gitflow-develop-behind",
        { hint: developBehindHint({ gitflow }).replace("작업 카드의 최신 상태 확인을 누르면", "다시 만들면") });
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
      const selected = selectedBranch ? await resolveWorkbranch(project.path, branch, { inPlace }) : null;
      if (selected) assertIdle({ cwd: selected.dir });
      let reused = null;
      if (reusePath !== undefined) {
        const listed = (await listWorkbranches(project.path)).worktrees.find((item) => !item.original && sameTaskPath(item.cwd, reusePath));
        if (!listed) throw new HttpError(409, "고른 워크트리가 이 저장소에 등록되어 있지 않습니다. 목록을 새로고침하세요.", "worktree-missing");
        if (listed.reason || listed.bare) throw new HttpError(409, listed.reason ?? "Bare 저장소는 작업 폴더로 사용할 수 없습니다.", "worktree-unavailable");
        const owner = await assertWorktreeReusable(repo, listed.cwd);
        const current = (await taskGit(listed.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() || null;
        // 다른 작업의 브랜치로 되돌아가면 그 작업을 정리할 때 브랜치를 지울 수 없으므로 되돌아갈 브랜치로 삼지 않는다.
        reused = { cwd: listed.cwd, owner, previousBranch: current && !branchOwner(repo.common, current) ? current : null };
      }
      const previousBranch = inPlace ? await assertInPlaceReady(repo) : reused?.previousBranch ?? null;
      const location = inPlace ? { cwd: path.resolve(repo.top), root: null } : reused ? { cwd: reused.cwd, root: path.dirname(reused.cwd) }
        : selected ? { cwd: selected.dir, root: path.dirname(selected.dir) } : taskWorktreeLocation(repo, id, worktreeName);
      // 이전 시도가 남긴 빈 폴더는 그대로 쓸 수 있으므로 막지 않는다.
      if (worktreeName && ((fs.existsSync(location.cwd) && !emptyDir(location.cwd)) || [...records.values()].some((other) => other.state !== "cleaned" && sameTaskPath(other.cwd, location.cwd))))
        throw new HttpError(409, `같은 이름의 작업 폴더가 이미 있습니다: ${worktreeName}`, "task-worktree-exists");
      const targetSha = type === "feature" ? current.developSha ?? current.mainSha : current.mainSha;
      const behind = !!selected && !await taskAncestor(project.path, targetSha, await taskRef(project.path, `refs/heads/${branch}`));
      // 기존 배포 준비 브랜치를 고르면 접두어 뒤 이름이 버전이다.
      const releaseVersion = version || (selectedBranch && branch.startsWith(gitflow.releasePrefix) ? branch.slice(gitflow.releasePrefix.length) : "");
      const task = { id, projectPath: project.path, title, content, acceptance, type, version: type === "release" ? releaseVersion || undefined : undefined,
        ...(requestId ? { requestId, requestFingerprint } : {}),
        finishMode: finishModeFor(repo.top),
        agent: body.agent ?? "claude", model: body.model, effort: body.effort, permission: body.permission, role: body.role,
        branch, baseBranch, targetBranch: flowBranches.target, baseCommit, gitflow: clone(gitflow),
        cwd: location.cwd, worktreeRoot: location.root, gitCommonDir: repo.common, ...(worktreeName ? { worktreeName } : {}),
        ownsWorktree: !inPlace && !reused && (!selected || selected.created), ownsBranch: !selected,
        ...(selected ? { selectedWorkBranch: true } : {}),
        ...(inPlace ? { inPlace: true, previousBranch } : {}),
        ...(reused ? { reusedWorktree: true, previousBranch } : {}),
        remote: current.remote, remoteFingerprint: remoteFingerprint((await taskGit(project.path, ["remote", "get-url", current.remote])).trim()),
        sessionIds: [], state: "working", pull: null, createdAt: now(), updatedAt: now(),
        freshness: { ...current, targetSha, behind, state: behind ? "needs-update" : current.state },
        needsDevelopSetup: !current.developSha };
      // Record intent before Git changes: retrying a lost creation response must
      // reuse this task even if the process died just after worktree creation.
      task.provisioning = true;
      save(task);
      if (inPlace || reused) {
        // 전환 전 실패는 기록을 지우고, 전환 여부가 불확실하거나 hook에서 실패하면 기록을 남긴다.
        try {
          if (!selected) await taskGit(location.cwd, ["switch", "--no-guess", "-c", branch, baseCommit], { write: true });
          else if (readTaskBranch(location.cwd) !== branch) await taskGit(location.cwd, ["switch", "--no-guess", branch], { write: true });
        }
        catch (error) {
          const checkout = selected && readTaskBranch(location.cwd);
          const unchanged = !error.outcomeUnknown && (selected ? checkout && checkout !== branch : !await taskRef(project.path, `refs/heads/${branch}`));
          if (unchanged) {
            fs.rmSync(path.join(directory, `${id}.json`), { force: true }); records.delete(id);
          } else { task.error = `작업 브랜치 준비 결과를 확인하세요: ${error.message}`; save(task); }
          throw failure(error);
        }
        if (reused) {
          // 병합을 마친 작업의 폴더를 이어받으면 그 작업은 폴더를 지우지 않고 남은 브랜치만 정리한다.
          if (reused.owner) { reused.owner.folderHandedTo = task.id; reused.owner.ownsWorktree = false; save(reused.owner); }
          shareFolder(location.cwd, task);
        }
        delete task.provisioning;
        save(task);
        if (body.session === false) return { task: clone(task) };
        progress("세션 준비 중");
        try { return await attachAndStart(task, body); }
        catch (error) { task.error = `작업은 생성됐지만 세션을 만들지 못했습니다: ${error.message}`; save(task); throw failure(error); }
      }
      progress(selected ? "작업 폴더 확인 중" : "작업 폴더 만드는 중");
      const createdRoot = !fs.existsSync(location.root);
      fs.mkdirSync(location.root, { recursive: true });
      // 재사용 대기 폴더가 있으면 그 폴더에 새 작업 브랜치를 만들고, 없으면 새로 만든다(유니티면 Library 복사를 시작한다).
      try { if (!selected) await workspace.provision(task, repo, location, () => addWorktree(task, false), { copyLibrary: body.copyLibrary }); }
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
      progress("세션 준비 중");
      try { return await attachAndStart(task, body); }
      catch (error) { task.error = `작업은 생성됐지만 세션을 만들지 못했습니다: ${error.message}`; save(task); throw failure(error); }
    }).finally(() => { clock.step(stage); clock.total(); });
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
  return { inPlaceStatus, workbranches, createBranchSession, activate, attach, create };
}

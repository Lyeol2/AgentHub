import { $, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { defaultPermission, permissionLabel } from "../../shared/permissions.js";
import { createWorkbranchPicker } from "../../shared/workbranches.js";
import { showError } from "../../shared/error-report.js";

// 새 세션 창에서 마지막으로 고른 값. 종류·워크트리 사용과 AI별 권한·모델·추론 강도를 기억한다.
// 창을 열 때는 프로젝트 기본값(프로젝트 설정) → 마지막 선택 → 기존 기본값 순으로 쓴다.
const NEW_SESSION_PREFS_KEY = "agenthub.newSession";
function loadNewSessionPrefs() {
  try { return JSON.parse(globalThis.localStorage?.getItem(NEW_SESSION_PREFS_KEY) ?? "{}") || {}; } catch { return {}; }
}
function saveNewSessionPrefs(prefs) {
  try { globalThis.localStorage?.setItem(NEW_SESSION_PREFS_KEY, JSON.stringify(prefs)); } catch { /* 저장하지 못해도 세션 생성에는 지장 없다. */ }
}

export function createCreationController({ api, loadStatus, loadSessions, loadProjects, sortedProjects, connectCreatedGraphNode, fillModels, fillEfforts, openChat, openSettings, data, navigation }) {
  const ui = {
    "newSessionContext": null,
    "creating": false
  };
  const branchPicker = createWorkbranchPicker({
    api, owner: "session", select: $("new-worktree-branch"), status: $("new-worktree-branch-status"), refresh: $("new-worktree-branch-refresh"),
    getPath: () => $("new-project").value,
    isActive: () => Boolean($("new-dialog").open && ui.newSessionContext && !ui.newSessionContext.cancelled && existingWorkbranchMode()),
    onChange: () => syncNewSubmit(),
  });
  // ── 새 세션 ─────────────────────────────────────────────────────
  const newKind = () => {
    const [agent, mode] = $("new-agent").value.split("-");
    return { agent, chat: mode === "chat" };
  };

  function syncNewKind() {
    const { agent, chat } = newKind();
    for (const node of $("new-form").querySelectorAll(".for-project")) node.hidden = chat;
    for (const node of $("new-form").querySelectorAll(".for-chat")) node.hidden = !chat;
    $("new-project").required = !chat;
    if (chat) {
      $("new-orchestrator").checked = false;
      $("new-isolate").value = "false";
    }
    syncNewWorktree();
    $("new-title").placeholder = chat ? "예: 여행 일정 짜기" : "예: 가방 UI 버그 수정";
    $("new-role").placeholder = chat
      ? "예: 친절한 영어 선생님. 틀린 표현은 고쳐 준다."
      : "예: 프론트엔드 담당. server/는 건드리지 않는다. 끝나면 '검토 요청'이라고 쓴다.";
    fillPermissions();
    fillModels("new-models", agent);
    // 모델 이름은 AI마다 다르므로 AI별로 마지막에 쓴 값을 채운다.
    const prefs = loadNewSessionPrefs();
    $("new-model").value = typeof prefs.model?.[agent] === "string" ? prefs.model[agent] : "";
    fillEfforts("new-effort", agent, $("new-model").value.trim(), prefs.effort?.[agent] ?? "");
  }

  // 고른 프로젝트의 기본값(프로젝트 목록에 함께 온다). 없으면 빈 값.
  function projectDefaults(projectPath = $("new-project").value) {
    const project = projectPath && sortedProjects().find((p) => samePath(p.path, projectPath));
    return project?.settings?.defaults ?? {};
  }

  function worktreeNameError(value) {
    const name = String(value ?? "").trim();
    if (!name) return "워크트리 이름을 입력하세요.";
    if (!/^[A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ][A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ_-]{0,63}$/u.test(name)) {
      return "워크트리 이름은 1~64자의 영문·숫자·한글·하이픈·밑줄만 쓸 수 있으며, 영문·숫자·한글로 시작해야 합니다.";
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return "워크트리 이름으로 Windows 예약어를 사용할 수 없습니다.";
    return "";
  }

  function existingWorkbranchMode() {
    return !newKind().chat && $("new-isolate").value === "true" && $("new-worktree-mode").value === "existing";
  }

  function syncNewSubmit() {
    $("new-submit").disabled = ui.creating || Boolean(ui.newSessionContext?.outcomeUnknown) || (existingWorkbranchMode() && !branchPicker.ready());
  }

  function syncNewWorktree(loadBranches = false) {
    const chat = newKind().chat;
    const useWorktree = !chat && $("new-isolate").value === "true";
    const existing = useWorktree && $("new-worktree-mode").value === "existing";
    const input = $("new-worktree-name");
    $("new-isolate").disabled = chat;
    $("new-worktree-mode-row").hidden = !useWorktree;
    $("new-worktree-mode").disabled = !useWorktree;
    $("new-worktree-row").hidden = !useWorktree || existing;
    $("new-worktree-branch-row").hidden = !existing;
    $("new-worktree-branch").required = existing;
    input.disabled = !useWorktree || existing;
    input.required = useWorktree && !existing;
    input.setCustomValidity(input.required ? worktreeNameError(input.value) : "");
    if (!existing) branchPicker.reset();
    else if (loadBranches) void branchPicker.load();
    syncNewSubmit();
  }

  function fillPermissions() {
    const { agent } = newKind();
    const modes = data.status.agents[agent].permissions;
    $("new-permission").replaceChildren(...modes.map((m) => el("option", { value: m }, permissionLabel(m))));
    const preferred = [projectDefaults().permission?.[agent], loadNewSessionPrefs().permission?.[agent]].find((mode) => modes.includes(mode));
    $("new-permission").value = preferred ?? defaultPermission(agent, modes);
  }

  // 워크트리 사용 여부: 프로젝트 기본값 → 마지막 선택 → 사용 안 함. 오케스트레이터는 원본 폴더에서 읽기만 한다.
  function applyWorktreeDefault(orchestrator = $("new-orchestrator").checked) {
    const prefs = loadNewSessionPrefs();
    const isolate = orchestrator || newKind().chat ? false : projectDefaults().isolate ?? prefs.isolate ?? false;
    $("new-isolate").value = isolate ? "true" : "false";
    $("new-worktree-mode").value = isolate && prefs.worktreeMode === "existing" ? "existing" : "new";
  }

  // 오케스트레이터는 선택한 작업 폴더에서 읽기만 한다.
  function syncOrchestrator() {
    if (!$("new-orchestrator").checked) return;
    $("new-permission").value = newKind().agent === "claude" ? "default" : "read-only";
    if (!$("new-title").value.trim()) $("new-title").value = "오케스트레이터";
  }

  // kind: claude | codex | claude-chat | codex-chat
  // pos: 흐름 그래프에서 우클릭한 자리(만든 세션을 거기에 놓는다)
  async function openNew(projectPath, { orchestrator = false, kind, pos = null, connectFrom = null, connectWhen = null, connectKeyword = "" } = {}) {
    if (ui.newSessionContext) ui.newSessionContext.cancelled = true;
    branchPicker.reset();
    const context = { projectPath, pos, connectFrom, connectWhen, connectKeyword,
      tabId: navigation.graphTabId, tabProjectPath: navigation.project };
    ui.newSessionContext = context;
    try {
      await loadStatus();
    } catch (err) {
      if (ui.newSessionContext === context) ui.newSessionContext = null;
      showError(err, { action: "AI CLI 상태 확인" });
      return;
    }
    if (ui.newSessionContext !== context || context.cancelled) return;
    if (pos && (navigation.view !== "project" || !samePath(projectPath, navigation.project) || context.tabId !== navigation.graphTabId)) {
      ui.newSessionContext = null;
      return;
    }
    const projects = sortedProjects();
    if (!projects.length && !kind?.endsWith("-chat")) {
      ui.newSessionContext = null;
      if (confirm("등록된 프로젝트가 없습니다. 프로젝트 없이 일반 채팅을 시작할까요?\n\n취소를 누르면 설정에서 프로젝트를 추가합니다.")) openChat();
      else openSettings();
      return;
    }
    $("new-project").replaceChildren(
      ...projects.map((p) => el("option", { value: p.path }, `${p.name} — ${p.path}`)));
    const match = projectPath && projects.find((p) => samePath(p.path, projectPath));
    if (match) $("new-project").value = match.path;
    // 종류: 지정한 종류 → 프로젝트 기본 AI → 마지막에 고른 코딩 에이전트. 일반 채팅은 지정했을 때만 연다.
    const last = loadNewSessionPrefs().kind;
    if (kind) $("new-agent").value = kind;
    else $("new-agent").value = [projectDefaults().agent, last].find((value) => ["claude", "codex"].includes(value))
      ?? ($("new-agent").value.endsWith("-chat") ? "claude" : $("new-agent").value || "claude");
    $("new-error").textContent = "";
    $("new-orchestrator").checked = orchestrator;
    if ($("new-save-defaults")) $("new-save-defaults").checked = false;
    applyWorktreeDefault(orchestrator);
    $("new-worktree-name").value = "";
    syncNewKind();
    syncNewWorktree(true);
    syncOrchestrator();
    $("new-dialog").showModal();
  }

  $("open-new").addEventListener("click", () => openNew(navigation.project ?? data.current?.projectPath));
  $("open-new-top").addEventListener("click", () => openNew());
  $("nav-chat").addEventListener("click", () => openChat());
  $("open-chat").addEventListener("click", () => openChat());
  $("new-agent").addEventListener("change", () => {
    syncNewKind();
    syncOrchestrator();
  });
  $("new-model").addEventListener("input", () => fillEfforts("new-effort", newKind().agent, $("new-model").value.trim()));
  $("new-orchestrator").addEventListener("change", syncOrchestrator);
  $("new-isolate").addEventListener("change", () => {
    syncNewWorktree(true);
    if ($("new-isolate").value === "true") $(existingWorkbranchMode() ? "new-worktree-branch" : "new-worktree-name").focus();
  });
  $("new-worktree-mode").addEventListener("change", () => syncNewWorktree(true));
  $("new-worktree-name").addEventListener("input", syncNewWorktree);
  $("p-orchestrator").addEventListener("click", () => openNew(navigation.project, { orchestrator: true }));
  $("new-project").addEventListener("change", () => {
    branchPicker.reset();
    // 바꾼 프로젝트에 기본값이 있으면 그 값으로 권한·워크트리를 다시 고른다. 없으면 지금 고른 값을 그대로 둔다.
    const defaults = projectDefaults();
    if (!newKind().chat && !$("new-orchestrator").checked) {
      if (defaults.isolate != null) applyWorktreeDefault();
      if (defaults.permission?.[newKind().agent]) fillPermissions();
    }
    syncNewWorktree(true);
  });

  $("new-dialog").addEventListener("close", () => {
    if (ui.newSessionContext) ui.newSessionContext.cancelled = true;
    ui.newSessionContext = null;
    branchPicker.reset();
  });

  $("new-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    if (ui.creating || ui.newSessionContext?.outcomeUnknown) return;
    const context = ui.newSessionContext;
    const form = new FormData(e.target);
    const { kind, ...body } = Object.fromEntries(form);
    Object.assign(body, newKind());
    body.orchestrator = form.has("orchestrator") && !body.chat;
    body.isolate = form.get("isolate") === "true" && !body.chat;
    const existing = body.isolate && (body.worktreeMode || $("new-worktree-mode").value) === "existing";
    delete body.worktreeMode;
    if (existing) {
      const branch = branchPicker.selected();
      if (!branch) {
        $("new-error").textContent = branchPicker.validationError();
        $("new-worktree-branch").focus();
        return;
      }
      body.isolate = false;
      body.workBranch = branch.name;
      delete body.worktreeName;
    } else if (body.isolate) {
      delete body.workBranch;
      body.worktreeName = String(body.worktreeName ?? "").trim();
      const error = worktreeNameError(body.worktreeName);
      if (error) {
        $("new-error").textContent = error;
        $("new-worktree-name").focus();
        return;
      }
    } else {
      delete body.worktreeName;
      delete body.workBranch;
    }
    if (body.chat) delete body.projectPath;
    else if (context?.tabId && samePath(context.tabProjectPath, body.projectPath)) body.tabId = context.tabId;
    const saveDefaults = form.has("saveDefaults") && !body.chat && !body.orchestrator;
    delete body.saveDefaults;
    const chosenIsolate = existing || body.isolate;
    ui.creating = true;
    syncNewSubmit();
    try {
      const created = await api("POST", "/api/sessions", body);
      rememberChoice(body, chosenIsolate, existing);
      if (saveDefaults) await saveProjectDefaults(body.projectPath, body, chosenIsolate);
      // 생성 후 연결이 실패해도 세션을 중복 생성하지 않게 생성 창부터 닫는다.
      if (ui.newSessionContext === context) {
        ui.newSessionContext = null;
        $("new-dialog").close();
        e.target.reset();
      }
      // 그래프에서 만든 세션은 지정한 자리에 놓고, 손잡이에서 시작했으면 바로 연결한다.
      if (context?.pos && !context.cancelled && !body.chat && navigation.view === "project" &&
          context.tabId === navigation.graphTabId && samePath(context.projectPath, body.projectPath) && samePath(navigation.project, body.projectPath)) {
        await api("PUT", `/api/sessions/${created.id}`, { graphPos: context.pos }).catch(() => {});
        await connectCreatedGraphNode(context, created.id, body.projectPath);
      }
      await Promise.all([loadSessions(), loadProjects()]); // 감지된 프로젝트는 세션을 만들면서 등록된다.
    } catch (err) {
      if (err.outcomeUnknown && context) context.outcomeUnknown = true;
      if (ui.newSessionContext === context) $("new-error").textContent = err.outcomeUnknown
        ? "세션 생성 결과를 아직 확인할 수 없습니다. 창을 닫고 세션 목록을 확인해 주세요."
        : err.message;
    } finally {
      ui.creating = false;
      syncNewSubmit();
    }
  });

  // 다음 새 세션 창의 기본값으로 쓸 마지막 선택. 오케스트레이터가 강제로 바꾼 권한·폴더는 남기지 않는다.
  function rememberChoice(body, isolate, existing) {
    const prefs = loadNewSessionPrefs();
    const { agent, chat } = body;
    const next = { ...prefs, kind: chat ? `${agent}-chat` : agent,
      model: { ...prefs.model, [agent]: body.model ?? "" }, effort: { ...prefs.effort, [agent]: body.effort ?? "" } };
    if (!chat && !body.orchestrator) {
      if (body.permission) next.permission = { ...prefs.permission, [agent]: body.permission };
      next.isolate = !!isolate;
      next.worktreeMode = existing ? "existing" : "new";
    }
    saveNewSessionPrefs(next);
  }

  // "이 프로젝트 기본값으로 저장": 고른 AI·권한·워크트리 사용을 프로젝트 설정에 남긴다. 실패해도 만든 세션은 그대로 둔다.
  async function saveProjectDefaults(projectPath, body, isolate) {
    const current = projectDefaults(projectPath);
    const defaults = { agent: body.agent, permission: { ...current.permission, ...(body.permission ? { [body.agent]: body.permission } : {}) }, isolate: !!isolate };
    try { await api("PUT", `/api/projects/settings?path=${encodeURIComponent(projectPath)}`, { defaults }); }
    catch (err) { alert(`세션은 만들었지만 프로젝트 기본값을 저장하지 못했습니다: ${err.message}`); }
  }

  function cancelCreation() {
    if (ui.newSessionContext) ui.newSessionContext.cancelled = true;
    ui.newSessionContext = null;
    branchPicker.reset();
    if ($("new-dialog").open) $("new-dialog").close();
  }

  return { openNew, cancelCreation };
}

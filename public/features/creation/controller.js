import { $, AGENT_LABEL, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { defaultPermission, permissionLabel } from "../../shared/permissions.js";
import { createWorkbranchPicker } from "../../shared/workbranches.js";

export function createCreationController({ api, loadStatus, loadSessions, loadProjects, sortedProjects, connectCreatedGraphNode, loadHub, fillModels, fillEfforts, openChat, openSettings, data, navigation }) {
  const ui = {
    "templateRoles": null,
    "newSessionContext": null,
    "creating": false
  };
  const branchPicker = createWorkbranchPicker({
    api, owner: "session", select: $("new-worktree-branch"), status: $("new-worktree-branch-status"), refresh: $("new-worktree-branch-refresh"),
    getPath: () => $("new-project").value,
    isActive: () => Boolean($("new-dialog").open && ui.newSessionContext && !ui.newSessionContext.cancelled && !newKind().chat && $("new-isolate").checked && $("new-worktree-mode").value === "existing"),
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
      $("new-isolate").checked = false;
    }
    syncNewWorktree();
    $("new-template-row").hidden = chat || !ui.templateRoles?.length;
    $("new-title").placeholder = chat ? "예: 여행 일정 짜기" : "예: 가방 UI 버그 수정";
    $("new-role").placeholder = chat
      ? "예: 친절한 영어 선생님. 틀린 표현은 고쳐 준다."
      : "예: 프론트엔드 담당. server/는 건드리지 않는다. 끝나면 '검토 요청'이라고 쓴다.";
    fillPermissions();
    fillModels("new-models", agent);
    fillEfforts("new-effort", agent, $("new-model").value.trim());
  }

  function worktreeNameError(value) {
    const name = String(value ?? "").trim();
    if (!name) return "작업 브랜치 이름을 입력하세요.";
    if (!/^[A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ][A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ_-]{0,63}$/u.test(name)) {
      return "작업 브랜치 이름은 1~64자의 영문·숫자·한글·하이픈·밑줄만 쓸 수 있으며, 영문·숫자·한글로 시작해야 합니다.";
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return "작업 브랜치 이름으로 Windows 예약어를 사용할 수 없습니다.";
    return "";
  }

  function existingWorkbranchMode() {
    return !newKind().chat && $("new-isolate").checked && $("new-worktree-mode").value === "existing";
  }

  function syncNewSubmit() {
    $("new-submit").disabled = ui.creating || Boolean(ui.newSessionContext?.outcomeUnknown) || (existingWorkbranchMode() && !branchPicker.ready());
  }

  function syncNewWorktree(loadBranches = false) {
    const chat = newKind().chat;
    const useWorktree = !chat && $("new-isolate").checked;
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
    $("new-permission").value = defaultPermission(agent, modes);
  }

  // 고른 프로젝트의 AGENTHUB.md 역할 템플릿을 채운다.
  async function fillTemplates() {
    const projectPath = $("new-project").value;
    let roles = [];
    try {
      roles = (await loadHub(projectPath)).roles ?? [];
    } catch {
      // 템플릿 없이도 세션은 만들 수 있다.
    }
    if ($("new-project").value !== projectPath) return;
    ui.templateRoles = roles;
    $("new-template").replaceChildren(el("option", { value: "" }, "직접 입력"),
      ...roles.map((r) => el("option", { value: r.name }, `${r.name} · ${AGENT_LABEL[r.agent]} · ${permissionLabel(r.permission)}`)));
    $("new-template-row").hidden = !roles.length || newKind().chat;
    applyTemplate();
  }

  function applyTemplate() {
    const role = ui.templateRoles?.find((r) => r.name === $("new-template").value);
    $("new-role-name").value = role?.name ?? "";
    if (!role) return;
    $("new-orchestrator").checked = false;
    $("new-agent").value = role.agent;
    $("new-model").value = role.model;
    syncNewKind();
    $("new-permission").value = role.permission;
    $("new-role").value = role.body;
    if (!$("new-title").value.trim()) $("new-title").value = role.name;
  }

  // 오케스트레이터는 선택한 작업 폴더에서 읽기만 한다.
  function syncOrchestrator() {
    if (!$("new-orchestrator").checked) return;
    $("new-permission").value = newKind().agent === "claude" ? "default" : "read-only";
    $("new-template").value = "";
    $("new-role-name").value = "";
    if (!$("new-title").value.trim()) $("new-title").value = "오케스트레이터";
  }

  // kind: claude | codex | claude-chat | codex-chat
  // pos: 흐름 그래프에서 우클릭한 자리(만든 세션을 거기에 놓는다)
  async function openNew(projectPath, { orchestrator = false, kind, pos = null, connectFrom = null, connectWhen = null, connectKeyword = "" } = {}) {
    if (ui.newSessionContext) ui.newSessionContext.cancelled = true;
    branchPicker.reset();
    const context = { projectPath, pos, connectFrom, connectWhen, connectKeyword };
    ui.newSessionContext = context;
    try {
      await loadStatus();
    } catch (err) {
      if (ui.newSessionContext === context) ui.newSessionContext = null;
      alert(err.message);
      return;
    }
    if (ui.newSessionContext !== context || context.cancelled) return;
    if (pos && (navigation.view !== "project" || !samePath(projectPath, navigation.project))) {
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
    if (kind) $("new-agent").value = kind;
    else if ($("new-agent").value.endsWith("-chat")) $("new-agent").value = "claude";
    $("new-template").replaceChildren();
    ui.templateRoles = [];
    $("new-error").textContent = "";
    $("new-orchestrator").checked = orchestrator;
    $("new-isolate").checked = false;
    $("new-worktree-mode").value = "new";
    $("new-worktree-name").value = "";
    syncNewKind();
    syncOrchestrator();
    $("new-dialog").showModal();
    fillTemplates();
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
    if ($("new-isolate").checked) $(existingWorkbranchMode() ? "new-worktree-branch" : "new-worktree-name").focus();
  });
  $("new-worktree-mode").addEventListener("change", () => syncNewWorktree(true));
  $("new-worktree-name").addEventListener("input", syncNewWorktree);
  $("p-orchestrator").addEventListener("click", () => openNew(navigation.project, { orchestrator: true }));
  $("new-project").addEventListener("change", () => {
    branchPicker.reset();
    syncNewWorktree(true);
    void fillTemplates();
  });
  $("new-template").addEventListener("change", applyTemplate);

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
    body.isolate = form.has("isolate") && !body.chat;
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
    ui.creating = true;
    syncNewSubmit();
    try {
      const created = await api("POST", "/api/sessions", body);
      // 생성 후 연결이 실패해도 세션을 중복 생성하지 않게 생성 창부터 닫는다.
      if (ui.newSessionContext === context) {
        ui.newSessionContext = null;
        $("new-dialog").close();
        e.target.reset();
      }
      // 그래프에서 만든 세션은 지정한 자리에 놓고, 손잡이에서 시작했으면 바로 연결한다.
      if (context?.pos && !context.cancelled && !body.chat && navigation.view === "project" &&
          samePath(context.projectPath, body.projectPath) && samePath(navigation.project, body.projectPath)) {
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

  function cancelCreation() {
    if (ui.newSessionContext) ui.newSessionContext.cancelled = true;
    ui.newSessionContext = null;
    branchPicker.reset();
    if ($("new-dialog").open) $("new-dialog").close();
  }

  return { openNew, cancelCreation };
}

import { $, AGENT_LABEL, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";

export function createCreationController({ api, loadStatus, loadSessions, loadProjects, sortedProjects, connectCreatedGraphNode, loadHub, fillModels, fillEfforts, openChat, openSettings, data, navigation }) {
  const ui = {
    "templateRoles": null,
    "newSessionContext": null
  };
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
    if (!name) return "워크트리 이름을 입력하세요.";
    if (!/^[A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ][A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ_-]{0,63}$/u.test(name)) {
      return "워크트리 이름은 1~64자의 영문·숫자·한글·하이픈·밑줄만 쓸 수 있으며, 영문·숫자·한글로 시작해야 합니다.";
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return "워크트리 이름으로 Windows 예약어를 사용할 수 없습니다.";
    return "";
  }

  function syncNewWorktree() {
    const chat = newKind().chat;
    const useWorktree = !chat && $("new-isolate").checked;
    const input = $("new-worktree-name");
    $("new-isolate").disabled = chat;
    $("new-worktree-row").hidden = !useWorktree;
    input.disabled = !useWorktree;
    input.required = useWorktree;
    input.setCustomValidity(useWorktree ? worktreeNameError(input.value) : "");
  }

  function fillPermissions() {
    const { agent } = newKind();
    const modes = data.status.agents[agent].permissions;
    $("new-permission").replaceChildren(...modes.map((m) => el("option", { value: m }, m)));
    $("new-permission").value = modes.at(-1);
    // Claude의 bypassPermissions는 기본값으로 두지 않는다.
    if (agent === "claude") $("new-permission").value = "acceptEdits";
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
      ...roles.map((r) => el("option", { value: r.name }, `${r.name} · ${AGENT_LABEL[r.agent]} · ${r.permission}`)));
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
  async function openNew(projectPath, { orchestrator = false, kind, pos = null, connectFrom = null } = {}) {
    if (ui.newSessionContext) ui.newSessionContext.cancelled = true;
    const context = { projectPath, pos, connectFrom };
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
    syncNewWorktree();
    if ($("new-isolate").checked) $("new-worktree-name").focus();
  });
  $("new-worktree-name").addEventListener("input", syncNewWorktree);
  $("p-orchestrator").addEventListener("click", () => openNew(navigation.project, { orchestrator: true }));
  $("new-project").addEventListener("change", fillTemplates);
  $("new-template").addEventListener("change", applyTemplate);

  $("new-dialog").addEventListener("close", () => {
    if (ui.newSessionContext) ui.newSessionContext.cancelled = true;
    ui.newSessionContext = null;
  });

  $("new-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const context = ui.newSessionContext;
    const form = new FormData(e.target);
    const { kind, ...body } = Object.fromEntries(form);
    Object.assign(body, newKind());
    body.orchestrator = form.has("orchestrator") && !body.chat;
    body.isolate = form.has("isolate") && !body.chat;
    if (body.isolate) {
      body.worktreeName = String(body.worktreeName ?? "").trim();
      const error = worktreeNameError(body.worktreeName);
      if (error) {
        $("new-error").textContent = error;
        $("new-worktree-name").focus();
        return;
      }
    } else delete body.worktreeName;
    if (body.chat) delete body.projectPath;
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
      $("new-error").textContent = err.message;
    }
  });

  function cancelCreation() {
    if (ui.newSessionContext) ui.newSessionContext.cancelled = true;
    ui.newSessionContext = null;
    if ($("new-dialog").open) $("new-dialog").close();
  }

  return { openNew, cancelCreation };
}

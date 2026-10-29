import { createGraphView } from "./view.js";
import { createNodeGroups } from "./node-groups.js";
import { KIND_LABEL, kindOf, hasBranchPorts, resultOnlyOutputs, hasWorktreeOutput, worktreeByDefault, isSourceOnly, isScheduleArmed } from "../commands/flow-nodes.js";
import { PAD, SVG_NS, isCommandNode, nodeSize, layoutGraph, edgePath } from "./model.js";
import { $, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { linkLabel } from "../../shared/flow.js";
import { openContextMenu, closeContextMenu } from "../../shared/context-menu.js";
import { createFlowAssistant } from "./flow-assistant.js";
import { createGraphHistory, linkBody, commandBody } from "./history.js";
import { createGraphTabs, graphScopeKey, inGraphTab, nodeTabId } from "./tabs.js";
import { showError } from "../../shared/error-report.js";
import { createFrameTask } from "../../shared/frame-task.js";
import { createLabelPlacer } from "./edge-layout.js";

export function createGraphController({ projectTab, openSessionWindow, api, goProject, selectSession, loadSessions, sessionById, commandById, nodeTitle, loadCommands, commandNode, runCommand, stopCommand, clearCommandError, removeCommand, openCommandDialog, openCommandOutput, skillChips, openSkillsManager, renderFlow, restartSession, clearSessionError, toggleSessionLock, openSessionMenu, openNew, cancelNodeCreation, saveGroupTemplate, openGroupTemplates, clearExecutionControls, data, navigation }) {
  const ui = {
    "graph": null,
    "graphSelected": new Set(),
    "graphGesture": null,
    "deletingGraphNodes": null,
    "editingLink": null
  };
  const view = createGraphView({ skillChips, restartSession, clearSessionError, toggleSessionLock, commandNode });
  // Hosts with graphTabId opt into tabs; a standalone embedded graph may omit them.
  const tabsEnabled = Object.hasOwn(navigation, "graphTabId");
  const tabViews = new Map();
  const visibleNode = (node) => inGraphTab(node, data, navigation);
  const history = createGraphHistory({
    refresh: (projectPath) => Promise.all([loadSessions(), loadCommands(projectPath), loadLinks()]),
    onChange: renderHistoryButtons,
    getScope: () => navigation.graphTabId ?? null,
  });
  // 그래프 아래 AI 입력창. 적용하면 새로 만든 노드를 골라 둔다.
  const assistant = createFlowAssistant({ api, navigation, getSelected: () => [...ui.graphSelected],
    onApplied: async (created, context = { projectPath: navigation.project, tabId: navigation.graphTabId }) => {
      await Promise.all([loadSessions(), loadCommands(context.projectPath), loadLinks()]);
      if (!samePath(context.projectPath, navigation.project) || context.tabId !== navigation.graphTabId) return;
      ui.graphSelected = new Set(created);
      syncGraphSelection();
    } });

  const nodeGroups = createNodeGroups({ api, data, navigation, ui, history, renderGraph, loadSessions, loadCommands, runCommand, saveGroupTemplate, trackGesture: trackGraphGesture, canvasPoint, placeCards, openLinkDialog, openCreateMenu: openGraphCreateMenu, syncSelection: syncGraphSelection });
  const tabs = createGraphTabs({ api, data, navigation,
    beforeSwitch: ({ force }) => {
      if (!force && (history.state(navigation.project).running || ui.deletingGraphNodes || ui.graphSaving)) return false;
      clearGraphTransientState();
      ui.graph = null;
      return true;
    },
    onSwitch: () => { if (navigation.view === "project") renderGraph(); },
    onChanged: async (projectPath, { tabIds = [] } = {}) => {
      history.invalidate(projectPath, tabIds);
      for (const id of tabIds) {
        const saved = tabViews.get(graphScopeKey(projectPath, id));
        if (saved) saved.selected = [];
      }
      if (samePath(projectPath, navigation.project) && tabIds.includes(navigation.graphTabId)) ui.graphSelected.clear();
      await Promise.all([loadSessions(), loadCommands(projectPath), loadLinks()]);
    },
    getSelection: () => [...ui.graphSelected],
  });

  function saveTabView() {
    const g = ui.graph;
    if (!g) return;
    const value = { pan: { ...g.pan }, zoom: g.zoom, selected: [...ui.graphSelected] };
    tabViews.set(graphScopeKey(g.projectPath, g.tabId), value);
    try {
      const all = JSON.parse(localStorage.getItem("agenthub-graph-views") ?? "{}");
      all[graphScopeKey(g.projectPath, g.tabId)] = { pan: value.pan, zoom: value.zoom };
      localStorage.setItem("agenthub-graph-views", JSON.stringify(all));
    } catch { /* Keep the in-memory view when browser storage is unavailable. */ }
  }
  function tabView() {
    const key = graphScopeKey(navigation.project, navigation.graphTabId);
    if (tabViews.has(key)) return tabViews.get(key);
    try { return JSON.parse(localStorage.getItem("agenthub-graph-views") ?? "{}")[key]; } catch { return null; }
  }

  // ── 세션 흐름 그래프 ────────────────────────────────────────────

  async function loadMessages(projectPath = navigation.project) {
    if (!projectPath) return;
    try {
      const messages = await api("GET", `/api/messages?path=${encodeURIComponent(projectPath)}`);
      if (!samePath(projectPath, navigation.project)) return;
      data.messages = messages;
    } catch {
      return;
    }
    if (navigation.view === "project") drawEdges();
  }

  async function loadLinks() {
    const before = new Set((data.links ?? []).filter((l) => l.pending).map((l) => l.id));
    try {
      data.links = await api("GET", "/api/links");
      await nodeGroups.load(navigation.project, { render: false });
    } catch {
      return;
    }
    // 새로 승인을 기다리는 넘기기가 생기면 알린다.
    for (const link of data.links) if (link.pending && !before.has(link.id)) notifyGate(link);
    if (navigation.view === "project") renderGraph();
    if (navigation.view === "session") renderFlow();
  }

  // 옮기지 않은 카드는 연결을 따라 왼쪽에서 오른쪽으로 놓는다. 같은 단계 안에서는 만든 순서대로 쌓는다.

  function renderGraph() {
    if (projectTab && (navigation.view !== "project" || projectTab() !== "flow")) return;
    const box = $("p-graph");
    tabs.ensureLoaded();
    tabs.render();
    nodeGroups.ensureLoaded();
    if (tabsEnabled && !tabs.ready()) {
      ui.graph = null;
      ui.graphSelected.clear();
      box.replaceChildren(el("div", { class: "graph-empty" }, tabs.error() || "그리드 탭을 불러오는 중…"));
      $("p-relayout").disabled = true;
      $("p-flow-assistant-prompt").disabled = true;
      $("p-flow-assistant-send").disabled = true;
      renderHistoryButtons();
      return;
    }
    $("p-relayout").disabled = false;
    assistant.selectionChanged();
    if (ui.graph && (ui.graph.dragging || ui.graphGesture)) {
      ui.graph.needsRender = true; // 데이터 변경은 끌기를 마친 뒤 한 번 반영한다.
      return;
    }
    const sessions = data.sessions
      .filter((s) => samePath(s.projectPath, navigation.project) && visibleNode(s))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const cmdNodes = samePath(data.commandsProject, navigation.project) ? (data.commands ?? []).filter(visibleNode) : [];
    if (!sessions.length && !cmdNodes.length && !nodeGroups.groups().length) {
      ui.graph = null;
      ui.graphSelected.clear();
      box.replaceChildren(el("div", { class: "graph-empty" },
        "이 그리드는 비어 있습니다. 여기서 우클릭하거나 아래 입력창에 만들 노드를 적으면 카드로 보입니다."));
      assistant.selectionChanged();
      renderZoomLabel();
      renderHistoryButtons();
      return;
    }
    // 명령 노드는 세션과 같은 흐름 안에 놓인다(세션 → 명령 → 세션).
    const ids = new Set([...sessions, ...cmdNodes].map((s) => s.id));
    const links = data.links.filter((l) => ids.has(l.from) && ids.has(l.to));
    // 오케스트레이터가 만든 세션은 지휘선으로 잇고, 배치도 오케스트레이터를 앞에 둔다.
    const commands = sessions.filter((s) => ids.has(s.createdBy)).map((s) => ({ from: s.createdBy, to: s.id }));
    // 결과 모으기은 묶은 세션에서 점선 묶음선으로 잇고, 배치도 묶은 세션 뒤에 둔다.
    const members = cmdNodes.filter((c) => c.kind === "group")
      .flatMap((c) => (c.members ?? []).filter((id) => ids.has(id)).map((id) => ({ from: id, to: c.id })));
    const pos = layoutGraph([...sessions, ...cmdNodes], [...commands, ...members, ...links]);

    const { canvas, svg, cards } = view.createCanvas(sessions, cmdNodes);
    // 캔버스를 배율에 맞춰 그리고, 프로젝트별 화면 이동 위치를 유지한다.
    const sizer = el("div", { class: "graph-sizer" }, canvas);
    const sameGraph = samePath(ui.graph?.projectPath, navigation.project) && ui.graph?.tabId === navigation.graphTabId;
    const saved = tabView();
    const pan = sameGraph ? { ...ui.graph.pan } : saved?.pan && Number.isFinite(saved.pan.x) && Number.isFinite(saved.pan.y) ? { ...saved.pan } : { x: 0, y: 0 };
    if (!sameGraph) ui.graphSelected = new Set(saved?.selected ?? []);
    ui.graph = { canvas, sizer, svg, cards, pos, links, commands, members, zoom: graphZoomFor(navigation.project), pan, projectPath: navigation.project, tabId: navigation.graphTabId };
    nodeGroups.render(ui.graph);
    placeCards();
    syncGraphSelection();
    box.replaceChildren(sizer);
    renderRemoteLinks(box, ids);
    renderZoomLabel();
    renderHistoryButtons();
  }

  function renderRemoteLinks(box, visibleIds) {
    const all = new Map([...data.sessions, ...(samePath(data.commandsProject, navigation.project) ? data.commands ?? [] : [])]
      .filter((node) => samePath(node.projectPath, navigation.project)).map((node) => [node.id, node]));
    const remote = (data.links ?? []).filter((link) => visibleIds.has(link.from) !== visibleIds.has(link.to));
    const buttons = remote.flatMap((link) => {
      const target = all.get(visibleIds.has(link.from) ? link.to : link.from);
      const tab = tabs.tabs().find((item) => item.id === nodeTabId(target, data));
      if (!target || !tab || tab.id === navigation.graphTabId) return [];
      const jump = el("button", { type: "button", class: link.pending ? "pending" : "", "data-remote-tab": tab.id,
        title: `${nodeTitle(link.from)} → ${nodeTitle(link.to)} · ${linkLabel(link)}`,
        onclick: () => tabs.select(tab.id),
        oncontextmenu: (event) => { event.preventDefault(); event.stopPropagation(); openLinkDialog(link); } }, `${link.pending ? "승인 대기 · " : ""}${visibleIds.has(link.from) ? "→" : "←"} ${tab.title} · ${target.title}`);
      if (!link.pending) return [jump];
      const gate = gateLabel(link);
      gate.className = "graph-remote-gate";
      return [jump, gate];
    });
    if (buttons.length) box.append(el("div", { class: "graph-remote-links", "aria-label": "다른 탭과의 연결", onpointerdown: (event) => event.stopPropagation(), ondblclick: (event) => event.stopPropagation(), oncontextmenu: (event) => event.stopPropagation() }, ...buttons));
  }
  // 카드 끌기·연결·선택 상자. 그래프에 초점을 두면 Delete로 선택한 노드를 한 번에 지운다.
  $("p-graph").tabIndex = 0;
  $("p-graph").addEventListener("pointerdown", onGraphPointerDown);
  $("p-graph").addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  $("p-graph").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g" && !e.repeat && !e.target.closest("input, textarea, select, [contenteditable]")) {
      e.preventDefault();
      if (!document.querySelector("dialog[open]") && navigation.view === "project") void nodeGroups.create();
      return;
    }
    if (e.key !== "Delete" || e.repeat || e.isComposing || e.defaultPrevented) return;
    if (e.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])")) return;
    if (document.querySelector("dialog[open]")) return;
    if (!ui.graphSelected.size || navigation.view !== "project" || ui.graph?.dragging) return;
    e.preventDefault();
    deleteGraphSelection();
  });

  // ── 되돌리기·다시 실행 ──────────────────────────────────────────
  // Ctrl+Z 되돌리기, Ctrl+Y 또는 Ctrl+Shift+Z 다시 실행. 입력 중이거나 창이 열려 있으면 그 칸의 기본 동작을 둔다.
  function renderHistoryButtons() {
    const state = history.state(navigation.project);
    $("p-undo").disabled = !state.undo;
    $("p-redo").disabled = !state.redo;
    $("p-undo").title = state.undo ? `되돌리기: ${state.undo} (Ctrl+Z)` : "되돌릴 변경이 없습니다 (Ctrl+Z)";
    $("p-redo").title = state.redo ? `다시 실행: ${state.redo} (Ctrl+Y)` : "다시 실행할 변경이 없습니다 (Ctrl+Y)";
  }
  async function stepHistory(action) {
    if (navigation.view !== "project" || ui.graph?.dragging || document.querySelector("dialog[open]")) return;
    closeContextMenu();
    const result = await history[action](navigation.project);
    if (result && !result.ok) showError({ message: `"${result.label}"을(를) ${action === "undo" ? "되돌리지" : "다시 실행하지"} 못했습니다. 그 사이 노드나 연결이 바뀌었을 수 있습니다.`, hint: "그래프에서 노드와 연결을 직접 확인해 고치세요.", raw: result.error.message }, { action: action === "undo" ? "실행 취소" : "다시 실행" });
  }
  $("p-undo").addEventListener("click", () => { void stepHistory("undo"); });
  $("p-redo").addEventListener("click", () => { void stepHistory("redo"); });
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing || e.defaultPrevented) return;
    const key = e.key.toLowerCase();
    const action = key === "z" ? e.shiftKey ? "redo" : "undo" : key === "y" && !e.shiftKey ? "redo" : null;
    if (!action || navigation.view !== "project" || !$("p-graph").getClientRects().length) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])") || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    if (!e.repeat) void stepHistory(action);
  });
  renderHistoryButtons();

  const storedPos = (id) => { const pos = commandById(id)?.pos ?? sessionById(id)?.graphPos ?? null; return pos ? { ...pos } : null; };
  // 위치를 저장한다. null이면 자동 배치로 돌아간다.
  const putPos = (id, pos) => isCommandNode(id) ? api("PUT", `/api/commands/${id}`, { pos }) : api("PUT", `/api/sessions/${id}`, { graphPos: pos });
  const groupMembers = () => new Map(nodeGroups.groups().map((group) => [group.id, [...group.members]]));
  async function restoreLayout(positions, members, { resolve }) {
    for (const [id, pos] of positions) await putPos(resolve(id), pos);
    for (const [id, list] of members) await api("PUT", `/api/node-groups/${resolve(id)}`, { members: list.map(resolve) });
  }
  // 연결을 지운 것을 되살린다. 지운 연결의 id는 새 연결 id로 이어 둔다.
  async function restoreLink(link, { resolve, remap }) {
    const created = await api("POST", "/api/links", { ...linkBody(link), from: resolve(link.from), to: resolve(link.to) });
    remap(link.id, created.id);
  }
  // 지울 노드의 설정과 이어진 연결
  const nodeSnapshot = (node) => ({ id: node.id, title: node.title, body: commandBody(node),
    links: data.links.filter((l) => l.from === node.id || l.to === node.id).map((l) => ({ ...l })) });
  // 노드를 지운 것을 기록한다. 되돌리면 노드를 다시 만들고 연결을 잇는다. 끝이 사라진(지운 세션 등) 연결은 건너뛴다.
  function recordNodesRemoved(projectPath, removed, tabId = navigation.graphTabId) {
    if (!removed.length) return;
    history.record(projectPath, { tabId, label: removed.length > 1 ? `노드 ${removed.length}개 삭제` : `"${removed[0].title}" 삭제`,
      undo: async (tools) => {
        for (const node of removed) {
          const body = node.body.members ? { ...node.body, members: node.body.members.map(tools.resolve) } : node.body;
          tools.remap(node.id, (await api("POST", "/api/commands", body)).id);
        }
        const links = [...new Map(removed.flatMap((node) => node.links).map((l) => [l.id, l])).values()];
        for (const link of links) await restoreLink(link, tools).catch(() => {});
      },
      redo: async ({ resolve }) => { for (const node of removed) await api("DELETE", `/api/commands/${resolve(node.id)}`); },
    });
  }
  function recordLinkCreated(projectPath, link, tabId = navigation.graphTabId) {
    history.record(projectPath, { tabId, label: "연결 만들기",
      undo: ({ resolve }) => api("DELETE", `/api/links/${resolve(link.id)}`),
      redo: (tools) => restoreLink(link, tools) });
  }

  // 흐름 그래프 우클릭: 세션 카드는 세션 메뉴, 명령 노드는 명령 메뉴, 빈 곳은 그 자리에 새 세션·명령을 만든다.
  $("p-graph").addEventListener("contextmenu", (e) => {
    if (tabsEnabled && !tabs.ready()) { e.preventDefault(); return; }
    if (e.target.closest(".edge-label")) return;
    const frame = e.target.closest(".node-group");
    if (frame) {
      const group = nodeGroups.byId(frame.dataset.groupId);
      if (group) openContextMenu(e, `노드 그룹 ${group.title}`, [...nodeGroups.contextEntries(group), ...tabs.moveEntries([group.id])]);
      return;
    }
    const card = e.target.closest(".gcard, .gcmd");
    const cmd = card && commandById(card.dataset.id);
    // 그룹 묶기 항목은 노드를 둘 이상 골랐을 때만 붙인다. 하나만 골랐으면 평소 메뉴를 연다.
    const grouping = card && ui.graphSelected.size > 1 ? [...nodeGroups.selectedEntries(), null] : [];
    const moving = card ? tabs.moveEntries(ui.graphSelected.has(card.dataset.id) ? [...ui.graphSelected] : [card.dataset.id]) : [];
    if (cmd) {
      const running = ["running", "watching"].includes(cmd.state) || isScheduleArmed(cmd);
      const kind = cmd.kind ?? "command";
      const label = KIND_LABEL[kindOf(cmd)];
      openContextMenu(e, `${label} ${cmd.title}`, [
        ...grouping,
        ...moving,
        kind === "markdown"
          ? ["결과 보기", () => openCommandOutput(cmd), { disabled: !cmd.lastRun?.output }]
          : kind === "schedule" ? [running ? "예약 중지" : "예약 시작", () => running ? stopCommand(cmd) : runCommand(cmd)]
          : kind === "group" ? ["지금 넘기기", () => runCommand(cmd), { title: "모을 노드가 모두 끝났을 때 넘깁니다" }]
            : running ? ["중지", () => stopCommand(cmd)] : ["지금 실행", () => runCommand(cmd)],
        ...(kind !== "markdown" && (cmd.lastRun || cmd.live) ? [["결과 보기", () => openCommandOutput(cmd)]] : []),
        ...(cmd.state === "error" ? [["오류 해제", () => clearCommandError(cmd), { title: "오류 표시만 지웁니다. 마지막 실행 기록은 남습니다." }]] : []),
        ["편집", () => openCommandDialog(cmd)],
        null,
        ["삭제", () => removeCommand(cmd), { danger: true }],
      ]);
      return;
    }
    if (card) {
      const s = sessionById(card.dataset.id);
      if (s && (grouping.length > 1 || moving.length)) openContextMenu(e, s.title, [...grouping, ...moving, ["세션 메뉴", () => openSessionMenu(e, s)]]);
      else if (s) openSessionMenu(e, s);
      return;
    }
    openGraphCreateMenu(e);
  });

  // 손잡이를 빈 곳에 놓았을 때도 같은 생성 메뉴를 쓰고, 만든 노드에 바로 잇는다.
  function openGraphCreateMenu(e, connectFrom = null, connectWhen = null, connectKeyword = "") {
    if (tabsEnabled && !tabs.ready()) return;
    const projectPath = navigation.project;
    const tabId = navigation.graphTabId;
    const at = ui.graph ? canvasPoint(e) : { x: PAD, y: PAD };
    const pos = { x: Math.max(0, Math.round(at.x)), y: Math.max(0, Math.round(at.y)) };
    const inProject = (action) => () => {
      if (navigation.view === "project" && samePath(projectPath, navigation.project) && tabId === navigation.graphTabId) action();
    };
    const node = (label, kind) => [label, inProject(() => openCommandDialog(null, pos, connectFrom, kind, { connectWhen, connectKeyword }))];
    const start = (label, kind) => [label, inProject(() => openCommandDialog(null, pos, null, kind))];
    // 고른 세션 카드가 있으면 그 세션들을 미리 골라 둔다.
    const picked = [...ui.graphSelected].filter((id) => { const node = sessionById(id) ?? commandById(id); return node && !node.chat && !["button", "markdown", "watch", "schedule", "webhook-in", "group"].includes(node.kind); });
    const collect = [picked.length > 1 && !connectFrom ? `선택한 노드 ${picked.length}개 결과 모으기` : "새 결과 모으기",
      inProject(() => openCommandDialog(null, pos, connectFrom, "group", { members: connectFrom ? [] : picked, connectWhen, connectKeyword }))];
    // 종류별로 묶는다. 시작점 노드는 들어오는 연결을 받을 수 없으므로 손잡이에서 열었을 때는 뺀다.
    const sections = [
      ["AI", [["새 세션", inProject(() => openNew(projectPath, { pos, connectFrom, connectWhen, connectKeyword }))]]],
      ["시작", connectFrom ? [] : [start("새 버튼", "button"), start("새 입력 폼", "input"), start("새 파일 감시", "watch"), start("새 시간 예약", "schedule"), start("새 웹훅 받기", "webhook-in")]],
      ["실행", [node("새 명령", "command"), node("새 GIT", "git")]],
      ["작업", [
        ["새 작업", inProject(() => openCommandDialog(null, pos, connectFrom, "task", { connectWhen, connectKeyword, taskAction: "start" }))],
        ["작업 마무리", inProject(() => openCommandDialog(null, pos, connectFrom, "task", { connectWhen, connectKeyword, taskAction: "finish" }))]]],
      ["흐름 제어", [node("새 반복 제어", "repeat"), node("새 결과 가공", "transform"), collect]],
      ["출력", [node("새 알림", "notify"), node("새 웹훅 보내기", "webhook"), node("새 Markdown 출력", "markdown")]],
    ];
    const selected = !connectFrom ? nodeGroups.selectedEntries() : [];
    openContextMenu(e, connectFrom ? "새 노드에 연결" : "여기에 만들기", [
      ...selected, ...(selected.length ? [null] : []),
      ...sections.filter(([, items]) => items.length).flatMap(([title, items]) => [title, ...items]),
      null,
      ...(!connectFrom && openGroupTemplates ? [["그룹 템플릿 추가", inProject(() => openGroupTemplates(pos))]] : []),
      ["스킬 관리", inProject(() => openSkillsManager())],
    ]);
  }

  function clearGraphTransientState() {
    saveTabView();
    ui.graphGesture?.cancel();
    assistant.reset();
    closeContextMenu();
    cancelNodeCreation();
    clearExecutionControls?.();
    document.getElementById("node-group-dialog")?.close?.();
    document.getElementById("link-dialog")?.close?.();
    document.getElementById("p-graph-tab-dialog")?.close?.();
    ui.graphSelected.clear();
  }

  function highlightSessions(ids = new Set()) {
    for (const [id, card] of ui.graph?.cards ?? []) card.classList.toggle("skill-hit", ids.has(id));
  }

  function clearSelection() {
    ui.graphSelected.clear();
    syncGraphSelection();
  }

  // 취소·포커스 상실·화면 전환에도 임시 선과 선택 상자가 남지 않게 정리한다.
  function trackGraphGesture(startEvent, onMove, onEnd) {
    ui.graphGesture?.cancel();
    const graph = ui.graph;
    let active = true;
    const matches = (e) => e.pointerId === startEvent.pointerId;
    const motion = createFrameTask(onMove);
    const move = (e) => { if (matches(e)) motion.schedule(e); };
    const finish = (e, cancelled) => {
      if (!active) return;
      if (cancelled) motion.cancel(); else motion.flush();
      active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("blur", cancel);
      if (ui.graphGesture?.cancel === cancel) ui.graphGesture = null;
      onEnd(e, cancelled);
      if (graph?.needsRender && ui.graph === graph && !graph.dragging && navigation.view === "project") renderGraph();
    };
    const up = (e) => { if (matches(e)) finish(e, false); };
    const abort = (e) => { if (matches(e)) finish(e, true); };
    const cancel = () => finish(startEvent, true);
    ui.graphGesture = { cancel };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", cancel);
  }

  async function connectCreatedGraphNode(context, to, projectPath) {
    if (!context?.connectFrom || context.cancelled || !samePath(context.projectPath, projectPath)) return;
    if (navigation.view !== "project" || !samePath(navigation.project, projectPath)) return;
    if (context.tabId !== undefined && context.tabId !== navigation.graphTabId) return;
    const source = sessionById(context.connectFrom) ??
      (samePath(data.commandsProject, projectPath) ? commandById(context.connectFrom) : null);
    if (!source || (source.projectPath && !samePath(source.projectPath, projectPath))) return;
    const tabId = context.tabId ?? navigation.graphTabId;
    try {
      const when = context.connectWhen ?? (["git", "task"].includes(source.kind) ? "success" : null);
      const target = commandById(to);
      const targetKind = target?.kind ?? context.kind ?? "session";
      const link = await api("POST", "/api/links", { from: source.id, to, ...(when ? { when, keyword: context.connectKeyword ?? "" } : defaultLinkCondition(source.id)), ...(hasWorktreeOutput(source) ? { useGitWorktree: when === "success" && worktreeByDefault(source) && ["session", "command"].includes(targetKind) } : {}), enabled: true });
      if (link?.id) recordLinkCreated(projectPath, link, tabId);
      await loadLinks();
    } catch (err) {
      showError({ message: `노드는 만들었지만 연결하지 못했습니다: ${err.message}`, hint: "노드의 손잡이를 끌어 다시 연결해 주세요.", reason: err.reason }, { action: "새 노드 연결" });
    }
  }

  // 우클릭 메뉴. entries: [이름, 동작, { danger, disabled, title }] 또는 구분선 null

  function placeCards() {
    const g = ui.graph;
    let width = 0;
    let height = 0;
    for (const [id, card] of g.cards) {
      const p = g.pos.get(id);
      const size = nodeSize(id);
      card.style.left = `${p.x}px`;
      card.style.top = `${p.y}px`;
      width = Math.max(width, p.x + size.w + PAD + (hasBranchPorts(commandById(id)) ? 32 : 0));
      height = Math.max(height, p.y + size.h + PAD);
    }
    // 되돌아가는 연결은 카드 아래로 휘어 내려가므로(edgePath) 그 선과 라벨이 잘리지 않게 아래 여백을 더 둔다.
    for (const link of g.links) {
      const a = g.pos.get(link.from);
      const b = g.pos.get(link.to);
      if (!a || !b || b.x >= a.x + nodeSize(link.from).w) continue;
      height = Math.max(height, Math.max(a.y + nodeSize(link.from).h, b.y + nodeSize(link.to).h) + 64);
    }
    g.size = { width, height };
    nodeGroups.place(g);
    g.canvas.style.width = `${g.size.width}px`;
    g.canvas.style.height = `${g.size.height}px`;
    applyGraphZoom();
    if (g.dragging && g.edgeGeometry) moveEdges();
    else drawEdges();
  }

  // ── 그래프 확대·축소 ────────────────────────────────────────────
  // 배율은 프로젝트마다 이 브라우저에 기억한다. 카드 위치는 배율과 상관없는 캔버스 좌표로 저장한다.
  const ZOOM_KEY = "agenthub-graph-zoom";
  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 2;

  function graphZoomFor(projectPath) {
    const saved = tabView()?.zoom;
    if (Number.isFinite(saved)) return Math.min(2, Math.max(.3, saved));
    try {
      const all = JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "{}");
      const z = all[graphScopeKey(projectPath, navigation.graphTabId)] ?? (!navigation.graphTabId || navigation.graphTabId === data.defaultGraphTabId ? all[String(projectPath).toLowerCase()] : null);
      return Number.isFinite(z) ? z : 1;
    } catch {
      return 1;
    }
  }

  function saveGraphZoom(projectPath, zoom) {
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "{}");
    } catch {
      // 깨진 값은 새로 쓴다.
    }
    all[graphScopeKey(projectPath, navigation.graphTabId)] = zoom;
    localStorage.setItem(ZOOM_KEY, JSON.stringify(all));
    saveTabView();
  }

  function applyGraphZoom() {
    const g = ui.graph;
    if (!g?.size) return;
    g.canvas.style.transform = g.zoom === 1 ? "" : `scale(${g.zoom})`;
    g.canvas.style.left = `${g.pan.x}px`;
    g.canvas.style.top = `${g.pan.y}px`;
  }

  function renderZoomLabel() {
    const z = ui.graph?.zoom ?? 1;
    $("p-zoom-reset").textContent = `${Math.round(z * 100)}%`;
    $("p-zoom-out").disabled = z <= ZOOM_MIN;
    $("p-zoom-in").disabled = z >= ZOOM_MAX;
  }

  // anchor(clientX·clientY)가 가리키는 지점이 그 자리에 머물도록 배율을 바꾼다. 없으면 보이는 칸의 가운데를 기준으로 한다.
  function setGraphZoom(zoom, anchor = null) {
    const g = ui.graph;
    if (!g?.canvas.isConnected) return;
    const box = $("p-graph");
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
    if (next === g.zoom) return;
    const rect = box.getBoundingClientRect();
    const ax = anchor ? anchor.clientX - rect.left : box.clientWidth / 2;
    const ay = anchor ? anchor.clientY - rect.top : box.clientHeight / 2;
    const cx = (ax - g.pan.x) / g.zoom;
    const cy = (ay - g.pan.y) / g.zoom;
    g.pan = { x: ax - cx * next, y: ay - cy * next };
    g.zoom = next;
    saveGraphZoom(navigation.project, next);
    applyGraphZoom();
    renderZoomLabel();
  }

  // 모든 카드가 보이게 맞춘다. 작으면 키우지 않는다(100%까지).
  function fitGraph() {
    const g = ui.graph;
    if (!g?.size) return;
    const box = $("p-graph");
    const fit = Math.floor(Math.min(1, box.clientWidth / g.size.width, box.clientHeight / g.size.height) * 100) / 100;
    setGraphZoom(fit);
    g.pan = { x: 0, y: 0 };
    applyGraphZoom();
    box.scrollLeft = 0;
    box.scrollTop = 0;
  }

  $("p-zoom-in").addEventListener("click", () => setGraphZoom((ui.graph?.zoom ?? 1) * 1.2));
  $("p-zoom-out").addEventListener("click", () => setGraphZoom((ui.graph?.zoom ?? 1) / 1.2));
  $("p-zoom-reset").addEventListener("click", () => setGraphZoom(1));
  $("p-zoom-fit").addEventListener("click", fitGraph);

  // 휠로 커서 자리를 기준으로 확대·축소한다(터치패드 오므리기·벌리기도 포함).
  $("p-graph").addEventListener("wheel", (e) => {
    if (!ui.graph?.canvas.isConnected) return;
    e.preventDefault();
    if (ui.graph.dragging) return;
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? $("p-graph").clientHeight : 1);
    setGraphZoom((ui.graph.zoom ?? 1) * Math.exp(-delta * 0.0015), e);
  }, { passive: false });

  // sa·sb: 양 끝 노드 크기

  function graphEdgePath(g, from, to, link = {}) {
    if (nodeGroups.containsHiddenEdge(g, from, to)) return null;
    if (!g.groupByMember?.has(from) && !g.groupByMember?.has(to)) {
      if (!g.pos.has(from) || !g.pos.has(to)) return null;
      return edgePath(g.pos.get(from), g.pos.get(to), nodeSize(from), nodeSize(to), hasBranchPorts(commandById(from)) ? link.when === "error" ? 78 : 40 : null);
    }
    const a = nodeGroups.endpoint(g, from, "output", to, link), b = nodeGroups.endpoint(g, to, "input", from, link);
    if (!a || !b) return null;
    const dx = Math.max(48, Math.abs(b.x - a.x) / 2);
    return { d: `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  function drawEdges() {
    const g = ui.graph;
    if (!g) return;
    g.svg.querySelectorAll("path.edge").forEach((n) => n.remove());
    g.canvas.querySelectorAll(".edge-label").forEach((n) => n.remove());
    g.edgeGeometry = [];
    const remember = (path, from, to, link = {}, label = null) => g.edgeGeometry.push({ path, from, to, link, label });
    // 메시지를 주고받은 세션 사이의 대화선(방향 없이 한 줄, 주고받은 수를 툴팁으로)
    const talks = new Map();
    for (const m of data.messages ?? []) {
      if (!g.pos.has(m.from) || !g.pos.has(m.to)) continue;
      const key = [m.from, m.to].sort().join(" ");
      const talk = talks.get(key) ?? { from: m.from, to: m.to, count: 0, last: m };
      talk.count++;
      talk.last = m;
      talks.set(key, talk);
    }
    for (const talk of talks.values()) {
      const edge = graphEdgePath(g, talk.from, talk.to);
      if (!edge) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edge.d);
      path.setAttribute("class", "edge message");
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `메시지 ${talk.count}개 · 마지막: ${nodeTitle(talk.last.from)} → ${nodeTitle(talk.last.to)}
  ${talk.last.text}`;
      path.append(title);
      g.svg.append(path);
      remember(path, talk.from, talk.to);
    }
    for (const command of g.commands) {
      const edge = graphEdgePath(g, command.from, command.to);
      if (!edge) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edge.d);
      path.setAttribute("class", "edge command");
      g.svg.append(path);
      remember(path, command.from, command.to);
    }
    for (const member of g.members ?? []) {
      const edge = graphEdgePath(g, member.from, member.to);
      if (!edge) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edge.d);
      path.setAttribute("class", "edge member");
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `${nodeTitle(member.from)} → 결과 모으기 ${nodeTitle(member.to)}`;
      path.append(title);
      g.svg.append(path);
      remember(path, member.from, member.to);
    }
    // Expanded groups show the correspondence between boundary ports and real nodes.
    for (const group of nodeGroups.groups().filter((item) => !item.collapsed)) for (const port of group.ports) {
      const pos = g.pos.get(port.nodeId);
      if (!pos) continue;
      const boundary = nodeGroups.portPoint(group, port), dimensions = nodeSize(port.nodeId);
      const actual = { x: pos.x + (port.direction === "output" ? dimensions.w : 0), y: pos.y + (port.direction === "output" && hasBranchPorts(commandById(port.nodeId)) ? port.when === "error" ? 78 : 40 : dimensions.h / 2) };
      const a = port.direction === "output" ? actual : boundary, b = port.direction === "output" ? boundary : actual;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M${a.x},${a.y} C${a.x + 32},${a.y} ${b.x - 32},${b.y} ${b.x},${b.y}`);
      path.setAttribute("class", "edge group-boundary");
      g.svg.append(path);
      g.edgeGeometry.push({ path, boundary: () => {
        const pos = g.pos.get(port.nodeId);
        const boundary = nodeGroups.portPoint(group, port), dimensions = nodeSize(port.nodeId);
        const actual = { x: pos.x + (port.direction === "output" ? dimensions.w : 0), y: pos.y + (port.direction === "output" && hasBranchPorts(commandById(port.nodeId)) ? port.when === "error" ? 78 : 40 : dimensions.h / 2) };
        const a = port.direction === "output" ? actual : boundary, b = port.direction === "output" ? boundary : actual;
        return { d: `M${a.x},${a.y} C${a.x + 32},${a.y} ${b.x - 32},${b.y} ${b.x},${b.y}` };
      } });
    }
    const placeLabel = createLabelPlacer();
    for (const link of g.links) {
      const edge = graphEdgePath(g, link.from, link.to, link);
      if (!edge) continue;
      const { d } = edge;
      const halfWidth = linkLabel(link).length * 4 + 10;
      const mid = placeLabel(edge.mid, halfWidth);
      const path = document.createElementNS(SVG_NS, "path");
      // 요청 시 부르기 연결은 턴이 끝나도 넘기지 않으므로 실행 중에도 흐름 표시를 하지 않는다.
      const call = link.when === "call";
      const live = !call && (sessionById(link.from) ?? commandById(link.from))?.state === "running";
      path.setAttribute("d", d);
      path.setAttribute("class", `edge${link.enabled ? "" : " off"}${live ? " live" : ""}${link.pending ? " gated" : ""}${call ? " call" : ""}`);
      path.setAttribute("marker-end", "url(#arrow)");
      g.svg.append(path);
      const label = link.pending ? gateLabel(link)
        : el("button", { class: `edge-label${link.enabled ? "" : " off"}${link.approve ? " gate" : ""}`, type: "button", "data-link": link.id },
          call ? `📞 ${linkLabel(link)}` : linkLabel(link));
      label.style.left = `${mid.x}px`;
      label.style.top = `${mid.y}px`;
      g.canvas.append(label);
      remember(path, link.from, link.to, link, label);
    }
  }

  // While moving, retain SVG nodes, gate buttons and their listeners. Only changed
  // geometry writes to the DOM; conversation aggregation stays outside this path.
  function moveEdges() {
    const g = ui.graph, placeLabel = createLabelPlacer();
    for (const item of g.edgeGeometry) {
      const edge = item.boundary?.() ?? graphEdgePath(g, item.from, item.to, item.link);
      if (!edge) continue;
      if (item.path.getAttribute("d") !== edge.d) item.path.setAttribute("d", edge.d);
      if (item.label) {
        const mid = placeLabel(edge.mid, linkLabel(item.link).length * 4 + 10);
        const left = `${mid.x}px`, top = `${mid.y}px`;
        if (item.label.style.left !== left) item.label.style.left = left;
        if (item.label.style.top !== top) item.label.style.top = top;
      }
    }
  }

  // 화면 좌표를 캔버스 좌표로. 확대·축소한 만큼 나눠 카드 위치와 같은 단위로 맞춘다.
  function canvasPoint(e) {
    const rect = ui.graph.canvas.getBoundingClientRect();
    const zoom = ui.graph.zoom ?? 1;
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  }

  // 연결선 가운데의 승인 대기. 승인하면 그때 받는 세션으로 넘긴다.
  function gateLabel(link) {
    const decide = async (e, action) => {
      e.stopPropagation();
      for (const b of e.currentTarget.parentElement.querySelectorAll("button")) b.disabled = true;
      try {
        await api("POST", `/api/links/${link.id}/decide`, { action });
      } catch (err) {
        showError(err, { action: "연결 승인 응답" });
      }
      loadLinks();
    };
    const from = nodeTitle(link.from);
    const to = nodeTitle(link.to);
    return el("div", { class: "edge-label gate-pending", "data-link": link.id, title: `${from} → ${to}\n${link.pending.preview || "(답변 없음)"}` },
      el("span", { class: "gate-text" }, "승인 대기"),
      el("button", { type: "button", class: "gate-btn ok", title: "승인하고 넘기기", onclick: (e) => decide(e, "approve") }, "✓"),
      el("button", { type: "button", class: "gate-btn no", title: "넘기지 않기", onclick: (e) => decide(e, "reject") }, "✕"));
  }

  function notifyGate(link) {
    if (!("Notification" in window) || Notification.permission !== "granted" || document.hasFocus()) return;
    const n = new Notification("넘기기 승인을 기다립니다", {
      body: `${nodeTitle(link.from)} → ${nodeTitle(link.to)}`,
      tag: `gate-${link.id}`,
    });
    const s = sessionById(link.from) ?? commandById(link.from);
    n.onclick = () => {
      window.focus();
      if (s?.projectPath) Promise.resolve(goProject(s.projectPath)).then(async () => { await tabs.load(s.projectPath); tabs.select(nodeTabId(s, data)); });
    };
  }

  // 카드를 누르면 선택하고, 끌면 옮긴다. 손잡이는 기존 카드나 빈 곳에 이어 새 노드를 만든다.
  function onGraphPointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    ui.graphGesture?.cancel();
    const g = ui.graph;
    if (e.button === 1) {
      e.preventDefault();
      if (g?.canvas.isConnected) startGraphPan(e);
      return;
    }
    if (e.button !== 0) return;
    if (!g?.canvas.isConnected) return; // 카드가 없어 안내 문구만 있는 그래프
    if (e.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])")) return;
    $("p-graph").focus({ preventScroll: true });
    const label = e.target.closest(".edge-label");
    if (label && e.target.closest(".gate-btn")) return; // 승인·거절 버튼은 자기 onclick으로 처리한다.
    if (label) {
      openLinkDialog(data.links.find((l) => l.id === label.dataset.link));
      return;
    }
    if (nodeGroups.pointerDown(e)) return;
    const card = e.target.closest(".gcard, .gcmd");
    // 빈 곳을 끌면 선택 상자로 여러 카드를 고른다.
    if (!card) {
      if (!e.target.closest("button, a, input, select, textarea")) startBoxSelect(e);
      return;
    }
    // 카드 안의 버튼(다시 시작, 스킬 칩, 명령 실행·중지)은 카드 선택·끌기와 따로 동작한다.
    if (e.target.closest(".gcard-restart, .gcard-clear-error, .gcard-lock, .session-lock, .gcard-skills, .gcmd-btn")) return;
    e.preventDefault();
    const id = card.dataset.id;
    const start = canvasPoint(e);
    const handle = e.target.closest(".gcard-handle");
    const connecting = Boolean(handle);
    const connectWhen = handle?.dataset.when ?? null;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    // 선택한 카드를 끌면 선택한 카드를 모두 함께 옮긴다.
    const group = !connecting && ui.graphSelected.has(id) ? [...ui.graphSelected].filter((n) => g.pos.has(n)) : [id];
    const origins = new Map(group.map((n) => [n, { ...g.pos.get(n) }]));
    let moved = false;
    let temp = null;
    g.dragging = true;

    const onMove = (ev) => {
      const p = canvasPoint(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      moved = true;
      g.dragging = true;
      if (connecting) {
        const from = g.pos.get(id);
        const x1 = from.x + nodeSize(id).w;
        const y1 = from.y + (hasBranchPorts(commandById(id)) ? connectWhen === "error" ? 78 : 40 : nodeSize(id).h / 2);
        if (!temp) {
          temp = document.createElementNS(SVG_NS, "path");
          temp.setAttribute("class", "temp");
          temp.setAttribute("marker-end", "url(#arrow)");
          g.svg.append(temp);
          g.canvas.classList.add("connecting");
        }
        const dx = Math.max(40, Math.abs(p.x - x1) / 2);
        temp.setAttribute("d", `M${x1},${y1} C${x1 + dx},${y1} ${p.x - dx},${p.y} ${p.x},${p.y}`);
      } else {
        // 묶음이 왼쪽·위 끝을 넘지 않게 함께 멈춘다.
        const dx = Math.max(p.x - start.x, -Math.min(...[...origins.values()].map((o) => o.x)));
        const dy = Math.max(p.y - start.y, -Math.min(...[...origins.values()].map((o) => o.y)));
        for (const [n, o] of origins) {
          g.pos.set(n, { x: o.x + dx, y: o.y + dy });
          g.cards.get(n)?.classList.add("dragging");
        }
        placeCards();
      }
    };

    const onUp = async (ev, cancelled) => {
      g.dragging = false;
      for (const n of group) g.cards.get(n)?.classList.remove("dragging");
      g.canvas.classList.remove("connecting");
      temp?.remove();
      if (cancelled) {
        for (const [n, origin] of origins) g.pos.set(n, origin);
        if (ui.graph === g && g.canvas.isConnected) placeCards();
        return;
      }
      if (ui.graph !== g || !g.canvas.isConnected) return;
      if (!moved) {
        // 누르면 선택만 한다(열기는 두 번 누르기). Ctrl·Shift를 누르고 누르면 선택에 더하거나 뺀다.
        if (connecting) return;
        if (additive) {
          if (ui.graphSelected.has(id)) ui.graphSelected.delete(id);
          else ui.graphSelected.add(id);
        } else {
          ui.graphSelected = new Set([id]);
        }
        syncGraphSelection();
        return;
      }
      if (connecting) {
        // 세션·명령 노드끼리 이으면 넘기기 연결을 만든다.
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const inputPort = target?.closest('.node-group-port[data-direction="input"]');
        const targetId = inputPort?.dataset.nodeId ?? target?.closest(".gcard, .gcmd")?.dataset.id;
        if (targetId && targetId !== id) openLinkDialog(null, id, targetId, connectWhen);
        else if (!targetId && !target?.closest(".node-group") && target?.closest("#p-graph") && !target.closest(".edge-label, button, a, input, select, textarea")) {
          openGraphCreateMenu(ev, id, connectWhen);
        }
        return;
      }
      const projectPath = navigation.project;
      const tabId = navigation.graphTabId;
      const before = new Map(group.map((n) => [n, storedPos(n)]));
      const membersBefore = groupMembers();
      ui.graphSaving = (ui.graphSaving ?? 0) + 1;
      try {
        await Promise.all(group.map(saveNodePos));
        await nodeGroups.droppedMembers(group);
        // 그룹 박스 안팎으로 옮겨 구성원이 바뀌었으면 함께 되돌린다.
        const after = new Map(group.map((n) => [n, storedPos(n)]));
        const membersAfter = groupMembers();
        const changed = [...new Set([...membersBefore.keys(), ...membersAfter.keys()])]
          .filter((id) => membersBefore.has(id) && membersAfter.has(id) && membersBefore.get(id).join() !== membersAfter.get(id).join());
        history.record(projectPath, { tabId, label: group.length > 1 ? `카드 ${group.length}개 이동` : "카드 이동",
          undo: (tools) => restoreLayout(before, changed.map((id) => [id, membersBefore.get(id)]), tools),
          redo: (tools) => restoreLayout(after, changed.map((id) => [id, membersAfter.get(id)]), tools) });
      } finally { ui.graphSaving--; }
    };

    trackGraphGesture(e, onMove, onUp);
  }

  // 휠 버튼을 누른 채 끌면 카드를 건드리지 않고 화면을 이동한다.
  function startGraphPan(e) {
    const g = ui.graph;
    const box = $("p-graph");
    const start = { x: e.clientX, y: e.clientY, pan: { ...g.pan } };
    box.focus({ preventScroll: true });
    closeContextMenu();
    g.dragging = true;
    box.classList.add("panning");
    trackGraphGesture(e, (ev) => {
      g.pan = { x: start.pan.x + ev.clientX - start.x, y: start.pan.y + ev.clientY - start.y };
      applyGraphZoom();
    }, () => {
      g.dragging = false;
      box.classList.remove("panning");
      saveTabView();
    });
  }

  // 옮긴 카드의 위치를 저장한다.
  async function saveNodePos(id) {
    const p = ui.graph?.pos.get(id);
    if (!p) return;
    const pos = { x: Math.round(p.x), y: Math.round(p.y) };
    const cmd = commandById(id);
    try {
      if (cmd) {
        cmd.pos = pos;
        await api("PUT", `/api/commands/${cmd.id}`, { pos });
        return;
      }
      const s = sessionById(id);
      if (s) s.graphPos = pos;
      await api("PUT", `/api/sessions/${id}`, { graphPos: pos });
    } catch (err) {
      showError(err, { action: "노드 위치 저장" });
    }
  }

  // ── 그래프 선택 ─────────────────────────────────────────────────
  // 선택은 화면에만 둔다. 다시 그려도 남아 있는 카드의 선택은 유지한다.
  function syncGraphSelection() {
    const g = ui.graph;
    if (!g) return;
    for (const id of ui.graphSelected) if (!g.cards.has(id) && !g.groupFrames?.has(id)) ui.graphSelected.delete(id);
    for (const [id, card] of [...g.cards, ...(g.groupFrames ?? [])]) card.classList.toggle("selected", ui.graphSelected.has(id));
    assistant.selectionChanged();
  }

  // 빈 곳에서 끌면 상자 안에 걸친 카드를 고른다. Ctrl·Shift를 누르고 끌면 지금 선택에 더한다.
  // 끌지 않고 빈 곳을 누르기만 하면 선택을 푼다.
  function startBoxSelect(e) {
    const g = ui.graph;
    if (!g) return;
    e.preventDefault();
    const start = canvasPoint(e);
    const before = new Set(ui.graphSelected);
    const base = e.ctrlKey || e.metaKey || e.shiftKey ? new Set(before) : new Set();
    let box = null;
    g.dragging = true;

    const onMove = (ev) => {
      const p = canvasPoint(ev);
      if (!box && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      if (!box) {
        box = el("div", { class: "graph-select-box" });
        g.canvas.append(box);
        g.canvas.classList.add("selecting");
      }
      const x1 = Math.min(start.x, p.x);
      const y1 = Math.min(start.y, p.y);
      const x2 = Math.max(start.x, p.x);
      const y2 = Math.max(start.y, p.y);
      Object.assign(box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
      const picked = new Set(base);
      for (const [id] of g.cards) {
        const pos = g.pos.get(id);
        const size = nodeSize(id);
        if (pos.x < x2 && pos.x + size.w > x1 && pos.y < y2 && pos.y + size.h > y1) picked.add(id);
      }
      for (const group of nodeGroups.groups().filter((item) => item.collapsed)) {
        const size = nodeGroups.size(group), pos = group.rect;
        if (pos.x < x2 && pos.x + size.w > x1 && pos.y < y2 && pos.y + size.h > y1) picked.add(group.id);
      }
      ui.graphSelected = picked;
      syncGraphSelection();
    };

    const onUp = (_ev, cancelled) => {
      g.dragging = false;
      g.canvas.classList.remove("selecting");
      box?.remove();
      if (cancelled) ui.graphSelected = before;
      else if (!box) ui.graphSelected = base;
      syncGraphSelection();
    };

    trackGraphGesture(e, onMove, onUp);
  }

  // 전체에 한 번만 확인한다. 작업 폴더와 원본 CLI 기록은 개별 삭제 메뉴에서 관리한다.
  async function deleteGraphSelection() {
    if (ui.deletingGraphNodes || navigation.view !== "project") return;
    const projectPath = navigation.project;
    const tabId = navigation.graphTabId;
    const selectedGroups = [...ui.graphSelected].map(nodeGroups.byId).filter(Boolean);
    if (selectedGroups.length) {
      // Selecting a container never silently deletes its member nodes.
      if (confirm(`선택한 그룹 ${selectedGroups.length}개를 해제할까요? 내부 노드와 연결은 유지됩니다.`)) {
        for (const group of selectedGroups) await nodeGroups.dissolve(group);
      }
      return;
    }
    const nodes = [...ui.graphSelected].map((id) =>
      data.sessions.find((s) => s.id === id && samePath(s.projectPath, projectPath)) ??
      (samePath(data.commandsProject, projectPath) ? commandById(id) : null)).filter(Boolean);
    if (!nodes.length) return;
    const running = nodes.filter((n) => n.state === "running").length;
    const sessionCount = nodes.filter((n) => !isCommandNode(n.id)).length;
    if (!confirm(`선택한 노드 ${nodes.length}개와 이어진 연결을 삭제할까요?${running ? `\n실행 중인 ${running}개는 멈춥니다.` : ""}\n세션의 작업 폴더와 원본 CLI 기록은 남겨 둡니다.${sessionCount ? "\n세션 삭제는 Ctrl+Z로 되돌릴 수 없습니다." : ""}`)) return;
    ui.deletingGraphNodes = true;
    closeContextMenu();
    // 노드 설정과 이어진 연결을 미리 남겨 두어 되돌릴 때 되살린다.
    const snapshots = new Map(nodes.filter((n) => isCommandNode(n.id)).map((n) => [n.id, nodeSnapshot(n)]));
    try {
      const results = await Promise.allSettled(nodes.map((node) =>
        api("DELETE", isCommandNode(node.id) ? `/api/commands/${node.id}` : `/api/sessions/${node.id}?force=1`)));
      const errors = [];
      const removed = [];
      results.forEach((result, i) => {
        if (result.status === "fulfilled") { ui.graphSelected.delete(nodes[i].id); if (snapshots.has(nodes[i].id)) removed.push(snapshots.get(nodes[i].id)); }
        else errors.push(`${nodes[i].title}: ${result.reason.message}`);
      });
      recordNodesRemoved(projectPath, removed, tabId);
      await Promise.all([loadSessions(), loadCommands(projectPath), loadLinks()]);
      if (errors.length) showError({ message: "일부 노드를 삭제하지 못했습니다.", hint: "실행 중인 노드는 멈춘 뒤 다시 삭제하세요.", raw: errors.join("\n") }, { action: "노드 삭제" });
    } finally {
      ui.deletingGraphNodes = false;
      syncGraphSelection();
    }
  }

  // 카드를 두 번 누르면 연다. Ctrl·Shift를 누르고 두 번 누르면 세션을 새 창으로 연다.
  $("p-graph").addEventListener("dblclick", (e) => {
    const frame = e.target.closest(".node-group");
    if (frame && !e.target.closest("button, .node-group-port")) { const group = nodeGroups.byId(frame.dataset.groupId); if (group) nodeGroups.edit(group); return; }
    const card = e.target.closest(".gcard, .gcmd");
    if (!card || e.target.closest(".gcard-restart, .gcard-clear-error, .gcard-lock, .session-lock, .gcard-skills, .gcmd-btn, .gcard-handle, .edge-label")) return;
    const cmd = commandById(card.dataset.id);
    if (cmd) openCommandDialog(cmd);
    else if (e.ctrlKey || e.metaKey || e.shiftKey) openSessionWindow(card.dataset.id);
    else selectSession(card.dataset.id);
  });

  $("p-relayout").addEventListener("click", async () => {
    if (tabsEnabled && !tabs.ready()) return;
    const grouped = new Set(nodeGroups.groups().flatMap((group) => group.members));
    const placed = data.sessions.filter((s) => samePath(s.projectPath, navigation.project) && visibleNode(s) && s.graphPos && !grouped.has(s.id));
    const placedCommands = (samePath(data.commandsProject, navigation.project) ? data.commands ?? [] : []).filter((c) => visibleNode(c) && c.pos && !grouped.has(c.id));
    const before = new Map([...placed, ...placedCommands].map((node) => [node.id, storedPos(node.id)]));
    if (before.size) history.record(navigation.project, { label: "자동 배치",
      undo: (tools) => restoreLayout(before, [], tools),
      redo: (tools) => restoreLayout(new Map([...before.keys()].map((id) => [id, null])), [], tools) });
    for (const s of placed) s.graphPos = null;
    for (const c of placedCommands) c.pos = null;
    renderGraph();
    await Promise.all([
      ...placed.map((s) => api("PUT", `/api/sessions/${s.id}`, { graphPos: null }).catch(() => {})),
      ...placedCommands.map((c) => api("PUT", `/api/commands/${c.id}`, { pos: null }).catch(() => {})),
    ]);
  });

  // ── 연결 설정 ───────────────────────────────────────────────────
  // 연결 조건 선택지를 서버 목록으로 채운다.
  function renderLinkConditions(source = commandById(ui.editingLink?.from)) {
    const select = $("link-when");
    const value = select.value;
    // 요청 시 부르기는 세션끼리만 쓴다(명령 노드에서 나가는 연결에는 보이지 않는다).
    select.replaceChildren(...(data.status?.linkConditions ?? [])
      .filter((c) => (!resultOnlyOutputs(source) || ["success", "error", "always", "manual"].includes(c.id)) && (c.id !== "call" || !source))
      .map((c) => el("option", { value: c.id }, c.label)));
    if (value) select.value = value;
  }

  // 보내는 세션의 역할에서 따옴표로 감싼 말("검토 요청", "통과" …)을 키워드 후보로 꺼낸다.
  // 역할 지시에 마지막 줄에 쓸 판정을 적어 두므로 그 말이 곧 분기 키워드다.
  function keywordSuggestions(nodeId) {
    // 판정을 말하는 줄("마지막 줄에 … 쓴다")만 본다. 다른 줄의 따옴표 말은 분기와 상관없다.
    const lines = (sessionById(nodeId)?.role ?? "").split(/\r?\n/).filter((l) => /마지막|판정|last line/i.test(l));
    const found = lines.flatMap((l) => [...l.matchAll(/["“]([^"”]{1,40})["”]/g)].map((m) => m[1].trim())).filter(Boolean);
    return [...new Set(found)];
  }

  // 새 연결의 기본 조건: 보내는 세션의 역할에 아직 다른 연결이 쓰지 않은 키워드 후보가 있으면 그 키워드, 없으면 성공 시
  function defaultLinkCondition(from) {
    const used = new Set(data.links.filter((l) => l.from === from && l.when === "keyword")
      .flatMap((l) => l.keyword.split(/[,，]/).map((k) => k.trim())));
    const keyword = keywordSuggestions(from).find((k) => !used.has(k));
    return keyword ? { when: "keyword", keyword } : { when: "success", keyword: "" };
  }

  // link가 없으면 from → to 새 연결을 만든다.
  function openLinkDialog(link, from = link?.from, to = link?.to, connectWhen = null, connectKeyword = "") {
    const source = commandById(from);
    const target = commandById(to);
    if (source?.kind === "markdown") return showError({ message: "Markdown 출력 노드는 완료 메시지를 받는 노드입니다.", hint: "Markdown 출력 노드로 들어오는 방향으로 연결하세요." }, { action: "연결" });
    if (isSourceOnly(target)) return showError({ message: KIND_LABEL[target.kind] + " 노드는 흐름의 시작점입니다.", hint: "이 노드에서 나가는 방향으로 연결하고, 카드에서 직접 실행해 주세요." }, { action: "연결" });
    ui.editingLink = { link, from, to };
    $("link-names").textContent = `${nodeTitle(from)} → ${nodeTitle(to)}`;
    renderLinkConditions(source);
    const initial = link ?? (connectWhen ? { when: connectWhen, keyword: connectKeyword } : defaultLinkCondition(from));
    $("link-when").value = initial.when;
    $("link-keyword").value = initial.keyword ?? "";
    // 키워드 후보를 누르면 키워드 칸에 넣는다.
    $("link-keyword-chips").replaceChildren(...keywordSuggestions(from).map((k) =>
      el("button", { type: "button", class: "flow-chip", onclick: () => { $("link-keyword").value = k; } }, k)));
    // 같은 세션에서 나가는 다른 연결을 보여 주어 분기 전체를 한눈에 보게 한다.
    const siblings = data.links.filter((l) => l.from === from && l.id !== link?.id);
    $("link-siblings").hidden = !siblings.length;
    $("link-siblings-list").replaceChildren(...siblings.map((l) =>
      el("li", {}, `→ ${nodeTitle(l.to)}`, el("span", { class: "muted" }, ` · ${linkLabel(l)}${l.enabled ? "" : " · 꺼짐"}`))));
    $("link-note").value = link?.note ?? "";
    $("link-note").placeholder = "다음 노드에 보낼 내용 · 입력값은 {{key}}, 이전 결과는 {{input}}로 사용";
    $("link-enabled").checked = link?.enabled ?? true;
    // 작업 마무리는 커밋·push·PR을 만들므로 새 연결은 승인 후 실행이 기본이다.
    $("link-approve").checked = link?.approve ?? (target?.kind === "task" && target.taskAction === "finish");
    $("link-git-worktree").checked = link?.useGitWorktree ?? (worktreeByDefault(source) && initial.when === "success");
    $("link-delete").hidden = !link;
    $("link-run").hidden = !link;
    $("link-error").textContent = "";
    syncLinkWhen();
    $("link-dialog").showModal();
  }

  function syncLinkWhen() {
    $("link-keyword-row").hidden = $("link-when").value !== "keyword";
    const source = commandById(ui.editingLink?.from), target = commandById(ui.editingLink?.to);
    const eligible = hasWorktreeOutput(source) && (!target || !target.kind || target.kind === "command") && $("link-when").value !== "error";
    $("link-git-worktree-row").hidden = !eligible;
    $("link-git-worktree-hint").hidden = !eligible;
  }
  $("link-when").addEventListener("change", syncLinkWhen);

  $("link-form").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    e.preventDefault();
    const { link, from, to } = ui.editingLink;
    const body = {
      when: $("link-when").value,
      keyword: $("link-keyword").value,
      note: $("link-note").value,
      enabled: $("link-enabled").checked,
      approve: $("link-approve").checked,
      ...(hasWorktreeOutput(commandById(from)) ? { useGitWorktree: !$("link-git-worktree-row").hidden && $("link-git-worktree").checked } : {}),
    };
    const projectPath = navigation.project;
    const tabId = navigation.graphTabId;
    // 연결 설정을 바꿨으면 이전 값으로 되돌릴 수 있게 남긴다.
    const recordEdit = () => {
      const previous = linkBody(link);
      const next = { ...previous, ...body, ...(body.when !== "keyword" ? { keyword: "" } : {}) };
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      history.record(projectPath, { tabId, label: "연결 설정 변경",
        undo: ({ resolve }) => api("PUT", `/api/links/${resolve(link.id)}`, previous),
        redo: ({ resolve }) => api("PUT", `/api/links/${resolve(link.id)}`, next) });
    };
    try {
      if (action === "delete") {
        if (!confirm("이 연결을 삭제할까요?")) return;
        await api("DELETE", `/api/links/${link.id}`);
        const removed = { ...link };
        history.record(projectPath, { tabId, label: "연결 삭제",
          undo: (tools) => restoreLink(removed, tools),
          redo: ({ resolve }) => api("DELETE", `/api/links/${resolve(removed.id)}`) });
      } else if (action === "run") {
        await api("PUT", `/api/links/${link.id}`, body);
        recordEdit();
        await api("POST", `/api/links/${link.id}/run`);
      } else if (link) {
        await api("PUT", `/api/links/${link.id}`, body);
        recordEdit();
      } else {
        const created = await api("POST", "/api/links", { ...body, from, to });
        if (created?.id) recordLinkCreated(projectPath, created, tabId);
      }
      $("link-dialog").close();
      await loadLinks();
    } catch (err) {
      $("link-error").textContent = err.message;
    }
  });

  async function loadGraphTabs(projectPath = navigation.project, { affectedTabIds = [] } = {}) {
    history.invalidate(projectPath, affectedTabIds);
    for (const id of affectedTabIds) {
      const saved = tabViews.get(graphScopeKey(projectPath, id));
      if (saved) saved.selected = [];
    }
    if (affectedTabIds.includes(navigation.graphTabId)) ui.graphSelected.clear();
    return tabs.load(projectPath);
  }

  return { loadGraphTabs, selectGraphTab: tabs.select, loadNodeGroups: nodeGroups.load, loadMessages, loadLinks, renderGraph, clearGraphTransientState, connectCreatedGraphNode, renderLinkConditions, drawEdges, highlightSessions, clearSelection,
    history, nodeSnapshot, recordNodesRemoved, renderHistoryButtons };
}

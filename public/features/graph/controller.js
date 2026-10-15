import { createGraphView } from "./view.js";
import { PAD, SVG_NS, isCommandNode, nodeSize, layoutGraph, edgePath } from "./model.js";
import { $, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { linkLabel } from "../../shared/flow.js";
import { openContextMenu, closeContextMenu } from "../../shared/context-menu.js";

export function createGraphController({ openSessionWindow, api, goProject, selectSession, loadSessions, sessionById, commandById, nodeTitle, loadCommands, commandNode, runCommand, stopCommand, removeCommand, openCommandDialog, skillChips, openSkillsManager, renderFlow, restartSession, openSessionMenu, openNew, cancelNodeCreation, data, navigation }) {
  const ui = {
    "graph": null,
    "graphSelected": new Set(),
    "graphGesture": null,
    "deletingGraphNodes": null,
    "editingLink": null
  };
  const view = createGraphView({ skillChips, restartSession, commandNode });

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
    const box = $("p-graph");
    if (ui.graph?.dragging) {
      ui.graph.needsRender = true; // 데이터 변경은 끌기를 마친 뒤 한 번 반영한다.
      return;
    }
    const sessions = data.sessions
      .filter((s) => samePath(s.projectPath, navigation.project))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const cmdNodes = samePath(data.commandsProject, navigation.project) ? data.commands ?? [] : [];
    if (!sessions.length && !cmdNodes.length) {
      ui.graph = null;
      box.replaceChildren(el("div", { class: "graph-empty" },
        "이 프로젝트에서 만든 세션이 없습니다. 여기서 우클릭하거나 새 세션을 만들면 카드로 보입니다."));
      return;
    }
    // 명령 노드는 세션과 같은 흐름 안에 놓인다(세션 → 명령 → 세션).
    const ids = new Set([...sessions, ...cmdNodes].map((s) => s.id));
    const links = data.links.filter((l) => ids.has(l.from) && ids.has(l.to));
    // 오케스트레이터가 만든 세션은 지휘선으로 잇고, 배치도 오케스트레이터를 앞에 둔다.
    const commands = sessions.filter((s) => ids.has(s.createdBy)).map((s) => ({ from: s.createdBy, to: s.id }));
    const pos = layoutGraph([...sessions, ...cmdNodes], [...commands, ...links]);

    const { canvas, svg, cards } = view.createCanvas(sessions, cmdNodes);
    // 캔버스를 배율에 맞춰 그리고, 프로젝트별 화면 이동 위치를 유지한다.
    const sizer = el("div", { class: "graph-sizer" }, canvas);
    const pan = samePath(ui.graph?.projectPath, navigation.project) ? { ...ui.graph.pan } : { x: 0, y: 0 };
    ui.graph = { canvas, sizer, svg, cards, pos, links, commands, zoom: graphZoomFor(navigation.project), pan, projectPath: navigation.project };
    placeCards();
    syncGraphSelection();
    box.replaceChildren(sizer);
    renderZoomLabel();
  }
  // 카드 끌기·연결·선택 상자. 그래프에 초점을 두면 Delete로 선택한 노드를 한 번에 지운다.
  $("p-graph").tabIndex = 0;
  $("p-graph").addEventListener("pointerdown", onGraphPointerDown);
  $("p-graph").addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  $("p-graph").addEventListener("keydown", (e) => {
    if (e.key !== "Delete" || e.repeat || e.isComposing || e.defaultPrevented) return;
    if (e.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])")) return;
    if (document.querySelector("dialog[open]")) return;
    if (!ui.graphSelected.size || navigation.view !== "project" || ui.graph?.dragging) return;
    e.preventDefault();
    deleteGraphSelection();
  });

  // 흐름 그래프 우클릭: 세션 카드는 세션 메뉴, 명령 노드는 명령 메뉴, 빈 곳은 그 자리에 새 세션·명령을 만든다.
  $("p-graph").addEventListener("contextmenu", (e) => {
    if (e.target.closest(".edge-label")) return;
    const card = e.target.closest(".gcard, .gcmd");
    const cmd = card && commandById(card.dataset.id);
    if (cmd) {
      const running = cmd.state === "running";
      openContextMenu(e, `명령 ${cmd.title}`, [
        running ? ["중지", () => stopCommand(cmd)] : ["지금 실행", () => runCommand(cmd)],
        ["편집", () => openCommandDialog(cmd)],
        null,
        ["삭제", () => removeCommand(cmd), { danger: true }],
      ]);
      return;
    }
    if (card) {
      const s = sessionById(card.dataset.id);
      if (s) openSessionMenu(e, s);
      return;
    }
    openGraphCreateMenu(e);
  });

  // 손잡이를 빈 곳에 놓았을 때도 같은 생성 메뉴를 쓰고, 만든 노드에 바로 잇는다.
  function openGraphCreateMenu(e, connectFrom = null) {
    const projectPath = navigation.project;
    const at = ui.graph ? canvasPoint(e) : { x: PAD, y: PAD };
    const pos = { x: Math.max(0, Math.round(at.x)), y: Math.max(0, Math.round(at.y)) };
    const inProject = (action) => () => {
      if (navigation.view === "project" && samePath(projectPath, navigation.project)) action();
    };
    openContextMenu(e, connectFrom ? "새 노드에 연결" : "여기에 만들기", [
      ["새 세션", inProject(() => openNew(projectPath, { pos, connectFrom }))],
      ["새 명령", inProject(() => openCommandDialog(null, pos, connectFrom))],
      null,
      ["스킬 관리", inProject(() => openSkillsManager())],
    ]);
  }

  function clearGraphTransientState() {
    ui.graphGesture?.cancel();
    closeContextMenu();
    cancelNodeCreation();
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
    const move = (e) => { if (matches(e)) onMove(e); };
    const finish = (e, cancelled) => {
      if (!active) return;
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
    const source = sessionById(context.connectFrom) ??
      (samePath(data.commandsProject, projectPath) ? commandById(context.connectFrom) : null);
    if (!source || (source.projectPath && !samePath(source.projectPath, projectPath))) return;
    try {
      await api("POST", "/api/links", { from: source.id, to, ...defaultLinkCondition(source.id), enabled: true });
      await loadLinks();
    } catch (err) {
      alert(`노드는 만들었지만 연결하지 못했습니다. 손잡이를 끌어 다시 연결해 주세요.\n\n${err.message}`);
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
      width = Math.max(width, p.x + size.w + PAD);
      height = Math.max(height, p.y + size.h + PAD);
    }
    // 되돌아가는 연결은 카드 아래로 휘어 내려가므로(edgePath) 그 선과 라벨이 잘리지 않게 아래 여백을 더 둔다.
    for (const link of g.links) {
      const a = g.pos.get(link.from);
      const b = g.pos.get(link.to);
      if (!a || !b || b.x >= a.x + nodeSize(link.from).w) continue;
      height = Math.max(height, Math.max(a.y + nodeSize(link.from).h, b.y + nodeSize(link.to).h) + 64);
    }
    g.canvas.style.width = `${width}px`;
    g.canvas.style.height = `${height}px`;
    g.size = { width, height };
    applyGraphZoom();
    drawEdges();
  }

  // ── 그래프 확대·축소 ────────────────────────────────────────────
  // 배율은 프로젝트마다 이 브라우저에 기억한다. 카드 위치는 배율과 상관없는 캔버스 좌표로 저장한다.
  const ZOOM_KEY = "agenthub-graph-zoom";
  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 2;

  function graphZoomFor(projectPath) {
    try {
      const z = JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "{}")[String(projectPath).toLowerCase()];
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
    all[String(projectPath).toLowerCase()] = zoom;
    localStorage.setItem(ZOOM_KEY, JSON.stringify(all));
  }

  function applyGraphZoom() {
    const g = ui.graph;
    if (!g?.size) return;
    g.canvas.style.transform = g.zoom === 1 ? "" : `scale(${g.zoom})`;
    g.canvas.style.left = `${g.pan.x}px`;
    g.canvas.style.top = `${g.pan.y}px`;
    g.sizer.style.width = `${g.size.width * g.zoom}px`;
    g.sizer.style.height = `${g.size.height * g.zoom}px`;
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
    const maxHeight = parseFloat(getComputedStyle(box).maxHeight) || box.clientHeight;
    const fit = Math.min(1, box.clientWidth / g.size.width, maxHeight / g.size.height);
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

  function drawEdges() {
    const g = ui.graph;
    if (!g) return;
    g.svg.querySelectorAll("path.edge").forEach((n) => n.remove());
    g.canvas.querySelectorAll(".edge-label").forEach((n) => n.remove());
    // 메시지를 주고받은 세션 사이의 대화선(방향 없이 한 줄, 주고받은 수를 툴팁으로)
    const talks = new Map();
    for (const m of data.messages) {
      if (!g.pos.has(m.from) || !g.pos.has(m.to)) continue;
      const key = [m.from, m.to].sort().join(" ");
      const talk = talks.get(key) ?? { from: m.from, to: m.to, count: 0, last: m };
      talk.count++;
      talk.last = m;
      talks.set(key, talk);
    }
    for (const talk of talks.values()) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edgePath(g.pos.get(talk.from), g.pos.get(talk.to), nodeSize(talk.from), nodeSize(talk.to)).d);
      path.setAttribute("class", "edge message");
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `메시지 ${talk.count}개 · 마지막: ${nodeTitle(talk.last.from)} → ${nodeTitle(talk.last.to)}
  ${talk.last.text}`;
      path.append(title);
      g.svg.append(path);
    }
    for (const command of g.commands) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", edgePath(g.pos.get(command.from), g.pos.get(command.to), nodeSize(command.from), nodeSize(command.to)).d);
      path.setAttribute("class", "edge command");
      g.svg.append(path);
    }
    const placed = []; // 라벨이 겹치면 아래로 비킨다.
    for (const link of g.links) {
      const { d, mid } = edgePath(g.pos.get(link.from), g.pos.get(link.to), nodeSize(link.from), nodeSize(link.to));
      const halfWidth = linkLabel(link).length * 4 + 10;
      while (placed.some((p) => Math.abs(p.x - mid.x) < p.halfWidth + halfWidth && Math.abs(p.y - mid.y) < 22)) mid.y += 22;
      placed.push({ ...mid, halfWidth });
      const path = document.createElementNS(SVG_NS, "path");
      const live = (sessionById(link.from) ?? commandById(link.from))?.state === "running";
      path.setAttribute("d", d);
      path.setAttribute("class", `edge${link.enabled ? "" : " off"}${live ? " live" : ""}${link.pending ? " gated" : ""}`);
      path.setAttribute("marker-end", "url(#arrow)");
      g.svg.append(path);
      const label = link.pending ? gateLabel(link)
        : el("button", { class: `edge-label${link.enabled ? "" : " off"}${link.approve ? " gate" : ""}`, type: "button", "data-link": link.id },
          linkLabel(link));
      label.style.left = `${mid.x}px`;
      label.style.top = `${mid.y}px`;
      g.canvas.append(label);
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
        alert(err.message);
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
      if (s?.projectPath) goProject(s.projectPath);
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
    const card = e.target.closest(".gcard, .gcmd");
    // 빈 곳을 끌면 선택 상자로 여러 카드를 고른다.
    if (!card) {
      if (!e.target.closest("button, a, input, select, textarea")) startBoxSelect(e);
      return;
    }
    // 카드 안의 버튼(다시 시작, 스킬 칩, 명령 실행·중지)은 카드 선택·끌기와 따로 동작한다.
    if (e.target.closest(".gcard-restart, .gcard-skills, .gcmd-btn")) return;
    e.preventDefault();
    const id = card.dataset.id;
    const start = canvasPoint(e);
    const connecting = e.target.classList.contains("gcard-handle");
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
        const y1 = from.y + nodeSize(id).h / 2;
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
        const targetId = target?.closest(".gcard, .gcmd")?.dataset.id;
        if (targetId && targetId !== id) openLinkDialog(null, id, targetId);
        else if (!targetId && target?.closest("#p-graph") && !target.closest(".edge-label, button, a, input, select, textarea")) {
          openGraphCreateMenu(ev, id);
        }
        return;
      }
      await Promise.all(group.map(saveNodePos));
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
      alert(err.message);
    }
  }

  // ── 그래프 선택 ─────────────────────────────────────────────────
  // 선택은 화면에만 둔다. 다시 그려도 남아 있는 카드의 선택은 유지한다.
  function syncGraphSelection() {
    const g = ui.graph;
    if (!g) return;
    for (const id of ui.graphSelected) if (!g.cards.has(id)) ui.graphSelected.delete(id);
    for (const [id, card] of g.cards) card.classList.toggle("selected", ui.graphSelected.has(id));
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
      for (const [id, pos] of g.pos) {
        const size = nodeSize(id);
        if (pos.x < x2 && pos.x + size.w > x1 && pos.y < y2 && pos.y + size.h > y1) picked.add(id);
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
    const nodes = [...ui.graphSelected].map((id) =>
      data.sessions.find((s) => s.id === id && samePath(s.projectPath, projectPath)) ??
      (samePath(data.commandsProject, projectPath) ? commandById(id) : null)).filter(Boolean);
    if (!nodes.length) return;
    const running = nodes.filter((n) => n.state === "running").length;
    if (!confirm(`선택한 노드 ${nodes.length}개와 이어진 연결을 삭제할까요?${running ? `\n실행 중인 ${running}개는 멈춥니다.` : ""}\n세션의 작업 폴더와 원본 CLI 기록은 남겨 둡니다.`)) return;
    ui.deletingGraphNodes = true;
    closeContextMenu();
    try {
      const results = await Promise.allSettled(nodes.map((node) =>
        api("DELETE", isCommandNode(node.id) ? `/api/commands/${node.id}` : `/api/sessions/${node.id}?force=1`)));
      const errors = [];
      results.forEach((result, i) => {
        if (result.status === "fulfilled") ui.graphSelected.delete(nodes[i].id);
        else errors.push(`${nodes[i].title}: ${result.reason.message}`);
      });
      await Promise.all([loadSessions(), loadCommands(projectPath), loadLinks()]);
      if (errors.length) alert(`일부 노드를 삭제하지 못했습니다.\n\n${errors.join("\n")}`);
    } finally {
      ui.deletingGraphNodes = false;
      syncGraphSelection();
    }
  }

  // 카드를 두 번 누르면 연다. Ctrl·Shift를 누르고 두 번 누르면 세션을 새 창으로 연다.
  $("p-graph").addEventListener("dblclick", (e) => {
    const card = e.target.closest(".gcard, .gcmd");
    if (!card || e.target.closest(".gcard-restart, .gcard-skills, .gcmd-btn, .gcard-handle, .edge-label")) return;
    const cmd = commandById(card.dataset.id);
    if (cmd) openCommandDialog(cmd);
    else if (e.ctrlKey || e.metaKey || e.shiftKey) openSessionWindow(card.dataset.id);
    else selectSession(card.dataset.id);
  });

  $("p-relayout").addEventListener("click", async () => {
    const placed = data.sessions.filter((s) => samePath(s.projectPath, navigation.project) && s.graphPos);
    for (const s of placed) s.graphPos = null;
    const placedCommands = (data.commands ?? []).filter((c) => c.pos);
    for (const c of placedCommands) c.pos = null;
    renderGraph();
    await Promise.all([
      ...placed.map((s) => api("PUT", `/api/sessions/${s.id}`, { graphPos: null }).catch(() => {})),
      ...placedCommands.map((c) => api("PUT", `/api/commands/${c.id}`, { pos: null }).catch(() => {})),
    ]);
  });

  // ── 연결 설정 ───────────────────────────────────────────────────
  // 연결 조건 선택지를 서버 목록으로 채운다.
  function renderLinkConditions() {
    const select = $("link-when");
    const value = select.value;
    select.replaceChildren(...(data.status?.linkConditions ?? []).map((c) => el("option", { value: c.id }, c.label)));
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
  function openLinkDialog(link, from = link?.from, to = link?.to) {
    ui.editingLink = { link, from, to };
    $("link-names").textContent = `${nodeTitle(from)} → ${nodeTitle(to)}`;
    const initial = link ?? defaultLinkCondition(from);
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
    $("link-enabled").checked = link?.enabled ?? true;
    $("link-approve").checked = link?.approve ?? false;
    $("link-delete").hidden = !link;
    $("link-run").hidden = !link;
    $("link-error").textContent = "";
    syncLinkWhen();
    $("link-dialog").showModal();
  }

  function syncLinkWhen() {
    $("link-keyword-row").hidden = $("link-when").value !== "keyword";
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
    };
    try {
      if (action === "delete") {
        if (!confirm("이 연결을 삭제할까요?")) return;
        await api("DELETE", `/api/links/${link.id}`);
      } else if (action === "run") {
        await api("PUT", `/api/links/${link.id}`, body);
        await api("POST", `/api/links/${link.id}/run`);
      } else if (link) {
        await api("PUT", `/api/links/${link.id}`, body);
      } else {
        await api("POST", "/api/links", { ...body, from, to });
      }
      $("link-dialog").close();
      await loadLinks();
    } catch (err) {
      $("link-error").textContent = err.message;
    }
  });

  return { loadMessages, loadLinks, renderGraph, clearGraphTransientState, connectCreatedGraphNode, renderLinkConditions, drawEdges, highlightSessions, clearSelection };
}

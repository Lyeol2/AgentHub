import { $, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { nodeSize } from "./model.js";
import { KIND_LABEL, hasBranchPorts, resultOnlyOutputs, isSourceOnly, isScheduleArmed } from "../commands/flow-nodes.js";

// A group is a canvas container. Links continue to point to its real member nodes.
export function createNodeGroups({ api, data, navigation, ui, history, renderGraph, loadSessions, loadCommands, runCommand, saveGroupTemplate, trackGesture, canvasPoint, placeCards, openLinkDialog, openCreateMenu, syncSelection }) {
  let loadingPath = null;
  const groups = () => samePath(data.nodeGroupsProject, navigation.project) ? data.nodeGroups ?? [] : [];
  const byId = (id) => groups().find((group) => group.id === id);
  const owner = (id) => groups().find((group) => group.members.includes(id));
  const nodes = () => [...data.sessions.filter((node) => samePath(node.projectPath, navigation.project)), ...(samePath(data.commandsProject, navigation.project) ? data.commands ?? [] : [])];
  const node = (id) => nodes().find((item) => item.id === id);
  const kind = (item) => (KIND_LABEL[item?.kind] ?? (item?.orchestrator ? "지휘 세션" : "세션"));
  const title = (id) => node(id)?.title ?? id;
  const conditionLabel = (when) => ({ success: "성공", error: "실패", always: "항상", keyword: "키워드", otherwise: "그 외", manual: "수동" }[when] ?? when);

  async function load(projectPath = navigation.project, { render = true } = {}) {
    if (!projectPath) return;
    loadingPath = projectPath;
    try {
      const result = await api("GET", `/api/node-groups?path=${encodeURIComponent(projectPath)}`);
      if (!samePath(projectPath, navigation.project)) return;
      data.nodeGroups = result.groups ?? [];
      data.nodeGroupsProject = projectPath;
      if (render && navigation.view === "project") renderGraph();
    } catch {
      if (!samePath(projectPath, navigation.project)) return;
      // Older servers and isolated graph fixtures have no group endpoint.
      if (!samePath(data.nodeGroupsProject, projectPath)) { data.nodeGroups = []; data.nodeGroupsProject = projectPath; }
    } finally {
      if (loadingPath === projectPath) loadingPath = null;
    }
  }

  function ensureLoaded() {
    if (navigation.project && !samePath(data.nodeGroupsProject, navigation.project) && loadingPath !== navigation.project) void load();
  }

  function replaceGroup(value) {
    if (!value?.id) return;
    const list = groups();
    const index = list.findIndex((group) => group.id === value.id);
    if (index < 0) list.push(value); else list[index] = value;
    data.nodeGroups = list;
  }

  async function update(group, body, { refreshNodes = false } = {}) {
    const projectPath = group.projectPath;
    if (!samePath(projectPath, navigation.project)) return false;
    try {
      const result = await api("PUT", `/api/node-groups/${group.id}`, body);
      if (!samePath(projectPath, navigation.project)) return false;
      replaceGroup(result.group ?? result);
      if (refreshNodes) await Promise.all([loadSessions(), loadCommands(projectPath)]);
      if (!samePath(projectPath, navigation.project)) return false;
      await load(projectPath);
      return true;
    } catch (error) { if (samePath(projectPath, navigation.project)) { alert(error.message); await load(projectPath); } return false; }
  }

  // 그룹 박스를 되살릴 때 보낼 값. 구성원과 포트는 그 사이 바뀐 노드 id를 따른다.
  const groupBody = (group, resolve) => ({ projectPath: group.projectPath, title: group.title, members: group.members.map(resolve),
    rect: group.rect, collapsed: group.collapsed, ports: (group.ports ?? []).map(({ id: _id, ...port }) => ({ ...port, nodeId: resolve(port.nodeId) })) });

  async function dissolve(group) {
    const projectPath = group.projectPath;
    try {
      await api("DELETE", `/api/node-groups/${group.id}`);
      const removed = structuredClone(group);
      history?.record(projectPath, { label: "그룹 해제",
        undo: async ({ resolve, remap }) => { const result = await api("POST", "/api/node-groups", groupBody(removed, resolve)); remap(removed.id, (result.group ?? result).id); },
        redo: ({ resolve }) => api("DELETE", `/api/node-groups/${resolve(removed.id)}`) });
      if (!samePath(projectPath, navigation.project)) return;
      ui.graphSelected.delete(group.id);
      await load(projectPath);
    } catch (error) { if (samePath(projectPath, navigation.project)) alert(error.message); }
  }

  function bounds(ids) {
    const graph = ui.graph;
    const points = ids.map((id) => ({ pos: graph?.pos.get(id), size: nodeSize(id) })).filter((entry) => entry.pos);
    const x = Math.max(0, Math.min(...points.map((entry) => entry.pos.x)) - 40);
    const y = Math.max(0, Math.min(...points.map((entry) => entry.pos.y)) - 76);
    return { x, y, w: Math.max(380, Math.max(...points.map((entry) => entry.pos.x + entry.size.w)) - x + 40), h: Math.max(260, Math.max(...points.map((entry) => entry.pos.y + entry.size.h)) - y + 50) };
  }

  async function create(selected = [...ui.graphSelected]) {
    const projectPath = navigation.project;
    const members = selected.filter((id) => node(id) && !owner(id));
    if (!members.length) return alert("그룹에 넣을 노드를 먼저 선택하세요. 이미 그룹에 속한 노드는 꺼낸 뒤 선택할 수 있습니다.");
    try {
      const result = await api("POST", "/api/node-groups", { projectPath, title: "노드 그룹", members, rect: bounds(members), collapsed: false, ports: [] });
      if (!samePath(projectPath, navigation.project)) return;
      const group = result.group ?? result;
      if (group.id) {
        const made = structuredClone(group);
        history?.record(projectPath, { label: "그룹 만들기",
          undo: ({ resolve }) => api("DELETE", `/api/node-groups/${resolve(made.id)}`),
          redo: async ({ resolve, remap }) => { const again = await api("POST", "/api/node-groups", groupBody(made, resolve)); remap(made.id, (again.group ?? again).id); } });
      }
      ui.graphSelected = new Set(group.id ? [group.id] : []);
      await load(projectPath);
    } catch (error) { if (samePath(projectPath, navigation.project)) alert(error.message); }
  }

  function summary(group) {
    const members = group.members.map(node).filter(Boolean);
    const running = members.filter((member) => member.state === "running").length;
    const waiting = members.filter((member) => member.waiting).length;
    const failed = members.filter((member) => member.state === "error" || member.lastRun?.ok === false).length;
    return `${members.length}개 노드${running ? ` · 실행 ${running}` : ""}${waiting ? ` · 응답 대기 ${waiting}` : ""}${failed ? ` · 오류 ${failed}` : ""}`;
  }

  function size(group) {
    const portsHeight = 105 + Math.max(group.ports.filter((port) => port.direction === "input").length, group.ports.filter((port) => port.direction === "output").length) * 30;
    const buttonsHeight = group.collapsed ? group.members.map(node).filter((item) => isSourceOnly(item)).length * 28 : 0;
    return group.collapsed ? { w: 300, h: Math.max(150, portsHeight + buttonsHeight) } : { w: group.rect.w, h: Math.max(group.rect.h, portsHeight) };
  }

  function portPoint(group, port) {
    const ports = group.ports.filter((item) => item.direction === port.direction);
    const index = Math.max(0, ports.findIndex((item) => item.id === port.id));
    const dimensions = size(group);
    return { x: group.rect.x + (port.direction === "output" ? dimensions.w : 0), y: group.rect.y + 85 + index * 30 };
  }

  function portElement(group, port) {
    const portNode = el("div", { class: `node-group-port ${port.direction}`, "data-port-id": port.id, "data-node-id": port.nodeId, "data-direction": port.direction, "data-when": port.when ?? "", title: `${port.label} · ${title(port.nodeId)}${port.when ? ` · ${conditionLabel(port.when)}` : ""}` },
      el("span", { class: "node-group-port-dot" }), el("span", { class: "node-group-port-label" }, port.label));
    const point = portPoint(group, port);
    portNode.style.top = `${point.y - group.rect.y}px`;
    return portNode;
  }

  function render(graph) {
    graph.groupFrames = new Map();
    graph.groupByMember = new Map();
    for (const group of groups()) {
      for (const id of group.members) graph.groupByMember.set(id, group);
      const dimensions = size(group);
      const frame = el("div", { class: `node-group${group.collapsed ? " collapsed" : ""}`, "data-group-id": group.id, title: group.title },
        el("div", { class: "node-group-header" },
          el("button", { type: "button", class: "node-group-toggle", title: group.collapsed ? "그룹 펼치기" : "그룹 접기", onclick: () => update(group, { collapsed: !group.collapsed }) }, group.collapsed ? "▸" : "▾"),
          el("strong", { class: "node-group-title" }, group.title),
          el("button", { type: "button", class: "node-group-edit", title: "그룹 이름·멤버·입출력 편집", onclick: () => edit(group) }, "편집")),
        el("div", { class: "node-group-summary" }, summary(group)),
        group.collapsed ? el("div", { class: "node-group-buttons" }, ...group.members.map(node).filter((item) => isSourceOnly(item)).map((button) => el("button", { type: "button", title: `${button.title} ${button.kind === "schedule" ? isScheduleArmed(button) ? "예약 중지" : "예약 시작" : button.state === "watching" ? "감시 중지" : "실행"}`, ...(button.state === "running" ? { disabled: "" } : {}), onclick: () => runCommand(button) }, `${button.state === "watching" || isScheduleArmed(button) ? "■" : "▶"} ${button.title}`))) : null,
        ...group.ports.map((port) => portElement(group, port)),
        group.collapsed ? null : el("span", { class: "node-group-resize", title: "그룹 크기 조절" }));
      Object.assign(frame.style, { left: `${group.rect.x}px`, top: `${group.rect.y}px`, width: `${dimensions.w}px`, height: `${dimensions.h}px` });
      graph.canvas.insertBefore(frame, graph.svg.nextSibling);
      graph.groupFrames.set(group.id, frame);
      if (group.collapsed) for (const id of group.members) { graph.cards.get(id)?.remove(); graph.cards.delete(id); }
    }
  }

  function place(graph) {
    for (const group of groups()) {
      const frame = graph.groupFrames?.get(group.id);
      if (!frame) continue;
      const dimensions = size(group);
      Object.assign(frame.style, { left: `${group.rect.x}px`, top: `${group.rect.y}px`, width: `${dimensions.w}px`, height: `${dimensions.h}px` });
      graph.size.width = Math.max(graph.size.width, group.rect.x + dimensions.w + 30);
      graph.size.height = Math.max(graph.size.height, group.rect.y + dimensions.h + 30);
    }
  }

  // Boundary ports only change how an edge is drawn; execution endpoints stay intact.
  function endpoint(graph, id, direction, otherId, link = {}) {
    const group = graph.groupByMember?.get(id);
    const otherGroup = graph.groupByMember?.get(otherId);
    if (group && group === otherGroup && group.collapsed) return null;
    if (group && group !== otherGroup) {
      const matching = group.ports.filter((port) => port.nodeId === id && port.direction === direction);
      const port = direction === "output" ? matching.find((item) => (item.when ?? "success") === (link.when ?? "success") && (item.keyword ?? "") === (link.keyword ?? "")) ?? matching.find((item) => !item.when) : matching[0];
      if (port) return portPoint(group, port);
      if (group.collapsed) return { x: group.rect.x + (direction === "output" ? size(group).w : 0), y: group.rect.y + 60 };
    }
    const pos = graph.pos.get(id);
    if (!pos) return null;
    const dimensions = nodeSize(id);
    return { x: pos.x + (direction === "output" ? dimensions.w : 0), y: pos.y + (direction === "output" && hasBranchPorts(node(id)) ? link.when === "error" ? 78 : 40 : dimensions.h / 2) };
  }

  function containsHiddenEdge(graph, from, to) {
    const group = graph.groupByMember?.get(from);
    return group?.collapsed && group === graph.groupByMember.get(to);
  }

  function pointerDown(event) {
    const frame = event.target.closest(".node-group");
    if (!frame) return false;
    const group = byId(frame.dataset.groupId);
    if (!group) return true;
    const portElement = event.target.closest(".node-group-port");
    if (portElement) {
      if (portElement.dataset.direction === "output") startPortDrag(event, group, group.ports.find((port) => port.id === portElement.dataset.portId));
      return true;
    }
    if (event.target.closest("button")) return true;
    // The expanded body remains available for box selection of its member nodes.
    if (!group.collapsed && !event.target.closest(".node-group-header, .node-group-summary, .node-group-resize")) return false;
    event.preventDefault();
    const graph = ui.graph;
    const start = canvasPoint(event);
    const before = { ...group.rect };
    const origins = new Map(group.members.map((id) => [id, graph.pos.get(id) ? { ...graph.pos.get(id) } : null]).filter(([, pos]) => pos));
    const resizing = !!event.target.closest(".node-group-resize");
    let moved = false;
    graph.dragging = true;
    trackGesture(event, (move) => {
      const at = canvasPoint(move);
      const dx = at.x - start.x, dy = at.y - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      if (resizing) group.rect = { ...before, w: Math.max(380, before.w + dx), h: Math.max(260, before.h + dy) };
      else {
        const x = Math.max(0, before.x + dx), y = Math.max(0, before.y + dy);
        group.rect = { ...before, x, y };
        for (const [id, pos] of origins) graph.pos.set(id, { x: pos.x + x - before.x, y: pos.y + y - before.y });
      }
      placeCards();
    }, async (_end, cancelled) => {
      graph.dragging = false;
      if (cancelled) {
        group.rect = before;
        for (const [id, pos] of origins) graph.pos.set(id, pos);
        placeCards();
      } else if (moved) {
        const rect = { ...group.rect };
        // The server calculates member movement from its previous group rectangle.
        await update(group, { rect }, { refreshNodes: !resizing });
      } else {
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        if (!additive) ui.graphSelected = new Set([group.id]);
        else if (ui.graphSelected.has(group.id)) ui.graphSelected.delete(group.id); else ui.graphSelected.add(group.id);
        syncSelection();
      }
    });
    return true;
  }

  function startPortDrag(event, group, port) {
    if (!port) return;
    event.preventDefault();
    const graph = ui.graph;
    const from = portPoint(group, port);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "temp");
    graph.svg.append(path);
    graph.dragging = true;
    trackGesture(event, (move) => {
      const to = canvasPoint(move), dx = Math.max(40, Math.abs(to.x - from.x) / 2);
      path.setAttribute("d", `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`);
    }, (end, cancelled) => {
      graph.dragging = false; path.remove();
      if (cancelled) return;
      const target = document.elementFromPoint(end.clientX, end.clientY);
      const input = target?.closest('.node-group-port[data-direction="input"]');
      const targetId = input?.dataset.nodeId ?? target?.closest(".gcard, .gcmd")?.dataset.id;
      if (targetId && targetId !== port.nodeId) openLinkDialog(null, port.nodeId, targetId, port.when, port.keyword);
      else if (!target?.closest(".node-group") && target?.closest("#p-graph")) openCreateMenu(end, port.nodeId, port.when, port.keyword);
    });
  }

  function selectedEntries() {
    const selected = [...ui.graphSelected].filter((id) => node(id));
    const entries = [];
    if (selected.some((id) => !owner(id))) entries.push([`선택한 노드 ${selected.filter((id) => !owner(id)).length}개 그룹 만들기`, () => create(selected)]);
    const own = new Set(selected.map(owner).filter(Boolean));
    for (const group of own) entries.push([`선택 노드를 “${group.title}” 밖으로 꺼내기`, () => update(group, { members: group.members.filter((id) => !selected.includes(id)) })]);
    if (selected.length && selected.every((id) => !owner(id))) for (const group of groups()) entries.push([`“${group.title}”에 선택 노드 넣기`, () => update(group, { members: [...group.members, ...selected] })]);
    return entries;
  }

  function contextEntries(group) {
    return [[group.collapsed ? "그룹 펼치기" : "그룹 접기", () => update(group, { collapsed: !group.collapsed })], ["이름·멤버·입출력 편집", () => edit(group)], ...(saveGroupTemplate ? [["템플릿으로 저장", () => saveGroupTemplate(group)]] : []), ...group.members.map(node).filter((item) => isSourceOnly(item)).map((button) => [`${button.title} ${button.kind === "schedule" ? isScheduleArmed(button) ? "예약 중지" : "예약 시작" : "실행"}`, () => runCommand(button), { disabled: button.state === "running" }]), null, ["그룹 해제 (내부 노드 유지)", () => dissolve(group)]];
  }

  async function droppedMembers(ids) {
    const graph = ui.graph;
    const changed = new Map();
    for (const id of ids) {
      const pos = graph?.pos.get(id);
      if (!pos) continue;
      const dimensions = nodeSize(id), center = { x: pos.x + dimensions.w / 2, y: pos.y + dimensions.h / 2 };
      const previous = owner(id);
      const target = groups().find((group) => !group.collapsed && center.x > group.rect.x && center.x < group.rect.x + group.rect.w && center.y > group.rect.y + 62 && center.y < group.rect.y + group.rect.h);
      if (previous?.id === target?.id) continue;
      if (previous) { const members = changed.get(previous.id) ?? [...previous.members]; changed.set(previous.id, members.filter((member) => member !== id)); }
      if (target) { const members = changed.get(target.id) ?? [...target.members]; changed.set(target.id, [...members, id]); }
    }
    // Remove old membership first so moving directly to another group stays valid.
    const entries = [...changed].sort(([a, membersA], [b, membersB]) => (membersA.length - byId(a).members.length) - (membersB.length - byId(b).members.length));
    for (const [id, members] of entries) { const group = byId(id); if (group) await update(group, { members }); }
  }

  function edit(group) {
    document.getElementById("node-group-dialog")?.remove();
    const name = el("input", { value: group.title, maxlength: "120", "aria-label": "그룹 이름", required: "" });
    const memberList = el("div", { class: "node-group-members" });
    const chosen = new Set(group.members);
    for (const item of nodes()) {
      const existing = owner(item.id), disabled = existing && existing.id !== group.id;
      const input = el("input", { type: "checkbox", value: item.id, ...(chosen.has(item.id) ? { checked: "" } : {}), ...(disabled ? { disabled: "" } : {}) });
      input.addEventListener("change", () => { if (input.checked) chosen.add(item.id); else chosen.delete(item.id); rebuildCandidates(); });
      memberList.append(el("label", { class: "check" }, input, ` ${item.title}`, el("span", { class: "muted" }, ` · ${kind(item)}${disabled ? ` · ${existing.title} 소속` : ""}`)));
    }
    let ports = group.ports.map((port) => ({ ...port }));
    const portList = el("div", { class: "node-group-port-editor" });
    const candidate = el("select", { "aria-label": "포트에 연결할 내부 노드" });
    const direction = el("select", { "aria-label": "포트 방향" }, el("option", { value: "input" }, "입력"), el("option", { value: "output" }, "출력"));
    const conditionOptions = data.status?.linkConditions?.length ? data.status.linkConditions : ["success", "error", "always", "keyword", "otherwise", "manual"].map((id) => ({ id, label: conditionLabel(id) }));
    const condition = el("select", { "aria-label": "출력 조건" });
    const keyword = el("input", { placeholder: "키워드", "aria-label": "포트 키워드" });
    const error = el("p", { class: "error", role: "alert" });
    const rebuildCandidates = () => {
      const previous = candidate.value;
      candidate.replaceChildren(...nodes().filter((item) => chosen.has(item.id) && (direction.value === "input" ? !isSourceOnly(item) : item.kind !== "markdown")).map((item) => el("option", { value: item.id }, `${item.title} · ${kind(item)}`)));
      if ([...candidate.options].some((option) => option.value === previous)) candidate.value = previous;
      const previousCondition = condition.value;
      const allowed = conditionOptions.filter((item) => !resultOnlyOutputs(node(candidate.value)) || ["success", "error", "always", "manual"].includes(item.id));
      condition.replaceChildren(...allowed.map((item) => el("option", { value: item.id }, item.label)));
      if (allowed.some((item) => item.id === previousCondition)) condition.value = previousCondition;
      condition.hidden = direction.value !== "output";
      keyword.hidden = direction.value !== "output" || condition.value !== "keyword";
    };
    const renderPorts = () => {
      portList.replaceChildren(...ports.map((port) => {
        const label = el("input", { value: port.label, "aria-label": `${port.direction === "input" ? "입력" : "출력"} 포트 이름` });
        label.addEventListener("input", () => port.label = label.value);
        return el("div", { class: "node-group-port-row" }, el("span", { class: "muted" }, port.direction === "input" ? "입력" : "출력"), label, el("span", { class: "node-group-port-node" }, `${title(port.nodeId)}${port.when ? ` · ${conditionLabel(port.when)}${port.keyword ? `: ${port.keyword}` : ""}` : ""}`), el("button", { type: "button", onclick: () => { ports = ports.filter((item) => item !== port); renderPorts(); } }, "제거"));
      }));
      if (!ports.length) portList.append(el("p", { class: "muted" }, "노드의 입력·출력을 노출하세요. 기존 외부 연결은 포트로 자동 표시됩니다."));
    };
    direction.addEventListener("change", rebuildCandidates); condition.addEventListener("change", rebuildCandidates); candidate.addEventListener("change", rebuildCandidates);
    rebuildCandidates(); renderPorts();
    const form = el("form", { method: "dialog", class: "node-group-form" },
      el("h2", {}, "노드 그룹 편집"), el("label", {}, "그룹 이름", name),
      el("h3", {}, "그룹 안의 노드"), el("p", { class: "muted" }, "세션, GIT, 명령, 버튼, 출력 등 모든 노드를 넣을 수 있습니다. 체크를 풀면 그룹 밖으로 꺼냅니다."), memberList,
      el("h3", {}, "외부 입출력"), el("p", { class: "muted" }, "연결된 포트를 없애려면 연결선을 먼저 제거하세요. 외부 연결의 포트는 자동으로 유지됩니다."), portList,
      el("div", { class: "node-group-port-add" }, direction, candidate, condition, keyword, el("button", { type: "button", onclick: () => {
        if (!candidate.value) return;
        const when = direction.value === "output" ? condition.value : undefined;
        if (when === "keyword" && !keyword.value.trim()) { error.textContent = "출력 키워드를 입력하세요."; return; }
        ports.push({ id: `port-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, direction: direction.value, nodeId: candidate.value, label: title(candidate.value) + (when ? ` · ${condition.selectedOptions[0].textContent}` : " 입력"), ...(when ? { when, ...(when === "keyword" ? { keyword: keyword.value.trim() } : {}) } : {}) });
        error.textContent = ""; renderPorts();
      } }, "포트 추가")), error,
      el("div", { class: "dialog-actions" }, saveGroupTemplate ? el("button", { type: "button", class: "ghost", onclick: () => saveGroupTemplate(group) }, "템플릿으로 저장") : null, el("button", { value: "cancel", type: "button", onclick: () => dialog.close() }, "취소"), el("button", { type: "submit", class: "primary" }, "저장")));
    const dialog = el("dialog", { id: "node-group-dialog", class: "node-group-dialog" }, form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!name.value.trim()) { error.textContent = "그룹 이름을 입력하세요."; return; }
      const body = { title: name.value.trim(), members: [...chosen], ports: ports.filter((port) => chosen.has(port.nodeId)).map((port) => ({ ...port, label: port.label.trim() || title(port.nodeId) })) };
      if (await update(group, body)) dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
  }

  return { groups, byId, owner, load, ensureLoaded, create, update, dissolve, render, place, endpoint, containsHiddenEdge, pointerDown, selectedEntries, contextEntries, edit, size, portPoint, droppedMembers };
}

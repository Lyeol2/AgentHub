import { $, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { openContextMenu } from "../../shared/context-menu.js";

const ACTIVE_KEY = "agenthub-graph-active-tabs";
export const graphProjectKey = (path) => String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export const graphScopeKey = (path, tabId) => `${graphProjectKey(path)}::${tabId ?? ""}`;
export const nodeTabId = (node, data) => node?.tabId || data.defaultGraphTabId || null;
export const inGraphTab = (node, data, navigation) => !navigation.graphTabId || nodeTabId(node, data) === navigation.graphTabId;

function readActive() {
  try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "{}"); } catch { return {}; }
}

// Tabs own presentation only. Moving a node never changes its execution ID or links.
export function createGraphTabs({ api, data, navigation, beforeSwitch = () => true, onSwitch = () => {}, onChanged = async () => {}, getSelection = () => [] }) {
  let loading = null;
  let request = 0;
  let busy = false;
  let error = "";
  let dragged = null;
  const tabs = () => samePath(data.graphTabsProject, navigation.project) ? data.graphTabs ?? [] : [];
  const remember = () => {
    try { const active = readActive(); active[graphProjectKey(navigation.project)] = navigation.graphTabId; localStorage.setItem(ACTIVE_KEY, JSON.stringify(active)); } catch { /* Storage may be unavailable. */ }
  };
  const currentNodes = () => [...(data.sessions ?? []).filter((node) => !node.chat && samePath(node.projectPath, navigation.project)), ...(samePath(data.commandsProject, navigation.project) ? data.commands ?? [] : [])];

  function select(id, { focus = false, force = false } = {}) {
    if (!tabs().some((tab) => tab.id === id)) return false;
    if (id !== navigation.graphTabId) {
      if (beforeSwitch({ force }) === false) return false;
      navigation.graphTabId = id;
      navigation.viewRevision = (navigation.viewRevision ?? 0) + 1;
      remember();
      onSwitch();
    }
    render();
    const button = $("p-graph-tabs")?.querySelector(`[data-graph-tab="${id}"]`);
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (focus) button?.focus();
    return true;
  }

  async function load(projectPath = navigation.project) {
    if (!projectPath) return;
    const mine = ++request;
    loading = projectPath;
    try {
      const result = await api("GET", `/api/graph-tabs?path=${encodeURIComponent(projectPath)}`);
      if (mine !== request || !samePath(projectPath, navigation.project)) return;
      if (!result?.tabs?.length) throw Error("그리드 탭을 불러오지 못했습니다.");
      const previous = samePath(data.graphTabsProject, projectPath) ? navigation.graphTabId : readActive()[graphProjectKey(projectPath)];
      data.graphTabs = result.tabs;
      data.graphTabsProject = projectPath;
      data.defaultGraphTabId = result.defaultTabId;
      error = "";
      const next = result.tabs.some((tab) => tab.id === previous) ? previous : result.defaultTabId;
      if (next !== navigation.graphTabId) select(next, { force: true });
      else { render(); onSwitch(); }
    } catch (err) {
      if (mine !== request || !samePath(projectPath, navigation.project)) return;
      error = err.message;
      // Keep loaded tabs on transient failures. Legacy fixtures can still render their graph.
      if (!samePath(data.graphTabsProject, projectPath)) {
        data.graphTabs = []; data.graphTabsProject = projectPath; data.defaultGraphTabId = null; navigation.graphTabId = null;
      }
      render(); onSwitch();
    } finally { if (mine === request) loading = null; }
  }

  function ensureLoaded() {
    if (navigation.project && !samePath(data.graphTabsProject, navigation.project) && !samePath(loading, navigation.project)) {
      navigation.graphTabId = null;
      void load();
    }
  }

  async function mutate(action) {
    if (busy) return;
    busy = true; error = ""; render();
    try { await action(); }
    catch (err) { error = err.message; }
    finally { busy = false; render(); }
  }

  async function add() {
    const projectPath = navigation.project;
    if (!projectPath || !tabs().length) return;
    await mutate(async () => {
      const tab = await api("POST", "/api/graph-tabs", { projectPath });
      if (!samePath(projectPath, navigation.project)) return;
      await load(projectPath);
      select(tab.id, { focus: true });
    });
  }

  async function reorder(id, target) {
    const projectPath = navigation.project;
    const ids = tabs().map((tab) => tab.id);
    const from = ids.indexOf(id);
    if (from < 0 || target < 0 || target >= ids.length || from === target) return;
    ids.splice(from, 1); ids.splice(target, 0, id);
    await mutate(async () => {
      await api("POST", "/api/graph-tabs/reorder", { projectPath, ids });
      if (samePath(projectPath, navigation.project)) await load(projectPath);
    });
  }

  function edit(tab, action) {
    if (busy || (action === "delete" && tabs().length < 2)) return;
    $("p-graph-tab-dialog")?.remove();
    const projectPath = navigation.project;
    const name = el("input", { id: "p-graph-tab-name", value: tab.title, maxlength: "100", required: "", autocomplete: "off" });
    const target = el("select", { id: "p-graph-tab-target" }, ...tabs().filter((item) => item.id !== tab.id).map((item) => el("option", { value: item.id }, item.title)));
    if (data.defaultGraphTabId !== tab.id) target.value = data.defaultGraphTabId;
    const count = currentNodes().filter((node) => nodeTabId(node, data) === tab.id).length;
    const hasGroups = (data.nodeGroups ?? []).some((group) => nodeTabId(group, data) === tab.id);
    if (action === "delete" && !count && !hasGroups) {
      void mutate(async () => {
        await api("DELETE", `/api/graph-tabs/${tab.id}?target=${encodeURIComponent(target.value)}`);
        await onChanged(projectPath, { tabIds: [tab.id] });
        if (samePath(projectPath, navigation.project)) await load(projectPath);
      });
      return;
    }
    const message = el("p", { class: "error", role: "alert" });
    const confirm = el("button", { id: "p-graph-tab-confirm", type: "submit", class: "primary" }, action === "delete" ? "옮기고 탭 삭제" : "저장");
    const form = el("form", { method: "dialog", class: "dialog-form" },
      el("h3", {}, action === "delete" ? `탭 삭제 · ${tab.title}` : "탭 이름 변경"),
      action === "delete" ? el("p", {}, `노드 ${count}개와 그룹을 선택한 탭으로 옮깁니다. 연결과 실행은 유지됩니다.`) : null,
      el("label", {}, action === "delete" ? "옮길 탭" : "탭 이름", action === "delete" ? target : name), message,
      el("menu", {}, el("button", { type: "button", "data-action": "cancel", onclick: () => dialog.close() }, "취소"), confirm));
    const dialog = el("dialog", { id: "p-graph-tab-dialog", "aria-label": action === "delete" ? "그리드 탭 삭제" : "그리드 탭 이름 변경" }, form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (confirm.disabled || !samePath(projectPath, navigation.project)) return;
      if (action !== "delete" && !name.value.trim()) { message.textContent = "탭 이름을 입력하세요."; return; }
      confirm.disabled = true;
      try {
        if (action === "delete") {
          await api("DELETE", `/api/graph-tabs/${tab.id}?target=${encodeURIComponent(target.value)}`);
          await onChanged(projectPath, { tabIds: [tab.id, target.value] });
        } else await api("PUT", `/api/graph-tabs/${tab.id}`, { title: name.value.trim() });
        dialog.close();
        if (samePath(projectPath, navigation.project)) await load(projectPath);
      } catch (err) { message.textContent = err.message; confirm.disabled = false; }
    });
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
    if (action !== "delete") { name.focus(); name.select(); }
  }

  async function move(id, nodeIds = getSelection()) {
    if (!nodeIds.length || id === navigation.graphTabId) return;
    const projectPath = navigation.project;
    const fromTabId = navigation.graphTabId;
    await mutate(async () => {
      await api("POST", `/api/graph-tabs/${id}/move`, { nodeIds });
      await onChanged(projectPath, { tabIds: [fromTabId, id] });
      if (samePath(projectPath, navigation.project)) { await load(projectPath); if (navigation.graphTabId === fromTabId) select(id, { focus: true }); }
    });
  }
  function moveEntries(nodeIds) {
    return tabs().filter((tab) => tab.id !== navigation.graphTabId).map((tab) => [`탭으로 이동: ${tab.title}`, () => move(tab.id, nodeIds), { disabled: busy }]);
  }
  function menu(event, tab, index) {
    openContextMenu(event, tab.title, [
      ["이름 변경", () => edit(tab, "rename")],
      ["왼쪽으로 이동", () => reorder(tab.id, index - 1), { disabled: index === 0 || busy }],
      ["오른쪽으로 이동", () => reorder(tab.id, index + 1), { disabled: index === tabs().length - 1 || busy }],
      null, ["탭 삭제", () => edit(tab, "delete"), { disabled: tabs().length === 1 || busy, danger: true }],
    ]);
  }

  function render() {
    const box = $("p-graph-tabs");
    if (!box?.replaceChildren) return;
    const focused = box.contains(document.activeElement) ? document.activeElement?.dataset.graphTab : null;
    const nodes = currentNodes();
    const buttons = tabs().map((tab, index) => {
      const members = nodes.filter((node) => nodeTabId(node, data) === tab.id);
      const running = members.filter((node) => ["running", "watching"].includes(node.state) || node.scheduleEnabled).length;
      const ids = new Set(members.map((node) => node.id));
      const waiting = members.filter((node) => node.waiting || node.pendingPermission || node.pendingQuestion).length + (data.links ?? []).filter((link) => link.pending && (ids.has(link.from) || ids.has(link.to))).length;
      const active = tab.id === navigation.graphTabId;
      const label = `${tab.title}${running ? ` · 실행 ${running}` : ""}${waiting ? ` · 응답 대기 ${waiting}` : ""}`;
      return el("button", { type: "button", role: "tab", "data-graph-tab": tab.id, "aria-selected": String(active), "aria-controls": "p-graph", tabindex: active ? "0" : "-1", class: `graph-tab${active ? " active" : ""}`, draggable: String(!busy), title: `${label} · 두 번 클릭해 이름 변경 · 우클릭해 관리`,
        onclick: () => select(tab.id), ondblclick: () => edit(tab, "rename"), oncontextmenu: (event) => menu(event, tab, index),
        onkeydown: (event) => {
          if (event.key === "F2") { event.preventDefault(); edit(tab, "rename"); return; }
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs().length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs().length) % tabs().length;
          select(tabs()[next].id, { focus: true });
        },
        ondragstart: (event) => { dragged = tab.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.id); },
        ondragend: () => { dragged = null; },
        ondragover: (event) => { if (dragged) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } },
        ondrop: (event) => { event.preventDefault(); const id = dragged; dragged = null; if (id) void reorder(id, index); },
      }, el("span", { class: "graph-tab-title" }, tab.title), running ? el("span", { class: "graph-tab-running", "aria-label": `실행 ${running}` }, `▶ ${running}`) : null, waiting ? el("span", { class: "graph-tab-waiting", "aria-label": `응답 대기 ${waiting}` }, `! ${waiting}`) : null);
    });
    box.replaceChildren(el("div", { class: "graph-tab-list", role: "tablist", "aria-label": "그리드 탭" }, ...buttons),
      el("button", { id: "p-graph-tab-add", type: "button", class: "ghost graph-tab-add", "aria-label": "그리드 탭 추가", title: "새 그리드 탭", ...(busy || !tabs().length ? { disabled: "" } : {}), onclick: add }, "+"),
      ...(error ? [el("button", { type: "button", class: "ghost graph-tab-error", title: error, onclick: () => load() }, "탭 다시 불러오기")] : []));
    if (focused) box.querySelector(`[data-graph-tab="${focused}"]`)?.focus({ preventScroll: true });
  }
  return { load, ensureLoaded, render, select, moveEntries, tabs,
    ready: () => tabs().some((tab) => tab.id === navigation.graphTabId),
    error: () => error,
  };
}

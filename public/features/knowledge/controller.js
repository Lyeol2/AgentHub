import { $, el, badge } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { linkLabel } from "../../shared/flow.js";

export function createKnowledgeController({ api, loadSessions, loadProjects, currentProject, loadLinks, data, navigation }) {
  const ui = {
    "boardProject": null,
    "boardDirty": null,
    "flowHub": null
  };
  // ── 공유 노트 ───────────────────────────────────────────────────
  // 세션들이 MCP 도구로 덧붙이는 프로젝트 메모. 열어 둔 동안 세션이 덧붙이면 다시 받는다(고치던 중이면 그대로 둔다).
  async function loadBoard() {
    const projectPath = ui.boardProject;
    try {
      const { text } = await api("GET", `/api/board?path=${encodeURIComponent(projectPath)}`);
      if (!samePath(projectPath, ui.boardProject) || ui.boardDirty) return;
      $("board-text").value = text;
    } catch (err) {
      $("board-error").textContent = err.message;
    }
  }

  $("p-board").addEventListener("click", async () => {
    const p = currentProject();
    if (!p) return;
    ui.boardProject = p.path;
    ui.boardDirty = false;
    $("board-project").textContent = p.name;
    $("board-text").value = "";
    $("board-error").textContent = "";
    $("board-dialog").showModal();
    await loadBoard();
  });
  $("board-text").addEventListener("input", () => { ui.boardDirty = true; });

  $("board-form").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    e.preventDefault();
    if (action === "clear" && !confirm("공유 노트를 모두 지울까요?")) return;
    try {
      const text = action === "clear" ? "" : $("board-text").value;
      await api("PUT", "/api/board", { path: ui.boardProject, text });
      $("board-dialog").close();
    } catch (err) {
      $("board-error").textContent = err.message;
    }
  });

  // ── AGENTHUB.md ─────────────────────────────────────────────────
  async function loadHub(projectPath) {
    const hub = await api("GET", `/api/hub?path=${encodeURIComponent(projectPath)}`);
    data.hubs.set(projectPath.toLowerCase(), hub);
    return hub;
  }

  async function renderHub() {
    const projectPath = navigation.project;
    const bar = $("p-hub");
    let hub;
    try {
      hub = await loadHub(projectPath);
    } catch (err) {
      bar.replaceChildren(el("span", { class: "error" }, err.message));
      return;
    }
    if (!samePath(navigation.project, projectPath)) return; // 기다리는 사이 다른 화면으로 이동함
    if (!hub.exists) {
      bar.replaceChildren(
        el("span", { class: "muted" }, "AGENTHUB.md가 없습니다. 만들면 공통 지침과 역할·흐름 템플릿을 쓸 수 있습니다."),
        el("span", { class: "spacer" }),
        el("button", { class: "sm", onclick: initHub }, "AGENTHUB.md 만들기"));
      return;
    }
    const start = el("button", { class: "sm primary", onclick: () => openFlowDialog(hub) }, "흐름 시작");
    start.disabled = !hub.flows.length;
    bar.replaceChildren(
      el("b", { class: "hub-file", title: hub.file }, "AGENTHUB.md"),
      el("span", { class: "muted" },
        `공통 지침 ${hub.common ? "있음" : "없음"} · 역할 ${hub.roles.length} · 흐름 ${hub.flows.length}`),
      el("span", { class: "spacer" }),
      el("button", { class: "ghost sm", onclick: openHubFile }, "열기"),
      el("button", { class: "ghost sm", onclick: renderHub }, "다시 읽기"),
      start);
    if (hub.warnings.length) bar.append(el("ul", { class: "hub-warnings" }, ...hub.warnings.map((w) => el("li", {}, w))));
  }

  async function initHub() {
    try {
      await api("POST", "/api/hub/init", { path: navigation.project });
      await loadProjects(); // 감지된 프로젝트는 이때 등록된다.
      await renderHub();
      openHubFile();
    } catch (err) {
      alert(err.message);
    }
  }

  function openHubFile() {
    api("POST", "/api/hub/open", { path: navigation.project }).catch((err) => alert(err.message));
  }

  // ── 흐름 시작 ───────────────────────────────────────────────────
  function openFlowDialog(hub) {
    ui.flowHub = hub;
    $("flow-name").replaceChildren(...hub.flows.map((f) => el("option", { value: f.name }, f.name)));
    $("flow-label").value = "";
    $("flow-prompt").value = "";
    $("flow-error").textContent = "";
    renderFlowPreview();
    $("flow-dialog").showModal();
  }

  function renderFlowPreview() {
    const hub = ui.flowHub;
    const flow = hub.flows.find((f) => f.name === $("flow-name").value);
    if (!flow) return;
    const names = [...new Set(flow.steps.flatMap((s) => [s.from, s.to]))];
    const roles = names.map((n) => hub.roles.find((r) => r.name === n));
    $("flow-preview").replaceChildren(
      el("div", { class: "flow-roles" }, ...names.map((n, i) => roles[i]
        ? el("span", { class: "flow-role-chip", title: roles[i].body }, badge(roles[i].agent), ` ${n} `,
          el("span", { class: "muted" }, roles[i].permission))
        : el("span", { class: "flow-role-chip missing" }, `${n} (역할 없음)`))),
      el("ul", { class: "flow-steps" }, ...flow.steps.map((s) =>
        el("li", {}, `${s.from} → ${s.to}`, el("span", { class: "muted" }, ` · ${linkLabel(s)}${s.note ? ` · ${s.note}` : ""}`)))));
  }
  $("flow-name").addEventListener("change", renderFlowPreview);

  $("flow-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      await api("POST", "/api/hub/flows", {
        projectPath: navigation.project,
        flowName: $("flow-name").value,
        name: $("flow-label").value,
        prompt: $("flow-prompt").value,
      });
      $("flow-dialog").close();
      await Promise.all([loadSessions(), loadLinks(), loadProjects()]);
    } catch (err) {
      $("flow-error").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  function refreshBoard(projectPath) {
    if ($("board-dialog").open && samePath(projectPath, ui.boardProject)) return loadBoard();
  }

  return { loadHub, renderHub, refreshBoard };
}

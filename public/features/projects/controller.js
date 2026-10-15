import { createProjectsView } from "./view.js";
import { $, el, badge, timeAgo, table } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";

export function createProjectsController({ sessionOpener, api, goDashboard, goProject, selectSession, loadGit, loadIssues, renderIssueCount, loadTasks, loadLinks, renderGraph, loadMessages, loadCommands, loadSkills, renderHub, openSessionMenu, toggleSessionLock, openNew, data, navigation }) {
  const ui = {
    "filter": "",
    "removingProject": null,
    "showHiddenFound": null
  };
  const { renderProjectNav, renderSessionList, renderDashboard, renderProjectSessionTable } = createProjectsView({
    data, navigation, getFilter: () => ui.filter, sortedProjects, hubSessions: (project) => hubSessions(project),
    lastActive, currentProject, goProject, openRemoveProject, sessionOpener, openSessionMenu, toggleSessionLock,
  });

  // ── 사이드바 ────────────────────────────────────────────────────
  async function loadSessions() {
    data.sessions = await api("GET", "/api/sessions");
    renderSessionList();
    renderProjectNav();
    if (navigation.view === "dashboard") renderDashboard();
    if (navigation.view === "project") renderProjectSessions();
  }

  // ── 프로젝트 목록(등록 + 자동 감지) ─────────────────────────────
  const hubSessions = (p) => data.sessions.filter((s) => samePath(s.projectPath, p.path));

  async function loadProjects() {
    try {
      data.projects = await api("GET", "/api/projects/all");
    } catch {
      return;
    }
    renderProjectNav();
    if (navigation.view === "dashboard") renderDashboard();
  }

  // 감지된 기록과 AgentHub 세션 중 가장 최근 활동
  function lastActive(p) {
    return [p.lastActive, ...hubSessions(p).map((s) => s.updatedAt)].filter(Boolean).sort().at(-1) ?? null;
  }

  function sortedProjects() {
    return [...(data.projects ?? [])].sort((a, b) => (lastActive(b) ?? "").localeCompare(lastActive(a) ?? ""));
  }

  // 일반 채팅과 프로젝트 세션은 사이드바에서 따로 보여 준다.

  $("session-filter").addEventListener("input", (e) => {
    ui.filter = e.target.value;
    renderSessionList();
  });
  $("nav-dashboard").addEventListener("click", goDashboard);

  // ── 대시보드 ────────────────────────────────────────────────────

  // ── 프로젝트 ────────────────────────────────────────────────────
  function currentProject() {
    return data.projects?.find((p) => samePath(p.path, navigation.project));
  }

  // ── 프로젝트 탭 ─────────────────────────────────────────────────
  // 프로젝트 탭(세션 흐름 / 세션 목록 / 작업 / Git / 팀 작업). 마지막에 본 탭을 이 브라우저에 기억한다.
  const TAB_KEY = "agenthub-project-tab";
  const PROJECT_TABS = ["flow", "sessions", "tasks", "git", "issues"];
  const projectTab = () => (PROJECT_TABS.includes(localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : "flow");

  function showProjectTab(tab) {
    navigation.viewRevision = (navigation.viewRevision ?? 0) + 1;
    localStorage.setItem(TAB_KEY, tab);
    for (const b of $("p-tabs").querySelectorAll("[data-tab]")) {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    }
    for (const panel of document.querySelectorAll("#view-project .tab-panel")) panel.hidden = panel.dataset.panel !== tab;
    if (tab === "git") loadGit();
    if (tab === "tasks") loadTasks?.(navigation.project);
    if (tab === "issues") loadIssues(navigation.project);
  }

  $("p-tabs").addEventListener("click", (e) => {
    const button = e.target.closest("[data-tab]");
    if (button) showProjectTab(button.dataset.tab);
  });

  // ── 세션 목록 탭 ────────────────────────────────────────────────

  $("p-session-filter").addEventListener("input", renderProjectSessionTable);

  // ── 프로젝트 제거 ───────────────────────────────────────────────
  // AgentHub 목록에서만 뺀다. 이 프로젝트의 AgentHub 세션·명령 노드·연결·공유 노트는 지우고, 폴더와 파일은 그대로 둔다.
  function openRemoveProject(p) {
    const sessions = hubSessions(p).filter((s) => !s.chat);
    const running = sessions.filter((s) => s.state === "running").length;
    const worktrees = sessions.filter((s) => s.worktree && !s.taskId && !s.worktree.shared).length;
    const commandCount = data.commandsProject && samePath(data.commandsProject, p.path) ? (data.commands ?? []).length : 0;
    ui.removingProject = p;
    $("project-remove-name").textContent = p.name;
    $("project-remove-summary").textContent = sessions.length || commandCount
      ? `AgentHub 세션 ${sessions.length}개${commandCount ? `, 명령 노드 ${commandCount}개` : ""}와 그 연결·공유 노트·메시지 기록을 지웁니다.`
      : "이 프로젝트에는 AgentHub 세션이 없습니다. 목록에서만 뺍니다.";
    $("project-remove-worktrees-row").hidden = !worktrees;
    $("project-remove-worktree-count").textContent = String(worktrees);
    $("project-remove-worktrees").checked = false;
    $("project-remove-force-row").hidden = !running;
    $("project-remove-running-count").textContent = String(running);
    $("project-remove-force").checked = false;
    $("project-remove-error").textContent = "";
    $("project-remove-dialog").showModal();
  }

  $("p-remove").addEventListener("click", () => {
    const p = currentProject();
    if (p) openRemoveProject(p);
  });

  $("project-remove-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const p = ui.removingProject;
    const query = new URLSearchParams({ path: p.path });
    if ($("project-remove-force").checked) query.set("force", "1");
    if ($("project-remove-worktrees").checked) query.set("removeWorktrees", "1");
    const button = e.submitter;
    button.disabled = true;
    try {
      const result = await api("DELETE", `/api/projects?${query}`);
      $("project-remove-dialog").close();
      if (result.worktreeErrors.length) alert(`제거했지만 지우지 못한 작업 폴더가 있습니다(커밋하지 않은 변경이 있을 수 있음):\n\n${result.worktreeErrors.join("\n")}`);
      if (navigation.view === "project" && samePath(navigation.project, p.path)) goDashboard();
      await Promise.all([loadProjects(), loadSessions(), loadLinks()]);
    } catch (err) {
      // 실행 중인 세션이 있으면 멈추고 제거할지 고르게 한다.
      if (err.reason === "running") $("project-remove-force-row").hidden = false;
      $("project-remove-error").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  function renderProjectSessions() {
    renderGraph();
    renderProjectSessionTable();
  }

  async function renderProject() {
    const p = currentProject();
    if (!p) return goDashboard();
    $("p-name").textContent = p.name;
    $("p-path").textContent = p.path;
    $("p-registered").hidden = p.registered;
    renderProjectSessions();
    renderIssueCount();
    showProjectTab(projectTab());
    loadSkills(p.path);
    loadCommands(p.path);
    loadMessages(p.path);
    renderHub();
    table("p-found", [["세션"], ["에이전트"], ["요청", "num"], ["마지막 사용", "num"], ["", "right"]], [],
      "기록을 찾는 중…");
    await renderFound(p);
  }

  async function renderFound(p) {
    let found;
    try {
      found = await api("GET", `/api/projects/discover?path=${encodeURIComponent(p.path)}`);
    } catch (err) {
      table("p-found", [["오류"]], [], err.message);
      return;
    }
    if (navigation.project !== p.path) return; // 기다리는 사이 다른 화면으로 이동함
    // 숨긴 기록은 "숨긴 기록 보기"를 눌렀을 때만 보인다.
    const hiddenCount = found.filter((f) => f.hidden).length;
    const shown = found.filter((f) => ui.showHiddenFound || !f.hidden);
    const hide = async (f, hidden) => {
      try {
        await api("POST", "/api/projects/hide", { agentSessionId: f.agentSessionId, hidden });
      } catch (err) {
        return alert(err.message);
      }
      renderFound(p);
    };
    const rows = shown.map((f) => el("tr", { class: f.hidden ? "hidden-found" : "" },
      el("td", { class: "title-cell", title: `${f.linkedTitle ? `AgentHub: ${f.linkedTitle}\n기록: ` : ""}${f.title}\n${f.cwd}\n${f.agentSessionId}` },
        f.linkedTitle || f.title || "(제목 없음)"),
      el("td", {}, badge(f.agent)),
      el("td", { class: "num" }, String(f.turns)),
      el("td", { class: "num" }, timeAgo(f.updatedAt)),
      el("td", { class: "right" },
        f.linkedId
          ? el("button", { class: "ghost sm", onclick: () => selectSession(f.linkedId) }, "열기")
          : el("button", { class: "sm", onclick: (e) => importSession(p, f, e.target) }, "가져오기"),
        " ",
        el("button", { class: "ghost sm", title: f.hidden ? "목록에 다시 보입니다" : "이 목록에서만 숨깁니다. Claude Code·Codex 기록은 지우지 않습니다.", onclick: () => hide(f, !f.hidden) },
          f.hidden ? "다시 보이기" : "숨기기"))));
    if (hiddenCount) {
      rows.push(el("tr", { class: "empty-row" }, el("td", { colspan: "5" },
        el("button", { class: "ghost sm", onclick: () => {
          ui.showHiddenFound = !ui.showHiddenFound;
          renderFound(p);
        } }, ui.showHiddenFound ? "숨긴 기록 감추기" : `숨긴 기록 ${hiddenCount}개 보기`))));
    }
    table("p-found", [["세션"], ["에이전트"], ["요청", "num"], ["마지막 사용", "num"], ["", "right"]], rows,
      "Claude Code나 Codex에서 이 폴더로 만든 세션이 없습니다.");
  }

  async function importSession(p, f, button) {
    button.disabled = true;
    button.textContent = "가져오는 중…";
    try {
      const created = await api("POST", "/api/sessions/import", {
        projectPath: p.path, agent: f.agent, agentSessionId: f.agentSessionId,
      });
      await Promise.all([loadSessions(), loadProjects()]); // 감지된 프로젝트는 가져오면서 등록된다.
      await selectSession(created.id);
    } catch (err) {
      alert(err.message);
      button.disabled = false;
      button.textContent = "가져오기";
    }
  }

  $("p-rescan").addEventListener("click", async () => {
    await loadProjects();
    await renderProject();
  });
  $("p-new").addEventListener("click", () => openNew(navigation.project));

  return { loadSessions, loadProjects, renderProjectNav, renderSessionList, renderDashboard, currentProject, projectTab, showProjectTab, renderProjectSessions, renderProject, sortedProjects };
}

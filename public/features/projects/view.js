import { $, el, table, lifePill, timeAgo, sessionLabel, sessionBadge, pill, AGENT_LABEL } from "../../shared/dom.js";
import { samePath, firstLine } from "../../shared/store.js";
import { openContextMenu } from "../../shared/context-menu.js";

export function createProjectsView({ data, navigation, getFilter, sortedProjects, hubSessions, lastActive, currentProject, goProject, openRemoveProject, sessionOpener, openSessionMenu }) {
  function renderProjectNav() {
    const projects = sortedProjects();
    $("project-nav").replaceChildren(
      ...projects.map((p) => {
        const running = hubSessions(p).some((s) => s.state === "running");
        const total = p.claude + p.codex;
        return el("button", {
          class: `nav-item${navigation.view === "project" && samePath(navigation.project, p.path) ? " active" : ""}`,
          title: `${p.path}
  Claude Code ${p.claude} · Codex ${p.codex} · AgentHub ${hubSessions(p).length}`,
          onclick: () => goProject(p.path),
          oncontextmenu: (e) => openContextMenu(e, p.name, [
            ["열기", () => goProject(p.path)],
            null,
            ["프로젝트 제거", () => openRemoveProject(p), { danger: true }],
          ]),
        },
        el("span", { class: `dot${running ? " running" : ""}` }),
        el("span", { class: "nav-name" }, p.name),
        el("span", { class: "count" }, String(total + hubSessions(p).length)));
      }),
    );
    if (!projects.length) $("project-nav").append(el("div", { class: "hint", style: "padding:4px 10px" }, "감지된 프로젝트가 없습니다."));
  }

  function renderSessionList() {
    const q = getFilter().toLowerCase();
    const items = data.sessions.filter((s) => !q || `${s.title} ${s.projectName}`.toLowerCase().includes(q));
    const item = (s, sub) => el("button", {
      class: `session-item${data.current?.id === s.id ? " active" : ""}`,
      onclick: sessionOpener(s.id),
      onauxclick: sessionOpener(s.id),
      oncontextmenu: (e) => openSessionMenu(e, s),
    },
    el("span", { class: "top" },
      el("span", { class: `dot ${s.state}` }),
      el("span", { class: "name" }, s.title),
      s.waiting ? el("span", { class: "pill q-pending", title: "답을 기다리는 질문이나 권한 요청이 있습니다" }, "답 대기") : null,
      s.compactions ? lifePill(s) : null),
    el("span", { class: "sub" }, sub));
    const chats = items.filter((s) => s.chat);
    $("chat-list").replaceChildren(...chats.map((s) => item(s, `${sessionLabel(s)}${s.model ? ` · ${s.model}` : ""} · ${timeAgo(s.updatedAt)}`)));
    if (!chats.length) $("chat-list").append(el("div", { class: "hint", style: "padding:4px 10px" }, q ? "찾는 채팅이 없습니다." : "채팅이 없습니다."));
    $("session-list").replaceChildren(
      ...items.filter((s) => !s.chat).map((s) => item(s, `${AGENT_LABEL[s.agent]} · ${s.projectName}`)));
  }

  function renderDashboard() {
    const sessions = data.sessions;
    const projects = sortedProjects();
    const count = (st) => sessions.filter((s) => s.state === st).length;
    const kpi = (label, value, cls = "", hint = "") =>
      el("div", { class: "kpi" },
        el("div", { class: "label" }, label),
        el("div", { class: `value ${cls}` }, String(value)),
        hint && el("div", { class: "hint" }, hint));
    $("kpis").replaceChildren(
      kpi("전체 세션", sessions.length, "", `Claude ${sessions.filter((s) => s.agent === "claude").length} · Codex ${sessions.filter((s) => s.agent === "codex").length}`),
      kpi("실행 중", count("running"), count("running") ? "accent" : ""),
      kpi("오류·중단", count("error") + count("interrupted"), count("error") ? "danger" : ""),
      kpi("프로젝트", projects.length, "", `감지 ${projects.filter((p) => !p.registered).length} · 등록 ${projects.filter((p) => p.registered).length}`),
    );

    table("project-table", [["이름"], ["경로"], ["Claude", "num"], ["Codex", "num"], ["AgentHub", "num"], ["최근 활동", "num"]],
      projects.map((p) => {
        const latest = lastActive(p);
        return el("tr", { class: "click", onclick: () => goProject(p.path) },
          el("td", {}, p.name, p.registered ? null : el("span", { class: "pill detected" }, "감지됨")),
          el("td", { class: "path" }, p.path),
          el("td", { class: "num" }, String(p.claude || "—")),
          el("td", { class: "num" }, String(p.codex || "—")),
          el("td", { class: "num" }, String(hubSessions(p).length || "—")),
          el("td", { class: "num" }, latest ? timeAgo(latest) : "—"));
      }),
      data.projects ? "Claude Code나 Codex로 작업한 프로젝트가 없습니다. 설정에서 직접 추가할 수도 있습니다." : "프로젝트를 찾는 중…");

    table("recent-table", [["세션"], ["에이전트"], ["프로젝트"], ["상태"], ["업데이트", "num"]],
      sessions.slice(0, 8).map((s) => sessionRow(s, true)),
      "아직 세션이 없습니다.");
  }

  function sessionRow(s, withProject) {
    return el("tr", { class: "click", onclick: sessionOpener(s.id), onauxclick: sessionOpener(s.id) },
      el("td", { class: "title-cell", title: s.title }, s.title),
      el("td", {}, sessionBadge(s)),
      withProject ? el("td", {}, s.projectName) : el("td", { class: "path" }, s.worktree ? "작업 폴더" : "원본"),
      el("td", {}, pill(s.state)),
      el("td", { class: "num" }, timeAgo(s.updatedAt)));
  }

  function renderProjectSessionTable() {
    const p = currentProject();
    if (!p) return;
    const all = hubSessions(p).filter((s) => !s.chat);
    $("p-tab-sessions").textContent = all.length ? String(all.length) : "";
    const q = $("p-session-filter").value.trim().toLowerCase();
    const shown = all
      .filter((s) => !q || `${s.title} ${s.roleName ?? ""} ${s.role ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rows = shown.map((s) => el("tr", {
      class: "click", onclick: sessionOpener(s.id), onauxclick: sessionOpener(s.id), oncontextmenu: (e) => openSessionMenu(e, s),
    },
    el("td", { class: "title-cell", title: s.title }, s.title, s.kind === "orchestrator" ? el("span", { class: "pill orch" }, "지휘") : null),
    el("td", {}, sessionBadge(s), s.model ? el("span", { class: "muted" }, ` ${s.model}`) : null),
    el("td", { class: "role-cell", title: s.role ?? "" }, [s.roleName, firstLine(s.role)].filter(Boolean).join(" · ") || "—"),
    el("td", { class: "path", title: s.cwd }, s.worktree ? s.worktree.branch : "원본"),
    el("td", {}, s.waiting ? el("span", { class: "pill q-pending" }, "답 대기") : pill(s.state)),
    el("td", { class: "num" }, timeAgo(s.updatedAt))));
    table("p-sessions", [["세션"], ["AI"], ["역할"], ["작업 폴더"], ["상태"], ["업데이트", "num"]], rows,
      q ? "검색 결과가 없습니다." : "이 프로젝트에서 만든 세션이 없습니다. 새 세션을 만들거나 아래에서 기존 세션을 가져오세요.");
  }
  return { renderProjectNav, renderSessionList, renderDashboard, renderProjectSessionTable };
}

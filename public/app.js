const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  sessions: [],
  view: "dashboard", // dashboard | project | session
  project: null, // 보고 있는 프로젝트 경로
  current: null, // 선택한 세션의 전체 데이터
  filter: "",
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

const AGENT_LABEL = { claude: "Claude", codex: "Codex" };
const STATE_LABEL = { idle: "대기", running: "실행 중", error: "오류", interrupted: "중단됨" };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const badge = (agent) => el("span", { class: `badge ${agent}` }, AGENT_LABEL[agent]);
const pill = (s) => el("span", { class: `pill ${s}` }, STATE_LABEL[s] ?? s);

function timeAgo(iso) {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return "방금";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}일 전`;
  return new Date(iso).toLocaleDateString();
}

function table(id, headers, rows, emptyText) {
  $(id).replaceChildren(
    el("thead", {}, el("tr", {}, ...headers.map(([text, cls]) => el("th", { class: cls ?? "" }, text)))),
    el("tbody", {}, ...(rows.length ? rows
      : [el("tr", { class: "empty-row" }, el("td", { colspan: String(headers.length) }, emptyText))])),
  );
}

// ── 화면 전환 ───────────────────────────────────────────────────
function show(view) {
  state.view = view;
  for (const name of ["dashboard", "project", "session"]) $(`view-${name}`).hidden = name !== view;
  $("nav-dashboard").classList.toggle("active", view === "dashboard");
  renderProjectNav();
  renderSessionList();
}

function goDashboard() {
  state.current = null;
  state.project = null;
  show("dashboard");
  renderDashboard();
}

async function goProject(projectPath) {
  state.current = null;
  state.project = projectPath;
  show("project");
  await renderProject();
}

async function selectSession(id) {
  state.current = await api("GET", `/api/sessions/${id}`);
  state.project = null;
  show("session");
  renderSession();
}

// ── CLI 상태 ────────────────────────────────────────────────────
async function loadStatus() {
  state.status = await api("GET", "/api/status");
  $("cli-status").replaceChildren(
    ...Object.entries(state.status.agents).map(([name, info]) =>
      el("div", { title: info.path ?? "CLI를 찾지 못했습니다" },
        el("span", { class: `dot ${info.path ? "ok" : "error"}` }),
        `${AGENT_LABEL[name]} ${info.path ? info.version ?? "버전 확인 실패" : "없음"}`)),
  );
  renderProjectNav();
}

// ── 사용 한도 ───────────────────────────────────────────────────
function timeUntil(iso) {
  const sec = (new Date(iso).getTime() - Date.now()) / 1000;
  if (sec <= 0) return "초기화됨";
  if (sec < 3600) return `${Math.ceil(sec / 60)}분 후`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분 후`;
  return `${Math.floor(sec / 86400)}일 ${Math.floor((sec % 86400) / 3600)}시간 후`;
}

const fmtDate = (iso) => new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 초기화 시각이 지난 기간은 사용률을 알 수 없으므로 0%로 보지 않고 따로 표시한다.
const isExpired = (w) => w.resetsAt && new Date(w.resetsAt).getTime() <= Date.now();

function barLevel(used) {
  if (used >= 90) return "danger";
  if (used >= 70) return "warn";
  return "";
}

function limitRow(w) {
  const expired = isExpired(w);
  const used = expired ? null : w.usedPercent;
  const statusText = w.status === "rejected" ? "한도 도달" : w.status === "allowed_warning" ? "한도 임박" : null;
  const value = used !== null && used !== undefined
    ? `${Math.max(0, 100 - used).toFixed(0)}% 남음`
    : expired ? "초기화됨" : statusText ?? "사용률 정보 없음";
  const level = used !== null && used !== undefined ? barLevel(used)
    : w.status === "rejected" ? "danger" : w.status === "allowed_warning" ? "warn" : "";
  const width = used !== null && used !== undefined ? used : w.status === "rejected" ? 100 : 0;
  return el("div", { class: "limit-row" },
    el("div", { class: "line" }, el("span", {}, w.label), el("b", {}, value)),
    el("div", { class: "bar" }, el("span", { class: level, style: `width:${Math.min(100, width)}%` })),
    w.resetsAt && !expired
      ? el("div", { class: "reset" }, `${used !== null && used !== undefined ? `${used}% 사용 · ` : ""}초기화 ${fmtDate(w.resetsAt)} (${timeUntil(w.resetsAt)})`)
      : null);
}

const LIMIT_EMPTY = {
  claude: "AgentHub에서 Claude 세션을 실행하면 표시됩니다. Claude CLI는 실행 중에만 한도 정보를 알려 줍니다.",
  codex: "Codex 세션 기록에서 한도 정보를 찾지 못했습니다. Codex를 한 번 실행하면 표시됩니다.",
};

async function loadLimits() {
  try {
    state.limits = await api("GET", "/api/limits");
  } catch {
    return;
  }
  renderLimits();
}

function renderLimits() {
  const limits = state.limits;
  if (!limits) return;
  $("limits").replaceChildren(...["claude", "codex"].map((agent) => {
    const info = limits[agent] ?? { windows: [] };
    return el("div", { class: "limit-agent" },
      el("header", {}, badge(agent),
        info.plan ? el("span", { class: "pill" }, info.plan) : null,
        info.observedAt ? el("span", { class: "muted", title: fmtDate(info.observedAt) }, `${timeAgo(info.observedAt)} 기준`) : null),
      ...(info.windows.length ? info.windows.map(limitRow) : [el("div", { class: "limit-empty" }, info.error ?? LIMIT_EMPTY[agent])]));
  }));

  // 사이드바에는 에이전트마다 가장 많이 쓴 기간 하나만 보여 준다.
  $("limit-mini").replaceChildren(...["claude", "codex"].flatMap((agent) => {
    const windows = (limits[agent]?.windows ?? []).filter((w) => !isExpired(w) && typeof w.usedPercent === "number");
    if (!windows.length) return [];
    const w = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    return [el("div", { class: "item", title: w.resetsAt ? `초기화 ${fmtDate(w.resetsAt)}` : "" },
      el("div", { class: "line" },
        el("span", {}, `${AGENT_LABEL[agent]} ${w.label}`),
        el("span", {}, `${Math.max(0, 100 - w.usedPercent).toFixed(0)}% 남음`)),
      el("div", { class: "bar" }, el("span", { class: barLevel(w.usedPercent), style: `width:${Math.min(100, w.usedPercent)}%` })))];
  }));
}

$("refresh-limits").addEventListener("click", loadLimits);
setInterval(loadLimits, 60_000);

// ── 사이드바 ────────────────────────────────────────────────────
async function loadSessions() {
  state.sessions = await api("GET", "/api/sessions");
  renderSessionList();
  renderProjectNav();
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "project") renderProjectSessions();
}

function renderProjectNav() {
  const projects = state.status?.projects ?? [];
  $("project-nav").replaceChildren(
    ...projects.map((p) => {
      const sessions = state.sessions.filter((s) => s.projectPath === p.path);
      const running = sessions.some((s) => s.state === "running");
      return el("button", {
        class: `nav-item${state.view === "project" && state.project === p.path ? " active" : ""}`,
        title: p.path,
        onclick: () => goProject(p.path),
      },
      el("span", { class: `dot${running ? " running" : ""}` }),
      p.name,
      el("span", { class: "count" }, String(sessions.length)));
    }),
  );
  if (!projects.length) $("project-nav").append(el("div", { class: "hint", style: "padding:4px 10px" }, "등록된 프로젝트가 없습니다."));
}

function renderSessionList() {
  const q = state.filter.toLowerCase();
  const items = state.sessions.filter((s) => !q || `${s.title} ${s.projectName}`.toLowerCase().includes(q));
  $("session-list").replaceChildren(
    ...items.map((s) =>
      el("button", {
        class: `session-item${state.current?.id === s.id ? " active" : ""}`,
        onclick: () => selectSession(s.id),
      },
      el("span", { class: "top" },
        el("span", { class: `dot ${s.state}` }),
        el("span", { class: "name" }, s.title)),
      el("span", { class: "sub" }, `${AGENT_LABEL[s.agent]} · ${s.projectName}`))),
  );
}

$("session-filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderSessionList();
});
$("nav-dashboard").addEventListener("click", goDashboard);

// ── 대시보드 ────────────────────────────────────────────────────
function renderDashboard() {
  const sessions = state.sessions;
  const projects = state.status?.projects ?? [];
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
    kpi("프로젝트", projects.length),
  );

  table("project-table", [["이름"], ["경로"], ["세션", "num"], ["최근 활동", "num"]],
    projects.map((p) => {
      const list = sessions.filter((s) => s.projectPath === p.path);
      const latest = list.map((s) => s.updatedAt).sort().at(-1);
      return el("tr", { class: "click", onclick: () => goProject(p.path) },
        el("td", {}, p.name),
        el("td", { class: "path" }, p.path),
        el("td", { class: "num" }, String(list.length)),
        el("td", { class: "num" }, latest ? timeAgo(latest) : "—"));
    }),
    "설정에서 프로젝트를 추가하세요.");

  table("recent-table", [["세션"], ["에이전트"], ["프로젝트"], ["상태"], ["업데이트", "num"]],
    sessions.slice(0, 8).map((s) => sessionRow(s, true)),
    "아직 세션이 없습니다.");
}

function sessionRow(s, withProject) {
  return el("tr", { class: "click", onclick: () => selectSession(s.id) },
    el("td", { class: "title-cell", title: s.title }, s.title),
    el("td", {}, badge(s.agent)),
    withProject ? el("td", {}, s.projectName) : el("td", { class: "path" }, s.worktree ? "작업 폴더" : "원본"),
    el("td", {}, pill(s.state)),
    el("td", { class: "num" }, timeAgo(s.updatedAt)));
}

// ── 프로젝트 ────────────────────────────────────────────────────
function currentProject() {
  return state.status.projects.find((p) => p.path === state.project);
}

function renderProjectSessions() {
  const list = state.sessions.filter((s) => s.projectPath === state.project);
  table("p-sessions", [["세션"], ["에이전트"], ["폴더"], ["상태"], ["업데이트", "num"]],
    list.map((s) => sessionRow(s, false)), "이 프로젝트에서 만든 세션이 없습니다.");
}

async function renderProject() {
  const p = currentProject();
  if (!p) return goDashboard();
  $("p-name").textContent = p.name;
  $("p-path").textContent = p.path;
  renderProjectSessions();
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
  if (state.project !== p.path) return; // 기다리는 사이 다른 화면으로 이동함
  table("p-found", [["세션"], ["에이전트"], ["요청", "num"], ["마지막 사용", "num"], ["", "right"]],
    found.map((f) => el("tr", {},
      el("td", { class: "title-cell", title: `${f.title}\n${f.cwd}\n${f.agentSessionId}` }, f.title || "(제목 없음)"),
      el("td", {}, badge(f.agent)),
      el("td", { class: "num" }, String(f.turns)),
      el("td", { class: "num" }, timeAgo(f.updatedAt)),
      el("td", { class: "right" }, f.linkedId
        ? el("button", { class: "ghost sm", onclick: () => selectSession(f.linkedId) }, "열기")
        : el("button", { class: "sm", onclick: (e) => importSession(p, f, e.target) }, "가져오기")))),
    "Claude Code나 Codex에서 이 폴더로 만든 세션이 없습니다.");
}

async function importSession(p, f, button) {
  button.disabled = true;
  button.textContent = "가져오는 중…";
  try {
    const created = await api("POST", "/api/sessions/import", {
      projectPath: p.path, agent: f.agent, agentSessionId: f.agentSessionId,
    });
    await loadSessions();
    await selectSession(created.id);
  } catch (err) {
    alert(err.message);
    button.disabled = false;
    button.textContent = "가져오기";
  }
}

$("p-rescan").addEventListener("click", () => renderProject());
$("p-new").addEventListener("click", () => openNew(state.project));

// ── 세션 화면 ───────────────────────────────────────────────────
function renderSession() {
  const s = state.current;
  if (!s) return;
  $("s-crumb").textContent = `${s.projectName} / 세션${s.imported ? " · 가져옴" : ""}`;
  $("s-agent").className = `badge ${s.agent}`;
  $("s-agent").textContent = AGENT_LABEL[s.agent];
  $("s-title").textContent = s.title;
  renderState();

  const meta = [
    s.worktree ? `작업 폴더 ${s.cwd} (브랜치 ${s.worktree.branch})` : `원본 폴더 ${s.cwd}`,
    `권한 ${s.permission}`,
    s.model ? `모델 ${s.model}` : null,
    s.agentSessionId ? `CLI 세션 ${s.agentSessionId.slice(0, 8)}` : null,
  ].filter(Boolean);
  $("s-meta").textContent = meta.join("  ·  ");
  $("s-meta").title = s.agentSessionId ?? "";
  $("s-diff").disabled = !s.baseCommit;

  $("s-events").replaceChildren(...s.events.map(renderEvent));
  scrollToBottom();
}

function renderState() {
  const s = state.current;
  const label = $("s-state");
  label.textContent = STATE_LABEL[s.state] ?? s.state;
  label.className = `pill ${s.state}`;
  const running = s.state === "running";
  $("s-stop").disabled = !running;
  $("s-delete").disabled = running;
  $("s-form").querySelector("button").disabled = running;
}

function renderEvent(ev) {
  const cls = `ev ${ev.kind}${ev.isError ? " is-error" : ""}`;
  const node = el("li", { class: cls }, ev.text ?? "");
  if (ev.detail) node.title = ev.detail;
  return node;
}

function scrollToBottom() {
  const list = $("s-events");
  list.scrollTop = list.scrollHeight;
}

$("s-show-log").addEventListener("change", (e) => {
  $("s-events").classList.toggle("show-log", e.target.checked);
});

$("s-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = $("s-prompt").value.trim();
  if (!prompt || !state.current) return;
  try {
    await api("POST", `/api/sessions/${state.current.id}/messages`, { prompt });
    $("s-prompt").value = "";
  } catch (err) {
    alert(err.message);
  }
});

$("s-prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("s-form").requestSubmit();
});

$("s-stop").addEventListener("click", () => api("POST", `/api/sessions/${state.current.id}/stop`).catch((e) => alert(e.message)));

$("s-delete").addEventListener("click", async () => {
  const s = state.current;
  const note = s.imported ? "\n\n원래 Claude Code·Codex 기록은 지워지지 않습니다." : "";
  if (!confirm(`"${s.title}" 세션 기록을 삭제할까요?${note}`)) return;
  let removeWorktree = false;
  if (s.worktree) {
    removeWorktree = confirm(
      `작업 폴더도 지울까요?\n${s.cwd}\n\n커밋하지 않은 변경이 있으면 지우지 않고 중단합니다. 브랜치 ${s.worktree.branch}는 남습니다.`);
  }
  try {
    await api("DELETE", `/api/sessions/${s.id}${removeWorktree ? "?removeWorktree=1" : ""}`);
    const back = s.projectPath;
    await loadSessions();
    await goProject(back);
  } catch (err) {
    alert(err.message);
  }
});

// ── 변경 보기 ───────────────────────────────────────────────────
function renderDiff(text) {
  return text.split("\n").map((line) => {
    let cls = "";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "del";
    else if (line.startsWith("@@")) cls = "hunk";
    return el("span", { class: cls }, `${line}\n`);
  });
}

$("s-diff").addEventListener("click", async () => {
  try {
    const s = state.current;
    const data = await api("GET", `/api/sessions/${s.id}/diff`);
    $("diff-base").textContent = `기준 커밋 ${s.baseCommit.slice(0, 8)}${s.worktree ? "" : " · 원본 폴더라 기존 수정도 함께 보입니다"}`;
    $("diff-status").textContent = data.status || "변경된 파일 없음";
    $("diff-body").replaceChildren(...renderDiff(data.diff || "(커밋된 파일의 변경 없음)"));
    $("diff-dialog").showModal();
  } catch (err) {
    alert(err.message);
  }
});

// ── 새 세션 ─────────────────────────────────────────────────────
function fillPermissions() {
  const agent = $("new-agent").value;
  const modes = state.status.agents[agent].permissions;
  $("new-permission").replaceChildren(...modes.map((m) => el("option", { value: m }, m)));
  $("new-permission").value = modes.at(-1);
  // Claude의 bypassPermissions는 기본값으로 두지 않는다.
  if (agent === "claude") $("new-permission").value = "acceptEdits";
}

async function openNew(projectPath) {
  await loadStatus();
  if (!state.status.projects.length) {
    alert("먼저 설정에서 프로젝트를 추가하세요.");
    openSettings();
    return;
  }
  $("new-project").replaceChildren(
    ...state.status.projects.map((p) => el("option", { value: p.path }, `${p.name} — ${p.path}`)));
  if (projectPath) $("new-project").value = projectPath;
  fillPermissions();
  $("new-error").textContent = "";
  $("new-dialog").showModal();
}

$("open-new").addEventListener("click", () => openNew(state.project ?? state.current?.projectPath));
$("open-new-top").addEventListener("click", () => openNew());
$("new-agent").addEventListener("change", fillPermissions);

$("new-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const form = new FormData(e.target);
  const body = Object.fromEntries(form);
  body.isolate = form.has("isolate");
  try {
    const created = await api("POST", "/api/sessions", body);
    $("new-dialog").close();
    e.target.reset();
    await loadSessions();
    await selectSession(created.id);
    $("s-prompt").focus();
  } catch (err) {
    $("new-error").textContent = err.message;
  }
});

// ── 설정 ────────────────────────────────────────────────────────
function renderProjects() {
  $("project-list").replaceChildren(
    ...state.status.projects.map((p, i) =>
      el("li", {}, el("span", {}, `${p.name} — ${p.path}`),
        el("button", {
          type: "button",
          class: "ghost danger sm",
          onclick: async () => {
            state.status.projects = await api("DELETE", `/api/projects/${i}`);
            renderProjects();
            refreshProjects();
          },
        }, "제거"))),
  );
}

function refreshProjects() {
  renderProjectNav();
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "project" && !currentProject()) goDashboard();
}

async function openSettings() {
  await loadStatus();
  renderProjects();
  $("cli-claude").value = state.status.cliOverrides.claude;
  $("cli-codex").value = state.status.cliOverrides.codex;
  $("settings-error").textContent = "";
  $("settings-dialog").showModal();
  $("project-path").focus();
}

$("open-settings").addEventListener("click", openSettings);
$("add-project-nav").addEventListener("click", openSettings);
$("add-project-dash").addEventListener("click", openSettings);

$("add-project").addEventListener("click", async () => {
  try {
    state.status.projects = await api("POST", "/api/projects", { path: $("project-path").value });
    $("project-path").value = "";
    $("settings-error").textContent = "";
    renderProjects();
    refreshProjects();
  } catch (err) {
    $("settings-error").textContent = err.message;
  }
});

$("project-path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("add-project").click();
  }
});

$("settings-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  try {
    await api("PUT", "/api/settings", { cli: { claude: $("cli-claude").value, codex: $("cli-codex").value } });
    $("settings-dialog").close();
    await loadStatus();
  } catch (err) {
    $("settings-error").textContent = err.message;
  }
});

// ── 실시간 갱신 ─────────────────────────────────────────────────
function connectStream() {
  const source = new EventSource("/api/stream");
  source.addEventListener("event", (e) => {
    const { sessionId, event } = JSON.parse(e.data);
    const s = state.current;
    if (s?.id !== sessionId || event.seq < s.events.length) return;
    s.events.push(event);
    const list = $("s-events");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.append(renderEvent(event));
    if (atBottom) scrollToBottom();
    if (event.kind === "status" || event.kind === "result") selectSession(sessionId); // CLI 세션 ID 등 메타 갱신
  });
  source.addEventListener("state", (e) => {
    const { sessionId, state: next } = JSON.parse(e.data);
    const item = state.sessions.find((s) => s.id === sessionId);
    if (item) item.state = next;
    // Codex 한도는 턴이 끝난 뒤 기록 파일에서 읽는다.
    if (item?.agent === "codex" && next !== "running") loadLimits();
    renderSessionList();
    renderProjectNav();
    if (state.view === "dashboard") renderDashboard();
    if (state.view === "project") renderProjectSessions();
    if (state.current?.id === sessionId) {
      state.current.state = next;
      renderState();
    }
  });
  source.addEventListener("sessions", loadSessions);
  source.addEventListener("limits", loadLimits);
  // 연결이 끊겼다가 돌아오면 놓친 이벤트를 다시 받아 온다.
  source.addEventListener("open", () => {
    if (state.current) selectSession(state.current.id);
  });
}

await Promise.all([loadStatus(), loadSessions(), loadLimits()]);
goDashboard();
connectStream();

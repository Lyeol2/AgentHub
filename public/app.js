const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  sessions: [],
  view: "dashboard", // dashboard | project | session
  project: null, // 보고 있는 프로젝트 경로
  current: null, // 선택한 세션의 전체 데이터
  filter: "",
  links: [], // 세션 사이 연결
  hubs: new Map(), // 프로젝트 경로(소문자) → AGENTHUB.md 내용
};

// 별도 창으로 연 세션(?session=id)이나 채팅(?chat=id 또는 "new"). 이 창은 사이드바 없이 그 화면만 보여 준다.
const QUERY = new URLSearchParams(location.search);
const POPUP = QUERY.get("session") ?? QUERY.get("chat");

// 데스크톱 앱에서는 AgentHub 창으로, 브라우저에서는 팝업으로 열린다.
const openWindow = (query) => window.open(`/?${query}`, "_blank", "width=760,height=900");
const openSessionWindow = (id) => openWindow(`session=${encodeURIComponent(id)}`);

// 목록의 세션은 그냥 누르면 이 창에서, 가운데 버튼이나 Ctrl·Shift를 누른 채 누르면 새 창으로 연다.
const sessionOpener = (id) => (e) => {
  if (e.button === 1 || e.ctrlKey || e.shiftKey) openSessionWindow(id);
  else if (e.button === 0) selectSession(id);
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `요청 실패 (${res.status})`), { reason: data.reason });
  return data;
}

const AGENT_LABEL = { claude: "Claude", codex: "Codex" };
const CHAT_LABEL = { claude: "Claude 채팅", codex: "ChatGPT" };
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
// 세션은 일반 채팅이면 채팅 이름으로 표시한다.
const sessionLabel = (s) => (s.chat ? CHAT_LABEL : AGENT_LABEL)[s.agent];
const sessionBadge = (s) => el("span", { class: `badge ${s.agent}${s.chat ? " chat" : ""}` }, sessionLabel(s));
const pill = (s) => el("span", { class: `pill ${s}` }, STATE_LABEL[s] ?? s);

// 세션 수명: 컨텍스트 압축 횟수(1회 노랑, 2회 주황, 3회 이상 빨강)와 지금 컨텍스트가 창을 얼마나 채웠는지
function lifeInfo(s) {
  const n = s.compactions ?? 0;
  const { used, window } = s.context ?? {};
  const pct = used && window ? Math.min(100, Math.round((used / window) * 100)) : null;
  const text = `압축 ${n}회${pct === null ? "" : ` · ${pct}%`}`;
  const title = `세션 수명 · 컨텍스트 압축 ${n}회${pct === null ? "" : ` · 컨텍스트 ${used.toLocaleString()} / ${window.toLocaleString()} 토큰`}\n` +
    "압축 1회 노랑, 2회 주황, 3회 이상 빨강. 답이 흐려지면 '다시 시작'으로 새 대화를 여세요.";
  return { n, text, title, cls: `pill life life-${Math.min(n, 3)}` };
}

const lifePill = (s) => {
  const life = lifeInfo(s);
  return el("span", { class: life.cls, title: life.title }, life.text);
};

function renderLife(id, s) {
  const life = lifeInfo(s);
  Object.assign($(id), { className: life.cls, title: life.title, textContent: life.text });
}

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
  for (const name of ["dashboard", "project", "session", "chat"]) $(`view-${name}`).hidden = name !== view;
  $("nav-dashboard").classList.toggle("active", view === "dashboard");
  $("nav-chat").classList.toggle("active", view === "chat" && !state.current);
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

// 일반 채팅은 채팅 화면으로, 나머지는 세션 화면으로 연다.
async function selectSession(id) {
  state.current = await api("GET", `/api/sessions/${id}`);
  state.project = null;
  if (state.current.chat) {
    show("chat");
    renderChat();
  } else {
    show("session");
    renderSession();
  }
}

// 지금 보이는 대화 목록(채팅 화면이면 채팅 쪽)
const eventsList = () => $(state.view === "chat" ? "c-events" : "s-events");

// ── CLI 상태 ────────────────────────────────────────────────────
async function loadStatus() {
  state.status = await api("GET", "/api/status");
  renderCliStatus();
  renderProjectNav();
}

// 로그인 여부는 CLI를 실행해 확인하므로 따로, 느리게 불러온다. true | false | null(확인 실패)
async function loadAuth(fresh = false) {
  try {
    state.auth = await api("GET", `/api/auth${fresh ? "?fresh=1" : ""}`);
  } catch {
    return;
  }
  renderCliStatus();
}

function renderCliStatus() {
  if (!state.status) return;
  $("cli-status").replaceChildren(
    ...Object.entries(state.status.agents).map(([name, info]) => {
      const loggedIn = state.auth?.[name];
      const needLogin = info.path && loggedIn === false;
      return el("div", { title: info.path ?? "CLI를 찾지 못했습니다" },
        el("span", { class: `dot ${!info.path || needLogin ? "error" : "ok"}` }),
        el("span", { class: "cli-text" }, `${AGENT_LABEL[name]} ${info.path ? info.version ?? "버전 확인 실패" : "없음"}`),
        needLogin ? el("button", { class: "login-btn", onclick: () => startLogin(name), title: "새 창에서 CLI 로그인을 엽니다" }, "로그인 필요") : null);
    }),
  );
}

// 새 콘솔 창에서 로그인 명령을 연다. 끝날 때까지 몇 초마다 다시 확인한다.
async function startLogin(agent) {
  try {
    await api("POST", `/api/auth/${agent}/login`);
  } catch (err) {
    alert(err.message);
    return;
  }
  alert(`${AGENT_LABEL[agent]} 로그인 창을 열었습니다. 창의 안내대로 브라우저에서 로그인한 뒤 그 창을 닫으세요.`);
  clearInterval(state.authPoll);
  let tries = 0;
  state.authPoll = setInterval(async () => {
    await loadAuth(true);
    if (state.auth?.[agent] || ++tries >= 60) clearInterval(state.authPoll);
  }, 5000);
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
setInterval(() => loadProjects(), 120_000); // 다른 앱에서 새로 연 프로젝트도 잡는다.

// ── 업데이트 ────────────────────────────────────────────────────
async function loadUpdate() {
  try {
    state.update = await api("GET", "/api/update");
  } catch {
    return;
  }
  renderUpdate();
}

async function updateAction(action) {
  try {
    state.update = await api("POST", `/api/update/${action}`);
  } catch (err) {
    state.update = { ...state.update, status: "error", error: err.message };
  }
  renderUpdate();
}

function renderUpdate() {
  const u = state.update;
  if (!u) return;
  const version = el("span", { class: "version" }, `AgentHub v${u.current}`);
  const button = (label, action, cls = "ghost") => el("button", { class: cls, onclick: () => updateAction(action) }, label);
  let action = null;
  let note = null;

  if (!u.desktop) {
    note = el("span", { class: "note" }, "업데이트는 데스크톱 앱에서 할 수 있습니다.");
  } else if (u.portable) {
    action = button("새 버전 받기", "check");
    note = el("span", { class: "note" }, "포터블 버전은 릴리스 페이지에서 직접 받습니다.");
  } else if (!u.supported) {
    note = el("span", { class: "note" }, "개발 모드에서는 업데이트하지 않습니다.");
  } else {
    switch (u.status) {
      case "checking":
        action = el("button", { class: "ghost", disabled: "" }, "확인 중…");
        break;
      case "available":
        action = button(`v${u.latest} 받기`, "download", "primary");
        note = el("span", { class: "new" }, "새 버전이 있습니다.");
        break;
      case "downloading":
        action = el("button", { class: "ghost", disabled: "" }, `받는 중 ${u.progress}%`);
        note = el("span", { class: "note" }, `v${u.latest ?? ""} 업데이트를 받고 있습니다.`);
        break;
      case "ready":
        action = button("재시작해서 업데이트", "install", "primary");
        note = el("span", { class: "new" }, `v${u.latest} 준비됨 · 앱을 닫아도 다음 실행 때 적용됩니다.`);
        break;
      case "none":
        action = button("업데이트 확인", "check");
        note = el("span", { class: "note" }, "최신 버전입니다.");
        break;
      case "error":
        action = button("다시 확인", "check");
        note = el("span", { class: "note error", title: u.error ?? "" }, u.error ?? "업데이트 확인 실패");
        break;
      default:
        action = button("업데이트 확인", "check");
    }
  }
  $("update-box").replaceChildren(el("div", { class: "line" }, version, action), note);
}

// ── 사이드바 ────────────────────────────────────────────────────
async function loadSessions() {
  state.sessions = await api("GET", "/api/sessions");
  renderSessionList();
  renderProjectNav();
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "project") renderProjectSessions();
}

// ── 프로젝트 목록(등록 + 자동 감지) ─────────────────────────────
const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const hubSessions = (p) => state.sessions.filter((s) => samePath(s.projectPath, p.path));

async function loadProjects() {
  try {
    state.projects = await api("GET", "/api/projects/all");
  } catch {
    return;
  }
  renderProjectNav();
  if (state.view === "dashboard") renderDashboard();
}

// 감지된 기록과 AgentHub 세션 중 가장 최근 활동
function lastActive(p) {
  return [p.lastActive, ...hubSessions(p).map((s) => s.updatedAt)].filter(Boolean).sort().at(-1) ?? null;
}

function sortedProjects() {
  return [...(state.projects ?? [])].sort((a, b) => (lastActive(b) ?? "").localeCompare(lastActive(a) ?? ""));
}

function renderProjectNav() {
  const projects = sortedProjects();
  $("project-nav").replaceChildren(
    ...projects.map((p) => {
      const running = hubSessions(p).some((s) => s.state === "running");
      const total = p.claude + p.codex;
      return el("button", {
        class: `nav-item${state.view === "project" && samePath(state.project, p.path) ? " active" : ""}`,
        title: `${p.path}
Claude Code ${p.claude} · Codex ${p.codex} · AgentHub ${hubSessions(p).length}`,
        onclick: () => goProject(p.path),
      },
      el("span", { class: `dot${running ? " running" : ""}` }),
      el("span", { class: "nav-name" }, p.name),
      el("span", { class: "count" }, String(total + hubSessions(p).length)));
    }),
  );
  if (!projects.length) $("project-nav").append(el("div", { class: "hint", style: "padding:4px 10px" }, "감지된 프로젝트가 없습니다."));
}

// 일반 채팅과 프로젝트 세션은 사이드바에서 따로 보여 준다.
function renderSessionList() {
  const q = state.filter.toLowerCase();
  const items = state.sessions.filter((s) => !q || `${s.title} ${s.projectName}`.toLowerCase().includes(q));
  const item = (s, sub) => el("button", {
    class: `session-item${state.current?.id === s.id ? " active" : ""}`,
    onclick: sessionOpener(s.id),
    onauxclick: sessionOpener(s.id),
  },
  el("span", { class: "top" },
    el("span", { class: `dot ${s.state}` }),
    el("span", { class: "name" }, s.title),
    s.compactions ? lifePill(s) : null),
  el("span", { class: "sub" }, sub));
  const chats = items.filter((s) => s.chat);
  $("chat-list").replaceChildren(...chats.map((s) => item(s, `${sessionLabel(s)}${s.model ? ` · ${s.model}` : ""} · ${timeAgo(s.updatedAt)}`)));
  if (!chats.length) $("chat-list").append(el("div", { class: "hint", style: "padding:4px 10px" }, q ? "찾는 채팅이 없습니다." : "채팅이 없습니다."));
  $("session-list").replaceChildren(
    ...items.filter((s) => !s.chat).map((s) => item(s, `${AGENT_LABEL[s.agent]} · ${s.projectName}`)));
}

$("session-filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderSessionList();
});
$("nav-dashboard").addEventListener("click", goDashboard);

// ── 대시보드 ────────────────────────────────────────────────────
function renderDashboard() {
  const sessions = state.sessions;
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
    state.projects ? "Claude Code나 Codex로 작업한 프로젝트가 없습니다. 설정에서 직접 추가할 수도 있습니다." : "프로젝트를 찾는 중…");

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

// ── 프로젝트 ────────────────────────────────────────────────────
function currentProject() {
  return state.projects?.find((p) => samePath(p.path, state.project));
}

function renderProjectSessions() {
  renderGraph();
}

async function renderProject() {
  const p = currentProject();
  if (!p) return goDashboard();
  $("p-name").textContent = p.name;
  $("p-path").textContent = p.path;
  $("p-registered").hidden = p.registered;
  renderProjectSessions();
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
$("p-new").addEventListener("click", () => openNew(state.project));

// ── 세션 흐름 그래프 ────────────────────────────────────────────
const CARD_W = 230;
const CARD_H = 108;
const GAP_X = 96;
const GAP_Y = 24;
const PAD = 20;
const SVG_NS = "http://www.w3.org/2000/svg";
const WHEN_LABEL = { success: "성공 시", error: "실패 시", always: "항상", manual: "수동" };
const linkLabel = (l) => (l.when === "keyword" ? `"${l.keyword}" 있으면` : WHEN_LABEL[l.when]);
const sessionById = (id) => state.sessions.find((s) => s.id === id);
const firstLine = (text) => text?.split(/\r?\n/)[0] ?? "";

async function loadLinks() {
  try {
    state.links = await api("GET", "/api/links");
  } catch {
    return;
  }
  if (state.view === "project") renderGraph();
  if (state.view === "session") renderFlow();
}

// 옮기지 않은 카드는 연결을 따라 왼쪽에서 오른쪽으로 놓는다. 같은 단계 안에서는 만든 순서대로 쌓는다.
function layoutGraph(sessions, links) {
  // 순환 연결은 만든 순서로 따라가다 되돌아가는 연결을 빼고 단계를 매긴다.
  const forward = new Set();
  const done = new Set();
  const onPath = new Set();
  const walk = (id) => {
    onPath.add(id);
    for (const l of links.filter((l) => l.from === id)) {
      if (onPath.has(l.to)) continue;
      forward.add(l);
      if (!done.has(l.to)) walk(l.to);
    }
    onPath.delete(id);
    done.add(id);
  };
  for (const s of sessions) if (!done.has(s.id)) walk(s.id);

  const level = new Map();
  const depth = (id) => {
    if (level.has(id)) return level.get(id);
    const parents = [...forward].filter((l) => l.to === id).map((l) => l.from);
    const value = parents.length ? Math.max(...parents.map((p) => depth(p) + 1)) : 0;
    level.set(id, value);
    return value;
  };
  const rows = new Map();
  const pos = new Map();
  for (const s of sessions) {
    const lv = depth(s.id);
    const row = rows.get(lv) ?? 0;
    rows.set(lv, row + 1);
    pos.set(s.id, s.graphPos ?? { x: PAD + lv * (CARD_W + GAP_X), y: PAD + row * (CARD_H + GAP_Y) });
  }
  return pos;
}

function renderGraph() {
  const box = $("p-graph");
  if (state.graph?.dragging) return; // 끄는 중에는 다시 그리지 않는다.
  const sessions = state.sessions
    .filter((s) => samePath(s.projectPath, state.project))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!sessions.length) {
    state.graph = null;
    box.replaceChildren(el("div", { class: "graph-empty" },
      "이 프로젝트에서 만든 세션이 없습니다. 새 세션을 만들면 카드로 보입니다."));
    return;
  }
  const ids = new Set(sessions.map((s) => s.id));
  const links = state.links.filter((l) => ids.has(l.from) && ids.has(l.to));
  // 오케스트레이터가 만든 세션은 지휘선으로 잇고, 배치도 오케스트레이터를 앞에 둔다.
  const commands = sessions.filter((s) => ids.has(s.createdBy)).map((s) => ({ from: s.createdBy, to: s.id }));
  const pos = layoutGraph(sessions, [...commands, ...links]);

  const canvas = el("div", { class: "graph-canvas" });
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("graph-edges");
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>`;
  canvas.append(svg);

  const cards = new Map();
  for (const s of sessions) {
    const role = [s.roleName, firstLine(s.role)].filter(Boolean).join(" · ");
    const orchestrator = s.kind === "orchestrator";
    const card = el("div", { class: `gcard ${s.state}${orchestrator ? " orchestrator" : ""}`, "data-id": s.id, title: s.role || s.title },
      el("div", { class: "gcard-top" }, badge(s.agent), orchestrator ? el("span", { class: "pill orch" }, "지휘") : null, pill(s.state)),
      el("div", { class: "gcard-title" }, s.title),
      el("div", { class: `gcard-role${role ? "" : " empty"}` }, role || "역할 없음"),
      el("div", { class: "gcard-foot" }, el("span", {}, timeAgo(s.updatedAt)), lifePill(s)),
      el("span", { class: "gcard-handle", title: "끌어서 다른 세션에 연결" }));
    cards.set(s.id, card);
    canvas.append(card);
  }

  state.graph = { canvas, svg, cards, pos, links, commands };
  placeCards();
  box.replaceChildren(canvas);
  canvas.addEventListener("pointerdown", onGraphPointerDown);
}

function placeCards() {
  const g = state.graph;
  let width = 0;
  let height = 0;
  for (const [id, card] of g.cards) {
    const p = g.pos.get(id);
    card.style.left = `${p.x}px`;
    card.style.top = `${p.y}px`;
    width = Math.max(width, p.x + CARD_W + PAD);
    height = Math.max(height, p.y + CARD_H + PAD);
  }
  g.canvas.style.width = `${width}px`;
  g.canvas.style.height = `${height}px`;
  drawEdges();
}

function edgePath(a, b) {
  const x1 = a.x + CARD_W;
  const y1 = a.y + CARD_H / 2;
  const x2 = b.x;
  const y2 = b.y + CARD_H / 2;
  if (x2 < x1) {
    // 되돌아가는 연결은 카드 아래쪽끼리 잇는다.
    const sx = a.x + CARD_W / 2;
    const tx = b.x + CARD_W / 2;
    const sy = a.y + CARD_H;
    const ty = b.y + CARD_H;
    const low = Math.max(sy, ty) + 44;
    return { d: `M${sx},${sy} C${sx},${low} ${tx},${low} ${tx},${ty}`, mid: { x: (sx + tx) / 2, y: low - 11 } };
  }
  const dx = Math.max(48, (x2 - x1) / 2);
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
}

function drawEdges() {
  const g = state.graph;
  g.svg.querySelectorAll("path.edge").forEach((n) => n.remove());
  g.canvas.querySelectorAll(".edge-label").forEach((n) => n.remove());
  for (const command of g.commands) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", edgePath(g.pos.get(command.from), g.pos.get(command.to)).d);
    path.setAttribute("class", "edge command");
    g.svg.append(path);
  }
  const placed = []; // 라벨이 겹치면 아래로 비킨다.
  for (const link of g.links) {
    const { d, mid } = edgePath(g.pos.get(link.from), g.pos.get(link.to));
    const halfWidth = linkLabel(link).length * 4 + 10;
    while (placed.some((p) => Math.abs(p.x - mid.x) < p.halfWidth + halfWidth && Math.abs(p.y - mid.y) < 22)) mid.y += 22;
    placed.push({ ...mid, halfWidth });
    const path = document.createElementNS(SVG_NS, "path");
    const live = sessionById(link.from)?.state === "running";
    path.setAttribute("d", d);
    path.setAttribute("class", `edge${link.enabled ? "" : " off"}${live ? " live" : ""}`);
    path.setAttribute("marker-end", "url(#arrow)");
    g.svg.append(path);
    const label = el("button", { class: `edge-label${link.enabled ? "" : " off"}`, type: "button", "data-link": link.id },
      linkLabel(link));
    label.style.left = `${mid.x}px`;
    label.style.top = `${mid.y}px`;
    g.canvas.append(label);
  }
}

function canvasPoint(e) {
  const rect = state.graph.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// 카드를 누르고 떼면 열고, 끌면 옮긴다. 손잡이를 끌어 다른 카드에 놓으면 연결한다.
function onGraphPointerDown(e) {
  if (e.button === 1 && e.target.closest(".gcard")) {
    e.preventDefault();
    openSessionWindow(e.target.closest(".gcard").dataset.id);
    return;
  }
  if (e.button !== 0) return;
  const g = state.graph;
  const label = e.target.closest(".edge-label");
  if (label) {
    openLinkDialog(state.links.find((l) => l.id === label.dataset.link));
    return;
  }
  const card = e.target.closest(".gcard");
  if (!card) return;
  e.preventDefault();
  const id = card.dataset.id;
  const start = canvasPoint(e);
  const origin = { ...g.pos.get(id) };
  const connecting = e.target.classList.contains("gcard-handle");
  let moved = false;
  let temp = null;

  const onMove = (ev) => {
    const p = canvasPoint(ev);
    if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
    moved = true;
    g.dragging = true;
    if (connecting) {
      const from = g.pos.get(id);
      const x1 = from.x + CARD_W;
      const y1 = from.y + CARD_H / 2;
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
      g.pos.set(id, { x: Math.max(0, origin.x + p.x - start.x), y: Math.max(0, origin.y + p.y - start.y) });
      card.classList.add("dragging");
      placeCards();
    }
  };

  const onUp = async (ev) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    g.dragging = false;
    card.classList.remove("dragging");
    g.canvas.classList.remove("connecting");
    temp?.remove();
    if (!moved) {
      if (!connecting) sessionOpener(id)(ev);
      return;
    }
    if (connecting) {
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".gcard");
      if (target && target.dataset.id !== id) openLinkDialog(null, id, target.dataset.id);
      return;
    }
    const p = g.pos.get(id);
    const s = sessionById(id);
    if (s) s.graphPos = { x: Math.round(p.x), y: Math.round(p.y) };
    try {
      await api("PUT", `/api/sessions/${id}`, { graphPos: s?.graphPos });
    } catch (err) {
      alert(err.message);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

$("p-relayout").addEventListener("click", async () => {
  const placed = state.sessions.filter((s) => samePath(s.projectPath, state.project) && s.graphPos);
  for (const s of placed) s.graphPos = null;
  renderGraph();
  await Promise.all(placed.map((s) => api("PUT", `/api/sessions/${s.id}`, { graphPos: null }).catch(() => {})));
});

// ── 연결 설정 ───────────────────────────────────────────────────
// link가 없으면 from → to 새 연결을 만든다.
function openLinkDialog(link, from = link?.from, to = link?.to) {
  state.editingLink = { link, from, to };
  $("link-names").textContent = `${sessionById(from)?.title ?? "?"} → ${sessionById(to)?.title ?? "?"}`;
  $("link-when").value = link?.when ?? "success";
  $("link-keyword").value = link?.keyword ?? "";
  $("link-note").value = link?.note ?? "";
  $("link-enabled").checked = link?.enabled ?? true;
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
  const { link, from, to } = state.editingLink;
  const body = {
    when: $("link-when").value,
    keyword: $("link-keyword").value,
    note: $("link-note").value,
    enabled: $("link-enabled").checked,
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

// ── AGENTHUB.md ─────────────────────────────────────────────────
async function loadHub(projectPath) {
  const hub = await api("GET", `/api/hub?path=${encodeURIComponent(projectPath)}`);
  state.hubs.set(projectPath.toLowerCase(), hub);
  return hub;
}

async function renderHub() {
  const projectPath = state.project;
  const bar = $("p-hub");
  let hub;
  try {
    hub = await loadHub(projectPath);
  } catch (err) {
    bar.replaceChildren(el("span", { class: "error" }, err.message));
    return;
  }
  if (!samePath(state.project, projectPath)) return; // 기다리는 사이 다른 화면으로 이동함
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
    await api("POST", "/api/hub/init", { path: state.project });
    await loadProjects(); // 감지된 프로젝트는 이때 등록된다.
    await renderHub();
    openHubFile();
  } catch (err) {
    alert(err.message);
  }
}

function openHubFile() {
  api("POST", "/api/hub/open", { path: state.project }).catch((err) => alert(err.message));
}

// ── 흐름 시작 ───────────────────────────────────────────────────
function openFlowDialog(hub) {
  state.flowHub = hub;
  $("flow-name").replaceChildren(...hub.flows.map((f) => el("option", { value: f.name }, f.name)));
  $("flow-label").value = "";
  $("flow-prompt").value = "";
  $("flow-error").textContent = "";
  renderFlowPreview();
  $("flow-dialog").showModal();
}

function renderFlowPreview() {
  const hub = state.flowHub;
  const flow = hub.flows.find((f) => f.name === $("flow-name").value);
  if (!flow) return;
  const names = [...new Set(flow.steps.flatMap((s) => [s.from, s.to]))];
  const roles = names.map((n) => hub.roles.find((r) => r.name === n));
  $("flow-preview").replaceChildren(
    el("div", { class: "flow-roles" }, ...names.map((n, i) => roles[i]
      ? el("span", { class: "flow-role-chip", title: roles[i].body }, badge(roles[i].agent), ` ${n} `,
        el("span", { class: "muted" }, `${roles[i].permission} · ${roles[i].isolate ? "분리" : "원본"}`))
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
      projectPath: state.project,
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

// ── 세션 화면 ───────────────────────────────────────────────────
// 세션 제목 아래에 역할과 받는·넘기는 연결을 보여 준다.
function renderFlow() {
  const s = state.current;
  if (!s) return;
  const chip = (id, text, link) => el("button", {
    class: `flow-chip${link.enabled ? "" : " off"}`,
    type: "button",
    title: "세션 열기",
    onclick: () => selectSession(id),
  }, text);
  const incoming = state.links.filter((l) => l.to === s.id && sessionById(l.from));
  const outgoing = state.links.filter((l) => l.from === s.id && sessionById(l.to));
  $("s-flow").replaceChildren(
    ...(s.role ? [el("span", { class: "flow-role", title: s.role }, `${s.roleName || "역할"} · ${firstLine(s.role)}`)] : []),
    ...incoming.map((l) => chip(l.from, `← ${sessionById(l.from).title} · ${linkLabel(l)}`, l)),
    ...outgoing.map((l) => chip(l.to, `→ ${sessionById(l.to).title} · ${linkLabel(l)}`, l)),
  );
}

function renderSession() {
  const s = state.current;
  if (!s) return;
  $("s-crumb-project").textContent = s.chat ? "대시보드" : s.projectName;
  $("s-crumb").textContent = ` / ${s.chat ? "일반 채팅" : "세션"}${s.imported ? " · 가져옴" : ""}`;
  $("s-agent").className = `badge ${s.agent}${s.chat ? " chat" : ""}`;
  $("s-agent").textContent = sessionLabel(s);
  $("s-title").textContent = s.title;
  $("s-kind").hidden = s.kind !== "orchestrator";
  renderState();

  const meta = [
    s.chat ? "도구 없이 대화만" : s.worktree ? `작업 폴더 ${s.cwd} (브랜치 ${s.worktree.branch})` : `원본 폴더 ${s.cwd}`,
    s.chat ? null : `권한 ${s.permission}`,
    `모델 ${s.model || "기본값"}`,
    `추론 ${s.effort || "기본값"}`,
    s.agentSessionId ? `CLI 세션 ${s.agentSessionId.slice(0, 8)}` : null,
  ].filter(Boolean);
  $("s-meta").textContent = meta.join("  ·  ");
  $("s-meta").title = s.agentSessionId ?? "";
  $("s-diff").disabled = !s.baseCommit;
  $("s-diff").hidden = !!s.chat;
  $("s-back").hidden = !!s.chat || !!POPUP;
  $("s-popout").hidden = !!POPUP;
  if (POPUP) document.title = `${s.title} · AgentHub`;
  renderFlow();

  $("s-events").replaceChildren(...s.events.map(renderEvent));
  scrollToBottom();
}

function renderState() {
  const s = state.current;
  if (state.view === "chat") return renderChatState();
  const label = $("s-state");
  label.textContent = STATE_LABEL[s.state] ?? s.state;
  label.className = `pill ${s.state}`;
  const running = s.state === "running";
  $("s-stop").disabled = !running;
  $("s-restart").disabled = running || !s.agentSessionId;
  renderLife("s-life", s);
  $("s-form").querySelector("button").disabled = running;
}

const PLAN_STATUS = { pending: "승인 대기", applied: "실행함", rejected: "거절함", invalid: "형식 오류" };

// 오케스트레이터가 쓴 계획. 승인하면 세션·연결·요청을 만든다.
function renderPlan(ev) {
  const s = state.current;
  const plan = ev.plan;
  const name = (ref) => {
    if (ref === s.id) return "오케스트레이터";
    return plan?.sessions.find((x) => x.key === ref)?.title ?? sessionById(ref)?.title ?? ref;
  };
  const section = (title, items) => items.length
    ? el("div", { class: "plan-section" }, el("div", { class: "plan-label" }, title), el("ul", {}, ...items))
    : null;
  const node = el("li", { class: `ev plan ${ev.status}` },
    el("div", { class: "plan-head" }, el("b", {}, "계획"), el("span", { class: `pill plan-${ev.status}` }, PLAN_STATUS[ev.status] ?? ev.status)),
    ev.error ? el("div", { class: "plan-error" }, ev.error) : null);
  if (plan) {
    node.append(
      section("세션", plan.sessions.map((x) => x.id
        ? el("li", {}, el("span", { class: "muted" }, "기존 "), x.title)
        : el("li", { title: x.roleText }, badge(x.agent), ` ${x.title} `,
          el("span", { class: "muted" }, [x.roleName && `역할 ${x.roleName}`, x.permission, x.isolate ? "분리" : "원본"].filter(Boolean).join(" · "))))),
      section("연결", plan.links.map((l) => el("li", {}, `${name(l.from)} → ${name(l.to)}`, el("span", { class: "muted" }, ` · ${linkLabel(l)}`)))),
      section("요청", plan.send.map((m) => el("li", { title: m.prompt }, el("b", {}, name(m.to)), ` ${firstLine(m.prompt)}`))));
  }
  const decide = async (action, reason) => {
    try {
      await api("POST", `/api/sessions/${s.id}/plans/${ev.planId}`, { action, reason });
    } catch (err) {
      alert(err.message);
    }
  };
  if (ev.status === "pending") {
    node.append(el("div", { class: "plan-actions" },
      el("button", { class: "primary sm", onclick: () => decide("approve") }, "승인하고 실행"),
      el("button", { class: "ghost sm", onclick: () => {
        const reason = prompt("거절 이유 (적으면 오케스트레이터가 계획을 고칩니다)");
        if (reason !== null) decide("reject", reason);
      } }, "거절")));
  } else if (ev.status === "invalid") {
    node.append(el("div", { class: "plan-actions" },
      el("button", { class: "ghost sm", onclick: () => api("POST", `/api/sessions/${s.id}/messages`, {
        prompt: `[계획 오류] ${ev.error}\n계획 블록을 고쳐 다시 제안하라.`,
      }).catch((err) => alert(err.message)) }, "오케스트레이터에게 오류 알리기")));
  } else if (ev.result) {
    node.append(el("div", { class: "plan-result" }, ev.result));
  }
  return node;
}

function renderEvent(ev) {
  const cls = `ev ${ev.kind}${ev.isError ? " is-error" : ""}`;
  if (ev.kind === "plan") return renderPlan(ev);
  if (ev.kind === "user" && ev.from) {
    // 연결된 세션에서 넘어온 요청은 접어서 보여 준다.
    const open = (e) => {
      e.preventDefault();
      if (sessionById(ev.from)) selectSession(ev.from);
    };
    return el("li", { class: `${cls} handoff` },
      el("details", {},
        el("summary", {}, el("a", { href: "#", onclick: open }, `↳ ${ev.fromTitle}`), "에서 넘어온 작업"),
        el("div", { class: "handoff-body" }, ev.text)));
  }
  const node = el("li", { class: cls }, ev.text ?? "");
  if (ev.detail) node.title = ev.detail;
  return node;
}

function scrollToBottom() {
  const list = eventsList();
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

// Enter로 보내고 Shift+Enter로 줄을 바꾼다. 한글 조합 중인 Enter는 무시한다.
$("s-prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("s-form").requestSubmit();
  }
});

$("s-crumb-project").addEventListener("click", (e) => {
  e.preventDefault();
  if (!state.current || POPUP) return; // 별도 창에는 프로젝트·대시보드 화면이 없다.
  if (state.current.chat) goDashboard();
  else goProject(state.current.projectPath);
});
$("s-back").addEventListener("click", () => state.current && goProject(state.current.projectPath));
$("s-popout").addEventListener("click", () => state.current && openSessionWindow(state.current.id));

$("s-role").addEventListener("click", () => {
  $("role-text").value = state.current?.role ?? "";
  $("role-error").textContent = "";
  $("role-dialog").showModal();
  $("role-text").focus();
});

$("role-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  try {
    const updated = await api("PUT", `/api/sessions/${state.current.id}`, { role: $("role-text").value });
    state.current.role = updated.role;
    $("role-dialog").close();
    renderFlow();
  } catch (err) {
    $("role-error").textContent = err.message;
  }
});

$("s-stop").addEventListener("click", () => api("POST", `/api/sessions/${state.current.id}/stop`).catch((e) => alert(e.message)));

// CLI 대화만 새로 시작한다. 화면이 새로 그려지는 것은 서버가 보내는 session 이벤트로 한다.
async function restartSession() {
  const s = state.current;
  if (!s) return;
  const kept = s.chat ? "화면의 기록은 남지만" : "AgentHub 기록·역할·연결은 그대로 남지만";
  if (!confirm(`"${s.title}"을(를) 다시 시작할까요?\n\nCLI 대화를 새로 시작해 컨텍스트를 비웁니다. ${kept}, AI는 이전 대화 내용을 기억하지 못합니다.`)) return;
  try {
    await api("POST", `/api/sessions/${s.id}/restart`);
  } catch (err) {
    alert(err.message);
  }
}
$("s-restart").addEventListener("click", restartSession);

$("s-delete").addEventListener("click", async () => {
  const s = state.current;
  const note = s.imported ? "\n\n원래 Claude Code·Codex 기록은 지워지지 않습니다." : "";
  if (!confirm(`"${s.title}" 세션 기록을 삭제할까요?${note}`)) return;
  let removeWorktree = false;
  if (s.worktree) {
    removeWorktree = confirm(
      `작업 폴더도 지울까요?\n${s.cwd}\n\n커밋하지 않은 변경이 있으면 지우지 않고 중단합니다. 브랜치 ${s.worktree.branch}는 남습니다.`);
  }
  if (!(await deleteSession(s, { removeWorktree }))) return;
  if (POPUP) return window.close(); // 별도 창은 보여 줄 세션이 없어졌으니 닫는다.
  await loadSessions();
  if (s.projectPath) await goProject(s.projectPath);
  else goDashboard();
});

// 세션을 지운다. 실행 중으로 멈춰 있거나 작업 폴더를 못 지우면 그 자리에서 어떻게 할지 묻는다. 지웠으면 true.
async function deleteSession(s, { removeWorktree = false, force = false } = {}) {
  const query = new URLSearchParams();
  if (removeWorktree) query.set("removeWorktree", "1");
  if (force) query.set("force", "1");
  try {
    await api("DELETE", `/api/sessions/${s.id}?${query}`);
    return true;
  } catch (err) {
    if (err.reason === "running" && confirm("실행 중인 세션입니다. 실행을 멈추고 삭제할까요?")) {
      return deleteSession(s, { removeWorktree, force: true });
    }
    if (err.reason === "worktree" && confirm(`${err.message}\n\n작업 폴더는 남겨 두고 세션 기록만 삭제할까요?`)) {
      return deleteSession(s, { force });
    }
    if (!["running", "worktree"].includes(err.reason)) alert(err.message);
    return false;
  }
}

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

// ── 모델·추론 강도 ──────────────────────────────────────────────
function fillModels(listId, agent) {
  $(listId).replaceChildren(...state.status.agents[agent].models.map((m) => el("option", { value: m.id }, m.label)));
}

// 고른 모델이 지원하는 추론 강도만 보여 준다. 모르는 모델이면 에이전트 전체 목록을 쓴다.
function fillEfforts(selectId, agent, model, current = $(selectId).value) {
  const info = state.status.agents[agent];
  const known = info.models.find((m) => m.id === model);
  const efforts = known?.efforts.length ? known.efforts : info.efforts;
  const fallback = known?.defaultEffort ? ` (${known.defaultEffort})` : "";
  $(selectId).replaceChildren(
    el("option", { value: "" }, `CLI 기본값${fallback}`),
    ...efforts.map((e) => el("option", { value: e }, e)));
  $(selectId).value = efforts.includes(current) ? current : "";
}

// ── 세션 설정 ───────────────────────────────────────────────────
$("s-config").addEventListener("click", async () => {
  const s = state.current;
  if (!s) return;
  await loadStatus();
  $("config-title").value = s.title;
  $("config-model").value = s.model ?? "";
  fillModels("config-models", s.agent);
  fillEfforts("config-effort", s.agent, s.model ?? "", s.effort ?? "");
  $("config-permission-row").hidden = !!s.chat;
  $("config-permission").replaceChildren(
    ...state.status.agents[s.agent].permissions.map((m) => el("option", { value: m }, m)));
  $("config-permission").value = s.permission;
  $("config-error").textContent = "";
  $("config-dialog").showModal();
});

$("config-model").addEventListener("input", () => {
  if (state.current) fillEfforts("config-effort", state.current.agent, $("config-model").value.trim());
});

$("config-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const s = state.current;
  const body = { title: $("config-title").value, model: $("config-model").value.trim(), effort: $("config-effort").value };
  if (!s.chat) body.permission = $("config-permission").value;
  try {
    const updated = await api("PUT", `/api/sessions/${s.id}`, body);
    Object.assign(state.current, { title: updated.title, model: updated.model, effort: updated.effort, permission: updated.permission });
    $("config-dialog").close();
    renderSession();
    loadSessions();
  } catch (err) {
    $("config-error").textContent = err.message;
  }
});

// ── 일반 채팅 화면 ──────────────────────────────────────────────
// 새 채팅은 첫 메시지를 보낼 때 세션을 만든다. 그 전까지 고른 AI·모델·추론 강도는 초안에 두고, 다음 새 채팅에도 쓴다.
const CHAT_PREFS_KEY = "agenthub.chat";

function loadChatPrefs() {
  const prefs = { agent: "claude", model: "", effort: "" };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(CHAT_PREFS_KEY) ?? "{}"));
  } catch {
    // 저장소를 못 쓰면 기본값
  }
  if (!state.status.agents[prefs.agent]) prefs.agent = "claude";
  return prefs;
}

function saveChatPrefs({ agent, model, effort }) {
  try {
    localStorage.setItem(CHAT_PREFS_KEY, JSON.stringify({ agent, model, effort }));
  } catch {
    // 저장하지 못해도 이번 채팅에는 지장 없다.
  }
}

function openChat() {
  state.current = null;
  state.project = null;
  state.chatDraft = loadChatPrefs();
  show("chat");
  renderChat();
  $("c-prompt").focus();
}

// 지금 채팅의 설정: 세션이 있으면 세션 값, 없으면 새 채팅 초안
const chatConfig = () => state.current ?? state.chatDraft;

function renderChat() {
  const s = state.current;
  $("c-title").textContent = s?.title ?? "새 채팅";
  $("c-title").disabled = !s;
  $("c-delete").hidden = !s;
  $("c-popout").hidden = !!POPUP;
  $("c-empty").hidden = !!s?.events.length;
  $("c-events").replaceChildren(...(s?.events ?? []).map(renderEvent));
  if (POPUP) document.title = `${s?.title ?? "새 채팅"} · AgentHub`;
  renderChatPick();
  renderChatState();
  scrollToBottom();
}

// AI·모델·추론 강도 선택. 대화는 CLI별로 이어지므로 시작한 뒤에는 AI만 바꿀 수 없다.
function renderChatPick() {
  const cfg = chatConfig();
  const started = !!state.current;
  $("c-agent").value = cfg.agent;
  $("c-agent").disabled = started;
  $("c-agent").title = started ? "대화를 시작한 뒤에는 AI를 바꿀 수 없습니다. 새 채팅에서 고르세요." : "AI";
  const models = state.status.agents[cfg.agent].models;
  const options = [el("option", { value: "" }, "기본 모델"), ...models.map((m) => el("option", { value: m.id }, m.label))];
  // 목록에 없는 모델(직접 넣은 ID)도 고른 값으로 보여 준다.
  if (cfg.model && !models.some((m) => m.id === cfg.model)) options.push(el("option", { value: cfg.model }, cfg.model));
  $("c-model").replaceChildren(...options);
  $("c-model").value = cfg.model ?? "";
  fillEfforts("c-effort", cfg.agent, cfg.model ?? "", cfg.effort ?? "");
}

function renderChatState() {
  const s = state.current;
  const running = s?.state === "running";
  $("c-state").hidden = !s || s.state === "idle";
  if (s) {
    $("c-state").textContent = STATE_LABEL[s.state] ?? s.state;
    $("c-state").className = `pill ${s.state}`;
  }
  $("c-stop").hidden = !running;
  $("c-life").hidden = !s;
  if (s) renderLife("c-life", s);
  $("c-restart").hidden = !s?.agentSessionId;
  $("c-restart").disabled = running;
  $("c-form").querySelector("button").disabled = running;
  $("c-events").classList.toggle("running", running);
  if (running) $("c-empty").hidden = true;
}

// 새 채팅이면 초안만 바꾸고, 진행 중인 채팅이면 다음 메시지부터 적용되도록 저장한다.
async function changeChat(patch) {
  const s = state.current;
  if (!s) {
    Object.assign(state.chatDraft, patch);
    saveChatPrefs(state.chatDraft);
    renderChatPick();
    return;
  }
  try {
    const updated = await api("PUT", `/api/sessions/${s.id}`, patch);
    Object.assign(s, { model: updated.model, effort: updated.effort });
    saveChatPrefs(s);
  } catch (err) {
    alert(err.message);
  }
  renderChatPick();
  loadSessions();
}

$("c-agent").addEventListener("change", () => changeChat({ agent: $("c-agent").value, model: "", effort: "" }));
$("c-model").addEventListener("change", () => {
  const cfg = chatConfig();
  const model = $("c-model").value;
  // 바꾼 모델이 지금 추론 강도를 지원하지 않으면 기본값으로 돌린다.
  const known = state.status.agents[cfg.agent].models.find((m) => m.id === model);
  const effort = known?.efforts.length && !known.efforts.includes(cfg.effort) ? "" : cfg.effort;
  changeChat({ model, effort });
});
$("c-effort").addEventListener("change", () => changeChat({ effort: $("c-effort").value }));

const chatTitle = (text) => {
  const line = firstLine(text).trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};

$("c-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = $("c-prompt").value.trim();
  if (!prompt) return;
  $("c-form").querySelector("button").disabled = true;
  try {
    let s = state.current;
    if (!s) {
      const { agent, model, effort } = state.chatDraft;
      s = await api("POST", "/api/sessions", { chat: true, agent, model, effort, title: chatTitle(prompt) });
    }
    await api("POST", `/api/sessions/${s.id}/messages`, { prompt });
    $("c-prompt").value = "";
    if (!state.current) {
      await loadSessions();
      await selectSession(s.id);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    if (state.view === "chat") renderChatState();
  }
});

// Enter로 보내고 Shift+Enter로 줄을 바꾼다. 한글 조합 중인 Enter는 무시한다.
$("c-prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("c-form").requestSubmit();
  }
});

$("c-title").addEventListener("click", async () => {
  const s = state.current;
  if (!s) return;
  const title = prompt("채팅 이름", s.title);
  if (title === null || !title.trim()) return;
  try {
    s.title = (await api("PUT", `/api/sessions/${s.id}`, { title })).title;
    renderChat();
    loadSessions();
  } catch (err) {
    alert(err.message);
  }
});

$("c-stop").addEventListener("click", () => state.current && api("POST", `/api/sessions/${state.current.id}/stop`).catch((e) => alert(e.message)));
$("c-new").addEventListener("click", () => openChat());
$("c-restart").addEventListener("click", restartSession);

$("c-delete").addEventListener("click", async () => {
  const s = state.current;
  if (!s || !confirm(`"${s.title}" 채팅을 삭제할까요?`)) return;
  if (!(await deleteSession(s))) return;
  await loadSessions();
  openChat();
});

$("c-popout").addEventListener("click", () => openWindow(`chat=${state.current?.id ?? "new"}`));

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
  if (chat) $("new-orchestrator").checked = false;
  $("new-template-row").hidden = chat || !state.templateRoles?.length;
  $("new-title").placeholder = chat ? "예: 여행 일정 짜기" : "예: 가방 UI 버그 수정";
  $("new-role").placeholder = chat
    ? "예: 친절한 영어 선생님. 틀린 표현은 고쳐 준다."
    : "예: 프론트엔드 담당. server/는 건드리지 않는다. 끝나면 '검토 요청'이라고 쓴다.";
  fillPermissions();
  fillModels("new-models", agent);
  fillEfforts("new-effort", agent, $("new-model").value.trim());
}

function fillPermissions() {
  const { agent } = newKind();
  const modes = state.status.agents[agent].permissions;
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
  state.templateRoles = roles;
  $("new-template").replaceChildren(el("option", { value: "" }, "직접 입력"),
    ...roles.map((r) => el("option", { value: r.name }, `${r.name} · ${AGENT_LABEL[r.agent]} · ${r.permission}`)));
  $("new-template-row").hidden = !roles.length || newKind().chat;
  applyTemplate();
}

function applyTemplate() {
  const role = state.templateRoles?.find((r) => r.name === $("new-template").value);
  $("new-role-name").value = role?.name ?? "";
  if (!role) return;
  $("new-orchestrator").checked = false;
  $("new-agent").value = role.agent;
  $("new-model").value = role.model;
  syncNewKind();
  $("new-permission").value = role.permission;
  $("new-isolate").checked = role.isolate;
  $("new-role").value = role.body;
  if (!$("new-title").value.trim()) $("new-title").value = role.name;
}

// 오케스트레이터는 원본 폴더에서 읽기만 한다.
function syncOrchestrator() {
  if (!$("new-orchestrator").checked) return;
  $("new-permission").value = newKind().agent === "claude" ? "default" : "read-only";
  $("new-isolate").checked = false;
  $("new-template").value = "";
  $("new-role-name").value = "";
  if (!$("new-title").value.trim()) $("new-title").value = "오케스트레이터";
}

// kind: claude | codex | claude-chat | codex-chat
async function openNew(projectPath, { orchestrator = false, kind } = {}) {
  await loadStatus();
  const projects = sortedProjects();
  if (!projects.length && !kind?.endsWith("-chat")) {
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
  state.templateRoles = [];
  $("new-error").textContent = "";
  $("new-orchestrator").checked = orchestrator;
  syncNewKind();
  syncOrchestrator();
  $("new-dialog").showModal();
  fillTemplates();
}

$("open-new").addEventListener("click", () => openNew(state.project ?? state.current?.projectPath));
$("open-new-top").addEventListener("click", () => openNew());
$("nav-chat").addEventListener("click", () => openChat());
$("open-chat").addEventListener("click", () => openChat());
$("new-agent").addEventListener("change", () => {
  syncNewKind();
  syncOrchestrator();
});
$("new-model").addEventListener("input", () => fillEfforts("new-effort", newKind().agent, $("new-model").value.trim()));
$("new-orchestrator").addEventListener("change", syncOrchestrator);
$("p-orchestrator").addEventListener("click", () => openNew(state.project, { orchestrator: true }));
$("new-project").addEventListener("change", fillTemplates);
$("new-template").addEventListener("change", applyTemplate);

$("new-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const form = new FormData(e.target);
  const { kind, ...body } = Object.fromEntries(form);
  Object.assign(body, newKind());
  body.isolate = form.has("isolate");
  body.orchestrator = form.has("orchestrator") && !body.chat;
  if (body.chat) delete body.projectPath;
  try {
    const created = await api("POST", "/api/sessions", body);
    $("new-dialog").close();
    e.target.reset();
    await Promise.all([loadSessions(), loadProjects()]); // 감지된 프로젝트는 세션을 만들면서 등록된다.
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

async function refreshProjects() {
  await loadProjects();
  if (state.view === "project" && !currentProject()) goDashboard();
}

async function openSettings() {
  await loadStatus();
  renderProjects();
  for (const agent of ["claude", "codex"]) {
    cliManual[agent] = !!state.status.cliOverrides[agent];
    $(`cli-${agent}`).value = state.status.cliOverrides[agent];
    renderCliField(agent);
  }
  $("settings-error").textContent = "";
  $("settings-dialog").showModal();
  $("project-path").focus();
}

// CLI 경로: 자동으로 찾은 경로는 읽기 전용으로 보여 주고, 직접 지정할 때만 고칠 수 있다.
const cliManual = { claude: false, codex: false };

function renderCliField(agent) {
  const info = state.status.agents[agent];
  const input = $(`cli-${agent}`);
  const note = $(`cli-${agent}-note`);
  const manual = cliManual[agent];
  input.readOnly = !manual;
  input.classList.toggle("auto", !manual);
  $(`cli-${agent}-mode`).textContent = manual ? "자동으로" : "직접 지정";
  if (manual) {
    input.placeholder = "실행 파일 경로";
    note.textContent = info.autoPath ? `자동으로 찾은 경로: ${info.autoPath}` : "자동으로 찾지 못했습니다.";
    note.className = "cli-note";
  } else {
    input.value = info.autoPath ?? "";
    input.placeholder = "찾지 못했습니다 · 직접 지정하세요";
    note.textContent = info.autoPath ? `자동으로 찾음${info.version ? ` · ${info.version}` : ""}` : "CLI를 찾지 못했습니다. 설치했다면 직접 지정하세요.";
    note.className = `cli-note ${info.autoPath ? "ok" : "missing"}`;
  }
}

for (const agent of ["claude", "codex"]) {
  $(`cli-${agent}-mode`).addEventListener("click", () => {
    cliManual[agent] = !cliManual[agent];
    $(`cli-${agent}`).value = cliManual[agent] ? state.status.cliOverrides[agent] || state.status.agents[agent].autoPath || "" : "";
    renderCliField(agent);
    if (cliManual[agent]) $(`cli-${agent}`).focus();
  });
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
    const cli = {};
    for (const agent of ["claude", "codex"]) cli[agent] = cliManual[agent] ? $(`cli-${agent}`).value : "";
    await api("PUT", "/api/settings", { cli });
    $("settings-dialog").close();
    await loadStatus();
  } catch (err) {
    $("settings-error").textContent = err.message;
  }
});

// ── 화면 테마 ───────────────────────────────────────────────────
// 테마 적용은 CSS보다 먼저 읽는 theme.js가 맡고, 여기서는 고르는 버튼만 다룬다.
function renderThemeSwitch() {
  const pref = window.agenthubTheme.get();
  for (const button of $("theme-switch").querySelectorAll("button")) {
    const on = button.dataset.themePref === pref;
    button.classList.toggle("active", on);
    button.setAttribute("aria-checked", String(on));
  }
}

$("theme-switch").addEventListener("click", (e) => {
  const pref = e.target.closest("button")?.dataset.themePref;
  if (pref) window.agenthubTheme.set(pref);
});
window.addEventListener("agenthub-theme", renderThemeSwitch);
renderThemeSwitch();

// ── 실시간 갱신 ─────────────────────────────────────────────────
function connectStream() {
  const source = new EventSource("/api/stream");
  source.addEventListener("event", (e) => {
    const { sessionId, event } = JSON.parse(e.data);
    const s = state.current;
    if (s?.id !== sessionId || event.seq < s.events.length) return;
    s.events.push(event);
    const list = eventsList();
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
  source.addEventListener("links", loadLinks);
  source.addEventListener("session", (e) => {
    const { sessionId } = JSON.parse(e.data);
    if (state.current?.id === sessionId) selectSession(sessionId);
  });
  source.addEventListener("limits", loadLimits);
  source.addEventListener("update", (e) => {
    state.update = JSON.parse(e.data);
    renderUpdate();
  });
  // 연결이 끊겼다가 돌아오면 놓친 이벤트를 다시 받아 온다. 목록의 실행 상태도 그 사이 바뀌었을 수 있다.
  source.addEventListener("open", () => {
    loadSessions();
    if (state.current) selectSession(state.current.id);
  });
}

await Promise.all([loadStatus(), loadSessions(), loadLimits(), loadUpdate(), loadProjects(), loadLinks()]);
if (POPUP) {
  document.body.classList.add("popup");
  if (POPUP === "new") openChat();
  else await selectSession(POPUP).catch(openChat);
} else {
  goDashboard();
}
connectStream();
loadAuth();
setInterval(loadAuth, 5 * 60_000);

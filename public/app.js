import { renderMarkdown } from "./markdown.js";
import { layoutGitGraph, gitWorkRows } from "./gitgraph.js";
import { createPullRequests } from "./gitpulls.js";
import { composerAction } from "./composer.js";
import { runningElapsed } from "./elapsed.js";

const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  sessions: [],
  view: "dashboard", // dashboard | project | session
  project: null, // 보고 있는 프로젝트 경로
  current: null, // 선택한 세션의 전체 데이터
  filter: "",
  links: [], // 세션 사이 연결
  graphSelected: new Set(), // 그래프에서 고른 카드(세션·명령 노드) ID
  messages: [], // 보고 있는 프로젝트에서 세션끼리 주고받은 메시지(그래프의 대화선)
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
const STATE_LABEL = { idle: "대기", running: "실행 중", error: "오류", interrupted: "중단됨", paused: "일시중지됨" };

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

// 타이머는 텍스트만 갱신한다. 노드 선택·끌기·입력창 포커스는 그대로 유지한다.
function updateElapsedElement(node, item, now = Date.now()) {
  const elapsed = runningElapsed(item, now);
  const fallback = node.dataset.elapsedFallback === "updated" && item;
  node.hidden = elapsed === null && !fallback;
  node.classList.toggle("is-running", elapsed !== null);
  const text = elapsed !== null ? "⏱ " + elapsed : fallback ? timeAgo(item.updatedAt) : "";
  if (node.textContent !== text) node.textContent = text;
  const startedAt = elapsed !== null ? item.runningStartedAt ?? item.live?.startedAt : null;
  if (startedAt) {
    node.dateTime = startedAt;
    node.title = "현재 작업 경과 시간 · 시작 " + new Date(startedAt).toLocaleString();
  } else {
    node.removeAttribute("datetime");
    node.removeAttribute("title");
  }
}

function elapsedElement(kind, item, fallback = false) {
  const node = el("time", {
    class: "run-elapsed", role: "timer", "aria-live": "off",
    "data-elapsed-kind": kind, "data-elapsed-id": item.id,
    ...(fallback ? { "data-elapsed-fallback": "updated" } : {}),
  });
  updateElapsedElement(node, item);
  return node;
}

function renderSessionElapsed(prefix, session) {
  const node = $(prefix + "-elapsed");
  node.dataset.elapsedKind = "session";
  node.dataset.elapsedId = session?.id ?? "";
  updateElapsedElement(node, session);
}

function refreshElapsedTimes() {
  const now = Date.now();
  for (const node of document.querySelectorAll("[data-elapsed-kind]")) {
    const item = node.dataset.elapsedKind === "command" ? commandById(node.dataset.elapsedId)
      : state.current?.id === node.dataset.elapsedId ? state.current : sessionById(node.dataset.elapsedId);
    updateElapsedElement(node, item, now);
    if (node.dataset.elapsedKind === "command" && item) {
      const detail = node.nextElementSibling;
      if (detail?.classList.contains("gcmd-result-text")) {
        const text = commandNodeFoot(item);
        if (detail.textContent !== text) detail.textContent = text;
      }
    }
  }
}

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
  state.viewRevision = (state.viewRevision ?? 0) + 1;
  clearGraphTransientState();
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
  renderLinkConditions();
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

// 설정 창의 CLI 상태. 없으면 "설치", 로그인이 안 됐으면 "로그인" 버튼을 보이고, 누르면 설치·로그인 창에서 진행한다.
function renderCliStatus() {
  if (!state.status) return;
  const rows = Object.entries(state.status.agents).map(([name, info]) => ({
    id: name, label: AGENT_LABEL[name], path: info.path, version: info.version, loggedIn: state.auth?.[name],
  }));
  const gh = state.setup?.tools.find((t) => t.id === "gh");
  if (gh) rows.push({ id: "gh", label: "GitHub", path: gh.path, version: gh.version?.replace(/^gh version\s*/, "").split(" ")[0], loggedIn: gh.loggedIn });
  $("cli-status").replaceChildren(...rows.map((r) => {
    const job = state.setup?.jobs?.[r.id];
    const busy = job?.state === "running";
    const action = busy ? null : !r.path ? "install" : r.loggedIn === false ? "login" : null;
    return el("div", { title: r.path ?? "CLI를 찾지 못했습니다" },
      el("span", { class: `dot ${busy ? "running" : !r.path || r.loggedIn === false ? "error" : "ok"}` }),
      el("span", { class: "cli-text" }, `${r.label} ${busy ? (job.kind === "install" ? "설치 중…" : "로그인 중…") : r.path ? r.version ?? "버전 확인 실패" : "없음"}`),
      action ? el("button", { type: "button", class: "login-btn", onclick: () => openSetup(r.id, action), title: "앱 안에서 설치·로그인을 진행합니다" },
        action === "install" ? "설치" : "로그인 필요") : null);
  }));
}

// ── CLI 설치·로그인 ─────────────────────────────────────────────
const SETUP_STATE = { running: "진행 중", done: "완료", error: "실패", canceled: "취소함" };

async function loadSetup() {
  try {
    state.setup = await api("GET", "/api/setup");
  } catch {
    return;
  }
  renderCliStatus();
  if ($("setup-dialog").open) renderSetup();
}

// 창을 열고, action이 있으면 바로 시작한다.
async function openSetup(tool = null, action = null) {
  if (!state.setup) await loadSetup();
  renderSetup();
  if (!$("setup-dialog").open) $("setup-dialog").showModal();
  if (tool && action) setupAction(tool, action);
}

async function setupAction(tool, action, body) {
  try {
    await api("POST", `/api/setup/${tool}/${action}`, body);
  } catch (err) {
    alert(err.message);
  }
}

function renderSetup() {
  const tools = state.setup?.tools ?? [];
  $("setup-list").replaceChildren(...tools.map((t) => {
    const job = state.setup.jobs?.[t.id];
    const running = job?.state === "running";
    const status = !t.path ? "설치 안 됨"
      : `${t.version ?? "버전 확인 실패"} · ${t.loggedIn === true ? "로그인됨" : t.loggedIn === false ? "로그인 필요" : "로그인 확인 실패"}`;
    const ok = t.path && t.loggedIn === true;
    const item = el("div", { class: `setup-item${ok ? " ok" : ""}` },
      el("div", { class: "setup-head" },
        el("b", {}, t.label),
        el("span", { class: `pill ${ok ? "setup-ok" : "setup-need"}` }, status),
        el("span", { class: "spacer" }),
        !t.path && t.installable ? el("button", { type: "button", class: "primary sm", onclick: () => setupAction(t.id, "install"), ...(running ? { disabled: "" } : {}) }, "설치") : null,
        t.path ? el("button", { type: "button", class: `${t.loggedIn ? "ghost" : "primary"} sm`, onclick: () => setupAction(t.id, "login"), ...(running ? { disabled: "" } : {}) }, t.loggedIn ? "다시 로그인" : "로그인") : null),
      !t.path && !t.installable ? el("p", { class: "hint" }, "winget이 없어 자동으로 설치할 수 없습니다. 직접 설치한 뒤 다시 확인하세요.") : null);
    if (job) item.append(setupJob(t, job, running));
    return item;
  }));
}

// 진행 중이거나 끝난 작업. 로그인이면 브라우저 주소·일회용 코드·코드 붙여넣기 칸을 보인다.
function setupJob(t, job, running) {
  const box = el("div", { class: `setup-job ${job.state}` },
    el("div", { class: "setup-job-head" },
      el("span", {}, `${job.kind === "install" ? "설치" : "로그인"} ${SETUP_STATE[job.state] ?? job.state}`),
      running ? el("button", { type: "button", class: "ghost sm danger", onclick: () => setupAction(t.id, "cancel") }, "취소") : null));
  if (job.kind === "login" && running) {
    if (job.url) {
      box.append(el("p", { class: "hint" }, "브라우저에서 로그인 페이지를 열었습니다. 열리지 않았으면 아래 버튼을 누르세요."),
        el("button", { type: "button", class: "ghost sm", onclick: () => window.open(job.url, "_blank") }, "브라우저에서 열기"));
    }
    if (job.code) {
      box.append(el("div", { class: "setup-code" },
        el("span", { class: "mono" }, job.code),
        el("button", { type: "button", class: "ghost sm", onclick: () => navigator.clipboard?.writeText(job.code) }, "복사"),
        el("span", { class: "hint" }, "로그인 페이지에 이 코드를 입력하세요.")));
    }
    // Claude는 브라우저에 표시된 코드를 다시 붙여 넣으라고 한다.
    if (t.id === "claude" || job.waitsForCode) {
      const input = el("input", { class: "mono", placeholder: "브라우저에 표시된 코드를 붙여 넣으세요" });
      const send = () => input.value.trim() && setupAction(t.id, "input", { text: input.value });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          send();
        }
      });
      box.append(el("div", { class: "setup-paste" }, input, el("button", { type: "button", class: "primary sm", onclick: send }, "보내기")));
    }
  }
  if (job.state === "done") box.append(el("p", { class: "ok-text" }, job.kind === "install" ? "설치했습니다." : "로그인했습니다."));
  if (job.log.trim()) box.append(el("details", { ...(job.state === "error" ? { open: "" } : {}) }, el("summary", {}, "출력"), el("pre", { class: "setup-log" }, job.log.trim().split("\n").slice(-40).join("\n"))));
  return box;
}

$("setup-refresh").addEventListener("click", async () => {
  $("setup-refresh").disabled = true;
  await Promise.all([loadStatus(), loadAuth(true), loadSetup()]);
  $("setup-refresh").disabled = false;
});
$("cli-status").addEventListener("click", (e) => {
  if (!e.target.closest("button")) openSetup();
});

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
  claude: "Claude CLI에 로그인하면 사용률이 표시됩니다.",
  codex: "Codex 세션 기록에서 한도 정보를 찾지 못했습니다. Codex를 한 번 실행하면 표시됩니다.",
};

// fresh: 새로고침 버튼처럼 서버의 캐시를 쓰지 않고 다시 묻는다.
async function loadLimits(fresh = false) {
  try {
    state.limits = await api("GET", `/api/limits${fresh === true ? "?fresh=1" : ""}`);
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

  // 사이드바에는 에이전트마다 가장 많이 쓴 기간 하나를 보여 준다.
  // Claude는 시간제(5시간) 한도를 늘 함께 보여 주고, 초기화까지 남은 시간도 붙인다.
  $("limit-mini").replaceChildren(...["claude", "codex"].flatMap((agent) => {
    const all = limits[agent]?.windows ?? [];
    const live = all.filter((w) => !isExpired(w) && typeof w.usedPercent === "number");
    const shown = [];
    const hourly = agent === "claude" ? all.find((w) => w.id === "five_hour") : null;
    if (hourly) shown.push(hourly);
    const rest = live.filter((w) => w !== hourly);
    if (rest.length) shown.push(rest.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)));
    return shown.map((w) => limitMini(agent, w));
  }));
}

const LIMIT_STATUS = { allowed: "사용 가능", allowed_warning: "한도 임박", rejected: "한도 도달" };

// 사이드바의 한도 한 줄. 초기화 시각이 지났으면 다 남은 것으로 본다.
function limitMini(agent, w) {
  const expired = isExpired(w);
  const used = expired ? 0 : w.usedPercent;
  const known = typeof used === "number";
  const reset = !expired && w.resetsAt ? untilText(w.resetsAt) : null;
  return el("div", { class: "item", title: w.resetsAt ? `초기화 ${fmtDate(w.resetsAt)}` : "" },
    // 초기화까지 남은 시간은 이름 옆에 작게 붙여 사이드바 높이를 늘리지 않는다.
    el("div", { class: "line" },
      el("span", {}, `${AGENT_LABEL[agent]} ${w.label}`,
        reset || expired ? el("span", { class: "reset" }, expired ? " · 초기화됨" : ` · ${reset} 뒤`) : null),
      // 사용률을 모르면(실행 중 이벤트만 받은 경우) 상태만 보인다.
      el("span", {}, known ? `${Math.max(0, 100 - used).toFixed(0)}% 남음` : LIMIT_STATUS[w.status] ?? "사용률 모름")),
    el("div", { class: "bar" }, el("span", {
      class: known ? barLevel(used) : w.status === "rejected" ? "danger" : w.status === "allowed_warning" ? "warn" : "",
      style: `width:${known ? Math.min(100, used) : w.status === "rejected" ? 100 : 0}%`,
    })));
}

// 지금부터 그 시각까지 남은 시간("2시간 13분", "40분", "3일 4시간")
function untilText(iso) {
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
  return `${Math.floor(hours / 24)}일${hours % 24 ? ` ${hours % 24}시간` : ""}`;
}

$("refresh-limits").addEventListener("click", () => loadLimits(true));
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

// 일반 채팅과 프로젝트 세션은 사이드바에서 따로 보여 준다.
function renderSessionList() {
  const q = state.filter.toLowerCase();
  const items = state.sessions.filter((s) => !q || `${s.title} ${s.projectName}`.toLowerCase().includes(q));
  const item = (s, sub) => el("button", {
    class: `session-item${state.current?.id === s.id ? " active" : ""}`,
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

// ── 프로젝트 탭 ─────────────────────────────────────────────────
// 세션 흐름 / 세션 목록 / Git. 마지막에 본 탭을 이 브라우저에 기억한다.
const TAB_KEY = "agenthub-project-tab";
const PROJECT_TABS = ["flow", "sessions", "git"];
const projectTab = () => (PROJECT_TABS.includes(localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : "flow");

function showProjectTab(tab) {
  localStorage.setItem(TAB_KEY, tab);
  for (const b of $("p-tabs").querySelectorAll("[data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === tab);
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  }
  for (const panel of document.querySelectorAll("#view-project .tab-panel")) panel.hidden = panel.dataset.panel !== tab;
  if (tab === "git") loadGit();
}

$("p-tabs").addEventListener("click", (e) => {
  const button = e.target.closest("[data-tab]");
  if (button) showProjectTab(button.dataset.tab);
});

// ── 세션 목록 탭 ────────────────────────────────────────────────
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
$("p-session-filter").addEventListener("input", renderProjectSessionTable);

// ── Git 탭 ──────────────────────────────────────────────────────
const GIT_TAB_KEY = "agenthub-git-tab";
const GIT_TABS = ["changes", "history", "pulls"];
const pullRequests = createPullRequests({ api, renderMarkdown, renderDiff, onSetup: () => openSetup("gh"), isProjectCurrent: (project) => samePath(project, state.project) });
const gitTab = () => GIT_TABS.includes(localStorage.getItem(GIT_TAB_KEY)) ? localStorage.getItem(GIT_TAB_KEY) : "changes";
const gitBusy = () => !!(state.git?.indexBusy || state.git?.committing || state.git?.merging);
const gitFiles = (area) => (state.git?.data?.files ?? []).filter((f) => f[area]);

function closeGitDetail() {
  if (state.git) {
    ++state.git.viewVersion;
    state.git.activeFile = null;
    setGitActive(null);
  }
  $("g-detail").hidden = true;
  $("g-diff-empty").hidden = false;
  for (const row of $("g-changes").querySelectorAll(".git-file.active")) row.classList.remove("active");
}

function showGitTab(tab) {
  if (!GIT_TABS.includes(tab)) return;
  if (state.git?.tab !== tab) closeGitDetail();
  if (state.git) state.git.tab = tab;
  localStorage.setItem(GIT_TAB_KEY, tab);
  for (const button of $("g-tabs").querySelectorAll("[data-git-tab]")) {
    const active = button.dataset.gitTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of $("g-body").querySelectorAll("[data-git-panel]")) panel.hidden = panel.dataset.gitPanel !== tab;
  $(tab === "changes" ? "g-change-preview" : "g-history-detail").append($("g-detail"));
  if (tab === "pulls" && state.git) pullRequests.activate(state.git.project);
}

async function loadGit() {
  const p = currentProject();
  if (!p) return;
  const projectPath = p.path;
  if (!state.git || !samePath(state.git.project, projectPath)) {
    state.git = { project: projectPath, selected: { staged: new Set(), unstaged: new Set() }, tab: gitTab(), data: null, loadVersion: 0, viewVersion: 0 };
    closeGitDetail();
    pullRequests.setProject(projectPath);
    showGitTab(state.git.tab);
    $("g-body").hidden = true;
    $("g-message").value = "";
    $("g-error").textContent = "";
    $("g-branch").textContent = "";
    $("g-sync").textContent = "";
    $("p-tab-git").textContent = "";
  }
  const current = state.git;
  const version = ++current.loadVersion;
  $("g-refresh").disabled = true;
  try {
    const data = await api("GET", "/api/git?path=" + encodeURIComponent(projectPath));
    if (state.git !== current || version !== current.loadVersion || !samePath(projectPath, state.project)) return;
    $("g-note").hidden = true;
    $("g-body").hidden = false;
    for (const area of ["staged", "unstaged"]) {
      const paths = new Set(data.files.filter((f) => f[area]).map((f) => f.path));
      for (const file of current.selected[area]) if (!paths.has(file)) current.selected[area].delete(file);
    }
    current.data = data;
    renderGit();
    if (current.tab === "pulls") pullRequests.activate(current.project);
    if (current.activeFile) {
      const { file, area } = current.activeFile;
      if (gitFiles(area).some((f) => f.path === file)) showGitFile(file, area);
      else closeGitDetail();
    }
  } catch (err) {
    if (state.git !== current || version !== current.loadVersion || !samePath(projectPath, state.project)) return;
    $("g-note").hidden = false;
    $("g-note").textContent = err.reason === "not-git" ? "Git 저장소가 아닙니다." : err.message;
    $("g-body").hidden = true;
  } finally {
    if (state.git === current && version === current.loadVersion) $("g-refresh").disabled = gitBusy();
  }
}

function renderGit() {
  const { data } = state.git;
  $("g-branch").textContent = data.branch;
  $("g-branch").title = "현재 브랜치: " + data.branch;
  $("g-sync").textContent = data.upstream
    ? (data.ahead ? "↑ " + data.ahead + " " : "") + (data.behind ? "↓ " + data.behind : "") + (!data.ahead && !data.behind ? "동기화됨" : "")
    : "";
  $("g-sync").title = data.upstream ? data.upstream + " · 마지막으로 받은 원격 기록 기준" : "";
  const n = data.files.length + data.moreFiles;
  $("p-tab-git").textContent = n ? String(n) : "";
  $("g-file-count").textContent = String(n);
  for (const area of ["unstaged", "staged"]) renderGitFiles(area);
  $("g-limit").hidden = !data.moreFiles;
  $("g-limit").textContent = "변경 파일 중 500개만 표시합니다. '모두'는 표시된 파일에 적용됩니다. 커밋에는 스테이징된 모든 파일이 포함됩니다.";
  renderGitControls();
  $("g-branch-count").textContent = String(data.branches.length);
  $("g-branches").replaceChildren(...data.branches.map(renderGitBranch));
  renderGitGraph();
}

function renderGitFiles(area) {
  const files = gitFiles(area);
  const selected = state.git.selected[area];
  const staged = area === "staged";
  const action = staged ? "unstage" : "stage";
  $("g-" + area + "-count").textContent = String(state.git.data[area + "Count"] ?? files.length);
  $("g-" + area).replaceChildren(...(files.length ? files.map((f) => {
    const label = (staged ? f.stageLabel : f.workLabel) || f.label;
    const box = el("input", { type: "checkbox", "aria-label": f.path + (staged ? " 스테이징됨 선택" : " 스테이징 전 선택"), onchange: (e) => {
      if (e.target.checked) selected.add(f.path);
      else selected.delete(f.path);
      renderGitControls();
    } });
    box.checked = selected.has(f.path);
    const active = state.git.activeFile?.file === f.path && state.git.activeFile?.area === area;
    return el("li", { class: "git-file" + (active ? " active" : ""), "data-file": f.path, "data-area": area }, box,
      el("span", { class: "git-status s-" + (["새 파일", "추가"].includes(label) ? "new" : label === "삭제" ? "del" : label === "충돌" ? "conflict" : "mod") }, label),
      el("button", { type: "button", class: "link mono", title: f.orig ? f.orig + " → " + f.path : f.path, onclick: () => showGitFile(f.path, area) }, f.path),
      el("button", { type: "button", class: "ghost sm git-file-action", "data-index-action": action, "aria-label": f.path + (staged ? " 스테이징 해제" : " 스테이징"), title: staged ? "스테이징 해제" : "스테이징", onclick: () => changeGitIndex(action, [f.path]) }, staged ? "−" : "+"));
  }) : [el("li", { class: "muted git-list-empty" }, staged ? "스테이징된 파일이 없습니다." : "스테이징 전 변경이 없습니다.")]));
}

const gitBranchName = (b) => b.sessionTitle || b.name;

function renderGitControls() {
  const current = state.git;
  if (!current?.data) return;
  const busy = gitBusy();
  for (const area of ["unstaged", "staged"]) {
    const files = gitFiles(area);
    const picked = files.filter((f) => current.selected[area].has(f.path)).length;
    const all = $("g-" + area + "-all");
    all.checked = files.length > 0 && picked === files.length;
    all.indeterminate = picked > 0 && picked < files.length;
    all.disabled = !files.length || busy;
    const action = area === "staged" ? "unstage" : "stage";
    $("g-" + action + "-selected").disabled = !picked || busy;
    $("g-" + action + "-selected").textContent = (area === "staged" ? "선택 해제" : "선택 스테이징") + (picked ? " (" + picked + ")" : "");
    $("g-" + action + "-all").disabled = !files.length || busy;
    $("g-" + action + "-all").title = current.data.moreFiles ? "표시된 파일 모두" : "모든 파일";
  }
  for (const input of $("g-changes").querySelectorAll(".git-file input, [data-index-action]")) input.disabled = busy;
  const staged = current.data.stagedCount ?? gitFiles("staged").length;
  $("g-commit").disabled = !staged || busy || !$("g-message").value.trim();
  $("g-commit").textContent = current.committing ? "커밋 중…" : staged ? "커밋 (" + staged + ")" : "커밋";
  $("g-commit-note").textContent = current.indexBusy ? "목록을 업데이트하는 중…" : "스테이징된 내용만 커밋합니다.";
  $("g-message").disabled = !!current.committing;
  $("g-refresh").disabled = busy;
}

function renderGitBranch(b) {
  const running = b.sessionState === "running";
  const status = running ? "작업 중" : b.dirty ? "변경 " + b.dirty : b.ahead ? "+" + b.ahead : b.current ? "현재" : "";
  const actions = [];
  const run = (label, fn, opts = {}) => {
    const button = el("button", { type: "button", class: "ghost sm", title: opts.title ?? "", onclick: fn }, label);
    button.disabled = !!opts.disabled;
    actions.push(button);
  };
  if (b.sessionId) run("세션 열기", () => selectSession(b.sessionId));
  if (b.sessionId && b.dirty) run("변경 보기", () => showSessionChanges(b));
  if (b.sessionId && b.dirty) run("커밋", (e) => openBranchCommit(e.target.closest("li"), b), { disabled: running, title: running ? "세션이 끝난 뒤 커밋할 수 있습니다." : "세션의 변경 전체를 커밋합니다." });
  if (!b.current && b.ahead) run("비교", () => showGitBranch(b));
  if (!b.current && b.ahead) run("병합", () => mergeGitBranch(b), { title: state.git.data.branch + "에 병합" });
  const summary = el("summary", { title: b.name },
    el("span", { class: "git-branch-dot" + (running ? " running" : "") }),
    el("span", { class: "name" }, gitBranchName(b)),
    el("span", { class: "git-branch-status" }, status));
  return el("li", { class: "git-branch" + (b.current ? " current" : "") },
    el("details", {}, summary,
      el("div", { class: "git-branch-info muted mono" }, b.name),
      b.dirty === null ? el("div", { class: "muted" }, "작업 폴더 없음") : null,
      actions.length ? el("div", { class: "git-actions" }, ...actions) : null));
}

function renderGitGraph() {
  const { data } = state.git;
  const work = gitWorkRows(data);
  const commits = data.graph?.commits ?? data.commits;
  const layout = layoutGitGraph([...work, ...commits]);
  const width = Math.max(60, layout.lanes * 22 + 26);
  $("g-graph").style.minWidth = (width + 470) + "px";
  const rows = layout.rows.map((row) => {
    const c = row.commit;
    const x = (lane) => 20 + lane * 22;
    const y = { top: 0, node: 24, bottom: 48 };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", width);
    svg.setAttribute("height", 48);
    svg.setAttribute("viewBox", "0 0 " + width + " 48");
    svg.setAttribute("aria-hidden", "true");
    for (const s of row.segments) {
      const path = document.createElementNS(svg.namespaceURI, "path");
      const ax = x(s.fromLane), bx = x(s.toLane), ay = y[s.from], by = y[s.to];
      const middle = (ay + by) / 2;
      path.setAttribute("d", ax === bx ? "M" + ax + " " + ay + "V" + by : "M" + ax + " " + ay + "C" + ax + " " + middle + " " + bx + " " + middle + " " + bx + " " + by);
      path.setAttribute("class", "git-track git-track-" + s.color + (s.dashed ? " work" : ""));
      svg.append(path);
    }
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", x(row.lane));
    circle.setAttribute("cy", 24);
    circle.setAttribute("r", c.work ? 5 : c.parents?.length > 1 ? 5.5 : 4);
    circle.setAttribute("class", "git-station git-track-" + row.color + (c.work ? " work" : ""));
    svg.append(circle);
    const branches = (c.refs ?? []).map((name) => data.branches.find((b) => b.name === name) ?? (c.branch?.name === name ? c.branch : { name }));
    const chips = branches.slice(0, 2).map((b) => el("span", { class: "git-ref" + (b.current ? " current" : ""), title: b.name }, gitBranchName(b)));
    if (branches.length > 2) chips.push(el("span", { class: "git-ref", title: branches.slice(2).map(gitBranchName).join("\n") }, "+" + (branches.length - 2)));
    const title = c.work ? [gitBranchName(c.branch), c.branch.sessionState === "running" ? "작업 중" : "", c.dirty ? "변경 " + c.dirty + "개" : ""].filter(Boolean).join(" · ") : c.subject;
    const button = el("button", { type: "button", class: "git-graph-row" + (c.work ? " work" : "") + (state.git.activeRow === c.hash ? " active" : ""),
      "data-hash": c.hash, "aria-pressed": String(state.git.activeRow === c.hash), title: c.work ? title : c.subject + "\n" + c.author + " · " + fmtDate(c.date) + "\n" + c.hash,
      onclick: () => {
        setGitActive(c.hash);
        if (!c.work) showGitCommit(c);
        else if (c.branch.sessionId) showSessionChanges(c.branch);
        else { showGitTab("changes"); $("g-changes").scrollIntoView({ block: "nearest" }); }
      } }, svg,
      el("span", { class: "git-graph-subject" }, title),
      el("span", { class: "git-graph-refs" }, ...chips),
      el("span", { class: "git-graph-meta mono" }, c.work ? "커밋 전" : c.short));
    return button;
  });
  $("g-graph").replaceChildren(...(rows.length ? rows : [el("p", { class: "git-empty muted" }, "아직 커밋이 없습니다.")]));
  $("g-summary").textContent = (work.length ? "작업 " + work.length + " · " : "") + "커밋 " + commits.length;
  $("g-history-note").textContent = data.graph?.truncated ? "최근 100개 · 아래로 이전 기록이 이어집니다." : "커밋을 누르면 변경 내용을 볼 수 있습니다.";
}

function setGitActive(hash) {
  state.git.activeRow = hash;
  for (const row of $("g-graph").querySelectorAll(".git-graph-row")) {
    row.classList.toggle("active", row.dataset.hash === hash);
    row.setAttribute("aria-pressed", String(row.dataset.hash === hash));
  }
}

function showGitView(title, text) {
  $("g-diff-empty").hidden = true;
  $("g-detail").hidden = false;
  $("g-view-title").textContent = title;
  $("g-view").replaceChildren(...renderDiff(text));
  $("g-view").scrollTop = 0;
}

async function gitGet(url, title) {
  const current = state.git;
  const version = ++current.viewVersion;
  showGitView(title, "불러오는 중…");
  try {
    const data = await api("GET", url);
    if (state.git === current && current.viewVersion === version && samePath(current.project, state.project)) showGitView(title, data.diff || "변경 없음");
  } catch (err) {
    if (state.git === current && current.viewVersion === version && samePath(current.project, state.project)) showGitView(title, err.message);
  }
}

const gitQuery = (extra) => new URLSearchParams({ path: state.git.project, ...extra });
function showGitFile(file, area = "unstaged") {
  showGitTab("changes");
  state.git.activeFile = { file, area };
  for (const row of $("g-changes").querySelectorAll(".git-file")) row.classList.toggle("active", row.dataset.file === file && row.dataset.area === area);
  return gitGet("/api/git/diff?" + gitQuery({ file, area }), file + (area === "staged" ? " · 스테이징됨" : " · 스테이징 전"));
}
const showGitCommit = (c) => gitGet("/api/git/show?" + gitQuery({ hash: c.hash }), c.short + " · " + c.subject);
const showGitBranch = (b) => gitGet("/api/git/branch?" + gitQuery({ branch: b.name }), gitBranchName(b) + " · 병합할 변경");

async function showSessionChanges(b) {
  const current = state.git;
  const version = ++current.viewVersion;
  const title = gitBranchName(b) + " · 작업 변경";
  showGitView(title, "불러오는 중…");
  try {
    const data = await api("GET", "/api/sessions/" + b.sessionId + "/diff");
    if (state.git === current && current.viewVersion === version && samePath(current.project, state.project)) showGitView(title, data.diff || data.status || "변경 없음");
  } catch (err) {
    if (state.git === current && current.viewVersion === version && samePath(current.project, state.project)) showGitView(title, err.message);
  }
}

function openBranchCommit(li, b) {
  if (gitBusy()) return;
  li.querySelector(".git-inline")?.remove();
  const current = state.git;
  const input = el("input", { placeholder: "커밋 메시지", "aria-label": gitBranchName(b) + " 커밋 메시지", value: gitBranchName(b) + " 작업" });
  const error = el("span", { class: "error", role: "alert" });
  let busy = false;
  const submit = async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      await api("POST", "/api/git/commit", { path: current.project, session: b.sessionId, message: input.value });
      if (state.git === current && samePath(current.project, state.project)) await loadGit();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      busy = false;
      button.disabled = false;
    }
  };
  const button = el("button", { type: "button", class: "primary sm", onclick: submit }, "커밋");
  const form = el("div", { class: "git-inline" }, input, button,
    el("button", { type: "button", class: "ghost sm", onclick: () => form.remove() }, "취소"), error);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) submit();
    if (e.key === "Escape" && !busy) form.remove();
  });
  li.querySelector("details").append(form);
  input.focus();
  input.select();
}

async function mergeGitBranch(b) {
  const current = state.git;
  if (gitBusy()) return;
  const into = current.data.branch;
  if (!confirm(gitBranchName(b) + " → " + into + " 병합할까요?\n충돌하면 자동 취소됩니다.")) return;
  current.merging = true;
  renderGitControls();
  try {
    const { result } = await api("POST", "/api/git/merge", { path: current.project, branch: b.name });
    if (state.git === current && samePath(current.project, state.project)) { ++current.viewVersion; showGitView("병합 완료", result); }
  } catch (err) {
    alert(err.message);
  } finally {
    current.merging = false;
    if (state.git === current) renderGitControls();
  }
  if (state.git === current && samePath(current.project, state.project)) await loadGit();
}

$("g-tabs").addEventListener("click", (e) => {
  const button = e.target.closest("[data-git-tab]");
  if (button) showGitTab(button.dataset.gitTab);
});
$("g-tabs").addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const active = GIT_TABS.indexOf(state.git?.tab ?? gitTab());
  const index = e.key === "Home" ? 0 : e.key === "End" ? GIT_TABS.length - 1 : (active + (e.key === "ArrowRight" ? 1 : -1) + GIT_TABS.length) % GIT_TABS.length;
  e.preventDefault();
  showGitTab(GIT_TABS[index]);
  $("g-tab-" + GIT_TABS[index]).focus();
});
$("g-detail-close").addEventListener("click", closeGitDetail);
$("g-refresh").addEventListener("click", () => { loadGit(); if (state.git?.tab === "pulls") pullRequests.refresh(); });
$("g-message").addEventListener("input", renderGitControls);
for (const area of ["unstaged", "staged"]) {
  const action = area === "staged" ? "unstage" : "stage";
  $("g-" + area + "-all").addEventListener("change", (e) => {
    for (const f of gitFiles(area)) {
      if (e.target.checked) state.git.selected[area].add(f.path);
      else state.git.selected[area].delete(f.path);
    }
    renderGitFiles(area);
    renderGitControls();
  });
  $("g-" + action + "-selected").addEventListener("click", () => changeGitIndex(action, [...state.git.selected[area]]));
  $("g-" + action + "-all").addEventListener("click", () => changeGitIndex(action, gitFiles(area).map((f) => f.path)));
}

async function changeGitIndex(action, files) {
  const current = state.git;
  if (!files.length || gitBusy()) return;
  $("g-error").textContent = "";
  current.indexBusy = true;
  renderGitControls();
  try {
    await api("POST", "/api/git/" + action, { path: current.project, files });
    if (state.git === current && samePath(current.project, state.project)) closeGitDetail();
  } catch (err) {
    if (state.git === current && samePath(current.project, state.project)) $("g-error").textContent = err.message;
  } finally {
    if (state.git === current && samePath(current.project, state.project)) await loadGit();
    current.indexBusy = false;
    if (state.git === current) renderGitControls();
  }
}

$("g-commit").addEventListener("click", async () => {
  const current = state.git;
  const staged = current?.data?.stagedCount ?? gitFiles("staged").length;
  if (!staged || !$("g-message").value.trim() || gitBusy()) return;
  $("g-error").textContent = "";
  current.committing = true;
  renderGitControls();
  let result;
  try {
    ({ result } = await api("POST", "/api/git/commit", { path: current.project, message: $("g-message").value, staged: true }));
    if (state.git === current && samePath(current.project, state.project)) {
      $("g-message").value = "";
      current.selected.staged.clear();
      closeGitDetail();
    }
  } catch (err) {
    if (state.git === current && samePath(current.project, state.project)) $("g-error").textContent = err.message;
  } finally {
    if (state.git === current && samePath(current.project, state.project)) await loadGit();
    current.committing = false;
    if (state.git === current) renderGitControls();
  }
  if (result && state.git === current && samePath(current.project, state.project) && current.tab === "changes") showGitView("커밋 완료", result);
});

// 창을 다시 열어 보면 외부 Git 작업도 반영한다.
window.addEventListener("focus", () => {
  if (state.view === "project" && projectTab() === "git") loadGit();
});

// ── 프로젝트 제거 ───────────────────────────────────────────────
// AgentHub 목록에서만 뺀다. 이 프로젝트의 AgentHub 세션·명령 노드·연결·공유 노트는 지우고, 폴더와 파일은 그대로 둔다.
function openRemoveProject(p) {
  const sessions = hubSessions(p).filter((s) => !s.chat);
  const running = sessions.filter((s) => s.state === "running").length;
  const worktrees = sessions.filter((s) => s.worktree).length;
  const commandCount = state.commandsProject && samePath(state.commandsProject, p.path) ? (state.commands ?? []).length : 0;
  state.removingProject = p;
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
  const p = state.removingProject;
  const query = new URLSearchParams({ path: p.path });
  if ($("project-remove-force").checked) query.set("force", "1");
  if ($("project-remove-worktrees").checked) query.set("removeWorktrees", "1");
  const button = e.submitter;
  button.disabled = true;
  try {
    const result = await api("DELETE", `/api/projects?${query}`);
    $("project-remove-dialog").close();
    if (result.worktreeErrors.length) alert(`제거했지만 지우지 못한 작업 폴더가 있습니다(커밋하지 않은 변경이 있을 수 있음):\n\n${result.worktreeErrors.join("\n")}`);
    if (state.view === "project" && samePath(state.project, p.path)) goDashboard();
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
  if (state.project !== p.path) return; // 기다리는 사이 다른 화면으로 이동함
  // 숨긴 기록은 "숨긴 기록 보기"를 눌렀을 때만 보인다.
  const hiddenCount = found.filter((f) => f.hidden).length;
  const shown = found.filter((f) => state.showHiddenFound || !f.hidden);
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
        state.showHiddenFound = !state.showHiddenFound;
        renderFound(p);
      } }, state.showHiddenFound ? "숨긴 기록 감추기" : `숨긴 기록 ${hiddenCount}개 보기`))));
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
$("p-new").addEventListener("click", () => openNew(state.project));

// ── 세션 흐름 그래프 ────────────────────────────────────────────
const CARD_W = 230;
const CARD_H = 128; // 장착한 스킬 칩 한 줄을 포함한 높이(style.css의 .gcard와 같다)
const GAP_X = 96;
const GAP_Y = 24;
const PAD = 20;
const SVG_NS = "http://www.w3.org/2000/svg";
const CARD_SIZE = { w: CARD_W, h: CARD_H };
// 명령 노드는 id가 "cmd-"로 시작한다(서버의 commands.mjs와 같다).
const isCommandNode = (id) => id.startsWith("cmd-");
const CMD_SIZE = { w: CARD_W, h: 108 }; // style.css의 .gcmd와 같다
const nodeSize = (id) => (isCommandNode(id) ? CMD_SIZE : CARD_SIZE);
// 연결선 위의 짧은 이름. 대화상자의 선택지는 서버가 내려 준다(/api/status의 linkConditions).
const WHEN_LABEL = { success: "성공 시", error: "실패 시", always: "항상", otherwise: "그 외", manual: "수동" };
const keywordText = (keyword) => keyword.split(/[,，]/).map((k) => k.trim()).filter(Boolean).map((k) => `"${k}"`).join(" 또는 ");
const linkLabel = (l) => `${l.when === "keyword" ? `${keywordText(l.keyword)} 있으면` : WHEN_LABEL[l.when] ?? l.when}${l.approve ? " · 승인 후" : ""}`;
const sessionById = (id) => state.sessions.find((s) => s.id === id);
const firstLine = (text) => text?.split(/\r?\n/)[0] ?? "";

async function loadLinks() {
  const before = new Set((state.links ?? []).filter((l) => l.pending).map((l) => l.id));
  try {
    state.links = await api("GET", "/api/links");
  } catch {
    return;
  }
  // 새로 승인을 기다리는 넘기기가 생기면 알린다.
  for (const link of state.links) if (link.pending && !before.has(link.id)) notifyGate(link);
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
    // graphPos: 옮긴 세션 카드 위치, pos: 옮긴 명령 노드 위치
    pos.set(s.id, s.graphPos ?? s.pos ?? { x: PAD + lv * (CARD_W + GAP_X), y: PAD + row * (CARD_H + GAP_Y) });
  }
  return pos;
}

function renderGraph() {
  const box = $("p-graph");
  if (state.graph?.dragging) {
    state.graph.needsRender = true; // 데이터 변경은 끌기를 마친 뒤 한 번 반영한다.
    return;
  }
  const sessions = state.sessions
    .filter((s) => samePath(s.projectPath, state.project))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const cmdNodes = samePath(state.commandsProject, state.project) ? state.commands ?? [] : [];
  if (!sessions.length && !cmdNodes.length) {
    state.graph = null;
    box.replaceChildren(el("div", { class: "graph-empty" },
      "이 프로젝트에서 만든 세션이 없습니다. 여기서 우클릭하거나 새 세션을 만들면 카드로 보입니다."));
    return;
  }
  // 명령 노드는 세션과 같은 흐름 안에 놓인다(세션 → 명령 → 세션).
  const ids = new Set([...sessions, ...cmdNodes].map((s) => s.id));
  const links = state.links.filter((l) => ids.has(l.from) && ids.has(l.to));
  // 오케스트레이터가 만든 세션은 지휘선으로 잇고, 배치도 오케스트레이터를 앞에 둔다.
  const commands = sessions.filter((s) => ids.has(s.createdBy)).map((s) => ({ from: s.createdBy, to: s.id }));
  const pos = layoutGraph([...sessions, ...cmdNodes], [...commands, ...links]);

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
      el("div", { class: "gcard-top" }, badge(s.agent), orchestrator ? el("span", { class: "pill orch" }, "지휘") : null,
        s.waiting ? el("span", { class: "pill q-pending", title: "답을 기다리는 질문이나 권한 요청이 있습니다" }, "답 대기") : pill(s.state)),
      el("div", { class: "gcard-title" }, s.title),
      el("div", { class: `gcard-role${role ? "" : " empty"}` }, role || "역할 없음"),
      skillChips(s),
      el("div", { class: "gcard-foot" }, elapsedElement("session", s, true),
        el("span", { class: "gcard-life" }, lifePill(s),
          el("button", {
            type: "button",
            class: "gcard-restart",
            title: "다시 시작: CLI 대화를 새로 시작해 컨텍스트를 비웁니다. 기록·역할·연결은 그대로 둡니다.",
            onclick: () => restartSession(s),
            ...(s.state === "running" ? { disabled: "" } : {}),
          }, "↻"))),
      el("span", { class: "gcard-handle", title: "끌어서 다른 세션에 연결" }));
    cards.set(s.id, card);
    canvas.append(card);
  }
  for (const c of cmdNodes) {
    const node = commandNode(c);
    cards.set(c.id, node);
    canvas.append(node);
  }

  // 캔버스를 배율에 맞춰 그리고, 프로젝트별 화면 이동 위치를 유지한다.
  const sizer = el("div", { class: "graph-sizer" }, canvas);
  const pan = samePath(state.graph?.projectPath, state.project) ? { ...state.graph.pan } : { x: 0, y: 0 };
  state.graph = { canvas, sizer, svg, cards, pos, links, commands, zoom: graphZoomFor(state.project), pan, projectPath: state.project };
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
  if (!state.graphSelected.size || state.view !== "project" || state.graph?.dragging) return;
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
  const projectPath = state.project;
  const at = state.graph ? canvasPoint(e) : { x: PAD, y: PAD };
  const pos = { x: Math.max(0, Math.round(at.x)), y: Math.max(0, Math.round(at.y)) };
  const inProject = (action) => () => {
    if (state.view === "project" && samePath(projectPath, state.project)) action();
  };
  openContextMenu(e, connectFrom ? "새 노드에 연결" : "여기에 만들기", [
    ["새 세션", inProject(() => openNew(projectPath, { pos, connectFrom }))],
    ["새 명령", inProject(() => openCommandDialog(null, pos, connectFrom))],
    null,
    ["스킬 관리", inProject(() => openSkillsManager())],
  ]);
}

function clearGraphTransientState() {
  state.graphGesture?.cancel();
  closeContextMenu();
  for (const context of [state.newSessionContext, state.editingCommand]) {
    if (context) context.cancelled = true;
  }
  state.newSessionContext = null;
  state.editingCommand = null;
  if ($("new-dialog").open) $("new-dialog").close();
  if ($("command-dialog").open) $("command-dialog").close();
  state.graphSelected.clear();
}

// 취소·포커스 상실·화면 전환에도 임시 선과 선택 상자가 남지 않게 정리한다.
function trackGraphGesture(startEvent, onMove, onEnd) {
  state.graphGesture?.cancel();
  const graph = state.graph;
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
    if (state.graphGesture?.cancel === cancel) state.graphGesture = null;
    onEnd(e, cancelled);
    if (graph?.needsRender && state.graph === graph && !graph.dragging && state.view === "project") renderGraph();
  };
  const up = (e) => { if (matches(e)) finish(e, false); };
  const abort = (e) => { if (matches(e)) finish(e, true); };
  const cancel = () => finish(startEvent, true);
  state.graphGesture = { cancel };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", abort);
  window.addEventListener("blur", cancel);
}

async function connectCreatedGraphNode(context, to, projectPath) {
  if (!context?.connectFrom || context.cancelled || !samePath(context.projectPath, projectPath)) return;
  if (state.view !== "project" || !samePath(state.project, projectPath)) return;
  const source = sessionById(context.connectFrom) ??
    (samePath(state.commandsProject, projectPath) ? commandById(context.connectFrom) : null);
  if (!source || (source.projectPath && !samePath(source.projectPath, projectPath))) return;
  try {
    await api("POST", "/api/links", { from: source.id, to, ...defaultLinkCondition(source.id), enabled: true });
    await loadLinks();
  } catch (err) {
    alert(`노드는 만들었지만 연결하지 못했습니다. 손잡이를 끌어 다시 연결해 주세요.\n\n${err.message}`);
  }
}

// 우클릭 메뉴. entries: [이름, 동작, { danger, disabled, title }] 또는 구분선 null
function openContextMenu(e, title, entries) {
  e.preventDefault();
  closeContextMenu();
  const menu = el("div", { class: "context-menu", role: "menu" }, el("div", { class: "menu-title" }, title),
    ...entries.map((entry) => {
      if (!entry) return el("hr");
      const [label, action, { danger = false, disabled = false, title: tip = "" } = {}] = entry;
      return el("button", {
        type: "button",
        class: `menu-item${danger ? " danger" : ""}`,
        title: tip,
        ...(disabled ? { disabled: "" } : {}),
        onclick: () => {
          closeContextMenu();
          action();
        },
      }, label);
    }));
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - height - 8)}px`;
}

// ── 명령 노드 ───────────────────────────────────────────────────
const commandById = (id) => (state.commands ?? []).find((c) => c.id === id);
const nodeTitle = (id) => (sessionById(id) ?? commandById(id))?.title ?? "?";
const COMMAND_STATE = { idle: "대기", running: "실행 중", success: "성공", error: "실패" };
const shellLabel = (id) => (state.shells ?? []).find((s) => s.id === id)?.label ?? id;
const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}초`;

// 세션끼리 주고받은 메시지. 그래프에 대화선으로 그린다.
async function loadMessages(projectPath = state.project) {
  if (!projectPath) return;
  try {
    const messages = await api("GET", `/api/messages?path=${encodeURIComponent(projectPath)}`);
    if (!samePath(projectPath, state.project)) return;
    state.messages = messages;
  } catch {
    return;
  }
  if (state.view === "project" && state.graph) drawEdges();
}

async function loadCommands(projectPath = state.project) {
  if (!projectPath) return;
  try {
    const { shells, commands } = await api("GET", `/api/commands?path=${encodeURIComponent(projectPath)}`);
    if (!samePath(projectPath, state.project)) return;
    state.shells = shells;
    state.commands = commands;
    state.commandsProject = projectPath;
  } catch {
    return;
  }
  if (state.view === "project") renderGraph();
  if ($("command-dialog").open) renderCommandRun();
}

function commandNodeFoot(c) {
  const running = c.state === "running";
  const run = c.lastRun;
  return running ? `실행 중 · ${firstLine(c.live?.tail?.split(/\r?\n/).at(-1) ?? "") || "출력 기다리는 중"}`
    : run ? `종료 ${run.exitCode}${run.timedOut ? " (시간 초과)" : ""} · ${seconds(run.durationMs)} · ${timeAgo(run.startedAt)}` : "아직 실행하지 않음";
}

function commandNode(c) {
  const running = c.state === "running";
  return el("div", { class: `gcmd ${c.state}`, "data-id": c.id, title: `${c.title}\n${c.command}\n\n누르면 편집, ● 손잡이를 끌어 다음 세션·명령에 잇습니다.` },
    el("div", { class: "gcard-top" },
      el("span", { class: "pill cmd" }, "명령"),
      el("span", { class: "gcmd-shell" }, shellLabel(c.shell)),
      el("span", { class: `pill cmd-${c.state}` }, COMMAND_STATE[c.state] ?? c.state)),
    el("div", { class: "gcard-title" }, c.title),
    el("div", { class: "gcmd-code mono" }, firstLine(c.command)),
    el("div", { class: "gcmd-foot" },
      el("span", { class: "gcmd-result" }, elapsedElement("command", c), el("span", { class: "gcmd-result-text" }, commandNodeFoot(c))),
      el("button", {
        type: "button",
        class: `gcmd-btn${running ? " stop" : ""}`,
        title: running ? "중지" : "지금 실행",
        onclick: () => (running ? stopCommand(c) : runCommand(c)),
      }, running ? "■" : "▶")),
    el("span", { class: "gcard-handle", title: "끌어서 다음 세션이나 명령에 연결" }));
}

async function runCommand(c) {
  try {
    await api("POST", `/api/commands/${c.id}/run`);
  } catch (err) {
    alert(err.message);
  }
  loadCommands();
}

async function stopCommand(c) {
  await api("POST", `/api/commands/${c.id}/stop`).catch((err) => alert(err.message));
  loadCommands();
}

async function removeCommand(c) {
  if (!confirm(`명령 노드 "${c.title}"을(를) 삭제할까요? 이 노드에 이어진 연결도 지웁니다.`)) return;
  try {
    await api("DELETE", `/api/commands/${c.id}`);
  } catch (err) {
    alert(err.message);
  }
  await Promise.all([loadCommands(), loadLinks()]);
}

// cmd가 없으면 새로 만든다. pos는 새 노드를 놓을 자리.
function openCommandDialog(cmd, pos = null, connectFrom = null) {
  if (state.editingCommand) state.editingCommand.cancelled = true;
  state.editingCommand = { id: cmd?.id ?? null, pos, projectPath: state.project, connectFrom };
  const shells = state.shells ?? [{ id: "powershell", label: "PowerShell" }];
  $("command-heading").textContent = cmd ? `명령 ${cmd.title}` : "새 명령";
  $("command-title").value = cmd?.title ?? "";
  $("command-shell").replaceChildren(...shells.map((s) => el("option", { value: s.id }, s.label)));
  $("command-shell").value = cmd?.shell ?? shells[0].id;
  $("command-cwd").value = cmd?.cwdMode ?? "source";
  $("command-timeout").value = cmd?.timeoutSec ?? 600;
  $("command-text").value = cmd?.command ?? "";
  $("command-prompt").value = "";
  $("command-explain").textContent = "";
  $("command-error").textContent = "";
  $("command-delete").hidden = !cmd;
  $("command-run").hidden = !cmd;
  renderCommandRun();
  $("command-dialog").showModal();
}

// 편집 창 아래쪽의 실행 결과(실행 중이면 지금까지의 출력)
function renderCommandRun() {
  const cmd = commandById(state.editingCommand?.id);
  const run = cmd?.lastRun;
  const box = $("command-last");
  if (!cmd || (!run && cmd.state !== "running")) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const running = cmd.state === "running";
  $("command-last-meta").textContent = running
    ? `실행 중 · ${cmd.live?.cwd ?? ""}`
    : `${run.ok ? "성공" : "실패"} · 종료 코드 ${run.exitCode}${run.timedOut ? " (시간 초과)" : ""}${run.stopped ? " (중지함)" : ""} · ${seconds(run.durationMs)} · ${timeAgo(run.startedAt)}${run.originTitle ? ` · ${run.originTitle}에서` : ""}\n${run.cwd}`;
  $("command-last-meta").className = `hint ${running ? "" : run.ok ? "ok-text" : "error"}`;
  $("command-output").textContent = (running ? cmd.live?.tail : run.tail) || "(출력 없음)";
  $("command-run").textContent = running ? "중지" : "지금 실행";
}

// 적은 설명으로 명령을 만든다. 제목이 비어 있으면 제목도 채운다.
$("command-generate").addEventListener("click", async () => {
  const prompt = $("command-prompt").value.trim();
  if (!prompt) return $("command-prompt").focus();
  const button = $("command-generate");
  button.disabled = true;
  button.textContent = "만드는 중…";
  $("command-error").textContent = "";
  $("command-explain").textContent = "";
  try {
    const made = await api("POST", "/api/commands/generate", { projectPath: state.project, prompt, shell: $("command-shell").value });
    $("command-text").value = made.command;
    if (!$("command-title").value.trim()) $("command-title").value = made.title;
    $("command-explain").textContent = made.explanation ? `만든 명령: ${made.explanation} · 실행하기 전에 한번 확인하세요.` : "실행하기 전에 한번 확인하세요.";
  } catch (err) {
    $("command-error").textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "명령 만들기";
  }
});
$("command-prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    $("command-generate").click();
  }
});

$("command-dialog").addEventListener("close", () => {
  if (state.editingCommand) state.editingCommand.cancelled = true;
  state.editingCommand = null;
});

$("command-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  const context = state.editingCommand;
  if (!context || context.cancelled) return;
  const { id, pos, projectPath } = context;
  const cmd = commandById(id);
  if (action === "delete") {
    $("command-dialog").close();
    return removeCommand(cmd);
  }
  if (action === "run") return cmd.state === "running" ? stopCommand(cmd) : runCommand(cmd);
  const body = {
    title: $("command-title").value,
    command: $("command-text").value,
    shell: $("command-shell").value,
    cwdMode: $("command-cwd").value,
    timeoutSec: Number($("command-timeout").value),
  };
  try {
    let created = null;
    if (cmd) await api("PUT", `/api/commands/${cmd.id}`, body);
    else created = await api("POST", "/api/commands", { ...body, projectPath, pos });
    if (state.editingCommand === context) {
      state.editingCommand = null;
      $("command-dialog").close();
    }
    if (created) await connectCreatedGraphNode(context, created.id, projectPath);
    await loadCommands(projectPath);
  } catch (err) {
    $("command-error").textContent = err.message;
  }
});

// ── 스킬 ────────────────────────────────────────────────────────
const skillByName = (name) => (state.skills ?? []).find((k) => k.name === name);

async function loadSkills(projectPath = state.project) {
  if (!projectPath) return;
  try {
    const skills = await api("GET", `/api/skills?path=${encodeURIComponent(projectPath)}`);
    if (!samePath(projectPath, state.project)) return;
    state.skills = skills;
    state.skillsProject = projectPath;
  } catch {
    return;
  }
  $("p-skills").textContent = `스킬 ${state.skills.length}`;
  if (state.view === "project") renderGraph();
  if ($("skills-dialog").open) renderSkillsManager();
}

// 스킬 범위: project(AgentHub 전용) | claude(프로젝트의 .claude/skills, 예전 위치) | personal(~/.claude·~/.agents 두 곳)
const SKILL_SCOPE_LABEL = { project: "스킬", claude: "Claude 스킬", personal: "개인 스킬" };
const SKILL_SCOPE_HINT = {
  project: "이 프로젝트의 .agenthub\\skills에 저장합니다. 흐름 그래프에서 ● 손잡이를 세션 카드에 끌어 놓은 세션만 씁니다(Claude·Codex 모두).",
  claude: "프로젝트의 .claude\\skills에 있는 스킬입니다. Claude는 노드를 잇지 않아도 이 프로젝트에서 저절로 씁니다. 우클릭으로 AgentHub 전용이나 개인으로 옮길 수 있습니다.",
  personal: "~\\.claude\\skills(Claude)와 ~\\.agents\\skills(Codex) 두 곳에 같은 내용으로 저장합니다. 모든 프로젝트에서 노드를 잇지 않아도 두 CLI가 저절로 찾고, 이은 세션에는 한 번 더 알려 줍니다.",
};

function syncSkillScope() {
  const skill = state.editingSkill?.skill;
  const scope = skill?.scope ?? $("skill-scope").value;
  const name = $("skill-name").value.trim() || "<이름>";
  $("skill-scope-hint").textContent = SKILL_SCOPE_HINT[scope];
  $("skill-file").textContent = skill
    ? skill.file
    : scope === "personal"
      ? `~\\.claude\\skills\\${name}\\SKILL.md, ~\\.agents\\skills\\${name}\\SKILL.md`
      : `${state.project}\\.agenthub\\skills\\${name}\\SKILL.md`;
}

// skill이 없으면 새로 만든다. pos는 새 스킬 노드를 놓을 자리.
function openSkillDialog(skill, pos = null) {
  state.editingSkill = { skill, pos };
  $("skill-heading").textContent = skill ? `${SKILL_SCOPE_LABEL[skill.scope] ?? "스킬"} ${skill.name}` : "새 스킬";
  $("skill-name").value = skill?.name ?? "";
  $("skill-name").disabled = !!skill;
  $("skill-scope-row").hidden = !!skill; // 범위는 만들 때 고르고, 바꿀 때는 우클릭의 옮기기를 쓴다.
  $("skill-scope").value = "project";
  $("skill-description").value = skill?.description ?? "";
  $("skill-body").value = skill?.body ?? "";
  // 두 곳의 내용이 다른 개인 스킬은 덮어쓰지 않도록 읽기만 한다.
  const locked = !!skill?.locked;
  $("skill-description").disabled = locked;
  $("skill-body").disabled = locked;
  $("skill-form").querySelector('button[value="ok"]').hidden = locked;
  $("skill-delete").hidden = !skill;
  $("skill-error").textContent = locked ? "~\\.claude와 ~\\.agents에 서로 다른 내용으로 있는 개인 스킬이라 AgentHub에서는 읽기만 합니다." : "";
  syncSkillScope();
  $("skill-dialog").showModal();
}
$("skill-scope").addEventListener("change", syncSkillScope);
$("skill-name").addEventListener("input", syncSkillScope);

$("skill-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  const { skill, pos } = state.editingSkill;
  if (action === "delete") {
    $("skill-dialog").close();
    return removeSkill(skill);
  }
  const body = { projectPath: state.project, description: $("skill-description").value, body: $("skill-body").value };
  try {
    if (skill) await api("PUT", `/api/skills/${skill.name}`, body);
    else await api("POST", "/api/skills", { ...body, name: $("skill-name").value.trim(), scope: $("skill-scope").value, pos });
    $("skill-dialog").close();
    await loadSkills();
  } catch (err) {
    $("skill-error").textContent = err.message;
  }
});

async function removeSkill(skill) {
  const where = skill.scope === "personal"
    ? `~\\.claude\\skills와 ~\\.agents\\skills 두 곳의 "${skill.name}" 폴더를 지웁니다. 다른 프로젝트와 AgentHub 밖의 Claude·Codex에서도 사라집니다.`
    : `${skill.file} 폴더째 지웁니다.`;
  if (!confirm(`스킬 "${skill.name}"을(를) 삭제할까요?\n\n${where}\n이 스킬을 이어 둔 세션에서도 뺍니다.`)) return;
  try {
    await api("DELETE", `/api/skills/${skill.name}?path=${encodeURIComponent(state.project)}`);
  } catch (err) {
    alert(err.message);
  }
  await Promise.all([loadSkills(), loadSessions()]);
}

// 다른 범위로 옮긴다. to: project | personal
async function moveSkill(skill, to) {
  const note = to === "personal"
    ? "개인 스킬로 옮기면 ~\\.claude\\skills와 ~\\.agents\\skills에 두고, 모든 프로젝트에서 Claude·Codex가 저절로 찾습니다."
    : "이 프로젝트의 AgentHub 전용 스킬(.agenthub\\skills)로 옮기면 노드로 이은 세션만 씁니다.";
  if (!confirm(`스킬 "${skill.name}"을(를) 옮길까요?\n\n${note}`)) return;
  try {
    await api("POST", `/api/skills/${skill.name}/move`, { projectPath: state.project, to });
  } catch (err) {
    alert(err.message);
  }
  await Promise.all([loadSkills(), loadSessions()]);
}

// 세션이 쓰는 스킬 목록을 바꾼다.
async function setSessionSkills(sessionId, change) {
  const s = sessionById(sessionId);
  if (!s) return;
  const next = change(s.skills ?? []);
  try {
    await api("PUT", `/api/sessions/${sessionId}`, { skills: next });
  } catch (err) {
    alert(err.message);
  }
  await loadSessions();
  if (state.view === "project") renderGraph();
}

const detachSkill = (sessionId, name) => setSessionSkills(sessionId, (list) => list.filter((n) => n !== name));

// ── 스킬 장착 ───────────────────────────────────────────────────
// 세션 카드의 스킬 칩. 누르면 장착할 스킬을 고른다. 칩은 3개까지 보이고 나머지는 +n으로 줄인다.
function skillChips(s) {
  const names = s.skills ?? [];
  const chip = (name) => el("span", { class: `skill-chip ${skillByName(name)?.scope ?? "missing"}` }, name);
  return el("div", {
    class: "gcard-skills",
    title: names.length ? `장착한 스킬: ${names.join(", ")}\n누르면 바꿉니다` : "누르면 스킬을 장착합니다",
    onclick: () => openEquipDialog(s),
  },
  ...names.slice(0, 3).map(chip),
  names.length > 3 ? el("span", { class: "skill-chip more" }, `+${names.length - 3}`) : null,
  names.length ? null : el("span", { class: "skill-chip add" }, "+ 스킬"));
}

// 사이드바에서 우클릭해 열 수도 있으므로 보고 있는 프로젝트와 상관없이 그 세션의 프로젝트 스킬을 읽는다.
async function openEquipDialog(s) {
  let skills;
  try {
    skills = await api("GET", `/api/skills?path=${encodeURIComponent(s.projectPath)}`);
  } catch (err) {
    return alert(err.message);
  }
  state.equipping = s;
  const on = new Set(s.skills ?? []);
  $("equip-session").textContent = s.title;
  $("equip-error").textContent = "";
  const groups = ["project", "claude", "personal"]
    .map((scope) => [scope, skills.filter((k) => (k.scope ?? "project") === scope)])
    .filter(([, list]) => list.length);
  $("equip-list").replaceChildren(
    ...groups.map(([scope, list]) => el("fieldset", { class: "equip-group" },
      el("legend", {}, SKILL_GROUP_LABEL[scope]),
      ...list.map((k) => {
        const box = el("input", { type: "checkbox", value: k.name });
        box.checked = on.has(k.name);
        return el("label", { class: "check equip-item", title: k.file }, box,
          el("span", { class: "equip-name mono" }, k.name),
          el("span", { class: "muted" }, k.description));
      }))),
    skills.length ? null : el("p", { class: "hint" }, "아직 스킬이 없습니다. '스킬 관리'에서 만드세요."));
  $("equip-dialog").showModal();
}

const SKILL_GROUP_LABEL = { project: "이 프로젝트 (AgentHub 전용)", claude: "Claude 프로젝트 스킬 (.claude/skills)", personal: "개인 스킬 (모든 프로젝트)" };

$("equip-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  if (action === "manage") {
    $("equip-dialog").close();
    return openSkillsManager();
  }
  const names = [...$("equip-list").querySelectorAll("input:checked")].map((b) => b.value);
  await setSessionSkills(state.equipping.id, () => names);
  $("equip-dialog").close();
});

// ── 스킬 관리 ───────────────────────────────────────────────────
// 만들기·편집·옮기기·삭제. 스킬에 마우스를 올리면 그 스킬을 장착한 카드를 강조한다.
async function openSkillsManager() {
  await loadSkills();
  renderSkillsManager();
  if (!$("skills-dialog").open) $("skills-dialog").showModal();
}

function renderSkillsManager() {
  const skills = state.skills ?? [];
  const usedBy = (name) => state.sessions.filter((s) => samePath(s.projectPath, state.project) && s.skills?.includes(name));
  const highlight = (name) => {
    const ids = new Set(name ? usedBy(name).map((s) => s.id) : []);
    for (const [id, card] of state.graph?.cards ?? []) card.classList.toggle("skill-hit", ids.has(id));
  };
  $("skills-list").replaceChildren(
    ...skills.map((k) => {
      const using = usedBy(k.name);
      const scope = k.scope ?? "project";
      const button = (label, action, cls = "ghost sm") => el("button", { type: "button", class: cls, onclick: action }, label);
      return el("div", { class: "skills-row", onmouseenter: () => highlight(k.name), onmouseleave: () => highlight(null) },
        el("span", { class: `skill-chip ${scope}` }, SKILL_SCOPE_LABEL[scope]),
        el("div", { class: "skills-main" },
          el("div", {}, el("b", { class: "mono" }, k.name), k.locked ? el("span", { class: "muted" }, " · 읽기 전용") : null),
          el("div", { class: "muted", title: k.file }, k.description)),
        el("span", { class: "muted skills-used", title: using.map((s) => s.title).join("\n") }, using.length ? `세션 ${using.length}` : "장착 없음"),
        el("div", { class: "skills-actions" },
          button(k.locked ? "보기" : "편집", () => openSkillDialog(k)),
          scope !== "project" && !k.locked ? button("프로젝트로", () => moveSkill(k, "project")) : null,
          scope !== "personal" ? button("개인으로", () => moveSkill(k, "personal")) : null,
          using.length ? button("장착 해제", () => detachSkillEverywhere(k.name)) : null,
          button("삭제", () => removeSkill(k), "ghost sm danger")));
    }),
    skills.length ? null : el("p", { class: "hint" }, "스킬이 없습니다. '새 스킬'로 만드세요."));
}

$("skills-new").addEventListener("click", () => openSkillDialog(null));
$("p-skills").addEventListener("click", () => openSkillsManager());

// ── 공유 노트 ───────────────────────────────────────────────────
// 세션들이 MCP 도구로 덧붙이는 프로젝트 메모. 열어 둔 동안 세션이 덧붙이면 다시 받는다(고치던 중이면 그대로 둔다).
async function loadBoard() {
  const projectPath = state.boardProject;
  try {
    const { text } = await api("GET", `/api/board?path=${encodeURIComponent(projectPath)}`);
    if (!samePath(projectPath, state.boardProject) || state.boardDirty) return;
    $("board-text").value = text;
  } catch (err) {
    $("board-error").textContent = err.message;
  }
}

$("p-board").addEventListener("click", async () => {
  const p = currentProject();
  if (!p) return;
  state.boardProject = p.path;
  state.boardDirty = false;
  $("board-project").textContent = p.name;
  $("board-text").value = "";
  $("board-error").textContent = "";
  $("board-dialog").showModal();
  await loadBoard();
});
$("board-text").addEventListener("input", () => { state.boardDirty = true; });

$("board-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  if (action === "clear" && !confirm("공유 노트를 모두 지울까요?")) return;
  try {
    const text = action === "clear" ? "" : $("board-text").value;
    await api("PUT", "/api/board", { path: state.boardProject, text });
    $("board-dialog").close();
  } catch (err) {
    $("board-error").textContent = err.message;
  }
});
$("skills-dialog").addEventListener("close", () => {
  for (const card of state.graph?.cards.values() ?? []) card.classList.remove("skill-hit");
});

async function detachSkillEverywhere(name) {
  const using = state.sessions.filter((s) => samePath(s.projectPath, state.project) && s.skills?.includes(name));
  for (const s of using) await detachSkill(s.id, name);
  if ($("skills-dialog").open) renderSkillsManager();
}

function placeCards() {
  const g = state.graph;
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
  const g = state.graph;
  if (!g?.size) return;
  g.canvas.style.transform = g.zoom === 1 ? "" : `scale(${g.zoom})`;
  g.canvas.style.left = `${g.pan.x}px`;
  g.canvas.style.top = `${g.pan.y}px`;
  g.sizer.style.width = `${g.size.width * g.zoom}px`;
  g.sizer.style.height = `${g.size.height * g.zoom}px`;
}

function renderZoomLabel() {
  const z = state.graph?.zoom ?? 1;
  $("p-zoom-reset").textContent = `${Math.round(z * 100)}%`;
  $("p-zoom-out").disabled = z <= ZOOM_MIN;
  $("p-zoom-in").disabled = z >= ZOOM_MAX;
}

// anchor(clientX·clientY)가 가리키는 지점이 그 자리에 머물도록 배율을 바꾼다. 없으면 보이는 칸의 가운데를 기준으로 한다.
function setGraphZoom(zoom, anchor = null) {
  const g = state.graph;
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
  saveGraphZoom(state.project, next);
  applyGraphZoom();
  renderZoomLabel();
}

// 모든 카드가 보이게 맞춘다. 작으면 키우지 않는다(100%까지).
function fitGraph() {
  const g = state.graph;
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

$("p-zoom-in").addEventListener("click", () => setGraphZoom((state.graph?.zoom ?? 1) * 1.2));
$("p-zoom-out").addEventListener("click", () => setGraphZoom((state.graph?.zoom ?? 1) / 1.2));
$("p-zoom-reset").addEventListener("click", () => setGraphZoom(1));
$("p-zoom-fit").addEventListener("click", fitGraph);

// 휠로 커서 자리를 기준으로 확대·축소한다(터치패드 오므리기·벌리기도 포함).
$("p-graph").addEventListener("wheel", (e) => {
  if (!state.graph?.canvas.isConnected) return;
  e.preventDefault();
  if (state.graph.dragging) return;
  const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? $("p-graph").clientHeight : 1);
  setGraphZoom((state.graph.zoom ?? 1) * Math.exp(-delta * 0.0015), e);
}, { passive: false });

// sa·sb: 양 끝 노드 크기
function edgePath(a, b, sa = CARD_SIZE, sb = CARD_SIZE) {
  const x1 = a.x + sa.w;
  const y1 = a.y + sa.h / 2;
  const x2 = b.x;
  const y2 = b.y + sb.h / 2;
  if (x2 < x1) {
    // 되돌아가는 연결은 카드 아래쪽끼리 잇는다.
    const sx = a.x + sa.w / 2;
    const tx = b.x + sb.w / 2;
    const sy = a.y + sa.h;
    const ty = b.y + sb.h;
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
  // 메시지를 주고받은 세션 사이의 대화선(방향 없이 한 줄, 주고받은 수를 툴팁으로)
  const talks = new Map();
  for (const m of state.messages) {
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
  const rect = state.graph.canvas.getBoundingClientRect();
  const zoom = state.graph.zoom ?? 1;
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
  state.graphGesture?.cancel();
  const g = state.graph;
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
    openLinkDialog(state.links.find((l) => l.id === label.dataset.link));
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
  const group = !connecting && state.graphSelected.has(id) ? [...state.graphSelected].filter((n) => g.pos.has(n)) : [id];
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
      if (state.graph === g && g.canvas.isConnected) placeCards();
      return;
    }
    if (state.graph !== g || !g.canvas.isConnected) return;
    if (!moved) {
      // 누르면 선택만 한다(열기는 두 번 누르기). Ctrl·Shift를 누르고 누르면 선택에 더하거나 뺀다.
      if (connecting) return;
      if (additive) {
        if (state.graphSelected.has(id)) state.graphSelected.delete(id);
        else state.graphSelected.add(id);
      } else {
        state.graphSelected = new Set([id]);
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
  const g = state.graph;
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
  const p = state.graph?.pos.get(id);
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
  const g = state.graph;
  if (!g) return;
  for (const id of state.graphSelected) if (!g.cards.has(id)) state.graphSelected.delete(id);
  for (const [id, card] of g.cards) card.classList.toggle("selected", state.graphSelected.has(id));
}

// 빈 곳에서 끌면 상자 안에 걸친 카드를 고른다. Ctrl·Shift를 누르고 끌면 지금 선택에 더한다.
// 끌지 않고 빈 곳을 누르기만 하면 선택을 푼다.
function startBoxSelect(e) {
  const g = state.graph;
  if (!g) return;
  e.preventDefault();
  const start = canvasPoint(e);
  const before = new Set(state.graphSelected);
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
    state.graphSelected = picked;
    syncGraphSelection();
  };

  const onUp = (_ev, cancelled) => {
    g.dragging = false;
    g.canvas.classList.remove("selecting");
    box?.remove();
    if (cancelled) state.graphSelected = before;
    else if (!box) state.graphSelected = base;
    syncGraphSelection();
  };

  trackGraphGesture(e, onMove, onUp);
}

// 전체에 한 번만 확인한다. 작업 폴더와 원본 CLI 기록은 개별 삭제 메뉴에서 관리한다.
async function deleteGraphSelection() {
  if (state.deletingGraphNodes || state.view !== "project") return;
  const projectPath = state.project;
  const nodes = [...state.graphSelected].map((id) =>
    state.sessions.find((s) => s.id === id && samePath(s.projectPath, projectPath)) ??
    (samePath(state.commandsProject, projectPath) ? commandById(id) : null)).filter(Boolean);
  if (!nodes.length) return;
  const running = nodes.filter((n) => n.state === "running").length;
  if (!confirm(`선택한 노드 ${nodes.length}개와 이어진 연결을 삭제할까요?${running ? `\n실행 중인 ${running}개는 멈춥니다.` : ""}\n세션의 작업 폴더와 원본 CLI 기록은 남겨 둡니다.`)) return;
  state.deletingGraphNodes = true;
  closeContextMenu();
  try {
    const results = await Promise.allSettled(nodes.map((node) =>
      api("DELETE", isCommandNode(node.id) ? `/api/commands/${node.id}` : `/api/sessions/${node.id}?force=1`)));
    const errors = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") state.graphSelected.delete(nodes[i].id);
      else errors.push(`${nodes[i].title}: ${result.reason.message}`);
    });
    await Promise.all([loadSessions(), loadCommands(projectPath), loadLinks()]);
    if (errors.length) alert(`일부 노드를 삭제하지 못했습니다.\n\n${errors.join("\n")}`);
  } finally {
    state.deletingGraphNodes = false;
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
  const placed = state.sessions.filter((s) => samePath(s.projectPath, state.project) && s.graphPos);
  for (const s of placed) s.graphPos = null;
  const placedCommands = (state.commands ?? []).filter((c) => c.pos);
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
  select.replaceChildren(...(state.status?.linkConditions ?? []).map((c) => el("option", { value: c.id }, c.label)));
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
  const used = new Set(state.links.filter((l) => l.from === from && l.when === "keyword")
    .flatMap((l) => l.keyword.split(/[,，]/).map((k) => k.trim())));
  const keyword = keywordSuggestions(from).find((k) => !used.has(k));
  return keyword ? { when: "keyword", keyword } : { when: "success", keyword: "" };
}

// link가 없으면 from → to 새 연결을 만든다.
function openLinkDialog(link, from = link?.from, to = link?.to) {
  state.editingLink = { link, from, to };
  $("link-names").textContent = `${nodeTitle(from)} → ${nodeTitle(to)}`;
  const initial = link ?? defaultLinkCondition(from);
  $("link-when").value = initial.when;
  $("link-keyword").value = initial.keyword ?? "";
  // 키워드 후보를 누르면 키워드 칸에 넣는다.
  $("link-keyword-chips").replaceChildren(...keywordSuggestions(from).map((k) =>
    el("button", { type: "button", class: "flow-chip", onclick: () => { $("link-keyword").value = k; } }, k)));
  // 같은 세션에서 나가는 다른 연결을 보여 주어 분기 전체를 한눈에 보게 한다.
  const siblings = state.links.filter((l) => l.from === from && l.id !== link?.id);
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
  const { link, from, to } = state.editingLink;
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

  renderEvents($("s-events"), s.events);
  scrollToBottom();
}

function renderState() {
  const s = state.current;
  if (state.view === "chat") return renderChatState();
  const label = $("s-state");
  label.textContent = STATE_LABEL[s.state] ?? s.state;
  label.className = `pill ${s.state}`;
  renderSessionElapsed("s", s);
  const running = s.state === "running";
  $("s-stop").disabled = !running && s.state !== "paused";
  // 도구 호출의 "실행 중" 표시는 턴이 도는 동안에만 보인다.
  $("s-events").classList.toggle("running", running);
  $("s-restart").disabled = running || !s.agentSessionId;
  renderLife("s-life", s);
  renderComposer("s", s);
}

// ── 실행 중에 보내기 ────────────────────────────────────────────
// 실행 중에 보낸 요청은 항상 대기열에 넣고, 끝나면 차례로 보낸다.
// Claude는 대기열 항목의 "붙이기"로 지금 작업에 끼워 넣을 수 있다(CLI가 다음 도구 실행 사이에 읽는다).
function composerMode(s) {
  return s?.state === "running" ? "queue" : "send";
}

const composerBusy = new Set();

function renderComposerAction(prefix, s) {
  const action = composerAction(s, $(prefix + "-prompt").value);
  const send = $(prefix + "-send");
  send.disabled = action.disabled || composerBusy.has(prefix);
  send.value = action.action;
  send.dataset.action = action.action;
  send.replaceChildren(el("span", { class: "composer-icon", "aria-hidden": "true" }, action.icon), el("span", {}, action.label));
  send.title = action.title;
  send.setAttribute("aria-label", action.label);
  send.setAttribute("aria-busy", String(composerBusy.has(prefix)));
}

function renderComposer(prefix, s) {
  const running = s?.state === "running";
  renderComposerAction(prefix, s);
  $(prefix + "-prompt").placeholder = running
    ? "작업 중 · 입력 후 Enter 대기열에 추가, 입력을 비우면 ⏸ 일시중지"
    : s?.state === "paused"
      ? "일시중지됨 · ▶ 재개 또는 요청을 입력해 이어서 진행"
      : (prefix === "c" ? "메시지를 입력하세요" : "요청을 입력하세요") + " · Enter 보내기, Shift+Enter 줄바꿈";
  renderQueue(prefix, s);
}

// 끝나면 보낼 요청 목록. 지금 작업에 붙이거나, 실행 중이 아니면 바로 보내거나, 지울 수 있다.
function renderQueue(prefix, s) {
  const items = s?.queue ?? [];
  const running = s?.state === "running";
  const act = async (item, action) => {
    try {
      if (action === "delete") await api("DELETE", `/api/sessions/${s.id}/queue/${item.id}`);
      else await api("POST", `/api/sessions/${s.id}/queue/${item.id}`, { action });
    } catch (err) {
      alert(err.message);
    }
    refreshQueue(s.id);
  };
  $(`${prefix}-queue`).hidden = !items.length;
  $(`${prefix}-queue`).replaceChildren(...items.map((item) => el("li", { class: "queue-item" },
    el("span", { class: "queue-tag" }, item.user ? "대기" : `↳ ${item.fromTitle ?? "넘어온 작업"}`),
    el("span", { class: "queue-text", title: item.text }, firstLine(item.text)),
    running && s.canInject && item.user ? el("button", { type: "button", class: "ghost sm", title: "지금 하는 작업에 이 요청을 붙입니다", onclick: () => act(item, "steer") }, "붙이기") : null,
    running ? null : el("button", { type: "button", class: "ghost sm", onclick: () => act(item, "send") }, "보내기"),
    el("button", { type: "button", class: "ghost sm danger", title: "대기열에서 지우기", onclick: () => act(item, "delete") }, "×"))));
}

async function refreshQueue(sessionId) {
  if (state.current?.id !== sessionId) return;
  try {
    const { queue } = await api("GET", `/api/sessions/${sessionId}`);
    if (state.current?.id !== sessionId) return;
    state.current.queue = queue;
  } catch {
    return;
  }
  renderComposer(state.view === "chat" ? "c" : "s", state.current);
}

// Enter: 보내기(실행 중이면 대기열에 추가), Shift+Enter: 줄바꿈. 한글 조합 중인 키는 무시한다.
function composerKeys(prefix) {
  $(prefix + "-prompt").addEventListener("input", () => renderComposerAction(prefix, state.current));
  $(prefix + "-prompt").addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // 빈 Enter는 작업을 멈추거나 재개하지 않는다. 제어는 버튼·Esc로만 한다.
      if (!$(prefix + "-prompt").value.trim() || $(prefix + "-send").disabled) return;
      $(prefix + "-form").requestSubmit($(prefix + "-send"));
    }
  });
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
          el("span", { class: "muted" }, [x.roleName && `역할 ${x.roleName}`, x.permission, x.isolate ? `워크트리 ${x.worktreeName}` : "원본 폴더"].filter(Boolean).join(" · "))))),
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

// ── 에이전트의 질문 ─────────────────────────────────────────────
const QUESTION_FENCE = "agenthub-question";
const QUESTION_BLOCK = new RegExp("```" + QUESTION_FENCE + "\\s*\\n[\\s\\S]*?```", "g");
// 메시지 블록은 보낸 메시지 줄로 따로 보여 주므로 답변 본문에서 뺀다(서버의 messages.mjs와 같다).
const MESSAGE_FENCE = "agenthub-message";
const MESSAGE_BLOCK = new RegExp("```" + MESSAGE_FENCE + "\\s*\\n[\\s\\S]*?```", "g");
const MESSAGE_VIA = { answer: "답을 기다리던 상대에게 전달", live: "작업 중에 전달", queue: "대기열로 전달" };
const QUESTION_STATUS = { pending: "답을 기다림", answered: "답함", skipped: "지나감", invalid: "형식 오류" };

// 선택지를 고르거나 직접 적어 답한다. 답은 다음 요청으로 에이전트에게 간다.
function renderQuestion(ev) {
  const s = state.current;
  const pending = ev.status === "pending";
  const node = el("li", { class: `ev question ${ev.status}` },
    el("div", { class: "plan-head" }, el("b", {}, "질문"), el("span", { class: `pill q-${ev.status}` }, QUESTION_STATUS[ev.status] ?? ev.status)),
    ev.error ? el("div", { class: "plan-error" }, ev.error) : null);
  if (!ev.questions) return node;
  // 답했거나 지나간 질문은 버튼 없이 질문과 고른 답만 글로 남긴다.
  if (!pending) {
    ev.questions.forEach((q, i) => {
      const a = ev.answers?.[i];
      const answer = [...(a?.selected ?? []), a?.text].filter(Boolean).join(", ");
      node.append(el("div", { class: "q-item done" },
        el("div", { class: "q-question" }, q.header ? el("span", { class: "q-header" }, q.header) : null, q.question),
        el("div", { class: "q-answer" }, answer ? `→ ${answer}` : el("span", { class: "muted" }, "답하지 않음"))));
    });
    return node;
  }

  const picks = ev.questions.map((_, i) => new Set(ev.answers?.[i]?.selected ?? []));
  const texts = [];
  const submit = async (button) => {
    const answers = ev.questions.map((_, i) => ({ selected: [...picks[i]], text: texts[i].value.trim() }));
    if (!answers.some((a) => a.selected.length || a.text)) return alert("답을 고르거나 적으세요.");
    button.disabled = true;
    try {
      await api("POST", `/api/sessions/${s.id}/questions/${ev.questionId}`, { answers });
    } catch (err) {
      alert(err.message);
      button.disabled = false;
    }
  };

  ev.questions.forEach((q, i) => {
    const group = el("div", { class: "q-options" });
    for (const o of q.options) {
      const attrs = { type: "button", class: `q-option${picks[i].has(o.label) ? " picked" : ""}`, "data-label": o.label };
      if (!pending) attrs.disabled = "";
      group.append(el("button", {
        ...attrs,
        onclick: () => {
          const on = !picks[i].has(o.label);
          if (!q.multiSelect) picks[i].clear();
          if (on) picks[i].add(o.label);
          else picks[i].delete(o.label);
          for (const b of group.children) b.classList.toggle("picked", picks[i].has(b.dataset.label));
        },
      }, el("b", {}, o.label), o.description ? el("span", { class: "muted" }, o.description) : null));
    }
    const textAttrs = { class: "q-text", placeholder: pending ? "직접 답 적기 · Enter로 답하기" : "" };
    if (!pending) textAttrs.disabled = "";
    const text = el("input", textAttrs);
    text.value = ev.answers?.[i]?.text ?? "";
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) node.querySelector(".q-submit")?.click();
    });
    texts.push(text);
    node.append(el("div", { class: "q-item" },
      el("div", { class: "q-question" }, q.header ? el("span", { class: "q-header" }, q.header) : null, q.question,
        q.multiSelect ? el("span", { class: "muted" }, " (여러 개 고를 수 있음)") : null),
      q.options.length ? group : null,
      text));
  });
  if (pending) {
    node.append(el("div", { class: "plan-actions" },
      el("button", { class: "primary sm q-submit", onclick: (e) => submit(e.currentTarget) }, "답하기")));
  }
  return node;
}

// 실행 중에 CLI가 묻는 권한 요청. 답할 때까지 CLI가 기다린다.
const PERMISSION_STATUS = { pending: "허용을 기다림", allowed: "허용함", denied: "거절함", skipped: "지나감" };

function renderPermission(ev) {
  const s = state.current;
  const decide = async (decision, button) => {
    let message;
    if (decision === "deny") {
      message = prompt("거절 이유나 대신 할 일 (비워 두어도 됩니다)");
      if (message === null) return;
    }
    for (const b of button.parentElement.children) b.disabled = true;
    try {
      await api("POST", `/api/sessions/${s.id}/permissions/${ev.requestId}`, { decision, message });
    } catch (err) {
      alert(err.message);
      for (const b of button.parentElement.children) b.disabled = false;
    }
  };
  const label = ev.status === "allowed" && ev.decision === "always" ? "항상 허용함" : PERMISSION_STATUS[ev.status] ?? ev.status;
  const node = el("li", { class: `ev permission ${ev.status}` },
    el("div", { class: "plan-head" }, el("b", {}, "권한 요청"), el("span", { class: `pill p-${ev.status}` }, label)),
    el("div", { class: "perm-tool mono" }, ev.text),
    ev.reason ? el("div", { class: "muted" }, ev.reason) : null,
    ev.detail ? el("details", {}, el("summary", {}, "자세히"), el("pre", { class: "perm-detail" }, ev.detail)) : null);
  if (ev.status === "pending") {
    node.append(el("div", { class: "plan-actions" },
      el("button", { class: "primary sm", onclick: (e) => decide("allow", e.currentTarget) }, "허용"),
      ev.canRemember ? el("button", { class: "ghost sm", title: "이 프로젝트에서 같은 종류의 요청은 다시 묻지 않습니다", onclick: (e) => decide("always", e.currentTarget) }, "항상 허용") : null,
      el("button", { class: "ghost sm danger", onclick: (e) => decide("deny", e.currentTarget) }, "거절")));
  }
  return node;
}

// 다른 창을 보고 있거나 다른 세션을 열어 둔 사이에 온 질문·권한 요청은 알림으로 알린다.
function notifyQuestion(sessionId, event) {
  const seeing = state.current?.id === sessionId && document.hasFocus();
  if (seeing || !("Notification" in window)) return;
  const s = sessionById(sessionId);
  const permission = event.kind === "permission";
  const show = () => {
    const n = new Notification(`${s?.title ?? "세션"}에서 ${permission ? "허용을 기다립니다" : "질문이 왔습니다"}`, {
      body: permission ? event.text : event.questions?.[0]?.question ?? "",
      tag: `q-${event.questionId ?? event.requestId}`,
    });
    n.onclick = () => {
      window.focus();
      selectSession(sessionId);
    };
  };
  if (Notification.permission === "granted") show();
  else if (Notification.permission !== "denied") Notification.requestPermission().then((p) => p === "granted" && show());
}

// ── 도구 호출 ───────────────────────────────────────────────────
// 도구 호출(명령 실행, 파일 읽기 등)은 한 줄로 접어 두고, 누르면 입력과 출력을 펼친다.
// 결과(tool_result)는 아직 결과가 없는 가장 앞의 도구 호출에 붙인다(CLI가 호출한 순서대로 결과를 보낸다).
const EXPAND_TOOLS_KEY = "agenthub-expand-tools";
const expandTools = () => localStorage.getItem(EXPAND_TOOLS_KEY) === "1";

function renderTool(ev, cls) {
  const body = el("div", { class: "tool-body" });
  if (ev.detail) body.append(el("div", { class: "tool-label" }, "입력"), el("pre", { class: "tool-input" }, ev.detail));
  const details = el("details", {},
    el("summary", {}, el("span", { class: "tool-name" }, ev.text ?? ""), el("span", { class: "tool-state" })),
    body);
  details.open = expandTools();
  return el("li", { class: `${cls} pending`, title: ev.text ?? "" }, details);
}

// 결과를 붙일 도구 호출이 있으면 붙이고 true
function attachToolResult(list, ev) {
  const tool = list.querySelector("li.ev.tool.pending");
  if (!tool) return false;
  tool.classList.remove("pending");
  tool.classList.add(ev.isError ? "failed" : "done");
  const text = ev.text ?? "";
  const lines = text ? text.split("\n").length : 0;
  tool.querySelector(".tool-state").textContent = ev.isError ? "오류" : lines ? `${lines}줄` : "";
  tool.querySelector(".tool-body").append(el("div", { class: "tool-label" }, "출력"),
    el("pre", { class: `tool-output${ev.isError ? " is-error" : ""}` }, text || "(출력 없음)"));
  return true;
}

function appendEvent(list, ev) {
  if (ev.kind === "tool_result" && attachToolResult(list, ev)) return;
  list.append(renderEvent(ev));
}

function renderEvents(list, events) {
  list.replaceChildren();
  for (const ev of events) appendEvent(list, ev);
}

$("s-expand-tools").checked = expandTools();
$("s-expand-tools").addEventListener("change", (e) => {
  localStorage.setItem(EXPAND_TOOLS_KEY, e.target.checked ? "1" : "0");
  for (const d of document.querySelectorAll(".events li.ev.tool > details")) d.open = e.target.checked;
});

function renderEvent(ev) {
  const cls = `ev ${ev.kind}${ev.isError ? " is-error" : ""}${ev.injected ? " injected" : ""}`;
  if (ev.kind === "tool") return renderTool(ev, cls);
  if (ev.kind === "plan") return renderPlan(ev);
  if (ev.kind === "question") return renderQuestion(ev);
  if (ev.kind === "permission") return renderPermission(ev);
  // 질문 블록은 아래 질문 카드로 보여 주므로 답변 본문에서는 뺀다.
  if (ev.kind === "text") {
    // 에이전트 답변은 마크다운으로 보여 준다(renderMarkdown이 원문을 이스케이프한다).
    const text = (ev.text ?? "").replace(QUESTION_BLOCK, "").replace(MESSAGE_BLOCK, "").trim();
    if (!text) return el("li", { class: "ev hidden-empty", hidden: true });
    const node = el("li", { class: `${cls} md` });
    node.innerHTML = renderMarkdown(text);
    return node;
  }
  if (ev.kind === "message") {
    // 이 세션이 다른 세션에 보낸 메시지
    return el("li", { class: `${cls} handoff` },
      el("details", {},
        el("summary", {}, "✉ ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); if (sessionById(ev.to)) selectSession(ev.to); } }, ev.toTitle),
          `에게 보낸 메시지 · ${MESSAGE_VIA[ev.via] ?? ""}`),
        el("div", { class: "handoff-body" }, ev.text)));
  }
  if (ev.kind === "user" && ev.from) {
    // 연결된 세션에서 넘어온 요청은 접어서 보여 준다.
    const open = (e) => {
      e.preventDefault();
      if (sessionById(ev.from)) selectSession(ev.from);
    };
    return el("li", { class: `${cls} handoff` },
      el("details", {},
        el("summary", {}, el("a", { href: "#", onclick: open }, `${ev.message || ev.reply ? "✉" : "↳"} ${ev.fromTitle}`),
          ev.reply ? "에게서 온 답" : ev.message ? "에게서 온 메시지" : "에서 넘어온 작업"),
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
  const input = $("s-prompt");
  const raw = input.value;
  const prompt = raw.trim();
  const s = state.current;
  if (!s || composerBusy.has("s")) return;
  const action = composerAction(s, raw).action;
  if (action === "pause" || action === "resume") return togglePause();
  if (!prompt) return;
  composerBusy.add("s");
  renderComposerAction("s", s);
  try {
    const result = await api("POST", "/api/sessions/" + s.id + "/messages", { prompt, mode: composerMode(s) });
    if (state.current?.id === s.id && input.value === raw) input.value = "";
    if (result.queued) refreshQueue(s.id);
  } catch (err) {
    alert(err.message);
  } finally {
    composerBusy.delete("s");
    if (state.view === "session") renderComposer("s", state.current);
  }
});
composerKeys("s");

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

// 일시중지·재개. 일시중지는 대화를 그대로 두고 멈추며, 재개하면 멈춘 곳부터 이어서 진행한다.
async function togglePause() {
  const s = state.current;
  const prefix = state.view === "chat" ? "c" : "s";
  if (!s || composerBusy.has(prefix)) return;
  composerBusy.add(prefix);
  renderComposerAction(prefix, s);
  try {
    const before = s.state;
    const action = before === "paused" ? "resume" : "pause";
    const updated = await api("POST", "/api/sessions/" + s.id + "/" + action);
    // 실시간 이벤트가 먼저 도착했다면 오래된 응답으로 상태를 되돌리지 않는다.
    if (s.state === before) {
      delete s.paused;
      delete s.pausedMidTurn;
      Object.assign(s, updated);
    }
    if (action === "resume" && state.current?.id === s.id) {
      delete state.current.paused;
      delete state.current.pausedMidTurn;
    }
  } catch (err) {
    alert(err.message);
  } finally {
    composerBusy.delete(prefix);
    if (state.current?.id === s.id) renderState();
  }
}

// CLI 대화만 새로 시작한다. 화면이 새로 그려지는 것은 서버가 보내는 session 이벤트로 한다.
// s: 다시 시작할 세션(흐름 그래프 카드에서 누르면 그 카드의 세션, 아니면 보고 있는 세션)
async function restartSession(s = state.current) {
  if (!s) return;
  const kept = s.chat ? "화면의 기록은 남지만" : "AgentHub 기록·역할·연결은 그대로 남지만";
  if (!confirm(`"${s.title}"을(를) 다시 시작할까요?\n\nCLI 대화를 새로 시작해 컨텍스트를 비웁니다. ${kept}, AI는 이전 대화 내용을 기억하지 못합니다.`)) return;
  try {
    await api("POST", `/api/sessions/${s.id}/restart`);
  } catch (err) {
    alert(err.message);
  }
}
$("s-restart").addEventListener("click", () => restartSession());

$("s-delete").addEventListener("click", async () => {
  const s = state.current;
  const options = askDeleteOptions(s);
  if (!options || !(await deleteSession(s, options))) return;
  if (POPUP) return window.close(); // 별도 창은 보여 줄 세션이 없어졌으니 닫는다.
  await loadSessions();
  if (s.projectPath) await goProject(s.projectPath);
  else goDashboard();
});

// ── 세션 우클릭 메뉴 ────────────────────────────────────────────
// 흐름 그래프 카드와 사이드바 세션 목록에서 쓴다.
function closeContextMenu() {
  document.querySelector(".context-menu")?.remove();
}

function openSessionMenu(e, s) {
  e.preventDefault();
  closeContextMenu();
  const running = s.state === "running";
  const item = (label, action, { danger = false, disabled = false, title = "" } = {}) => el("button", {
    type: "button",
    class: `menu-item${danger ? " danger" : ""}`,
    title,
    ...(disabled ? { disabled: "" } : {}),
    onclick: () => {
      closeContextMenu();
      action();
    },
  }, label);
  const menu = el("div", { class: "context-menu", role: "menu" },
    el("div", { class: "menu-title" }, s.title),
    item("열기", () => selectSession(s.id)),
    item("새 창으로 열기", () => openSessionWindow(s.id)),
    item("다시 시작", () => restartSession(s), {
      disabled: running, title: "CLI 대화만 새로 시작해 컨텍스트를 비웁니다. 화면 기록·역할·연결은 그대로 둡니다.",
    }),
    item("재생성", () => recreateSession(s), {
      disabled: running, title: "같은 설정(역할·모델·권한·연결)으로 새 세션을 만들고 지금 세션은 지웁니다. 화면 기록도 비워집니다.",
    }),
    s.chat ? null : item("스킬 장착…", () => openEquipDialog(s)),
    el("hr"),
    item("삭제", () => confirmDeleteSession(s), { danger: true }));
  document.body.append(menu);
  // 화면 밖으로 나가지 않게 놓는다.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - height - 8)}px`;
}

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".context-menu")) closeContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const hadMenu = !!document.querySelector(".context-menu");
  closeContextMenu();
  // Claude Code·Codex처럼 Esc로 실행 중인 세션을 일시중지한다(대화상자·메뉴가 열려 있으면 그것만 닫는다).
  if (hadMenu || e.defaultPrevented || document.querySelector("dialog[open]")) return;
  if (["session", "chat"].includes(state.view) && state.current?.state === "running") {
    e.preventDefault();
    togglePause();
  }
  // 프로젝트 화면에서는 그래프 선택을 푼다.
  if (state.view === "project" && state.graphSelected.size) {
    state.graphSelected = new Set();
    syncGraphSelection();
  }
});
window.addEventListener("blur", closeContextMenu);
window.addEventListener("resize", closeContextMenu);

async function recreateSession(s) {
  const folder = s.worktree ? `\n작업 폴더(${s.cwd})는 그대로 이어받습니다.` : "";
  if (!confirm(`"${s.title}"을(를) 재생성할까요?\n\n같은 역할·모델·권한·연결로 새 세션을 만들고 지금 세션은 지웁니다. 화면 기록과 CLI 대화는 새로 시작합니다.${folder}`)) return;
  try {
    const created = await api("POST", `/api/sessions/${s.id}/recreate`);
    await Promise.all([loadSessions(), loadLinks()]);
    if (state.current?.id === s.id) await selectSession(created.id);
  } catch (err) {
    alert(err.message);
  }
}

// 확인을 받고 지운다. 보고 있던 세션이면 프로젝트(또는 채팅·대시보드) 화면으로 돌아간다.
async function confirmDeleteSession(s) {
  const options = askDeleteOptions(s);
  if (!options || !(await deleteSession(s, options))) return;
  await loadSessions();
  if (state.current?.id !== s.id) return;
  if (s.chat) openChat();
  else if (s.projectPath) await goProject(s.projectPath);
  else goDashboard();
}

// 삭제 확인과 함께 작업 폴더·CLI 기록 파일을 어떻게 할지 묻는다. 취소하면 null.
// CLI 기록은 지우지 않아도 프로젝트 화면 목록에서 숨겨지므로 "가져오기"로 다시 뜨지 않는다.
function askDeleteOptions(s) {
  if (!confirm(`"${s.title}" ${s.chat ? "채팅" : "세션"}을 삭제할까요?`)) return null;
  let removeWorktree = false;
  if (s.worktree) {
    removeWorktree = confirm(
      `작업 폴더도 지울까요?\n${s.cwd}\n\n커밋하지 않은 변경이 있으면 지우지 않고 중단합니다. 브랜치 ${s.worktree.branch}는 남습니다.`);
  }
  let deleteRecords = false;
  if (!s.chat && (s.agentSessionId || s.cliSessionIds?.length)) {
    const origin = s.imported ? "\n이 세션은 Claude Code·Codex에서 가져온 것이라, 지우면 그쪽에서도 대화를 이어 갈 수 없습니다." : "";
    deleteRecords = confirm(
      `Claude Code·Codex에 남은 대화 기록 파일도 지울까요?${origin}\n\n확인: 기록 파일까지 지웁니다(되돌릴 수 없음).\n취소: 파일은 남기고 프로젝트 화면의 기록 목록에서만 숨깁니다.`);
  }
  return { removeWorktree, deleteRecords };
}

// 세션을 지운다. 실행 중으로 멈춰 있거나 작업 폴더를 못 지우면 그 자리에서 어떻게 할지 묻는다. 지웠으면 true.
async function deleteSession(s, { removeWorktree = false, deleteRecords = false, force = false } = {}) {
  const query = new URLSearchParams();
  if (removeWorktree) query.set("removeWorktree", "1");
  if (deleteRecords) query.set("records", "delete");
  if (force) query.set("force", "1");
  try {
    const { records } = await api("DELETE", `/api/sessions/${s.id}?${query}`);
    if (records?.errors.length) alert(`세션은 지웠지만 일부 기록 파일을 지우지 못했습니다(목록에서는 숨겼습니다).\n\n${records.errors.join("\n")}`);
    return true;
  } catch (err) {
    if (err.reason === "running" && confirm("실행 중인 세션입니다. 실행을 멈추고 삭제할까요?")) {
      return deleteSession(s, { removeWorktree, deleteRecords, force: true });
    }
    if (err.reason === "worktree" && confirm(`${err.message}\n\n작업 폴더는 남겨 두고 세션만 삭제할까요?`)) {
      return deleteSession(s, { deleteRecords, force });
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
  const info = state.status.agents[agent];
  $(listId).replaceChildren(...info.models.map((m) => el("option", { value: m.id }, m.label)));
  // 비워 두면 쓸 모델을 알려 준다. Codex 설정의 기본 모델을 쓸 수 없으면 대신 쓸 모델을 보인다(서버의 codex.defaultModel).
  const input = document.querySelector(`input[list="${listId}"]`);
  const d = info.defaultModel;
  if (input) {
    input.placeholder = d?.unavailable ? `CLI 기본값: ${d.model} (설정의 ${d.configured}은 쓸 수 없음)`
      : d?.configured ? `CLI 기본값: ${d.configured}` : "CLI 기본값";
  }
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
  $("config-agent").replaceChildren(...Object.keys(state.status.agents).map((a) => el("option", { value: a }, AGENT_LABEL[a] ?? a)));
  $("config-agent").value = s.agent;
  $("config-carry").checked = true;
  $("config-model").value = s.model ?? "";
  fillConfigAgent(s.agent, s.effort ?? "", s.permission);
  $("config-permission-row").hidden = !!s.chat;
  $("config-error").textContent = "";
  $("config-dialog").showModal();
});

// 고른 AI에 맞춰 모델 후보·추론 강도·권한 목록을 채운다. AI를 바꾸면 이어받기 선택을 보인다.
// 권한은 비슷한 것으로 옮긴다(읽기만 ↔ 읽기만, 수정 허용 ↔ 수정 허용). 서버의 handover.mjs와 같다.
const PERMISSION_MAP = {
  claude: { "read-only": "plan", "workspace-write": "acceptEdits" },
  codex: { default: "read-only", plan: "read-only", acceptEdits: "workspace-write", bypassPermissions: "workspace-write" },
};

function fillConfigAgent(agent, effort = $("config-effort").value, permission = $("config-permission").value) {
  const s = state.current;
  const switching = agent !== s.agent;
  $("config-switch").hidden = !switching;
  fillModels("config-models", agent);
  fillEfforts("config-effort", agent, $("config-model").value.trim(), effort);
  const modes = state.status.agents[agent].permissions;
  $("config-permission").replaceChildren(...modes.map((m) => el("option", { value: m }, m)));
  const mapped = modes.includes(permission) ? permission : PERMISSION_MAP[agent]?.[permission];
  $("config-permission").value = mapped && modes.includes(mapped) ? mapped : modes.at(-1);
}

$("config-agent").addEventListener("change", () => {
  const s = state.current;
  if (!s) return;
  const agent = $("config-agent").value;
  // 모델 이름은 AI마다 다르므로 바꾸면 비우고(CLI 기본값), 돌아오면 원래 값을 되살린다.
  $("config-model").value = agent === s.agent ? s.model ?? "" : "";
  fillConfigAgent(agent, agent === s.agent ? s.effort ?? "" : "", agent === s.agent ? s.permission : $("config-permission").value);
});

$("config-model").addEventListener("input", () => {
  if (state.current) fillEfforts("config-effort", $("config-agent").value, $("config-model").value.trim());
});

$("config-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const s = state.current;
  const body = { title: $("config-title").value, model: $("config-model").value.trim(), effort: $("config-effort").value };
  if (!s.chat) body.permission = $("config-permission").value;
  const agent = $("config-agent").value;
  if (agent !== s.agent) Object.assign(body, { agent, carry: $("config-carry").checked });
  try {
    const updated = await api("PUT", `/api/sessions/${s.id}`, body);
    $("config-dialog").close();
    // AI를 바꾸면 기록에 상태 줄이 붙고 CLI 대화 ID도 바뀌므로 세션을 통째로 다시 받는다.
    if (updated.agent !== s.agent) await selectSession(s.id);
    else {
      Object.assign(state.current, { title: updated.title, model: updated.model, effort: updated.effort, permission: updated.permission });
      renderSession();
    }
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
  renderEvents($("c-events"), s?.events ?? []);
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
  renderSessionElapsed("c", s);
  $("c-life").hidden = !s;
  if (s) renderLife("c-life", s);
  $("c-restart").hidden = !s?.agentSessionId;
  $("c-restart").disabled = running;
  renderComposer("c", s);
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
  if (composerBusy.has("c")) return;
  const input = $("c-prompt");
  const raw = input.value;
  const prompt = raw.trim();
  const current = state.current;
  const viewRevision = state.viewRevision;
  const action = composerAction(current, raw).action;
  if (action === "pause" || action === "resume") return togglePause();
  if (!prompt) return;
  composerBusy.add("c");
  renderComposerAction("c", current);
  try {
    let s = current;
    if (!s) {
      const { agent, model, effort } = state.chatDraft;
      s = await api("POST", "/api/sessions", { chat: true, agent, model, effort, title: chatTitle(prompt) });
    }
    const result = await api("POST", "/api/sessions/" + s.id + "/messages", { prompt, mode: composerMode(current) });
    const stillCurrent = current ? state.current?.id === current.id
      : !state.current && state.view === "chat" && state.viewRevision === viewRevision;
    if (stillCurrent && input.value === raw) input.value = "";
    if (result.queued) refreshQueue(s.id);
    if (!current && stillCurrent) {
      await loadSessions();
      if (!state.current && state.view === "chat" && state.viewRevision === viewRevision) await selectSession(s.id);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    composerBusy.delete("c");
    if (state.view === "chat") renderChatState();
  }
});

composerKeys("c");

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

$("c-new").addEventListener("click", () => openChat());
$("c-restart").addEventListener("click", () => restartSession());

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
  if (chat) {
    $("new-orchestrator").checked = false;
    $("new-isolate").checked = false;
  }
  syncNewWorktree();
  $("new-template-row").hidden = chat || !state.templateRoles?.length;
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
  if (state.newSessionContext) state.newSessionContext.cancelled = true;
  const context = { projectPath, pos, connectFrom };
  state.newSessionContext = context;
  try {
    await loadStatus();
  } catch (err) {
    if (state.newSessionContext === context) state.newSessionContext = null;
    alert(err.message);
    return;
  }
  if (state.newSessionContext !== context || context.cancelled) return;
  if (pos && (state.view !== "project" || !samePath(projectPath, state.project))) {
    state.newSessionContext = null;
    return;
  }
  const projects = sortedProjects();
  if (!projects.length && !kind?.endsWith("-chat")) {
    state.newSessionContext = null;
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
  $("new-isolate").checked = false;
  $("new-worktree-name").value = "";
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
$("new-isolate").addEventListener("change", () => {
  syncNewWorktree();
  if ($("new-isolate").checked) $("new-worktree-name").focus();
});
$("new-worktree-name").addEventListener("input", syncNewWorktree);
$("p-orchestrator").addEventListener("click", () => openNew(state.project, { orchestrator: true }));
$("new-project").addEventListener("change", fillTemplates);
$("new-template").addEventListener("change", applyTemplate);

$("new-dialog").addEventListener("close", () => {
  if (state.newSessionContext) state.newSessionContext.cancelled = true;
  state.newSessionContext = null;
});

$("new-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const context = state.newSessionContext;
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
    if (state.newSessionContext === context) {
      state.newSessionContext = null;
      $("new-dialog").close();
      e.target.reset();
    }
    // 그래프에서 만든 세션은 지정한 자리에 놓고, 손잡이에서 시작했으면 바로 연결한다.
    if (context?.pos && !context.cancelled && !body.chat && state.view === "project" &&
        samePath(context.projectPath, body.projectPath) && samePath(state.project, body.projectPath)) {
      await api("PUT", `/api/sessions/${created.id}`, { graphPos: context.pos }).catch(() => {});
      await connectCreatedGraphNode(context, created.id, body.projectPath);
    }
    await Promise.all([loadSessions(), loadProjects()]); // 감지된 프로젝트는 세션을 만들면서 등록된다.
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
$("open-setup").addEventListener("click", () => openSetup());
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
    if ((event.kind === "question" || event.kind === "permission") && event.status === "pending") notifyQuestion(sessionId, event);
    const s = state.current;
    if (s?.id !== sessionId || event.seq < s.events.length) return;
    s.events.push(event);
    const list = eventsList();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    appendEvent(list, event);
    if (atBottom) scrollToBottom();
    if (event.kind === "status" || event.kind === "result") selectSession(sessionId); // CLI 세션 ID 등 메타 갱신
  });
  source.addEventListener("state", (e) => {
    const payload = JSON.parse(e.data);
    const { sessionId, state: next } = payload;
    const applyState = (session) => {
      session.state = next;
      if (next !== "running") session.runningStartedAt = null;
      else if (Object.hasOwn(payload, "runningStartedAt")) session.runningStartedAt = payload.runningStartedAt;
    };
    const item = state.sessions.find((s) => s.id === sessionId);
    if (item) applyState(item);
    // Codex 한도는 턴이 끝난 뒤 기록 파일에서 읽는다.
    if (item?.agent === "codex" && next !== "running") loadLimits();
    renderSessionList();
    renderProjectNav();
    if (state.view === "dashboard") renderDashboard();
    if (state.view === "project") renderProjectSessions();
    // 시작·종료 상태를 모두 반영해 노선도의 작업 중 표시를 갱신한다.
    if (state.view === "project" && projectTab() === "git" && item && samePath(item.projectPath, state.project)) loadGit();
    if (state.current?.id === sessionId) {
      applyState(state.current);
      renderState();
    }
  });
  source.addEventListener("sessions", loadSessions);
  // 다른 창에서 커밋·병합했다.
  source.addEventListener("git", (e) => {
    if (state.view === "project" && projectTab() === "git" && samePath(JSON.parse(e.data).projectPath, state.project)) loadGit();
  });
  // 프로젝트를 더하거나 뺐다. 보고 있던 프로젝트가 빠졌으면 대시보드로 돌아간다.
  source.addEventListener("projects", async () => {
    await loadProjects();
    if (state.view === "project" && !currentProject()) goDashboard();
  });
  source.addEventListener("links", loadLinks);
  source.addEventListener("messages", (e) => {
    if (samePath(JSON.parse(e.data).projectPath, state.project)) loadMessages();
  });
  source.addEventListener("board", (e) => {
    if ($("board-dialog").open && samePath(JSON.parse(e.data).projectPath, state.boardProject)) loadBoard();
  });
  // 설치·로그인 진행 상황. 끝나면 CLI 경로·버전·로그인 상태를 다시 받는다.
  source.addEventListener("setup", (e) => {
    if (!state.setup) return loadSetup();
    state.setup.jobs = JSON.parse(e.data);
    renderCliStatus();
    if ($("setup-dialog").open) renderSetup();
  });
  source.addEventListener("cli", () => Promise.all([loadStatus(), loadAuth(true), loadSetup()]));
  source.addEventListener("commands", () => state.view === "project" && loadCommands());
  source.addEventListener("skills", (e) => {
    if (samePath(JSON.parse(e.data).projectPath, state.project)) loadSkills();
  });
  source.addEventListener("queue", (e) => refreshQueue(JSON.parse(e.data).sessionId));
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
loadSetup();
setInterval(loadAuth, 5 * 60_000);
setInterval(refreshElapsedTimes, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshElapsedTimes(); });

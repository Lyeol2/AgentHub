const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  sessions: [],
  current: null, // 선택한 세션의 전체 데이터
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
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// ── CLI 상태 ────────────────────────────────────────────────────
async function loadStatus() {
  state.status = await api("GET", "/api/status");
  const box = $("cli-status");
  box.replaceChildren(
    ...Object.entries(state.status.agents).map(([name, info]) =>
      el("div", { class: info.path ? "" : "missing", title: info.path ?? "" },
        `${AGENT_LABEL[name]}: ${info.path ? info.version ?? "버전 확인 실패" : "CLI 없음"}`)),
  );
}

// ── 세션 목록 ───────────────────────────────────────────────────
async function loadSessions() {
  state.sessions = await api("GET", "/api/sessions");
  renderSessionList();
}

function renderSessionList() {
  $("session-list").replaceChildren(
    ...state.sessions.map((s) =>
      el("button", {
        class: `session-item${state.current?.id === s.id ? " active" : ""}`,
        onclick: () => selectSession(s.id),
      },
      el("span", { class: "top" },
        el("span", { class: `badge ${s.agent}` }, AGENT_LABEL[s.agent]),
        el("span", { class: "name" }, s.title)),
      el("span", { class: "sub" }, `${s.projectName} · ${STATE_LABEL[s.state] ?? s.state}`))),
  );
}

async function selectSession(id) {
  state.current = await api("GET", `/api/sessions/${id}`);
  renderSessionList();
  renderSession();
}

// ── 세션 화면 ───────────────────────────────────────────────────
function renderSession() {
  const s = state.current;
  $("empty").hidden = !!s;
  $("session").hidden = !s;
  if (!s) return;

  $("s-agent").className = `badge ${s.agent}`;
  $("s-agent").textContent = AGENT_LABEL[s.agent];
  $("s-title").textContent = s.title;
  renderState();

  const meta = [
    s.worktree ? `작업 폴더: ${s.cwd} (브랜치 ${s.worktree.branch})` : `작업 폴더: ${s.cwd} (원본)`,
    `권한: ${s.permission}`,
    s.model ? `모델: ${s.model}` : null,
    s.agentSessionId ? `CLI 세션: ${s.agentSessionId}` : null,
  ].filter(Boolean);
  $("s-meta").textContent = meta.join(" · ");
  $("s-diff").disabled = !s.baseCommit;

  $("s-events").replaceChildren(...s.events.map(renderEvent));
  scrollToBottom();
}

function renderState() {
  const s = state.current;
  const label = $("s-state");
  label.textContent = STATE_LABEL[s.state] ?? s.state;
  label.className = `state ${s.state}`;
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
  if (!confirm(`"${s.title}" 세션 기록을 삭제할까요?`)) return;
  let removeWorktree = false;
  if (s.worktree) {
    removeWorktree = confirm(
      `작업 폴더도 지울까요?\n${s.cwd}\n\n커밋하지 않은 변경이 있으면 지우지 않고 중단합니다. 브랜치 ${s.worktree.branch}는 남습니다.`);
  }
  try {
    await api("DELETE", `/api/sessions/${s.id}${removeWorktree ? "?removeWorktree=1" : ""}`);
    state.current = null;
    renderSession();
    await loadSessions();
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

$("open-new").addEventListener("click", async () => {
  await loadStatus();
  if (!state.status.projects.length) {
    alert("먼저 설정에서 프로젝트를 추가하세요.");
    openSettings();
    return;
  }
  $("new-project").replaceChildren(
    ...state.status.projects.map((p) => el("option", { value: p.path }, `${p.name} — ${p.path}`)));
  fillPermissions();
  $("new-error").textContent = "";
  $("new-dialog").showModal();
});

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
          class: "ghost danger",
          onclick: async () => {
            state.status.projects = await api("DELETE", `/api/projects/${i}`);
            renderProjects();
          },
        }, "제거"))),
  );
}

async function openSettings() {
  await loadStatus();
  renderProjects();
  $("cli-claude").value = state.status.cliOverrides.claude;
  $("cli-codex").value = state.status.cliOverrides.codex;
  $("settings-error").textContent = "";
  $("settings-dialog").showModal();
}

$("open-settings").addEventListener("click", openSettings);

$("add-project").addEventListener("click", async () => {
  try {
    state.status.projects = await api("POST", "/api/projects", { path: $("project-path").value });
    $("project-path").value = "";
    $("settings-error").textContent = "";
    renderProjects();
  } catch (err) {
    $("settings-error").textContent = err.message;
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
    renderSessionList();
    if (state.current?.id === sessionId) {
      state.current.state = next;
      renderState();
    }
  });
  source.addEventListener("sessions", loadSessions);
  // 연결이 끊겼다가 돌아오면 놓친 이벤트를 다시 받아 온다.
  source.addEventListener("open", () => {
    if (state.current) selectSession(state.current.id);
  });
}

await Promise.all([loadStatus(), loadSessions()]);
connectStream();

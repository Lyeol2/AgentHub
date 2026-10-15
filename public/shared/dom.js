export const $ = (id) => document.getElementById(id);

export const AGENT_LABEL = { claude: "Claude", codex: "Codex" };
export const CHAT_LABEL = { claude: "Claude 채팅", codex: "ChatGPT" };
export const STATE_LABEL = { idle: "대기", running: "실행 중", error: "오류", interrupted: "중단됨", paused: "일시중지됨" };

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export const badge = (agent) => el("span", { class: `badge ${agent}` }, AGENT_LABEL[agent]);
// 세션은 일반 채팅이면 채팅 이름으로 표시한다.
export const sessionLabel = (s) => (s.chat ? CHAT_LABEL : AGENT_LABEL)[s.agent];
export const sessionBadge = (s) => el("span", { class: `badge ${s.agent}${s.chat ? " chat" : ""}` }, sessionLabel(s));
export const pill = (s) => el("span", { class: `pill ${s}` }, STATE_LABEL[s] ?? s);

export function lifeInfo(s) {
  const n = s.compactions ?? 0;
  const { used, window } = s.context ?? {};
  const pct = used && window ? Math.min(100, Math.round((used / window) * 100)) : null;
  const text = `압축 ${n}회${pct === null ? "" : ` · ${pct}%`}`;
  const title = `세션 수명 · 컨텍스트 압축 ${n}회${pct === null ? "" : ` · 컨텍스트 ${used.toLocaleString()} / ${window.toLocaleString()} 토큰`}\n` +
    "압축 1회 노랑, 2회 주황, 3회 이상 빨강. 답이 흐려지면 '다시 시작'으로 새 대화를 여세요.";
  return { n, text, title, cls: `pill life life-${Math.min(n, 3)}` };
}

export const lifePill = (s) => {
  const life = lifeInfo(s);
  return el("span", { class: life.cls, title: life.title }, life.text);
};

export function renderLife(id, s) {
  const life = lifeInfo(s);
  Object.assign($(id), { className: life.cls, title: life.title, textContent: life.text });
}

export function timeAgo(iso) {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return "방금";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}일 전`;
  return new Date(iso).toLocaleDateString();
}

export function table(id, headers, rows, emptyText) {
  $(id).replaceChildren(
    el("thead", {}, el("tr", {}, ...headers.map(([text, cls]) => el("th", { class: cls ?? "" }, text)))),
    el("tbody", {}, ...(rows.length ? rows
      : [el("tr", { class: "empty-row" }, el("td", { colspan: String(headers.length) }, emptyText))])),
  );
}

export function renderDiff(text) {
  return text.split("\n").map((line) => {
    let cls = "";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "del";
    else if (line.startsWith("@@")) cls = "hunk";
    return el("span", { class: cls }, `${line}\n`);
  });
}

export const fmtDate = (iso) => new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

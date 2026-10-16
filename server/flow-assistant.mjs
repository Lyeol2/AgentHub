// 흐름 도우미: 세션 흐름 아래 입력창에 적은 요청을 AI가 그래프 작업 목록으로 바꾸고, 사용자가 확인하면 적용한다.
// 여기서는 AI에게 줄 설명을 만들고, 돌아온 작업 목록을 현재 그래프에 맞춰 검사한다. 지우기는 하지 않는다.
import { AGENTS } from "./runner.mjs";
import { CONDITIONS } from "./chain.mjs";
import { ROLE_MAX } from "./role.mjs";
import { checkCommand, commandKind } from "./commands.mjs";

const MAX_ACTIONS = 30;
const MAX_NEW_SESSIONS = 8;
const MAX_NEW_NODES = 12;
// 브랜치·구성원처럼 이 화면에서 확인할 값이 필요한 Git·결과 모으기는 편집 창에서 만든다.
export const ASSISTANT_NODE_KINDS = ["command", "button", "input", "repeat", "transform", "notify", "markdown", "webhook", "webhook-in", "watch"];
const SOURCE_ONLY = ["button", "input", "watch", "webhook-in"];
const KIND_NAME = { session: "세션", command: "명령", button: "버튼", input: "입력 폼", repeat: "반복 제어", transform: "결과 가공", notify: "알림",
  markdown: "Markdown 출력", webhook: "웹훅 보내기", "webhook-in": "웹훅 받기", watch: "파일 감시", git: "GIT", group: "결과 모으기" };
const WHEN_NAME = { success: "성공하면", error: "실패하면", keyword: "키워드가 있으면", always: "항상", otherwise: "그 외", manual: "수동" };

const str = (value, max) => String(value ?? "").trim().slice(0, max);
const firstLine = (value, max = 80) => String(value ?? "").split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, max) ?? "";

// AI에게 지금 그래프를 보여 준다. 노드는 id로 가리키게 한다.
export function graphOutline({ sessions, commands, links, selected = [] }) {
  const nodes = [
    ...sessions.map((s) => `- ${s.id} · 세션 "${s.title}" · ${s.agent}${s.roleName ? ` · 역할 이름 ${s.roleName}` : ""}${s.role ? ` · 역할: ${firstLine(s.role)}` : " · 역할 없음"}`),
    ...commands.map((c) => `- ${c.id} · ${KIND_NAME[commandKind(c)] ?? commandKind(c)} "${c.title}"`),
  ];
  const ids = new Set([...sessions, ...commands].map((n) => n.id));
  const edges = links.filter((l) => ids.has(l.from) && ids.has(l.to))
    .map((l) => `- ${l.from} → ${l.to} · ${l.when}${l.when === "keyword" ? ` "${l.keyword}"` : ""}`);
  const picked = selected.filter((id) => ids.has(id));
  return [
    `[노드]\n${nodes.length ? nodes.join("\n") : "없음"}`,
    `[연결]\n${edges.length ? edges.join("\n") : "없음"}`,
    `[사용자가 선택한 노드]\n${picked.length ? picked.join(", ") : "없음"}`,
  ].join("\n\n");
}

export function assistantPrompt({ request, outline, projectPath }) {
  return `너는 AgentHub의 세션 흐름 그래프를 고치는 도우미다. 사용자의 요청을 그래프 작업 목록으로 바꾼다.
프로젝트 폴더: ${projectPath} (역할을 쓰는 데 필요하면 파일을 읽어도 된다. 파일을 고치거나 명령을 실행하지 않는다.)
"이거", "선택한 것"은 사용자가 선택한 노드를 가리킨다. 노드를 지우는 작업은 없다. 지우기를 요청하면 actions를 비우고 summary에 직접 지우라고 적는다.

${outline}

답은 아래 JSON 객체 하나만 쓴다. 다른 말은 쓰지 않는다.
{"summary": "무엇을 할지 한 문장", "actions": [ ... ]}

actions 항목(순서대로 실행한다):
- {"type": "create_session", "key": "rev", "title": "리뷰", "agent": "claude|codex", "permission": "(선택)", "roleName": "(선택) 짧은 역할 이름", "role": "맡는 일·고쳐도 되는 범위·완료 기준·마지막 줄에 쓸 판정"}
  claude 권한: ${AGENTS.claude.PERMISSION_MODES.join(", ")} / codex 권한: ${AGENTS.codex.PERMISSION_MODES.join(", ")}. 검토만 하는 세션은 읽기 전용 권한을 쓴다.
- {"type": "create_node", "key": "test", "kind": "${ASSISTANT_NODE_KINDS.join("|")}", "title": "...", ...종류별 값}
  command: "command"(셸 명령, Windows면 PowerShell 문법) · button: "prompt"(연결된 세션에 보낼 요청) · notify: "message" · webhook: "url", "method", "body"
  transform: "transformMode"(json|lines|template), "expression", "template" · repeat: "maxIterations" · watch: "watchPaths"(배열)
- {"type": "set_role", "target": "<세션>", "role": "...", "roleName": "(선택)"}
- {"type": "rename", "target": "<노드>", "title": "..."}
- {"type": "link", "from": "<노드>", "to": "<노드>", "when": "${CONDITIONS.join("|")}", "keyword": "(keyword일 때)", "note": "(선택) 받는 쪽에 줄 지시"}
- {"type": "send", "to": "<세션>", "prompt": "지금 보낼 요청"} 사용자가 일을 시키라고 했을 때만 쓴다.
<노드>와 <세션>에는 위 목록의 id나 이번 목록에서 만든 key를 쓴다. key는 영문·숫자·_·-다.
버튼·입력 폼·파일 감시·웹훅 받기는 시작점이라 들어오는 연결을 받지 않고, Markdown 출력에서는 나가는 연결을 만들지 않는다.
키워드로 넘기려면 보내는 세션의 역할에 "마지막 줄에 '검토 요청'만 쓴다"처럼 판정을 적고 같은 키워드로 연결한다.

사용자 요청: ${request}`;
}

// 답에서 JSON 객체를 꺼낸다.
export function parseAssistantAnswer(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI가 작업 목록을 만들지 못했습니다. 요청을 조금 더 구체적으로 적어 보세요.");
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { throw new Error("AI의 답이 JSON 형식이 아닙니다. 다시 시도해 보세요."); }
}

// 작업 목록을 지금 그래프에 맞춰 검사하고, 미리 보기 문장(text)을 붙인다. 틀린 곳이 있으면 오류를 던진다.
// sessions·commands: 같은 프로젝트의 노드
export function normalizeActions(raw, { sessions, commands }) {
  const list = Array.isArray(raw?.actions) ? raw.actions : null;
  if (!list) throw new Error("작업 목록이 없습니다.");
  if (list.length > MAX_ACTIONS) throw new Error(`한 번에 ${MAX_ACTIONS}개 작업까지 할 수 있습니다. 요청을 나눠 주세요.`);
  const known = new Map([...sessions.map((s) => [s.id, { kind: "session", title: s.title }]), ...commands.map((c) => [c.id, { kind: commandKind(c), title: c.title }])]);
  const keys = new Map();
  const actions = [];
  let newSessions = 0, newNodes = 0;
  const ref = (value, where) => {
    const name = str(value, 60);
    const node = keys.get(name) ?? known.get(name);
    if (!node) throw new Error(`${where}: "${name}"은 그래프의 노드가 아닙니다.`);
    return { ref: name, ...node };
  };
  const newKey = (value) => {
    const key = str(value, 40);
    if (!/^[\w-]+$/.test(key) || keys.has(key) || known.has(key)) throw new Error(`새 노드의 key가 올바르지 않거나 겹칩니다: "${key}"`);
    return key;
  };
  const name = (node) => `"${node.title}"`;

  for (const item of list) {
    const type = item?.type;
    if (type === "create_session") {
      if (++newSessions > MAX_NEW_SESSIONS) throw new Error(`한 번에 새 세션은 ${MAX_NEW_SESSIONS}개까지 만들 수 있습니다.`);
      const key = newKey(item.key);
      const agent = str(item.agent || "claude", 20).toLowerCase();
      if (!AGENTS[agent]) throw new Error(`세션 "${key}": agent는 claude 또는 codex입니다.`);
      const permission = item.permission || (agent === "claude" ? "acceptEdits" : "workspace-write");
      if (!AGENTS[agent].PERMISSION_MODES.includes(permission)) throw new Error(`세션 "${key}": ${agent} 권한은 ${AGENTS[agent].PERMISSION_MODES.join(", ")} 중 하나입니다.`);
      const title = str(item.title, 100) || key;
      keys.set(key, { kind: "session", title, created: true });
      actions.push({ type, key, agent, permission, title, roleName: str(item.roleName, 100), role: str(item.role, ROLE_MAX),
        text: `새 세션 "${title}" 만들기 (${agent === "claude" ? "Claude" : "Codex"} · ${permission})${item.role ? ` · 역할: ${firstLine(item.role, 60)}` : ""}` });
    } else if (type === "create_node") {
      if (++newNodes > MAX_NEW_NODES) throw new Error(`한 번에 새 노드는 ${MAX_NEW_NODES}개까지 만들 수 있습니다.`);
      const key = newKey(item.key);
      const kind = item.kind ?? "command";
      if (!ASSISTANT_NODE_KINDS.includes(kind)) throw new Error(`"${kind}" 노드는 여기서 만들 수 없습니다. 우클릭 메뉴에서 만들어 주세요.`);
      // AI의 답은 값을 바로 적고, 미리 보기에서 돌아온 목록은 fields에 담는다.
      const { type: _type, key: _key, text: _text, fields: nested, ...rest } = item;
      const fields = nested && typeof nested === "object" ? nested : rest;
      let checked;
      try { checked = checkCommand({ ...fields, kind }); }
      catch (error) { throw new Error(`${KIND_NAME[kind]} "${str(item.title, 100) || key}": ${error.message}`); }
      keys.set(key, { kind, title: checked.title, created: true });
      actions.push({ type, key, kind, fields: { ...checked, kind }, text: `새 ${KIND_NAME[kind]} "${checked.title}" 만들기` });
    } else if (type === "set_role") {
      const target = ref(item.target, "역할 설정");
      if (target.kind !== "session") throw new Error(`역할은 세션에만 정할 수 있습니다: ${name(target)}`);
      const role = str(item.role, ROLE_MAX);
      actions.push({ type, target: target.ref, role, ...(item.roleName !== undefined ? { roleName: str(item.roleName, 100) } : {}),
        text: `${name(target)} 역할 ${role ? `설정: ${firstLine(role, 60)}` : "비우기"}` });
    } else if (type === "rename") {
      const target = ref(item.target, "이름 바꾸기");
      const title = str(item.title, 100);
      if (!title) throw new Error(`${name(target)}의 새 이름이 없습니다.`);
      actions.push({ type, target: target.ref, title, text: `${name(target)} 이름을 "${title}"(으)로 바꾸기` });
      (keys.get(target.ref) ?? known.get(target.ref)).title = title;
    } else if (type === "link") {
      const from = ref(item.from, "연결");
      const to = ref(item.to, "연결");
      if (from.ref === to.ref) throw new Error(`같은 노드끼리는 연결할 수 없습니다: ${name(from)}`);
      if (SOURCE_ONLY.includes(to.kind)) throw new Error(`${KIND_NAME[to.kind]} ${name(to)}은 시작점이라 들어오는 연결을 받을 수 없습니다.`);
      if (from.kind === "markdown") throw new Error(`Markdown 출력 ${name(from)}에서는 연결을 만들 수 없습니다.`);
      const when = item.when || "success";
      if (!CONDITIONS.includes(when)) throw new Error(`연결 조건은 ${CONDITIONS.join(", ")} 중 하나입니다: "${when}"`);
      const keyword = when === "keyword" ? str(item.keyword, 100) : "";
      if (when === "keyword" && !keyword) throw new Error(`${name(from)} → ${name(to)} 연결에 키워드가 없습니다.`);
      actions.push({ type, from: from.ref, to: to.ref, when, keyword, note: str(item.note, ROLE_MAX),
        text: `${name(from)} → ${name(to)} 연결 (${WHEN_NAME[when] ?? when}${keyword ? `: ${keyword}` : ""})` });
    } else if (type === "send") {
      const to = ref(item.to, "요청 보내기");
      if (to.kind !== "session") throw new Error(`요청은 세션에만 보낼 수 있습니다: ${name(to)}`);
      const prompt = str(item.prompt, 20_000);
      if (!prompt) throw new Error(`${name(to)}에 보낼 요청이 없습니다.`);
      actions.push({ type, to: to.ref, prompt, text: `${name(to)}에 요청 보내기: ${firstLine(prompt, 60)}` });
    } else throw new Error(`알 수 없는 작업입니다: ${String(type).slice(0, 40)}`);
  }
  return actions;
}

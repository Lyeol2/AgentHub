// 메시지의 형식·길이·수신자 선택과 연결 권한. 파일·실행기·전송에 의존하지 않는다.
import path from "node:path";

export const MESSAGE_FENCE = "agenthub-message";
export const MESSAGE_MAX = 8000;
const BLOCK_MAX = 4; // 블록 하나에 담을 수 있는 메시지 수
export const TURN_MAX = 12; // 한 턴에 보낼 수 있는 메시지 수. 세션끼리 끝없이 떠드는 것을 막는다.
export const LOG_MAX = 300;
export const BOARD_MAX = 60000;
export const ASK_TIMEOUT_SEC = 300;
export const ASK_TIMEOUT_MAX = 600;

export const MESSAGE_GUIDE = `[AgentHub 세션 간 소통]
이 프로젝트에는 다른 AI 세션들이 함께 일한다. 활성화된 연결선으로 직접 연결된 세션끼리만 agenthub MCP 도구로 소통한다. 연결 방향과 관계없이 답장할 수 있다.
- list_sessions: 직접 연결되어 연락할 수 있는 세션의 이름·역할·상태를 본다.
- send_message(to, text): 다른 세션에 메시지를 보낸다. 상대가 작업 중이면 작업 중에, 아니면 다음 요청으로 받는다.
- ask_session(to, question): 묻고 답이 올 때까지 기다린다. 답 없이는 진행할 수 없을 때만 쓴다.
- check_messages: 작업 중에 나에게 온 메시지를 확인한다. 오래 걸리는 작업 중간에 확인한다.
- board_read / board_post(text): 프로젝트 공유 노트. API 약속, 정한 사항, 진행 상황처럼 모두가 알아야 할 것을 남긴다.
- call_session(to, task, wait): 사용자가 이번 요청에서 다른 세션에 넘기거나 부르라고 시켰을 때만 그 세션을 불러 일을 맡긴다. wait가 true면 결과가 올 때까지 기다린다. "요청 시 호출" 연결은 이 도구로만 쓴다. 사용자가 시키지 않았으면 부르지 않는다.
자기 작업은 스스로 끝낸다. 다른 세션에 연락하는 경우는 다음으로 제한한다.
- 사용자가 다른 세션에 넘기거나 부르라고 요청했을 때(call_session).
- 직접 확인할 수 없는 정보·결정이 필요해 내 작업이 막혔을 때.
- 같은 파일이나 인터페이스의 실제 변경이 겹쳐 조율하지 않으면 충돌할 때.
- 상대가 요청한 정보·작업 결과를 돌려줄 때. 결과가 준비되면 한 번만 보낸다.
확인·감사·수신 확인만 하는 답장, 요청받지 않은 일반 진행·완료 보고, 같은 내용의 반복 전송은 하지 않는다. 연결로 이미 전달하는 결과도 메시지로 중복해서 보내지 않는다.
단순 알림은 읽고 반영한 뒤 답장 없이 자기 작업을 이어 간다. 답이 필요한 경우에만 send_message로 보낸 세션에게 답한다.
MCP 도구를 쓸 수 없으면 답변 끝에 아래 블록을 쓴다. wait가 true면 답이 올 때까지 다음 단계로 넘기지 않는다. 부르기는 "call": true를 더한다.
\`\`\`${MESSAGE_FENCE}
{"to": "받는 세션 이름이나 역할", "text": "메시지", "wait": false}
\`\`\``;

export const boundedText = (value, max) => String(value ?? "").trim().slice(0, max);
const MESSAGE_BLOCK = new RegExp("```" + MESSAGE_FENCE + "\\s*\\n([\\s\\S]*?)```", "g");

// 답변에서 메시지 블록을 모두 꺼낸다. 없으면 null, 형식이 틀리면 { error }.
// 블록 하나에 메시지 하나({to, text}) 또는 여러 개({messages: [...]}, 배열)를 쓸 수 있다.
export function extractMessages(text) {
  const blocks = [...String(text ?? "").matchAll(MESSAGE_BLOCK)];
  if (!blocks.length) return null;
  const messages = [];
  for (const block of blocks) {
    let raw;
    try {
      raw = JSON.parse(block[1]);
    } catch (err) {
      return { error: `메시지 블록이 JSON 형식이 아닙니다: ${err.message}` };
    }
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [raw];
    for (const item of items.slice(0, BLOCK_MAX)) {
      const message = { to: boundedText(item?.to, 200), text: boundedText(item?.text, MESSAGE_MAX), wait: !!item?.wait, ...(item?.call === true ? { call: true } : {}) };
      if (message.to && message.text) messages.push(message);
    }
  }
  if (!messages.length) return { error: "메시지 블록에 받는 세션(to)과 내용(text)이 없습니다." };
  return { messages };
}

// 화면에서 답변 본문의 메시지 블록을 뺄 때 쓴다.
export const stripMessages = (text) => String(text ?? "").replace(MESSAGE_BLOCK, "").trim();

// 같은 프로젝트에서 이름(id, 제목, 역할 이름)으로 받는 세션을 찾는다. 못 찾거나 여럿이면 Error.
export function findTarget(sessions, from, to) {
  const key = boundedText(to, 200).toLowerCase();
  const others = sessions.filter((s) => s.id !== from.id && !s.chat);
  const byId = others.find((s) => s.id.toLowerCase() === key);
  if (byId) return byId;
  const exact = others.filter((s) => s.title?.toLowerCase() === key || s.roleName?.toLowerCase() === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`"${to}"인 세션이 여럿입니다. 세션 id로 보내세요: ${exact.map((s) => `${s.id}(${s.title})`).join(", ")}`);
  }
  // "작업 · 리뷰"처럼 흐름 이름이 붙은 제목은 뒷부분만으로도 찾는다.
  const partial = others.filter((s) => s.title?.toLowerCase().split(/\s*·\s*/).includes(key));
  if (partial.length === 1) return partial[0];
  const names = others.map((s) => s.title).join(", ") || "없음";
  throw new Error(`"${to}" 세션을 찾지 못했습니다. 보낼 수 있는 세션: ${names}`);
}

// 받는 세션에 들어갈 요청 글
export function messageText(from, text, { ask = false } = {}) {
  const role = from.roleName ? ` · 역할 ${from.roleName}` : "";
  const reply = ask
    ? `"${from.title}" 세션이 답을 기다리고 있다. send_message(to: "${from.title}")로 답한다.`
    : `확인·감사만 하는 답장은 보내지 않는다. 요청받은 정보·결과 또는 상대 작업에 꼭 필요한 새 사실이 있을 때만 send_message(to: "${from.title}")로 답한다.`;
  return [`[세션 메시지] 보낸 세션: ${from.title} (${from.agent}${role}, id ${from.id})`, "", text, "", reply].join("\n");
}

// 사람이 읽는 상태 이름
const STATE_TEXT = { idle: "대기", running: "실행 중", error: "오류", interrupted: "중단됨" };

// "요청 시 호출" 연결: 턴이 끝나도 넘기지 않고, 사용자가 시킬 때만 출발 세션이 call_session으로 도착 세션을 부른다.
export const isCallLink = (link) => link?.when === "call";
const joins = (link, a, b) => (link.from === a && link.to === b) || (link.from === b && link.to === a);

// 메시지는 활성화된 직접 연결이 있으면 연결 방향과 관계없이 주고받는다.
// 요청 시 호출 연결은 불린 세션이 부른 세션에게 결과를 돌려주는 방향(도착 → 출발)만 메시지를 허용한다.
export function hasSessionLink(links, fromId, toId) {
  return !!fromId && !!toId && fromId !== toId && links.some((link) => link.enabled && (
    isCallLink(link) ? link.from === toId && link.to === fromId : joins(link, fromId, toId)
  ));
}

// 부르기: 요청 시 호출 연결은 출발 → 도착으로만, 일반 연결은 방향과 관계없이 부를 수 있다.
export function hasCallLink(links, fromId, toId) {
  return !!fromId && !!toId && fromId !== toId && links.some((link) => link.enabled && (
    isCallLink(link) ? link.from === fromId && link.to === toId : joins(link, fromId, toId)
  ));
}

export function sameProject(left, right) {
  return typeof left === "string" && !!left && typeof right === "string" && !!right &&
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

// 활성 직접 연결만 허용하며 답장을 위해 연결 방향은 구분하지 않는다.
export function canContact(links, from, to) {
  return !!from && !!to && !from.chat && !to.chat &&
    sameProject(from.projectPath, to.projectPath) && hasSessionLink(links, from.id, to.id);
}

export function canCall(links, from, to) {
  return !!from && !!to && !from.chat && !to.chat &&
    sameProject(from.projectPath, to.projectPath) && hasCallLink(links, from.id, to.id);
}

// others: 메시지를 주고받을 수 있는 세션, callable: 부를 수 있는 세션(겹칠 수 있다)
export function directoryText(others, callable = []) {
  const all = [...new Map([...others, ...callable].map((s) => [s.id, s])).values()];
  if (!all.length) return "직접 연결된 다른 세션이 없습니다.";
  const talk = new Set(others.map((s) => s.id)), call = new Set(callable.map((s) => s.id));
  return all.map((s) => {
    const role = s.roleName ? ` · 역할 ${s.roleName}` : "";
    const first = s.role?.split(/\r?\n/).find((l) => l.trim())?.slice(0, 120);
    const can = [talk.has(s.id) ? "메시지" : "", call.has(s.id) ? "부르기(사용자가 요청할 때만)" : ""].filter(Boolean).join(" · ");
    return `- ${s.title} (id ${s.id}, ${s.agent}${role}, ${STATE_TEXT[s.state] ?? s.state}) · ${can}${first ? `\n  ${first}` : ""}`;
  }).join("\n");
}

// ── 부르기 ─────────────────────────────────────────────────────
// 이번 턴을 사용자가 직접 보낸 요청으로 시작했으면 그 요청들(작업 중에 덧붙인 요청 포함)을, 아니면 null을 돌려준다.
// 연결·대기열로 넘어온 요청(from이 있는 요청)으로 시작한 턴에서는 부를 수 없다.
export function userRequest(session) {
  const found = [];
  for (let i = (session?.events?.length ?? 0) - 1; i >= 0; i--) {
    const event = session.events[i];
    if (event.kind !== "user") continue;
    if (!event.from) found.push(event);
    else if (!event.injected) return null;
    if (!event.injected) break;
  }
  return found.length ? found : null;
}

// 사용자가 요청에서 부를 세션을 직접 가리켰는지: "@세션/이름" 참조, 세션 제목·역할 이름(또는 "작업 · 리뷰"의 한 토막)
export function mentionsSession(requests, target) {
  const text = requests.map((event) => event.text ?? "").join("\n").toLowerCase();
  const link = `agenthub://session/${target.id}`;
  if (requests.some((event) => (event.references ?? []).some((ref) => ref?.path === link)) || text.includes(link.toLowerCase())) return true;
  const names = [target.title, target.roleName, ...String(target.title ?? "").split(/\s*·\s*/)]
    .map((name) => String(name ?? "").trim().toLowerCase()).filter((name) => name.length >= 2);
  return names.some((name) => text.includes(name));
}

// 불린 세션에 들어갈 요청 글
export function callText(from, text, { wait = false } = {}) {
  const role = from.roleName ? ` · 역할 ${from.roleName}` : "";
  const reply = wait
    ? `"${from.title}" 세션이 결과를 기다리고 있다. 끝나면 send_message(to: "${from.title}")로 결과를 한 번 돌려준다.`
    : `끝나면 결과를 send_message(to: "${from.title}")로 한 번 돌려준다. 확인·감사만 하는 답장은 보내지 않는다.`;
  return [`[세션 호출] 부른 세션: ${from.title} (${from.agent}${role}, id ${from.id})`, "사용자가 그 세션에서 요청해 이 세션에 맡긴 일이다.", "", text, "", reply].join("\n");
}

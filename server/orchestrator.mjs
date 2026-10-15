// 오케스트레이터 세션: 목표를 작업으로 나눠 계획 블록으로 쓰면, 사용자가 승인한 뒤 AgentHub가 세션·연결·요청을 만든다.
import { AGENTS } from "./runner.mjs";
import { CONDITIONS } from "./chain.mjs";
import { withRole } from "./role.mjs";

export const PLAN_FENCE = "agenthub-plan";
export const ORCHESTRATOR = "orchestrator"; // 계획 안에서 오케스트레이터 자신을 가리키는 이름
const MAX_NEW_SESSIONS = 8;
const MAX_STATUS_SESSIONS = 30;
const STATE_TEXT = { idle: "대기", running: "실행 중", error: "오류", interrupted: "중단됨" };

const PLAN_EXAMPLE = `\`\`\`${PLAN_FENCE}
{
  "sessions": [
    { "key": "ui", "role": "구현", "title": "정렬 버튼 UI", "prompt": "가방 화면에 정렬 버튼을 추가한다. ..." },
    { "key": "review", "role": "리뷰", "title": "정렬 버튼 리뷰" }
  ],
  "links": [
    { "from": "ui", "to": "review", "when": "keyword", "keyword": "검토 요청" },
    { "from": "review", "to": "${ORCHESTRATOR}", "when": "always" }
  ],
  "send": []
}
\`\`\``;

function instructions() {
  return `[AgentHub 오케스트레이터]
너는 AgentHub에서 여러 코딩 에이전트 세션을 지휘한다. 직접 코드를 고치지 않는다. 파일은 읽어도 된다.
사용자의 목표를 작업으로 나누고, 작업마다 세션을 만들거나 이미 있는 세션에 요청을 보내는 계획을 세운다.
계획은 답변 끝에 아래 형식의 코드 블록 하나로 쓴다. AgentHub가 사용자 승인을 받은 뒤 실행한다. 계획이 필요 없는 답변에는 블록을 쓰지 않는다.

${PLAN_EXAMPLE}

- sessions: 새로 만들 세션, 또는 이미 있는 세션 { "key": "...", "id": "<세션 id>" }. key는 이 계획 안에서 부르는 이름이다(영문·숫자·_·-).
- 새 세션은 role에 아래 역할 템플릿 이름을 쓰거나, agent(claude|codex)·permission·roleText를 직접 적는다. isolate(작업 폴더 분리), title, model도 적을 수 있다.
- 새 세션에 prompt를 적으면 만든 뒤 바로 보낸다.
- links: from·to에는 key, 세션 id, 또는 "${ORCHESTRATOR}"(너 자신)를 쓴다. when은 ${CONDITIONS.join("|")}이고 keyword 조건이면 keyword를 적는다(여러 개는 쉼표로 나눈다). note는 받는 세션에 줄 지시다.
- 한 세션에서 나가는 연결은 if/else처럼 고른다: 답변 마지막 줄에 키워드가 맞은 연결 → 없으면 success/error 연결 → 그것도 없으면 otherwise 연결. always는 언제나 함께 넘긴다. 키워드로 가르려면 그 세션의 prompt에 마지막 줄에 쓸 판정을 적어 준다.
- 이미 이어진 두 세션 사이의 연결을 다시 적으면 그 조건으로 고친다.
- 결과를 다시 받아야 하면 그 세션에서 "${ORCHESTRATOR}"로 가는 연결을 만든다. 결과는 다음 요청으로 들어온다.
- send: 이미 있는 세션에 요청을 보낸다. { "to": "<key 또는 id>", "prompt": "..." }
- 같은 파일을 고치는 세션을 동시에 돌리지 않는다. 작업 폴더를 분리한 세션의 변경은 그 세션 브랜치에 남는다.
- 결과가 돌아오면 확인하고 다음 계획을 세운다. 목표를 다 이루었으면 무엇이 어디에 바뀌었는지 정리해 보고한다.`;
}

function roleLines(hub) {
  if (!hub?.roles.length) return "없음. 새 세션은 agent·permission·roleText를 직접 적는다.";
  return hub.roles.map((r) => {
    const body = r.body.split(/\r?\n/).find((l) => l.trim()) ?? "";
    return `- ${r.name}: ${r.agent} · ${r.permission} · ${r.isolate ? "작업 폴더 분리" : "원본 폴더"} — ${body}`;
  }).join("\n");
}

function sessionLines(orchestrator, sessions) {
  const others = sessions.filter((s) => s.id !== orchestrator.id).slice(0, MAX_STATUS_SESSIONS);
  if (!others.length) return "없음";
  return others.map((s) => {
    const role = s.roleName ? ` · 역할 ${s.roleName}` : "";
    return `- ${s.id} · ${s.title} · ${s.agent}${role} · ${STATE_TEXT[s.state] ?? s.state}`;
  }).join("\n");
}

// 첫 요청에는 지휘 규칙·역할 템플릿·세션 목록을, 이후 요청에는 세션 상태만 붙인다.
// sessions: 같은 프로젝트의 세션(최근 순)
export function orchestratorInput(session, prompt, { hub, sessions }) {
  const status = `[현재 세션]\n${sessionLines(session, sessions)}`;
  if (session.agentSessionId) return `${status}\n\n${withRole(session, prompt, hub?.common ?? "")}`;
  return [
    instructions(),
    `[역할 템플릿] (AGENTHUB.md)\n${roleLines(hub)}`,
    status,
    withRole(session, prompt, hub?.common ?? ""),
  ].join("\n\n");
}

// 답변에서 마지막 계획 블록을 꺼낸다. 없으면 null, 형식이 틀리면 { error }.
export function extractPlan(text) {
  const blocks = [...text.matchAll(new RegExp("```" + PLAN_FENCE + "\\s*\\n([\\s\\S]*?)```", "g"))];
  if (!blocks.length) return null;
  try {
    return { plan: JSON.parse(blocks.at(-1)[1]) };
  } catch (err) {
    return { error: `계획 블록이 JSON 형식이 아닙니다: ${err.message}` };
  }
}

const str = (value, max) => String(value ?? "").trim().slice(0, max);

// 계획을 검사해 실행할 수 있는 형태로 바꾼다. 틀린 곳이 있으면 오류를 던진다.
// sessions: 같은 프로젝트의 세션
export function normalizePlan(raw, { hub, sessions, orchestratorId }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("계획은 JSON 객체여야 합니다.");
  const known = new Map(sessions.map((s) => [s.id, s]));
  const keys = new Map(); // key → { id } 또는 { new: true }
  const plan = { sessions: [], links: [], send: [] };

  for (const item of raw.sessions ?? []) {
    const key = str(item?.key, 40);
    if (!/^[\w-]+$/.test(key)) throw new Error(`세션 key가 올바르지 않습니다: "${key}"`);
    if (keys.has(key) || key === ORCHESTRATOR) throw new Error(`세션 key가 겹칩니다: "${key}"`);
    if (item.id) {
      if (!known.has(item.id)) throw new Error(`세션 "${item.id}"이 이 프로젝트에 없습니다.`);
      keys.set(key, { id: item.id });
      plan.sessions.push({ key, id: item.id, title: known.get(item.id).title });
      continue;
    }
    const role = item.role ? hub?.roles.find((r) => r.name === item.role) : null;
    if (item.role && !role) throw new Error(`AGENTHUB.md에 역할 "${item.role}"이 없습니다.`);
    const agent = str(item.agent ?? role?.agent ?? "claude", 20).toLowerCase();
    if (!AGENTS[agent]) throw new Error(`세션 "${key}": agent는 claude 또는 codex입니다.`);
    const modes = AGENTS[agent].PERMISSION_MODES;
    const permission = item.permission ?? (role?.agent === agent ? role.permission : null)
      ?? (agent === "claude" ? "acceptEdits" : "workspace-write");
    if (!modes.includes(permission)) throw new Error(`세션 "${key}": ${agent} 권한은 ${modes.join(", ")} 중 하나입니다.`);
    keys.set(key, { new: true });
    plan.sessions.push({
      key,
      agent,
      permission,
      model: str(item.model ?? role?.model, 64),
      isolate: item.isolate ?? role?.isolate ?? false,
      roleName: role?.name ?? "",
      roleText: str(item.roleText ?? role?.body, 4000),
      title: str(item.title, 100) || role?.name || key,
      prompt: str(item.prompt, 20000),
    });
  }
  if (plan.sessions.filter((s) => !s.id).length > MAX_NEW_SESSIONS) {
    throw new Error(`한 계획에서 새 세션은 ${MAX_NEW_SESSIONS}개까지 만들 수 있습니다.`);
  }

  const ref = (value, where) => {
    const name = str(value, 60);
    if (name === ORCHESTRATOR) return { id: orchestratorId };
    if (keys.has(name)) return { key: name, ...keys.get(name) };
    if (known.has(name)) return { id: name };
    throw new Error(`${where}: "${name}"은 계획의 key나 이 프로젝트의 세션 id가 아닙니다.`);
  };
  const label = (r) => r.key ?? r.id;

  for (const item of raw.links ?? []) {
    const from = ref(item?.from, "연결");
    const to = ref(item?.to, "연결");
    if (label(from) === label(to)) throw new Error(`같은 세션끼리는 연결할 수 없습니다: "${label(from)}"`);
    const when = item.when ?? "success";
    if (!CONDITIONS.includes(when)) throw new Error(`연결 조건은 ${CONDITIONS.join(", ")} 중 하나입니다: "${when}"`);
    const keyword = str(item.keyword, 100);
    if (when === "keyword" && !keyword) throw new Error(`"${label(from)}" → "${label(to)}" 연결에 keyword가 없습니다.`);
    plan.links.push({ from: label(from), to: label(to), when, keyword, note: str(item.note, 4000) });
  }

  for (const item of raw.send ?? []) {
    const to = ref(item?.to, "요청");
    if (to.id === orchestratorId) throw new Error("오케스트레이터 자신에게는 요청을 보낼 수 없습니다.");
    const prompt = str(item.prompt, 20000);
    if (!prompt) throw new Error(`"${label(to)}"에 보낼 prompt가 없습니다.`);
    plan.send.push({ to: label(to), prompt });
  }
  for (const s of plan.sessions) {
    if (s.prompt) plan.send.push({ to: s.key, prompt: s.prompt });
  }

  if (!plan.sessions.length && !plan.links.length && !plan.send.length) throw new Error("계획에 할 일이 없습니다.");
  return plan;
}

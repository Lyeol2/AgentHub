// 글이나 이미지가 있으면 보내고, 비어 있으면 현재 작업을 일시중지하거나 재개한다.
export function composerAction(session, text = "", attachmentCount = 0) {
  const hasContent = !!text.trim() || attachmentCount > 0;
  if (!hasContent && session?.state === "running" && session.paused) {
    return { action: "pausing", label: "멈추는 중", icon: "⏸", title: "작업을 멈추고 있습니다. 잠시 기다려 주세요.", disabled: true };
  }
  if (!hasContent && session?.state === "running") {
    return { action: "pause", label: "일시중지", icon: "⏸", title: "현재 작업을 일시중지합니다. 입력하면 대기열에 요청을 추가할 수 있습니다.", disabled: false };
  }
  if (!hasContent && session?.state === "paused") {
    return { action: "resume", label: "재개", icon: "▶", title: "멈춘 곳부터 이어서 진행합니다.", disabled: false };
  }
  if (session?.state === "running") {
    return { action: "queue", label: "대기열에 추가", icon: "↑", title: "지금 작업이 끝나면 보냅니다 (Enter). 입력을 비우면 일시중지할 수 있습니다.", disabled: !hasContent };
  }
  return {
    action: "send", label: "보내기", icon: "↑", disabled: !hasContent,
    title: session?.state === "paused" ? "이 요청을 보내고 일시중지를 해제합니다 (Enter)." : "요청을 보냅니다 (Enter).",
  };
}

// ── 작성창 자동 완성 ─────────────────────────────────────────────
// 요청 맨 앞의 "/이름"은 명령(스킬·기본 명령), 줄 처음이나 공백 뒤의 "@경로"는 파일 참조다.
// 커서 앞이 그런 자리면 { type, query, start, end }를, 아니면 null을 돌려준다.
export function completionTrigger(text, caret = text.length) {
  const before = String(text ?? "").slice(0, caret);
  const slash = before.match(/^\/([a-z0-9-]*)$/i);
  if (slash) return { type: "command", query: slash[1].toLowerCase(), start: 0, end: caret };
  const at = before.match(/(^|\s)@("?)([^\s"]*)$/);
  if (at) return { type: "file", query: at[3], start: caret - at[3].length - at[2].length - 1, end: caret };
  return null;
}

// 고른 항목으로 커서가 있는 낱말을 바꾼다. 폴더는 이어서 고를 수 있게 공백을 붙이지 않는다.
export function applyCompletion(text, trigger, value) {
  const after = text.slice(trigger.end).replace(/^[^\s"]*"?/, "");
  const insert = trigger.type === "command" ? `/${value}`
    : /\s/.test(value) ? `@"${value}"` : `@${value}`;
  const space = value.endsWith("/") || /^\s/.test(after) ? "" : " ";
  const next = text.slice(0, trigger.start) + insert + space + after;
  return { text: next, caret: trigger.start + insert.length + space.length };
}

// 이름이 query로 시작하는 명령을 앞에, 이름이나 설명에 들어 있는 명령을 뒤에 둔다.
export function filterCommands(commands, query = "") {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.startsWith(q));
  const rest = q ? commands.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || (c.description ?? "").toLowerCase().includes(q))) : [];
  return [...starts, ...rest];
}

// AgentHub가 직접 처리하는 기본 명령. 스킬과 이름이 겹치면 기본 명령이 먼저다.
export const BUILTIN_COMMANDS = [
  { name: "clear", description: "다시 시작: CLI 대화를 새로 시작해 컨텍스트를 비웁니다", builtin: true },
  { name: "export", description: "세션을 .agenthub 파일로 내보냅니다", builtin: true },
  { name: "import", description: "내보낸 기록을 새 세션으로 불러오거나 이 세션에 읽힙니다", builtin: true },
];

// 첨부 없이 기본 명령만 입력하고 보내면 그 명령을 실행한다.
export function builtinCommand(text) {
  const match = String(text ?? "").trim().match(/^\/([a-z]+)$/);
  return match && BUILTIN_COMMANDS.some((c) => c.name === match[1]) ? match[1] : null;
}

// ── 고른 파일 참조 ───────────────────────────────────────────────
// 자동 완성으로 고른 파일은 작성창에 "@파일이름"으로만 보이고, 보낼 때 전체 경로로 바꾼다.
// 이름이 같은 다른 파일을 이미 골랐으면 겹치지 않을 만큼 상위 폴더를 붙인다.
export function refToken(file, refs = new Map()) {
  const parts = String(file).split("/").filter(Boolean);
  for (let n = 1; n <= parts.length; n++) {
    const token = parts.slice(-n).join("/");
    const taken = refs.get(token);
    if (!taken || taken === file) return token;
  }
  return file;
}

const refWord = (token) => (/\s/.test(token) ? `@"${token}"` : `@${token}`);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// text 안의 고른 참조 위치. 긴 이름부터 맞추고 낱말 경계(줄 처음·공백)에서만 찾는다.
export function refMatches(text, refs = new Map()) {
  const tokens = [...refs.keys()].sort((a, b) => b.length - a.length);
  if (!tokens.length) return [];
  const pattern = new RegExp(`(^|\\s)(${tokens.map((t) => escapeRegExp(refWord(t))).join("|")})(?=\\s|$)`, "g");
  const found = [];
  for (const m of String(text ?? "").matchAll(pattern)) {
    const word = m[2];
    const token = word.startsWith('@"') ? word.slice(2, -1) : word.slice(1);
    found.push({ start: m.index + m[1].length, end: m.index + m[0].length, token, file: refs.get(token) });
  }
  return found;
}

// 보낼 요청: 작성창의 "@파일이름"을 CLI가 찾을 수 있는 "@전체/경로"로 바꾼다.
export function expandRefs(text, refs = new Map()) {
  let result = "";
  let last = 0;
  for (const m of refMatches(text, refs)) {
    result += text.slice(last, m.start) + refWord(m.file);
    last = m.end;
  }
  return result + String(text ?? "").slice(last);
}

// 세션의 AI(Claude ↔ Codex)를 바꿀 때 진행 상황을 넘긴다.
// CLI가 다르면 대화를 이어 갈 수 없으므로 AgentHub에 남은 기록을 정리해 새 AI의 첫 요청 앞에 붙인다.
export const AGENT_NAME = { claude: "Claude", codex: "Codex" };

const BUDGET = 24000; // 넘길 기록의 최대 글자 수. 넘치면 첫 요청은 남기고 앞쪽 기록부터 줄인다.
const TEXT_MAX = 2500;
const USER_MAX = 2000;

const cut = (text, max) => {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max)} …(생략)` : s;
};

// 기록 한 건을 한 덩어리 글로. 넘길 필요가 없는 것(상태, 로그, 사용량, 생각)은 null
function line(e) {
  switch (e.kind) {
    case "user":
      if (e.fromTitle) return `[${e.reply ? "답" : e.message ? "메시지" : "넘어온 작업"} · ${e.fromTitle}]\n${cut(e.text, USER_MAX)}`;
      return `[사용자${e.injected ? " · 작업 중 추가" : ""}]\n${cut(e.text, USER_MAX)}`;
    case "text":
      return `[AI]\n${cut(e.text, TEXT_MAX)}`;
    case "tool":
      return `[도구] ${cut(e.text, 300)}`;
    case "tool_result":
      return e.isError ? `[도구 오류] ${cut(e.text, 300)}` : null;
    case "error":
      return `[오류] ${cut(e.text, 500)}`;
    case "message":
      return `[보낸 메시지 → ${e.toTitle}] ${cut(e.text, 500)}`;
    case "question":
      if (!e.questions?.length) return null;
      return `[질문] ${e.questions.map((q) => q.question).join(" / ")}${e.status === "answered" ? " (답함)" : ""}`;
    case "plan":
      return `[계획] ${e.status}${e.result ? ` · ${e.result}` : ""}`;
    default:
      return null;
  }
}

// session: 바꾸기 전 세션(이전 agent·model), files: 기준 커밋 이후 바뀐 파일(git status 형식)
export function handoverText(session, files = "", { previousCwd, previousBranch } = {}) {
  const parts = session.events.map(line).filter(Boolean);
  const firstUser = parts.findIndex((p) => p.startsWith("[사용자"));
  // 첫 요청(작업의 목표)은 꼭 남기고, 나머지는 최근 것부터 예산 안에서 채운다.
  const head = firstUser >= 0 ? [parts[firstUser]] : [];
  const tail = [];
  let used = head.join("\n\n").length;
  for (let i = parts.length - 1; i > firstUser; i--) {
    if (used + parts[i].length > BUDGET) break;
    tail.unshift(parts[i]);
    used += parts[i].length + 2;
  }
  const skipped = parts.length - head.length - tail.length;
  const from = `${AGENT_NAME[session.agent] ?? session.agent}${session.model ? ` (${session.model})` : ""}`;
  const branch = session.worktree ? ` (브랜치 ${session.worktree.branch})` : "";
  return [
    previousCwd ? "[작업 폴더를 바꾼 세션의 진행 상황]" : "[이전 AI에서 이어받은 작업]",
    previousCwd
      ? `이 세션은 지금까지 ${from}로 진행했다. 지금부터 아래 프로젝트 원본 폴더에서 작업한다.`
      : `이 세션은 지금까지 ${from}로 진행했다. 지금부터 네가 같은 작업 폴더에서 이어서 한다.`,
    previousCwd
      ? `이전 작업 폴더: ${previousCwd}${previousBranch ? ` (브랜치 ${previousBranch})` : ""}\n이전 폴더와 브랜치는 보존되어 있지만 변경을 원본으로 자동으로 옮기지는 않았다. 아래 기록의 이전 경로에서 작업하거나 새 worktree를 만들지 않는다. 필요한 변경이 있으면 먼저 원본의 현재 파일과 비교한다.`
      : "아래는 AgentHub에 남은 지금까지의 기록이다. 파일은 작업 폴더의 지금 상태가 최신이므로 필요한 것은 직접 확인한다.",
    `작업 폴더: ${session.cwd}${branch}`,
    "",
    "바뀐 파일:",
    files.replace(/\s+$/, "").replace(/^\n+/, "") || "(없음)", // git status의 앞 칸은 상태 표시라 남긴다.
    "",
    "--- 지금까지의 기록 ---",
    ...head,
    ...(skipped > 0 && tail.length ? [`(… 중간 기록 ${skipped}건 생략)`] : []),
    ...tail,
    "--- 기록 끝 ---",
    "기록에서 끝나지 않은 일이 있으면 이어서 하고, 다 끝났으면 다음 요청을 따른다.",
  ].join("\n\n").replace(/\n{3,}/g, "\n\n");
}

// 권한 모드는 에이전트마다 다르므로 읽기·수정·전체 접근 범위가 비슷한 것으로 옮긴다.
const PERMISSION_MAP = {
  claude: { "read-only": "plan", "workspace-write": "acceptEdits", "auto-review": "acceptEdits", "danger-full-access": "bypassPermissions" },
  codex: { default: "read-only", plan: "read-only", acceptEdits: "workspace-write", bypassPermissions: "danger-full-access" },
};

export function mapPermission(permission, to, { orchestrator = false } = {}) {
  // 오케스트레이터는 읽기만 하되 Claude에서는 질문에 답하는 default 모드를 쓴다.
  if (orchestrator) return to === "claude" ? "default" : "read-only";
  return PERMISSION_MAP[to]?.[permission] ?? null;
}

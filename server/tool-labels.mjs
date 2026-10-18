// 도구 줄 앞에 붙이는 한국어 동작 이름. 원래 요약(도구 이름·경로·명령)은 그대로 두고 앞에만 붙인다.
// 모르는 도구는 null을 돌려 이름만 보이게 한다.

// 명령 안의 `unity` CLI·Unity.exe 실행(셸 감싸기 포함). UnityProjects·~/Unity 같은 경로 이름은 고르지 않는다.
const UNITY_COMMAND = /unity\.exe\b|(^|[\s"'&;|(])unity(?=[\s"')]|$)/i;
const UNITY_NAME = /unity/i;

const CLAUDE_TOOLS = {
  Read: "파일 읽기", NotebookRead: "파일 읽기", LS: "파일 읽기",
  Edit: "파일 수정", MultiEdit: "파일 수정", NotebookEdit: "파일 수정",
  Write: "파일 만들기",
  Bash: "명령 실행", PowerShell: "명령 실행", BashOutput: "명령 실행", KillShell: "명령 실행", KillBash: "명령 실행",
  Grep: "검색", Glob: "검색", ToolSearch: "검색",
  WebFetch: "웹 조회", WebSearch: "웹 조회",
  Task: "하위 작업", Agent: "하위 작업",
  TodoWrite: "할 일 정리",
  Skill: "스킬 사용",
};

export const isUnityCommand = (command) => typeof command === "string" && UNITY_COMMAND.test(command);

// Claude Code 도구 이름과 입력으로 라벨을 정한다.
export function claudeToolLabel(name = "", input = {}) {
  if (typeof name !== "string") return null;
  if (name.startsWith("mcp__")) return UNITY_NAME.test(name.split("__")[1] ?? "") ? "유니티 조작" : "MCP 도구";
  if (CLAUDE_TOOLS[name] === "명령 실행" && isUnityCommand(input?.command)) return "유니티 조작";
  return CLAUDE_TOOLS[name] ?? null;
}

// Codex 항목 종류로 라벨을 정한다.
export function codexToolLabel(item = {}) {
  switch (item.type) {
    case "commandExecution": return isUnityCommand(item.command) ? "유니티 조작" : "명령 실행";
    case "fileChange": {
      const kinds = (item.changes ?? []).map((change) => change.kind?.type ?? change.kind);
      return kinds.length && kinds.every((kind) => kind === "add") ? "파일 만들기" : kinds.length && kinds.every((kind) => kind === "delete") ? "파일 삭제" : "파일 수정";
    }
    case "mcpToolCall": return UNITY_NAME.test(item.server ?? "") ? "유니티 조작" : "MCP 도구";
    case "webSearch": return "웹 조회";
    case "imageView": return "파일 읽기";
    default: return null;
  }
}

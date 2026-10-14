// Codex CLI(`codex exec --json`) 연결.
export const PERMISSION_MODES = ["read-only", "workspace-write"];

export function buildArgs(session) {
  const sandbox = session.permission ?? "workspace-write";
  const args = ["exec"];
  if (session.agentSessionId) {
    // resume에는 --sandbox/--cd가 없으므로 설정 덮어쓰기로 넘기고, 작업 폴더는 cwd로 정한다.
    args.push("resume", session.agentSessionId, "--json", "-c", `sandbox_mode=${sandbox}`);
  } else {
    args.push("--json", "--sandbox", sandbox, "--cd", session.cwd);
  }
  if (session.model) args.push("--model", session.model);
  args.push("-");
  return args;
}

function truncate(text, max = 4000) {
  if (typeof text !== "string") text = JSON.stringify(text);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max}자 생략)` : text;
}

function itemEvents(phase, item) {
  switch (item.type) {
    case "agent_message":
      return phase === "completed" && item.text ? [{ kind: "text", text: item.text }] : [];
    case "reasoning":
      return phase === "completed" && item.text ? [{ kind: "thinking", text: item.text }] : [];
    case "command_execution":
      if (phase === "started") return [{ kind: "tool", text: `$ ${item.command}` }];
      if (phase === "completed") {
        const code = item.exit_code ?? "?";
        return [{
          kind: "tool_result",
          text: truncate(`${item.aggregated_output ?? ""}\n(종료 코드 ${code})`.trim()),
          isError: code !== 0,
        }];
      }
      return [];
    case "file_change":
      if (phase !== "completed") return [];
      return [{ kind: "tool", text: `파일 변경: ${(item.changes ?? []).map((c) => `${c.kind} ${c.path}`).join(", ")}` }];
    case "mcp_tool_call":
      return phase === "started" ? [{ kind: "tool", text: `MCP ${item.server}.${item.tool}` }] : [];
    case "web_search":
      return phase === "started" ? [{ kind: "tool", text: `웹 검색: ${item.query}` }] : [];
    case "todo_list":
      if (phase !== "completed" && phase !== "updated") return [];
      return [{ kind: "status", text: (item.items ?? []).map((t) => `${t.completed ? "☑" : "☐"} ${t.text}`).join("\n") }];
    case "error":
      // 사용자 설정 경고처럼 실행을 막지 않는 메시지다.
      return phase === "completed" ? [{ kind: "log", text: item.message }] : [];
    default:
      return [];
  }
}

// API 오류가 JSON 문자열로 감싸여 오면 안쪽 메시지만 꺼낸다.
function errorText(message) {
  try {
    const parsed = JSON.parse(message);
    return parsed.error?.message ?? parsed.message ?? message;
  } catch {
    return message;
  }
}

export function parseLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [{ kind: "log", text: line }];
  }

  switch (msg.type) {
    case "thread.started":
      return [{ kind: "status", text: "세션 시작", agentSessionId: msg.thread_id }];
    case "item.started":
    case "item.updated":
    case "item.completed":
      return msg.item ? itemEvents(msg.type.split(".")[1], msg.item) : [];
    case "turn.completed": {
      const u = msg.usage;
      const usage = u ? ` · 입력 ${u.input_tokens ?? 0} / 출력 ${u.output_tokens ?? 0} 토큰` : "";
      return [{ kind: "result", text: `턴 완료${usage}` }];
    }
    case "turn.failed":
      return [{ kind: "error", text: errorText(msg.error?.message ?? "턴 실패") }];
    case "error":
      return [{ kind: "error", text: errorText(msg.message ?? "오류") }];
    default:
      return [];
  }
}

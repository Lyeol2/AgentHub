// Claude Code CLI(`claude -p --output-format stream-json`) 연결.
import { randomUUID } from "node:crypto";

// default: 비대화 실행이라 허락이 필요한 도구(수정, 명령)는 거절되고 읽기만 된다.
export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"];

export function buildArgs(session) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  args.push("--permission-mode", session.permission ?? "acceptEdits");
  if (session.model) args.push("--model", session.model);
  for (const dir of session.addDirs ?? []) args.push("--add-dir", dir);
  if (session.agentSessionId) {
    args.push("--resume", session.agentSessionId);
  } else {
    // 세션 ID는 init 이벤트를 받은 뒤에 저장한다. 시작 전에 실패하면 다음 턴에 새 ID로 시도한다.
    args.push("--session-id", randomUUID());
  }
  return args;
}

function truncate(text, max = 4000) {
  if (typeof text !== "string") text = JSON.stringify(text);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max}자 생략)` : text;
}

function toolSummary(name, input = {}) {
  const hint = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description;
  return hint ? `${name}: ${hint}` : name;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  }
  return JSON.stringify(content);
}

// stream-json 한 줄을 공통 이벤트 목록으로 바꾼다.
export function parseLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [{ kind: "log", text: line }];
  }

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        return [{ kind: "status", text: `세션 시작 (${msg.model ?? "기본 모델"})`, agentSessionId: msg.session_id }];
      }
      return [];
    case "assistant": {
      if (msg.error) {
        // 로그인 실패 같은 API 오류는 본문을 오류 하나로만 표시한다.
        const text = (msg.message?.content ?? []).map((b) => b.text).filter(Boolean).join("\n");
        return [{ kind: "error", text: text || msg.error }];
      }
      const events = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && block.text) events.push({ kind: "text", text: block.text });
        else if (block.type === "thinking" && block.thinking) events.push({ kind: "thinking", text: block.thinking });
        else if (block.type === "tool_use") {
          events.push({ kind: "tool", text: toolSummary(block.name, block.input), detail: truncate(block.input) });
        }
      }
      return events;
    }
    case "user": {
      const events = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_result") {
          events.push({ kind: "tool_result", text: truncate(resultText(block.content)), isError: !!block.is_error });
        }
      }
      return events;
    }
    case "rate_limit_event":
      // 화면에 남기지 않고 사용 한도 표시에만 쓴다.
      return msg.rate_limit_info ? [{ kind: "limit", rateLimit: msg.rate_limit_info }] : [];
    case "result": {
      const cost = typeof msg.total_cost_usd === "number" ? ` · 환산 비용 $${msg.total_cost_usd.toFixed(4)}` : "";
      const seconds = msg.duration_ms ? ` · ${(msg.duration_ms / 1000).toFixed(1)}초` : "";
      if (msg.is_error) return [{ kind: "error", text: msg.result ?? "실행 실패" }];
      return [{ kind: "result", text: `턴 완료${seconds}${cost}` }];
    }
    default:
      return [];
  }
}

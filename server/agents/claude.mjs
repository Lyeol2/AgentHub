// Claude Code CLI(`claude -p --input-format stream-json --output-format stream-json`) 연결.
// 요청을 stdin으로 한 줄씩 보내고, 실행 중에 CLI가 묻는 권한 요청·질문(AskUserQuestion)을 control_request로 받아
// 화면에서 답을 받은 뒤 control_response로 돌려준다(Agent SDK가 쓰는 방식과 같다).
import fs from "node:fs";
import { randomUUID } from "node:crypto";

// default: 허락이 필요한 도구(수정, 명령)를 쓸 때마다 화면에서 허용·거절을 묻는다.
export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"];
export const CHAT_PERMISSION = "acceptEdits";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// 별칭은 CLI가 그때그때 최신 모델로 바꿔 준다. 목록에 없는 모델 ID도 직접 입력할 수 있다.
export function models() {
  return [
    { id: "fable", label: "Fable" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ].map((m) => ({ ...m, efforts: EFFORTS }));
}

export const efforts = () => EFFORTS;

// 일반 채팅은 코딩 도구 없이 대화만 한다.
const CHAT_PROMPT = "You are Claude, a helpful AI assistant having a conversation with the user. " +
  "Answer directly and conversationally, using Markdown where it helps. Reply in the language the user writes in.";

// mcp: AgentHub MCP 서버(세션끼리 소통하는 도구). 설정 파일로 넘기고 도구는 묻지 않고 쓰게 한다.
export function buildArgs(session, { mcp = null } = {}) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"];
  if (mcp) args.push("--mcp-config", mcp.configFile, "--allowedTools", "mcp__agenthub");
  args.push("--permission-mode", session.permission ?? "acceptEdits");
  if (session.model) args.push("--model", session.model);
  if (session.effort) args.push("--effort", session.effort);
  if (session.chat) {
    args.push("--tools", "", "--system-prompt", CHAT_PROMPT, "--strict-mcp-config", "--disable-slash-commands");
  }
  for (const dir of session.addDirs ?? []) args.push("--add-dir", dir);
  if (session.agentSessionId) {
    args.push("--resume", session.agentSessionId);
  } else {
    // 세션 ID는 init 이벤트를 받은 뒤에 저장한다. 시작 전에 실패하면 다음 턴에 새 ID로 시도한다.
    args.push("--session-id", randomUUID());
  }
  return args;
}

// ── 실행 중 대화(control 프로토콜) ──────────────────────────────
// stdin을 열어 둔 채 요청을 보낸다. 턴이 끝나면(result) stdin을 닫아 CLI를 끝낸다.
export const interactive = true;

// 지금 턴을 멈춘다(Claude Code에서 Esc를 누른 것과 같다). CLI는 턴을 끝내고 대화 기록을 남긴다.
export const interruptLine = () => JSON.stringify({ type: "control_request", request_id: `interrupt-${randomUUID()}`, request: { subtype: "interrupt" } });

export const initLine = () => JSON.stringify({ type: "control_request", request_id: `init-${randomUUID()}`, request: { subtype: "initialize" } });

export const userLine = (text, attachments = []) => JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }, ...attachments.map((attachment) => ({ type: "image", source: { type: "base64", media_type: attachment.mimeType, data: fs.readFileSync(attachment.path).toString("base64") } }))] },
  parent_tool_use_id: null,
  session_id: "",
});

export const controlResponse = (requestId, response) => JSON.stringify({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response },
});

// CLI가 보낸 control_request를 화면에 띄울 요청으로 바꾼다. 화면에 물을 필요가 없는 요청이면 null.
// { kind: "question" | "permission", ... }
export function parseControl(msg) {
  const req = msg.request ?? {};
  if (req.subtype !== "can_use_tool") return null;
  const input = req.input ?? {};
  if (req.tool_name === "AskUserQuestion") {
    return { kind: "question", questions: input.questions ?? [], input };
  }
  return {
    kind: "permission",
    tool: req.tool_name,
    text: toolSummary(req.tool_name, input),
    detail: truncate(input),
    reason: req.decision_reason ?? null,
    input,
    suggestions: req.permission_suggestions ?? [],
  };
}

// 사용자의 답을 AskUserQuestion 결과로 바꾼다. 키는 질문 문장, 값은 고른 선택지(여러 개면 ", "로 잇는다).
export function questionResponse(input, answers) {
  const result = {};
  (input.questions ?? []).forEach((q, i) => {
    const a = answers?.[i] ?? {};
    const value = [...(a.selected ?? []), String(a.text ?? "").trim()].filter(Boolean).join(", ");
    if (value) result[q.question] = value;
  });
  return { behavior: "allow", updatedInput: { questions: input.questions, answers: result } };
}

// decision: allow | always | deny
export function permissionResponse(pending, decision, message) {
  if (decision === "deny") return { behavior: "deny", message: message || "사용자가 거절했습니다." };
  const response = { behavior: "allow", updatedInput: pending.input };
  if (decision === "always" && pending.suggestions?.length) response.updatedPermissions = pending.suggestions;
  return response;
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
      // 컨텍스트가 차서 CLI가 대화를 요약했다. 세션 수명 표시에 쓴다.
      if (msg.subtype === "compact_boundary") {
        const before = msg.compact_metadata?.pre_tokens;
        return [{ kind: "status", text: `컨텍스트를 압축했습니다${before ? ` (압축 전 ${before.toLocaleString()} 토큰)` : ""}`, compact: true }];
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
        if (block.type === "text" && block.text) {
          // 하나의 답변에 속한 연속 텍스트 블록은 함께 보여 준다.
          const previous = events.at(-1);
          if (previous?.kind === "text") previous.text += "\n\n" + block.text;
          else events.push({ kind: "text", text: block.text });
        }
        else if (block.type === "thinking" && block.thinking) events.push({ kind: "thinking", text: block.thinking });
        else if (block.type === "tool_use") {
          events.push({ kind: "tool", text: toolSummary(block.name, block.input), detail: truncate(block.input) });
        }
      }
      // 이번 호출에 넣은 토큰이 지금 컨텍스트 크기다. 하위 에이전트 호출은 따로 센다.
      const u = msg.message?.usage;
      if (u && !msg.parent_tool_use_id) {
        const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        if (used) events.push({ kind: "usage", context: { used } });
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
      // final: 턴이 끝났다는 표시(runner가 stdin을 닫는다)
      if (msg.is_error) return [{ kind: "error", text: msg.result || (msg.errors ?? []).join("\n") || "실행 실패", final: true }];
      // 모델별 컨텍스트 창 크기. 하위 에이전트 모델이 섞여 있으면 가장 큰 값(주 모델)을 쓴다.
      const windows = Object.values(msg.modelUsage ?? {}).map((m) => m.contextWindow).filter(Number.isFinite);
      const result = { kind: "result", text: `턴 완료${seconds}${cost}`, final: true };
      if (windows.length) result.context = { window: Math.max(...windows) };
      return [result];
    }
    default:
      return [];
  }
}

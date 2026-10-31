// Claude Code CLI(`claude -p --input-format stream-json --output-format stream-json`) 연결.
// 요청을 stdin으로 한 줄씩 보내고, 실행 중에 CLI가 묻는 권한 요청·질문(AskUserQuestion)을 control_request로 받아
// 화면에서 답을 받은 뒤 control_response로 돌려준다(Agent SDK가 쓰는 방식과 같다).
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isImageAttachment } from "../attachments.mjs";
import { attachmentInputText } from "../attachment-input.mjs";
import { claudeToolLabel } from "../tool-labels.mjs";

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
// --include-partial-messages: 답을 쓰는 동안 글자 조각(stream_event)을 받아 화면에 바로 보여 준다.
// --replay-user-messages: 보낸 요청을 CLI가 받으면 다시 돌려준다. 실행 중에 붙인 요청이 실제로 반영됐는지 확인한다.
// unity: 프로젝트 설정의 유니티 통제({ mode, ask, deny }, server/unity-control.mjs). null이면 바꾸지 않는다.
export function buildArgs(session, { mcp = null, unity = null } = {}) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-prompt-tool", "stdio"];
  if (mcp) args.push("--mcp-config", mcp.configFile, "--allowedTools", "mcp__agenthub");
  // /plan 요청은 그 턴만 계획 모드로 실행한다(파일 수정·명령 없이 계획을 세우고 ExitPlanMode로 승인을 묻는다).
  args.push("--permission-mode", session.planTurn ? "plan" : session.permission ?? "acceptEdits");
  // 사용자가 모두 허용을 고른 세션은 /plan으로 시작해도 승인 뒤 원래 권한으로 돌아갈 수 있어야 한다.
  if (session.permission === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
  // "이 세션에서 계속 허용"한 규칙과 유니티 통제는 이 실행에만 쓰는 설정으로 넘긴다(사용자·프로젝트 설정 파일은 고치지 않는다).
  // ask 규칙은 권한 모드가 bypassPermissions여도 묻고, deny 규칙은 allow보다 앞선다.
  if (!session.chat) {
    const remembered = (session.allowRules ?? []).filter((rule) => rule.agent === "claude");
    const permissions = {};
    const allow = remembered.filter((rule) => rule.kind === "rule").map((rule) => rule.rule);
    if (allow.length) permissions.allow = allow;
    if (unity?.ask?.length) permissions.ask = unity.ask;
    if (unity?.deny?.length) permissions.deny = unity.deny;
    if (Object.keys(permissions).length) args.push("--settings", JSON.stringify({ permissions }));
    if (unity?.deny?.length) args.push("--disallowedTools", unity.deny.join(","));
    for (const dir of remembered.filter((rule) => rule.kind === "dir").map((rule) => rule.dir)) if (!session.addDirs?.includes(dir)) args.push("--add-dir", dir);
  }
  if (session.model) args.push("--model", session.model);
  if (session.effort) args.push("--effort", session.effort);
  if (session.chat) {
    args.push("--tools", "", "--system-prompt", CHAT_PROMPT, "--strict-mcp-config", "--disable-slash-commands");
  }
  // 아트 레퍼런스 폴더는 읽을 수 있게 연다(작업 폴더 밖일 때만 들어 있다).
  for (const dir of [...new Set([...(session.addDirs ?? []), ...(session.referenceDirs ?? [])])]) args.push("--add-dir", dir);
  if (session.agentSessionId) {
    args.push("--resume", session.agentSessionId);
  } else {
    // 세션 ID는 init 이벤트를 받은 뒤에 저장한다. 시작 전에 실패하면 다음 턴에 새 ID로 시도한다.
    args.push("--session-id", randomUUID());
  }
  return args;
}

// ── 실행 중 대화(control 프로토콜) ──────────────────────────────
// stdin을 열어 둔 채 요청을 보낸다. 턴이 끝나도(result) CLI를 닫지 않고 두었다가 다음 요청을 같은 프로세스에 쓴다.
// 입력을 닫으면 CLI가 백그라운드 작업(서브에이전트 등)을 강제로 끝내므로, 닫는 시점은 runner가 정한다.
export const interactive = true;
export const keepAlive = true;

// 지금 턴을 멈춘다(Claude Code에서 Esc를 누른 것과 같다). CLI는 턴을 끝내고 대화 기록을 남긴다.
export const interruptLine = () => JSON.stringify({ type: "control_request", request_id: `interrupt-${randomUUID()}`, request: { subtype: "interrupt" } });

// 실행 중인 CLI의 권한 모드를 바로 바꾼다(Agent SDK의 setPermissionMode와 같은 요청).
export const permissionModeLine = (mode, requestId = `mode-${randomUUID()}`) => JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "set_permission_mode", mode } });

// perTaskStopAffordance: 작업별 중지(stop_task)를 쓰는 화면이라고 알린다. 열린 입력에서 interrupt가 턴만 멈추고 백그라운드 작업은 살려 둔다.
// agentProgressSummaries: 서브에이전트 진행 한 줄 요약(task_progress summary)을 받는다.
// forwardSubagentText: 서브에이전트의 글도 parent_tool_use_id를 붙여 보낸다(작업별 최근 활동에만 쓴다).
export const initLine = () => JSON.stringify({ type: "control_request", request_id: `init-${randomUUID()}`, request: { subtype: "initialize", perTaskStopAffordance: true, agentProgressSummaries: true, forwardSubagentText: true } });

// 실행 중인 하위 작업 하나를 멈춘다.
export const stopTaskLine = (taskId, requestId = `stop-task-${randomUUID()}`) => JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "stop_task", task_id: taskId } });

export const userLine = (text, attachments = []) => JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }, ...attachments.map((attachment) => isImageAttachment(attachment)
    ? { type: "image", source: { type: "base64", media_type: attachment.mimeType, data: fs.readFileSync(attachment.path).toString("base64") } }
    : { type: "text", text: attachmentInputText(attachment) })] },
  parent_tool_use_id: null,
  session_id: "",
});

export const controlResponse = (requestId, response) => JSON.stringify({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response },
});

// CLI가 보낸 control_request를 화면에 띄울 요청으로 바꾼다. 화면에 물을 필요가 없는 요청이면 null.
// { kind: "question" | "permission", ... }
export function parseControl(msg, session = {}) {
  const req = msg.request ?? {};
  if (req.subtype !== "can_use_tool") return null;
  const input = req.input ?? {};
  if (req.tool_name === "AskUserQuestion") {
    return { kind: "question", questions: input.questions ?? [], input };
  }
  // 계획 모드를 끝내고 진행할지 묻는다. 승인하면 세션에 고른 권한으로 돌아가 이어서 작업한다.
  if (req.tool_name === "ExitPlanMode") {
    return {
      kind: "permission",
      tool: req.tool_name,
      text: "계획대로 진행할까요?",
      detail: typeof input.plan === "string" ? input.plan : truncate(input),
      reason: null,
      input,
      suggestions: [],
      planApproval: true,
      mode: session.permission && session.permission !== "plan" ? session.permission : "default",
    };
  }
  return {
    kind: "permission",
    tool: req.tool_name,
    text: toolSummary(req.tool_name, input),
    detail: truncate(input),
    reason: req.decision_reason ?? null,
    input,
    suggestions: req.permission_suggestions ?? [],
    rememberLabel: REMEMBER_LABEL,
    rememberDescription: "이 AgentHub 세션에서는 같은 요청을 다시 묻지 않습니다. 다음 요청에서 CLI를 다시 실행해도 유지되며, 세션 설정에서 지울 수 있습니다.",
  };
}

export const REMEMBER_LABEL = "이 세션에서 계속 허용";

// "이 세션에서 계속 허용"으로 받은 CLI 제안을 세션에 남길 규칙으로 바꾼다. 다음 실행 때 buildArgs가 다시 넘긴다.
// rules: [{ key, kind: "rule" | "dir", label, ... }] / mode: 제안에 권한 모드 변경(setMode)이 있으면 그 모드
export function rememberedRules(control) {
  const rules = [];
  let mode = null;
  for (const suggestion of control.suggestions ?? []) {
    if (["addRules", "replaceRules"].includes(suggestion?.type) && (suggestion.behavior ?? "allow") === "allow") {
      for (const r of suggestion.rules ?? []) {
        if (!r?.toolName) continue;
        const rule = r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
        rules.push({ key: `rule:${rule}`, kind: "rule", rule, label: rule });
      }
    } else if (suggestion?.type === "addDirectories") {
      for (const dir of suggestion.directories ?? []) if (typeof dir === "string" && dir) rules.push({ key: `dir:${dir}`, kind: "dir", dir, label: `폴더 접근: ${dir}` });
    } else if (suggestion?.type === "setMode" && typeof suggestion.mode === "string") mode = suggestion.mode;
  }
  return { rules, mode };
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
  if (pending.planApproval) response.updatedPermissions = [{ type: "setMode", mode: pending.mode, destination: "session" }];
  // 이번 CLI 실행에도 바로 적용한다. 사용자·프로젝트 설정 파일에 쓰지 않도록 범위는 session으로 둔다(다음 실행은 AgentHub가 다시 넘긴다).
  if (decision === "always" && pending.suggestions?.length) response.updatedPermissions = pending.suggestions.map((s) => (s && typeof s === "object" && "destination" in s ? { ...s, destination: "session" } : s));
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

// --replay-user-messages로 CLI가 돌려준 사용자 요청의 글. 도구 결과(tool_result)는 요청이 아니므로 null.
export function replayedUserText(msg) {
  if (msg?.type !== "user" || msg.parent_tool_use_id) return null;
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((block) => block?.type === "tool_result")) return null;
  return content.find((block) => block?.type === "text")?.text ?? null;
}

// 하위 작업(서브에이전트·백그라운드 명령) 알림을 { kind: "subtask", phase, taskId, ... }로 바꾼다. runner가 server/subtasks.mjs로 모은다.
const TASK_PHASES = { task_started: "started", task_progress: "progress", task_updated: "updated", task_notification: "notification" };
function subtaskEvents(msg) {
  const phase = TASK_PHASES[msg.subtype];
  if (!phase || typeof msg.task_id !== "string") return [];
  const event = { kind: "subtask", phase, taskId: msg.task_id };
  if (msg.tool_use_id) event.toolUseId = msg.tool_use_id;
  if (msg.description) event.description = msg.description;
  if (phase === "started") Object.assign(event, {
    subagentType: msg.subagent_type ?? null, taskType: msg.task_type ?? null, background: !!msg.is_backgrounded, parentId: msg.parent_task_id ?? null,
    depth: Number.isInteger(msg.spawn_depth) ? msg.spawn_depth : null, prompt: msg.prompt ?? null, ...(msg.ambient || msg.skip_transcript ? { ambient: true } : {}),
  });
  if (phase === "progress") Object.assign(event, { usage: msg.usage ?? null, lastTool: msg.last_tool_name ? claudeToolLabel(msg.last_tool_name) ?? msg.last_tool_name : null, summary: msg.summary ?? null });
  if (phase === "updated") event.patch = msg.patch ?? {};
  if (phase === "notification") Object.assign(event, { status: msg.status, summary: msg.summary ?? null, usage: msg.usage ?? null, outputFile: msg.output_file || null, reason: msg.reason ?? null });
  return [event];
}

// 하위 작업 안의 대화(parent_tool_use_id가 있는 메시지)는 본 기록에 넣지 않고 그 작업의 최근 활동으로만 모은다.
function subtaskActivity(msg) {
  const items = [];
  if (msg.type === "assistant" && msg.error) items.push({ kind: "error", text: (msg.message?.content ?? []).map((b) => b.text).filter(Boolean).join("\n") || msg.error });
  else for (const block of msg.message?.content ?? []) {
    if (msg.type === "assistant" && block.type === "text" && block.text) items.push({ kind: "text", text: block.text });
    else if (msg.type === "assistant" && block.type === "tool_use") items.push({ kind: "tool", name: block.name, label: claudeToolLabel(block.name, block.input) ?? block.name, text: toolSummary(block.name, block.input) });
    else if (block.type === "tool_result" && block.is_error) items.push({ kind: "error", text: resultText(block.content) });
  }
  return items.length ? [{ kind: "subtask_activity", toolUseId: msg.parent_tool_use_id, items }] : [];
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
      return subtaskEvents(msg);
    case "assistant": {
      if (msg.parent_tool_use_id) return subtaskActivity(msg);
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
          const label = claudeToolLabel(block.name, block.input);
          // toolUseId: 이 호출이 띄운 하위 작업(subtasks의 toolUseId)과 화면에서 잇는다.
          events.push({ kind: "tool", text: toolSummary(block.name, block.input), ...(label ? { label } : {}), detail: truncate(block.input), ...(block.id ? { toolUseId: block.id } : {}) });
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
      if (msg.parent_tool_use_id) return subtaskActivity(msg);
      const events = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_result") {
          events.push({ kind: "tool_result", text: truncate(resultText(block.content)), isError: !!block.is_error });
        }
      }
      return events;
    }
    case "stream_event": {
      // 답을 쓰는 중인 글자 조각. 기록에는 남기지 않고 화면에만 잠깐 보여 준다(최종 답변이 오면 지운다).
      // 하위 에이전트의 출력은 본 대화가 아니므로 보이지 않는다.
      if (msg.parent_tool_use_id) return [];
      const event = msg.event ?? {};
      if (event.type === "message_start") return [{ kind: "delta", reset: true }];
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) return [{ kind: "delta", text: event.delta.text }];
      return [];
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

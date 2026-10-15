// Codex CLI app-server 연결. 기존 exec 기록 파서도 유지한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PERMISSION_MODES = ["read-only", "workspace-write", "auto-review", "danger-full-access"];
export const CHAT_PERMISSION = "read-only";
const DEFAULT_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const MODELS_CACHE = path.join(CODEX_HOME, "models_cache.json");
const CONFIG_TOML = path.join(CODEX_HOME, "config.toml");

// ~/.codex/config.toml 맨 위(첫 [표] 앞)의 기본 모델과 추론 강도. 파일이 없거나 값이 없으면 null.
export function configDefaults() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_TOML, "utf8");
  } catch {
    return { model: null, effort: null };
  }
  const top = text.split(/^\s*\[/m)[0];
  const get = (key) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m"))?.[1] ?? null;
  return { model: get("model"), effort: get("model_reasoning_effort") };
}

// Codex가 아는 모든 모델 ID(목록에 보이지 않는 모델 포함). 캐시가 없으면 빈 목록.
export function knownModels() {
  try {
    return (JSON.parse(fs.readFileSync(MODELS_CACHE, "utf8")).models ?? []).map((m) => m.slug).filter(Boolean);
  } catch {
    return [];
  }
}

// 세션이 실제로 쓸 모델과 추론 강도. 결과의 model·effort가 null이면 CLI(config.toml)에 맡긴다.
// 세션에서 고른 모델이나 config.toml의 기본 모델이 Codex 모델 목록(숨은 모델 포함)에 아예 없으면
// 지금 계정에서 쓸 수 없는 모델이라 CLI가 "model is not supported" 오류로 바로 실패한다.
// 그때는 목록의 첫 모델로 바꿔 실행하고, 바꾼 모델이 그 추론 강도를 지원하지 않으면 그 모델의 기본 강도를 쓴다.
export function resolveModel(session = {}, list = models(), config = configDefaults(), known = knownModels()) {
  const source = session.model ? "session" : "config";
  const requested = session.model || config.model;
  const keep = { model: session.model || null, effort: session.effort || null, unavailable: false, configured: requested ?? null, source };
  if (!requested || !list.length || !known.length || known.includes(requested)) return keep;
  const fallback = list[0];
  const wanted = session.effort || (source === "config" ? config.effort : null);
  const fits = !wanted || !fallback.efforts.length || fallback.efforts.includes(wanted);
  // 설정의 강도가 맞으면 CLI가 알아서 쓰므로 세션에서 고른 강도만 넘긴다.
  const effort = fits ? session.effort || null : fallback.defaultEffort ?? null;
  return { model: fallback.id, effort, unavailable: true, configured: requested, source };
}

// 화면에 보일 "모델을 고르지 않았을 때 쓸 모델"
export const defaultModel = () => resolveModel({});

// 새 대화를 시작할 때 기록에 남길 안내(쓸 수 없는 모델을 바꿔 실행할 때만)
// 모델 목록은 그 목록을 받은 Codex 버전이 아는 모델만 담는다. Codex 앱(새 버전)과 오래된 CLI가 같은 목록 파일을 번갈아 쓰므로,
// 새 모델이 빠져 보이면 CLI가 오래된 것일 수 있다고 함께 알린다.
export function modelNote(session, resolved = resolveModel(session)) {
  if (!resolved.unavailable) return null;
  const why = `${resolved.configured}은(는) 지금 Codex CLI가 모르는 모델이라 ${resolved.model}(으)로 실행합니다. CLI가 오래되면 새 모델을 모릅니다(업데이트: npm i -g @openai/codex@latest).`;
  return resolved.source === "session"
    ? `이 세션의 모델 ${why} 또는 세션 설정에서 모델을 바꾸세요.`
    : `Codex 설정의 기본 모델 ${why} 또는 ~/.codex/config.toml의 model을 바꾸세요.`;
}

// Codex CLI가 받아 둔 모델 목록(~/.codex/models_cache.json)과 모델마다 지원하는 추론 강도.
export function models() {
  try {
    const cache = JSON.parse(fs.readFileSync(MODELS_CACHE, "utf8"));
    return (cache.models ?? [])
      .filter((m) => m.slug && m.visibility === "list")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({
        id: m.slug,
        label: m.display_name ?? m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
        defaultEffort: m.default_reasoning_level ?? null,
      }));
  } catch {
    return [];
  }
}

// 모델별 추론 강도를 모두 합친 목록. 캐시가 없으면 기본 목록을 쓴다.
export function efforts() {
  const all = new Set(models().flatMap((m) => m.efforts));
  return all.size ? [...all] : DEFAULT_EFFORTS;
}

// 일반 채팅은 시스템 프롬프트를 바꿀 수 없어 새 대화의 첫 요청 앞에 붙인다.
export const CHAT_INTRO = "[일반 대화] 코딩 작업이 아니라 사용자와 나누는 일반 대화다. " +
  "파일을 읽거나 명령을 실행하지 말고 바로 답한다. 사용자가 쓴 언어로 답한다.";

// app-server는 기존 CLI 로그인·설정을 쓰며 실행 중 승인을 JSON-RPC로 주고받는다.
export const transport = "app-server";
// AgentHub 권한 선택을 CLI 설정과 대화 시작·재개에 같은 정책으로 넘긴다.
export function permissionSettings(session = {}) {
  const permission = session.chat ? CHAT_PERMISSION : session.permission ?? "workspace-write";
  return {
    sandbox: permission === "auto-review" ? "workspace-write" : permission,
    approvalPolicy: session.chat || permission === "danger-full-access" ? "never" : "on-request",
    approvalsReviewer: permission === "auto-review" ? "auto_review" : "user",
  };
}

export function buildArgs(session, { mcp = null, resolved = resolveModel(session) } = {}) {
  const args = ["app-server", "--listen", "stdio://"];
  const policy = permissionSettings(session);
  const settings = { approval_policy: policy.approvalPolicy, approvals_reviewer: policy.approvalsReviewer, sandbox_mode: policy.sandbox };
  if (resolved.model) settings.model = resolved.model;
  if (resolved.effort) settings.model_reasoning_effort = resolved.effort;
  if (session.addDirs?.length) settings["sandbox_workspace_write.writable_roots"] = session.addDirs;
  if (mcp) {
    settings["mcp_servers.agenthub.url"] = mcp.url;
    settings["mcp_servers.agenthub.tool_timeout_sec"] = 660;
    settings["mcp_servers.agenthub.default_tools_approval_mode"] = "approve";
  }
  for (const [key, value] of Object.entries(settings)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  return args;
}

export function parseControl(msg) {
  const { method, params = {} } = msg.request ?? {};
  if (method === "item/tool/requestUserInput") {
    return { kind: "question", input: params, questions: (params.questions ?? []).map((q) => ({ ...q, multiSelect: false })) };
  }
  const tools = { "item/commandExecution/requestApproval": "명령 실행", "item/fileChange/requestApproval": "파일 변경", "item/permissions/requestApproval": "추가 권한" };
  if (!tools[method]) return null;
  const network = params.networkApprovalContext;
  return {
    kind: "permission", method, input: params,
    rememberLabel: "이번 실행에서 허용",
    rememberDescription: "현재 Codex 실행이 끝날 때까지 요청한 범위를 허용합니다. 다음 요청에는 다시 물을 수 있습니다.",
    tool: network ? "네트워크 접근" : tools[method],
    text: network ? `네트워크 접근: ${network.protocol ?? ""} ${network.host ?? ""}`.trim() : params.command || (params.changes?.length ? `파일 변경: ${params.changes.map((change) => change.path).join(", ")}` : tools[method]),
    detail: truncate(params), reason: params.reason ?? null,
    suggestions: params.availableDecisions && !params.availableDecisions.includes("acceptForSession") ? [] : ["session"],
  };
}

export function permissionResponse(control, decision) {
  if (!["allow", "always", "deny"].includes(decision)) throw new Error("올바른 권한 결정을 선택하세요.");
  if (control.method === "item/permissions/requestApproval") {
    return { permissions: decision === "deny" ? {} : control.input.permissions, scope: decision === "always" ? "session" : "turn" };
  }
  const selected = decision === "deny" ? "decline" : decision === "always" ? "acceptForSession" : "accept";
  if (control.input.availableDecisions?.length && !control.input.availableDecisions.includes(selected)) throw new Error("이 요청에서 지원하지 않는 결정입니다.");
  return { decision: selected };
}

export function questionResponse(input, answers) {
  return { answers: Object.fromEntries((input.questions ?? []).map((q, i) => [q.id, { answers: [...(answers?.[i]?.selected ?? []), String(answers?.[i]?.text ?? "").trim()].filter(Boolean) }])) };
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
      if (phase === "started") return [{ kind: "tool", text: `MCP ${item.server}.${item.tool}` }];
      if (phase === "completed") {
        // 승인 거절 같은 실패도 보이게 한다. 성공 결과는 글 부분만 보인다.
        if (item.error) return [{ kind: "tool_result", text: truncate(item.error.message ?? item.error), isError: true }];
        const text = (item.result?.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
        return [{ kind: "tool_result", text: truncate(text || "(결과 없음)") }];
      }
      return [];
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
    case "agenthub_event": return msg.event ? [msg.event] : [];
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

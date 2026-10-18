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

// config.toml에 등록된 MCP 서버 이름. 이름이 따옴표로 묶였거나 파일이 없으면 건너뛴다.
export function configMcpServers(text) {
  if (text === undefined) {
    try { text = fs.readFileSync(CONFIG_TOML, "utf8"); } catch { return []; }
  }
  return [...new Set([...String(text).matchAll(/^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)\s*[.\]]/gm)].map((match) => match[1]))];
}

// config.toml에서 MCP 서버별로 따로 적은 도구 이름([mcp_servers.<서버>.tools.<도구>]). 서버 이름 → 도구 이름 목록
export function configMcpTools(text) {
  if (text === undefined) {
    try { text = fs.readFileSync(CONFIG_TOML, "utf8"); } catch { return {}; }
  }
  const tools = {};
  for (const [, server, tool] of String(text).matchAll(/^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)\.tools\.([A-Za-z0-9_-]+)\s*\]/gm)) (tools[server] ??= []).includes(tool) || tools[server].push(tool);
  return tools;
}

// config.toml에서 켜져 있는 URL 방식 MCP 서버. 명령(stdio) 방식은 미리 연결해 볼 수 없어 뺀다.
export function configMcpUrls(text) {
  if (text === undefined) {
    try { text = fs.readFileSync(CONFIG_TOML, "utf8"); } catch { return []; }
  }
  const servers = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]/);
    if (header) {
      current = header[1].match(/^mcp_servers\.([A-Za-z0-9_-]+)$/) ? { name: header[1].slice("mcp_servers.".length), url: null, enabled: true } : null;
      if (current) servers.push(current);
      continue;
    }
    if (!current) continue;
    const url = line.match(/^\s*url\s*=\s*["']([^"']+)["']/);
    if (url) current.url = url[1];
    if (/^\s*enabled\s*=\s*false\b/.test(line)) current.enabled = false;
  }
  return servers.filter((server) => server.url && server.enabled && server.name !== "agenthub").map(({ name, url }) => ({ name, url }));
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
  // /plan 요청은 그 턴만 읽기 전용으로 실행해 계획만 세우게 한다.
  if (session.planTurn) return { sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user" };
  return {
    sandbox: permission === "auto-review" ? "workspace-write" : permission,
    approvalPolicy: session.chat || permission === "danger-full-access" ? "never" : "on-request",
    approvalsReviewer: permission === "auto-review" ? "auto_review" : "user",
  };
}

// unity: 프로젝트 설정의 유니티 통제({ mode, settings }, server/unity-control.mjs). 서버를 끄거나 도구 승인 방식을 prompt로 덮어쓴다.
export function buildArgs(session, { mcp = null, resolved = resolveModel(session), disabledMcp = [], unity = null } = {}) {
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
  // 연결할 수 없는 사용자 MCP 서버는 이번 실행에서만 끈다. 연결 재시도와 오류 로그를 막는다.
  if (!session.chat) Object.assign(settings, unity?.settings);
  for (const name of disabledMcp) if (/^[A-Za-z0-9_-]+$/.test(name) && name !== "agenthub") settings[`mcp_servers.${name}.enabled`] = false;
  for (const [key, value] of Object.entries(settings)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  return args;
}

export const REMEMBER_LABEL = "이 세션에서 계속 허용";
const REMEMBER_DESCRIPTION = "이 AgentHub 세션에서는 같은 요청을 다시 묻지 않습니다. 다음 요청에서 Codex를 다시 실행해도 AgentHub가 대신 허용하며, 세션 설정에서 지울 수 있습니다.";
// Codex MCP 도구 승인은 MCP elicitation 요청으로 온다(_meta.codex_approval_kind = "mcp_tool_call").
export const MCP_APPROVAL = "mcpServer/elicitation/request";
export const isMcpApproval = (method, params = {}) => method === MCP_APPROVAL && params?._meta?.codex_approval_kind === "mcp_tool_call";

export function parseControl(msg) {
  const { method, params = {} } = msg.request ?? {};
  if (method === "item/tool/requestUserInput") {
    return { kind: "question", input: params, questions: (params.questions ?? []).map((q) => ({ ...q, multiSelect: false })) };
  }
  const remember = { rememberLabel: REMEMBER_LABEL, rememberDescription: REMEMBER_DESCRIPTION };
  if (isMcpApproval(method, params)) {
    const tool = params._meta?.tool_title || params._meta?.tool_name;
    return { kind: "permission", method, input: params, ...remember, tool: "MCP 도구", text: params.message || `MCP ${params.serverName}${tool ? `.${tool}` : ""}`,
      detail: truncate(params), reason: null, suggestions: ["session"] };
  }
  const tools = { "item/commandExecution/requestApproval": "명령 실행", "item/fileChange/requestApproval": "파일 변경", "item/permissions/requestApproval": "추가 권한" };
  if (!tools[method]) return null;
  const network = params.networkApprovalContext;
  return {
    kind: "permission", method, input: params, ...remember,
    tool: network ? "네트워크 접근" : tools[method],
    text: network ? `네트워크 접근: ${network.protocol ?? ""} ${network.host ?? ""}`.trim() : params.command || (params.changes?.length ? `파일 변경: ${params.changes.map((change) => change.path).join(", ")}` : tools[method]),
    detail: truncate(params), reason: params.reason ?? null,
    suggestions: params.availableDecisions && !params.availableDecisions.includes("acceptForSession") && !params.availableDecisions.includes("accept") ? [] : ["session"],
  };
}

export function permissionResponse(control, decision) {
  if (!["allow", "always", "deny"].includes(decision)) throw new Error("올바른 권한 결정을 선택하세요.");
  if (control.method === MCP_APPROVAL) {
    if (decision === "deny") return { action: "decline", content: null };
    const persist = [control.input?._meta?.persist].flat().filter(Boolean);
    return { action: "accept", content: {}, ...(decision === "always" && persist.includes("session") ? { _meta: { persist: "session" } } : {}) };
  }
  if (control.method === "item/permissions/requestApproval") {
    return { permissions: decision === "deny" ? {} : control.input.permissions, scope: decision === "always" ? "session" : "turn" };
  }
  let selected = decision === "deny" ? "decline" : decision === "always" ? "acceptForSession" : "accept";
  // 세션 범위 허용을 지원하지 않는 요청이어도 AgentHub가 규칙을 기억하므로 이번에는 그냥 허용한다.
  if (selected === "acceptForSession" && control.input.availableDecisions?.length && !control.input.availableDecisions.includes(selected)) selected = "accept";
  if (control.input.availableDecisions?.length && !control.input.availableDecisions.includes(selected)) throw new Error("이 요청에서 지원하지 않는 결정입니다.");
  return { decision: selected };
}

// "이 세션에서 계속 허용"한 요청을 세션에 남길 규칙으로 바꾼다. Codex는 다음 실행에 넘길 규칙 플래그가 없어
// 다음 실행부터는 같은 요청이 오면 AgentHub가 카드 없이 대신 허용한다(ruleMatches).
export function rememberedRules(control) {
  const p = control.input ?? {};
  if (control.method === MCP_APPROVAL) {
    const tool = p._meta?.tool_name ?? p._meta?.tool_title ?? p.message ?? "";
    return { rules: [{ key: `mcp:${p.serverName}:${tool}`, kind: "mcp", server: p.serverName, tool, label: `MCP ${p.serverName}${tool ? ` · ${tool}` : ""}` }] };
  }
  if (control.method === "item/permissions/requestApproval") {
    const value = JSON.stringify(p.permissions ?? {});
    return { rules: [{ key: `permissions:${value}`, kind: "permissions", value, label: `추가 권한: ${value}` }] };
  }
  if (p.networkApprovalContext?.host) {
    const host = p.networkApprovalContext.host;
    return { rules: [{ key: `network:${host}`, kind: "network", host, label: `네트워크 접근: ${host}` }] };
  }
  if (control.method === "item/fileChange/requestApproval") {
    const paths = [...new Set((p.changes ?? []).map((change) => change.path).filter(Boolean))].sort();
    return paths.length ? { rules: [{ key: `files:${paths.join("|")}`, kind: "files", paths, label: `파일 변경: ${paths.join(", ")}` }] } : { rules: [] };
  }
  if (control.method === "item/commandExecution/requestApproval" && p.command) {
    return { rules: [{ key: `command:${p.command}`, kind: "command", command: p.command, label: `명령: ${p.command}` }] };
  }
  return { rules: [] };
}

// 저장한 규칙이 이번 요청을 허용하는지. 명령은 같은 명령만, 파일은 저장한 파일 안에서의 변경만 허용한다.
export function ruleMatches(rule, control) {
  const p = control.input ?? {};
  switch (rule.kind) {
    case "mcp": return control.method === MCP_APPROVAL && rule.server === p.serverName && rule.tool === (p._meta?.tool_name ?? p._meta?.tool_title ?? p.message ?? "");
    case "permissions": return control.method === "item/permissions/requestApproval" && rule.value === JSON.stringify(p.permissions ?? {});
    case "network": return !!p.networkApprovalContext && rule.host === p.networkApprovalContext.host;
    case "files": {
      const paths = (p.changes ?? []).map((change) => change.path).filter(Boolean);
      return control.method === "item/fileChange/requestApproval" && paths.length > 0 && paths.every((file) => rule.paths.includes(file));
    }
    case "command": return control.method === "item/commandExecution/requestApproval" && !p.networkApprovalContext && rule.command === p.command;
    default: return false;
  }
}

export function questionResponse(input, answers) {
  return { answers: Object.fromEntries((input.questions ?? []).map((q, i) => [q.id, { answers: [...(answers?.[i]?.selected ?? []), String(answers?.[i]?.text ?? "").trim()].filter(Boolean) }])) };
}

// 셸 명령 도구 이벤트. 긴 명령이나 여러 줄 명령은 한 줄 요약만 보이고, 펼치면 전체 명령을 본다.
export const COMMAND_SUMMARY_MAX = 120;
export function commandEvent(command) {
  const full = String(command ?? "");
  const first = full.split(/\r?\n/)[0];
  const long = full.length > COMMAND_SUMMARY_MAX || first !== full;
  return { kind: "tool", text: `$ ${long ? `${first.slice(0, COMMAND_SUMMARY_MAX)} …` : full}`, ...(long ? { detail: truncate(full) } : {}) };
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
      if (phase === "started") return [commandEvent(item.command)];
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

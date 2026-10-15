// Codex CLI(`codex exec --json`) 연결.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PERMISSION_MODES = ["read-only", "workspace-write"];
export const CHAT_PERMISSION = "read-only";
const DEFAULT_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const MODELS_CACHE = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "models_cache.json");

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

// mcp: AgentHub MCP 서버(세션끼리 소통하는 도구). ask_session은 답을 몇 분까지 기다리므로 도구 제한 시간을 늘린다.
export function buildArgs(session, { mcp = null } = {}) {
  const sandbox = session.permission ?? "workspace-write";
  const args = ["exec"];
  if (session.agentSessionId) {
    // resume에는 --sandbox/--cd가 없으므로 설정 덮어쓰기로 넘기고, 작업 폴더는 cwd로 정한다.
    args.push("resume", session.agentSessionId, "--json", "-c", `sandbox_mode=${sandbox}`);
  } else {
    args.push("--json", "--sandbox", sandbox, "--cd", session.cwd);
  }
  if (session.model) args.push("--model", session.model);
  if (session.effort) args.push("-c", `model_reasoning_effort=${session.effort}`);
  // exec는 승인을 물을 수 없어 승인이 필요한 MCP 도구를 거절하므로, AgentHub 도구는 묻지 않고 쓰게 한다.
  if (mcp) {
    args.push("-c", `mcp_servers.agenthub.url=${mcp.url}`, "-c", "mcp_servers.agenthub.tool_timeout_sec=660",
      "-c", "mcp_servers.agenthub.default_tools_approval_mode=approve");
  }
  // 일반 채팅은 git 저장소가 아닌 빈 폴더에서 실행한다.
  if (session.chat) args.push("--skip-git-repo-check");
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

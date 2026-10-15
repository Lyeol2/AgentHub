// AgentHub MCP 서버(streamable HTTP, JSON 응답만). 세션마다 받은 토큰 주소(/mcp/<토큰>)로 어느 세션이 부르는지 가린다.
// Claude·Codex CLI가 실행될 때 이 주소를 MCP 서버로 붙여, 에이전트가 작업 중에 다른 세션과 소통하게 한다.
import { randomBytes } from "node:crypto";

const PROTOCOL = "2025-06-18";

// 세션 ID ↔ 토큰. 서버를 다시 켜면 새로 만든다(CLI는 턴마다 새로 실행하므로 상관없다).
export class McpTokens {
  constructor() {
    this.bySession = new Map();
    this.byToken = new Map();
  }

  token(sessionId) {
    let token = this.bySession.get(sessionId);
    if (!token) {
      token = randomBytes(24).toString("hex");
      this.bySession.set(sessionId, token);
      this.byToken.set(token, sessionId);
    }
    return token;
  }

  session(token) {
    return this.byToken.get(token) ?? null;
  }

  forget(sessionId) {
    const token = this.bySession.get(sessionId);
    this.bySession.delete(sessionId);
    if (token) this.byToken.delete(token);
  }
}

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// tools: [{ name, description, inputSchema, run(session, args) → 글 }]
// 요청 하나(또는 배치)를 처리해 응답을 돌려준다. 알림뿐이면 null(HTTP 202).
export async function handleRpc(body, session, tools, { name = "agenthub", version = "0", instructions = "" } = {}) {
  const batch = Array.isArray(body);
  const replies = [];
  for (const msg of batch ? body : [body]) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      replies.push(failure(msg?.id ?? null, -32600, "Invalid Request"));
      continue;
    }
    if (msg.id === undefined || msg.id === null) continue; // 알림(notifications/initialized 등)에는 답하지 않는다.
    replies.push(await dispatch(msg, session, tools, { name, version, instructions }));
  }
  if (!replies.length) return null;
  return batch ? replies : replies[0];
}

async function dispatch(msg, session, tools, info) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions,
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return failure(id, -32602, `없는 도구입니다: ${params.name}`);
      try {
        const text = await tool.run(session, params.arguments ?? {});
        return result(id, { content: [{ type: "text", text: String(text) }] });
      } catch (err) {
        // 도구 실패는 에이전트가 읽고 고칠 수 있게 결과로 돌려준다.
        return result(id, { content: [{ type: "text", text: err.message }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `지원하지 않는 메서드입니다: ${method}`);
  }
}

// AgentHub MCP 서버(streamable HTTP, JSON 응답만). 세션마다 받은 토큰 주소(/mcp/<토큰>)로 어느 세션이 부르는지 가린다.
// Claude·Codex CLI가 실행될 때 이 주소를 MCP 서버로 붙여, 에이전트가 작업 중에 다른 세션과 소통하게 한다.
import { randomBytes } from "node:crypto";
import { ASK_TIMEOUT_SEC, ASK_TIMEOUT_MAX } from "./policies/messaging.mjs";

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


// MCP 도구의 schema와 사용자용 결과 형식은 전송 어댑터의 책임이다.
export function createMessagingTools({ mailbox, board, notify = () => {} }) {
  const VIA_TEXT = {
    answer: "보냈다. 상대가 이 답을 기다리던 중이라 바로 받았다.",
    live: "보냈다. 상대가 작업 중이라 지금 하는 작업에 바로 들어갔다.",
    queue: "보냈다. 상대가 쉬고 있으면 바로 시작하고, 실행 중이면 지금 작업이 끝난 뒤 받는다.",
  };

  return [
    {
      name: "list_sessions",
      description: "같은 프로젝트에서 활성화된 노드 연결로 직접 연결된 세션(이름, id, 에이전트, 역할, 상태, 메시지·부르기 가능 여부)만 본다. 메시지를 보내거나 부를 상대를 찾을 때 쓴다.",
      inputSchema: { type: "object", properties: {} },
      run: (session) => mailbox.directory(session),
    },
    {
      name: "send_message",
      description: "활성화된 노드 연결로 직접 연결된 세션에만 필요한 질문·충돌 조율·요청받은 결과를 보낸다. 연결 방향은 구분하지 않는다. 답을 기다리지 않으며 확인·감사 답장이나 반복 상태 보고에는 쓰지 않는다.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "받는 세션의 이름, 역할 이름, 또는 id" },
          text: { type: "string", description: "보낼 내용" },
        },
        required: ["to", "text"],
      },
      run: (session, { to, text }) => {
        const { target, via } = mailbox.send(session, to, text);
        return `"${target.title}"에게 ${VIA_TEXT[via]}`;
      },
    },
    {
      name: "ask_session",
      description: `활성화된 노드 연결로 직접 연결된 세션에 묻고 답이 올 때까지 기다린다(기본 ${ASK_TIMEOUT_SEC}초, 최대 ${ASK_TIMEOUT_MAX}초). 답 없이는 진행할 수 없을 때만 쓴다.`,
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "받는 세션의 이름, 역할 이름, 또는 id" },
          question: { type: "string", description: "물을 내용" },
          timeoutSec: { type: "number", description: "기다릴 최대 시간(초)" },
        },
        required: ["to", "question"],
      },
      run: async (session, { to, question, timeoutSec }) => {
        const { target, answer } = await mailbox.ask(session, to, question, timeoutSec);
        return answer ?? `"${target.title}"에게서 제한 시간 안에 답이 오지 않았다. 늦게 온 답은 다음 요청으로 받는다. 기다리지 말고 할 수 있는 일을 계속한다.`;
      },
    },
    {
      name: "call_session",
      description: `사용자가 이번 요청에서 다른 세션에 넘기거나 부르라고 시켰을 때만 그 세션을 불러 일을 맡긴다. "요청 시 호출" 연결이나 일반 연결로 이어진 세션만 부를 수 있다. 사용자가 세션을 직접 말하지 않았으면 거절되며, 그때는 사용자에게 먼저 묻는다. wait가 true면 결과가 올 때까지 기다린다(기본 ${ASK_TIMEOUT_SEC}초, 최대 ${ASK_TIMEOUT_MAX}초).`,
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "부를 세션의 이름, 역할 이름, 또는 id" },
          task: { type: "string", description: "맡길 일. 상대가 이 글만 보고 일할 수 있게 필요한 맥락(브랜치·커밋·파일·완료 조건)을 함께 쓴다." },
          wait: { type: "boolean", description: "결과가 올 때까지 기다릴지(기본 false)" },
          timeoutSec: { type: "number", description: "기다릴 최대 시간(초)" },
        },
        required: ["to", "task"],
      },
      run: async (session, { to, task, wait = false, timeoutSec }) => {
        if (!wait) {
          const { target, via } = mailbox.call(session, to, task);
          return `"${target.title}" 세션을 불렀다. ${via === "live" ? "상대가 작업 중이라 지금 하는 작업에 바로 들어갔다." : "상대가 쉬고 있으면 바로 시작하고, 실행 중이면 지금 작업이 끝난 뒤 받는다."} 결과는 나중에 메시지로 받는다.`;
        }
        const { target, answer } = await mailbox.callAndWait(session, to, task, timeoutSec);
        return answer ?? `"${target.title}"에게서 제한 시간 안에 결과가 오지 않았다. 늦게 온 결과는 다음 요청으로 받는다. 기다리지 말고 할 수 있는 일을 계속한다.`;
      },
    },
    {
      name: "check_messages",
      description: "작업 중에 나에게 와서 아직 읽지 않은 메시지를 확인한다. 읽은 메시지는 다음 요청으로 다시 오지 않는다.",
      inputSchema: { type: "object", properties: {} },
      run: (session) => mailbox.inbox(session).join("\n\n---\n\n") || "새 메시지가 없다.",
    },
    {
      name: "board_read",
      description: "프로젝트 공유 노트를 읽는다. 다른 세션이 남긴 약속·결정·진행 상황이 있다.",
      inputSchema: { type: "object", properties: {} },
      run: (session) => board.read(session.projectPath) || "공유 노트가 비어 있다.",
    },
    {
      name: "board_post",
      description: "프로젝트 공유 노트에 글을 덧붙인다. API 약속, 정한 사항, 진행 상황처럼 다른 세션도 알아야 할 것을 짧게 남긴다.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "남길 내용(마크다운)" } },
        required: ["text"],
      },
      run: (session, { text }) => {
        board.post(session.projectPath, session.title, text);
        notify("board", { projectPath: session.projectPath });
        return "공유 노트에 남겼다.";
      },
    },
  ];

}

import { handleRpc } from "../mcp.mjs";
import { MESSAGE_GUIDE } from "../policies/messaging.mjs";
import { send, readJson } from "./http.mjs";

export function createMcpHandler({ tokens, store, tools, version }) {
  return async function handleMcp(req, res, token) {
    const sessionId = tokens.session(token);
    const session = sessionId && store.get(sessionId);
    if (!session) return send(res, 404, { error: "알 수 없는 MCP 주소입니다." });
    if (req.method === "DELETE") return send(res, 200, {});
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, {
        jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" },
      });
    }
    const reply = await handleRpc(body, session, tools, {
      name: "agenthub", version, instructions: MESSAGE_GUIDE,
    });
    if (!reply) {
      res.writeHead(202).end();
      return;
    }
    send(res, 200, reply);
  };
}


import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexMcpProbe, tcpReachable } from "../server/codex-mcp-probe.mjs";
import { Runner } from "../server/runner.mjs";
import * as codex from "../server/agents/codex.mjs";

const CONFIG = `model = "gpt"
[mcp_servers.unityMCP]
url = "http://127.0.0.1:8080/mcp"
[mcp_servers.unityMCP.tools.read_console]
enabled = false
[mcp_servers.node_repl]
command = "node"
[mcp_servers.figma]
url = "http://127.0.0.1:3845/mcp"
enabled = false
[mcp_servers.agenthub]
url = "http://127.0.0.1:4517/mcp/x"
`;

test("codex mcp: config에서 켜진 URL 방식 서버만 고른다", () => {
  assert.deepEqual(codex.configMcpUrls(CONFIG), [{ name: "unityMCP", url: "http://127.0.0.1:8080/mcp" }]);
  const args = codex.buildArgs({ id: "s", agent: "codex", events: [] }, { resolved: {}, disabledMcp: ["unityMCP", "agenthub", "bad name"] });
  assert.ok(args.includes("mcp_servers.unityMCP.enabled=false"));
  assert.ok(!args.some((arg) => /agenthub\.enabled|bad name/.test(arg)));
});

test("codex mcp: TCP 연결로 서버가 떠 있는지 확인한다", async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.equal(await tcpReachable(`http://127.0.0.1:${port}/mcp`), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await tcpReachable(`http://127.0.0.1:${port}/mcp`), false);
});

test("codex mcp: 꺼진 서버는 세션 실행에서 빼고 목록이 바뀔 때만 알린다", async () => {
  const state = { up: false };
  const probe = new CodexMcpProbe({ read: () => [{ name: "unityMCP", url: "http://x" }], reachable: async () => state.up });
  await probe.refresh();
  assert.deepEqual(probe.unreachable(), ["unityMCP"]);
  const session = { id: "s", agent: "codex", cwd: process.cwd(), permission: "workspace-write", state: "idle", events: [], agentSessionId: null };
  const calls = [];
  const runner = new Runner({ touch() {}, get: () => session }, { spawn(file, args) {
    calls.push(args);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    return child;
  } });
  runner.unreachableMcp = () => probe.unreachable();
  const turn = () => { runner.send(session, "작업", "fake-codex"); runner.running.get(session.id).emit("close", 0, null); };
  const notes = () => session.events.filter((event) => event.kind === "status" && /MCP/.test(event.text)).length;
  turn(); turn();
  assert.ok(calls[0].includes("mcp_servers.unityMCP.enabled=false"));
  assert.equal(notes(), 1);
  state.up = true; await probe.refresh(); turn();
  assert.ok(!calls[2].includes("mcp_servers.unityMCP.enabled=false"));
  assert.equal(notes(), 2);
});

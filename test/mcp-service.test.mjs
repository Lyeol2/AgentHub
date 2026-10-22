import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionRoutes } from "../server/transport/routes/sessions.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-mcp-service-"));
process.env.AGENTHUB_DATA = path.join(root, "config");
const { createSessionService } = await import("../server/application/sessions.mjs");
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("agenthub-mcp-service-"));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const session = { id: "mcp-session", agent: "claude", cwd: root, state: "running", events: [] };
  const calls = [];
  const status = { agent: "claude", live: true, servers: [], actions: { reconnect: true, reload: false } };
  const runner = {
    async mcpStatus(s, cliPath) { calls.push(["status", s.id, cliPath]); return status; },
    async reconnectMcp(s, serverName) { calls.push(["reconnect", s.id, serverName]); return { message: "재연결 요청됨" }; },
    async reloadMcp(s) { calls.push(["reload", s.id]); return { message: "설정 갱신 요청됨" }; },
    send() { assert.fail("MCP management must not start inference"); },
    inject() { assert.fail("MCP management must not steer a turn"); },
  };
  const service = createSessionService({
    config: {}, dataDir: path.join(root, "data"), mcpDir: path.join(root, "mcp"),
    store: { get: (id) => id === session.id ? session : null }, runner,
    cliPaths: () => ({ claude: "claude-cli", codex: "codex-cli" }),
    projects: { ensureProject() {}, projectSessions: () => [session] },
    chain: { enqueue() { assert.fail("MCP management must not queue a prompt"); } },
  });
  const routes = sessionRoutes(service);
  const request = (method, route, body) => routes.find(([verb, url]) => method === verb && route === url)[2]({ params: { id: session.id }, body });
  return { session, runner, service, calls, status, request };
}

test("MCP routes query and manage the selected session without changing its conversation", async () => {
  const f = fixture();
  const original = structuredClone(f.session);
  assert.deepEqual(await f.request("GET", "sessions/:id/mcp"), f.status);
  assert.deepEqual(await f.request("POST", "sessions/:id/mcp/reconnect", { serverName: "plugin:unity-mcp:editor" }), { message: "재연결 요청됨" });
  f.session.agent = "codex";
  await f.request("GET", "sessions/:id/mcp");
  await f.request("POST", "sessions/:id/mcp/reload");
  assert.deepEqual(f.calls, [
    ["status", f.session.id, "claude-cli"], ["reconnect", f.session.id, "plugin:unity-mcp:editor"],
    ["status", f.session.id, "codex-cli"], ["reload", f.session.id],
  ]);
  assert.deepEqual(f.session, { ...original, agent: "codex" });
});

test("MCP management rejects missing, locked and chat sessions before contacting the CLI", async () => {
  const f = fixture();
  for (const call of [() => f.service.mcpStatus("missing"), () => f.service.reconnectMcp("missing", { serverName: "unity" }), () => f.service.reloadMcp("missing")]) {
    await assert.rejects(call, { status: 404 });
  }
  for (const [changes, status] of [[{ locked: true }, 423], [{ locked: false, chat: true }, 400]]) {
    Object.assign(f.session, changes);
    await assert.rejects(() => f.service.mcpStatus(f.session.id), { status });
    await assert.rejects(() => f.service.reconnectMcp(f.session.id, { serverName: "unity" }), { status });
    await assert.rejects(() => f.service.reloadMcp(f.session.id), { status });
  }
  assert.deepEqual(f.calls, []);
});

test("MCP reconnect validates server names without coercing arbitrary request bodies", async () => {
  const f = fixture();
  for (const body of [undefined, null, {}, { serverName: {} }, { serverName: "  " }, { serverName: "a\n" }, { serverName: "a".repeat(513) }]) {
    await assert.rejects(() => f.service.reconnectMcp(f.session.id, body), { status: 400 });
  }
  assert.deepEqual(f.calls, []);
});

test("MCP failures remain errors rather than appearing as an empty server list or success", async () => {
  const f = fixture();
  const unavailable = async () => { throw new Error("CLI 연결이 끝났습니다."); };
  f.runner.mcpStatus = f.runner.reconnectMcp = f.runner.reloadMcp = unavailable;
  await assert.rejects(() => f.service.mcpStatus(f.session.id), { status: 503, message: "CLI 연결이 끝났습니다." });
  await assert.rejects(() => f.service.reconnectMcp(f.session.id, { serverName: "unity" }), { status: 409 });
  await assert.rejects(() => f.service.reloadMcp(f.session.id), { status: 409 });
});

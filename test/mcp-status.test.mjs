import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Runner } from "../server/runner.mjs";
import { normalizeMcpServers } from "../server/mcp-status.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const secret = "secret-not-for-browser";
const claudeServers = [{ name: "test-mcp", status: "connected", tools: [{ name: "search", description: "자료 찾기" }], config: { env: { TOKEN: secret }, url: `https://example.test/${secret}`, headers: { Authorization: secret } } }];
const codexServers = [{ name: "test-mcp", runtimeStatus: "connected", authStatus: "bearerToken", tools: { search: { name: "search", description: "자료 찾기", inputSchema: { secret } } }, resources: [{ uri: secret }], httpOrigin: "https://private.test" }];

function fixture(t, agent, handler = null) {
  const session = { id: "mcp-session", agent, cwd: process.cwd(), projectPath: process.cwd(), permission: agent === "claude" ? "acceptEdits" : "workspace-write", events: [], state: "idle", agentSessionId: "existing-conversation" };
  const children = [];
  const spawn = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { file, args, options, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), messages: [], killed: false });
    child.emitLine = (message) => { if (!child.stdout.destroyed) child.stdout.write(JSON.stringify(message) + "\n"); };
    child.reply = (request, payload) => child.emitLine(agent === "claude"
      ? { type: "control_response", response: { subtype: "success", request_id: request.request_id, response: payload ?? {} } }
      : { id: request.id, result: payload ?? {} });
    child.kill = () => { child.killed = true; child.emit("close", 0, null); };
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line); child.messages.push(message);
        queueMicrotask(() => {
          if (handler?.(message, child) === false) return;
          if (agent === "claude") {
            if (message.type === "control_request") child.reply(message, message.request.subtype === "mcp_status" ? { mcpServers: claudeServers } : {});
            if (message.type === "user") child.emitLine({ type: "system", subtype: "init", session_id: "existing-conversation", model: "test-model" });
          } else if (message.id) {
            const result = message.method === "mcpServerStatus/list" ? { data: codexServers, nextCursor: null }
              : message.method.startsWith("thread/") ? { thread: { id: "existing-conversation" } }
                : message.method === "turn/start" ? { turn: { id: "active-turn", status: "inProgress" } } : {};
            child.reply(message, result);
          }
        });
      }
    });
    children.push(child);
    return child;
  };
  const runner = new Runner({ touch() {}, get: () => session }, { spawn });
  runner.mcp = () => ({ configFile: "fake-mcp-config.json", url: `http://localhost/mcp/${secret}` });
  runner.kill = (child) => child.kill();
  runner.mcpInspector.timeoutMs = 100;
  runner.mcpInspector.settleMs = 0;
  t.after(() => {
    for (const child of children) {
      if (!child.closed) child.emit("close", 0, null);
      child.appServer?.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });
  return { runner, session, children };
}

test("MCP 화면 응답은 상태·도구만 공개하고 원본 설정·URL·오류·스키마를 버린다", () => {
  const normalized = normalizeMcpServers("claude", [{ ...claudeServers[0], error: secret, tools: [{ name: "safe", description: `참조 https://private/${secret} token=${secret}` }] }]);
  assert.deepEqual(Object.keys(normalized[0]).sort(), ["error", "name", "status", "tools"]);
  assert.equal(JSON.stringify(normalized).includes(secret), false);
  assert.equal(JSON.stringify(normalizeMcpServers("codex", codexServers)).includes(secret), false);
  assert.deepEqual(normalizeMcpServers("codex", [{ name: "configured", runtimeStatus: null, authStatus: "oAuth", tools: {} }]), [{ name: "configured", status: "unknown", authStatus: "oAuth", tools: [] }]);
  const statuses = ["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled", null];
  assert.deepEqual(normalizeMcpServers("codex", statuses.map((runtimeStatus, i) => ({ name: `s${i}`, runtimeStatus }))).map((s) => s.status), ["disconnected", "pending", "connected", "needs-auth", "failed", "disconnected", "disabled", "unknown"]);
});

for (const agent of ["claude", "codex"]) test(`MCP ${agent}: 비활성 세션은 초기화와 조회만 하며 프로브를 중복 실행하지 않는다`, async (t) => {
  const f = fixture(t, agent);
  const first = f.runner.mcpStatus(f.session, "fake-cli");
  const second = f.runner.mcpStatus(f.session, "fake-cli");
  assert.equal(first, second);
  const status = await first;
  assert.equal(f.children.length, 1);
  assert.equal(status.live, false);
  assert.deepEqual(status.actions, { reconnect: false, reload: false });
  assert.match(status.message, /다음 요청 때 새로 연결/);
  assert.equal(status.servers[0].tools[0].name, "search");
  assert.equal(JSON.stringify(status).includes(secret), false);
  const child = f.children[0];
  assert.equal(child.args.includes("--resume"), false);
  assert.equal(child.args.includes("--session-id"), false);
  if (agent === "claude") assert.ok(child.args.includes("--no-session-persistence"));
  assert.ok(child.args.some((arg) => arg.includes(agent === "claude" ? "fake-mcp-config" : "mcp_servers.agenthub")));
  assert.ok(child.messages.every((message) => message.type !== "user" && !/^(thread|turn)\//.test(message.method ?? "")));
  assert.equal(child.killed, true);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(f.runner.procs.size, 0);
  assert.equal(f.runner.mcpInspector.probes.size, 0);
  assert.equal(f.session.agentSessionId, "existing-conversation");
  assert.deepEqual(f.session.events, []);
  assert.equal(f.session.state, "idle");
});

test("MCP Claude: 초기 pending 뒤 한 번 더 상태를 확인한다", async (t) => {
  let statusRequests = 0;
  const f = fixture(t, "claude", (message, child) => {
    if (message.request?.subtype === "mcp_status" && ++statusRequests === 1) {
      child.reply(message, { mcpServers: [{ name: "test-mcp", status: "pending", tools: [] }] }); return false;
    }
  });
  assert.equal((await f.runner.mcpStatus(f.session, "fake-cli")).servers[0].status, "connected");
  assert.equal(statusRequests, 2);
});

for (const failure of ["timeout", "close", "error", "malformed"]) test(`MCP 프로브 ${failure}: 종료 후 설정 목록으로 안내하고 비밀 오류를 공개하지 않는다`, async (t) => {
  const f = fixture(t, "claude", (message, child) => {
    if (message.request?.subtype !== "mcp_status") return;
    if (failure === "close") child.emit("close", 1, null);
    if (failure === "error") child.emit("error", new Error(secret));
    if (failure === "malformed") child.reply(message, { unexpected: secret });
    return false;
  });
  f.runner.mcpInspector.timeoutMs = 15;
  const status = await f.runner.mcpStatus(f.session, "fake-cli");
  assert.equal(status.live, false);
  assert.match(status.message, /완료하지 못해/);
  assert.ok(status.servers.some((s) => s.name === "agenthub" && s.status === "unknown"));
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(f.children[0].killed, true);
  assert.equal(f.children[0].controls.size, 0);
  assert.equal(f.runner.mcpInspector.inflight.size, 0);
});

test("MCP Claude: 점검 중 도구 사용 요청은 거절하고 실행하지 않는다", async (t) => {
  const f = fixture(t, "claude", (message, child) => {
    if (message.request?.subtype === "initialize") child.emitLine({ type: "control_request", request_id: "tool-approval", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo forbidden" } } });
  });
  await f.runner.mcpStatus(f.session, "fake-cli");
  const denial = f.children[0].messages.find((message) => message.response?.request_id === "tool-approval");
  assert.equal(denial.response.response.behavior, "deny");
});

test("MCP Claude: live 초기화를 기다려 조회하고 검증한 서버에만 재연결한다", async (t) => {
  let initialization;
  const f = fixture(t, "claude", (message, child) => {
    if (message.request?.subtype === "initialize") { initialization = message; return false; }
    if (message.type === "user") return false;
  });
  f.runner.send(f.session, "가짜 작업", "fake-cli");
  const checking = f.runner.mcpStatus(f.session, "fake-cli");
  await tick();
  const child = f.children[0];
  assert.equal(child.messages.some((message) => message.request?.subtype === "mcp_status"), false);
  child.reply(initialization);
  const status = await checking;
  assert.equal(status.live, true);
  assert.deepEqual(status.actions, { reconnect: true, reload: false });
  assert.equal(child.killed, false);
  await assert.rejects(f.runner.reconnectMcp(f.session, "missing"), /재연결하지 못했습니다/);
  assert.equal(child.messages.some((message) => message.request?.subtype === "mcp_reconnect"), false);
  await f.runner.reconnectMcp(f.session, "test-mcp");
  assert.equal(child.messages.findLast((message) => message.request?.subtype === "mcp_reconnect").request.serverName, "test-mcp");
  assert.equal(child.messages.filter((message) => message.type === "user").length, 1);
});

test("MCP Codex: live 초기화·thread를 기다리고 pagination에 같은 threadId를 쓴다", async (t) => {
  let initialization;
  const f = fixture(t, "codex", (message, child) => {
    if (message.method === "initialize") { initialization = message; return false; }
    if (message.method === "mcpServerStatus/list") {
      child.reply(message, { data: [{ ...codexServers[0], name: message.params.cursor ? "second" : "first" }], nextCursor: message.params.cursor ? null : "next" }); return false;
    }
  });
  f.runner.send(f.session, "가짜 작업", "fake-cli");
  const checking = f.runner.mcpStatus(f.session, "fake-cli");
  await tick();
  const child = f.children[0];
  assert.equal(child.messages.some((message) => message.method === "mcpServerStatus/list"), false);
  child.reply(initialization);
  const status = await checking;
  assert.deepEqual(status.servers.map((s) => s.name), ["first", "second"]);
  assert.deepEqual(status.actions, { reconnect: false, reload: true });
  for (const message of child.messages.filter((message) => message.method === "mcpServerStatus/list")) assert.equal(message.params.threadId, "existing-conversation");
  assert.equal(child.messages.filter((message) => message.method === "initialize").length, 1);
  const reloaded = await f.runner.reloadMcp(f.session);
  assert.match(reloaded.message, /갱신을 요청/);
  assert.equal(child.messages.findLast((message) => message.method === "config/mcpServer/reload").params, null);
  assert.equal(child.messages.filter((message) => message.method === "turn/start").length, 1);
});

test("MCP live 오류와 재연결 오류는 원본 CLI 오류를 공개하지 않는다", async (t) => {
  let failStatus = true;
  const f = fixture(t, "claude", (message, child) => {
    if ((failStatus && message.request?.subtype === "mcp_status") || message.request?.subtype === "mcp_reconnect") {
      child.emitLine({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: secret } }); return false;
    }
  });
  f.runner.send(f.session, "가짜 작업", "fake-cli");
  await assert.rejects(f.runner.mcpStatus(f.session, "fake-cli"), (error) => !error.message.includes(secret) && /조회하지 못했습니다/.test(error.message));
  failStatus = false;
  await assert.rejects(f.runner.reconnectMcp(f.session, "test-mcp"), (error) => !error.message.includes(secret) && /재연결하지 못했습니다/.test(error.message));
  assert.equal(f.children[0].controls.size, 0);
});

test("MCP 비활성 동작은 새 대화를 실행하거나 설정을 갱신하지 않는다", async (t) => {
  const f = fixture(t, "claude");
  await assert.rejects(f.runner.reconnectMcp(f.session, "test-mcp"), /다음 요청 때 새로 연결/);
  f.session.agent = "codex";
  await assert.rejects(f.runner.reloadMcp(f.session), /다음 요청 때 새로 연결/);
  assert.equal(f.children.length, 0);
});

for (const agent of ["claude", "codex"]) test(`MCP ${agent}: 앱 종료는 대기 중인 점검 프로세스와 요청을 즉시 정리한다`, async (t) => {
  const f = fixture(t, agent, () => false);
  const checking = f.runner.mcpStatus(f.session, "fake-cli");
  await tick();
  assert.equal(f.runner.mcpInspector.probes.size, 1);
  f.runner.stopAll();
  assert.equal(f.children[0].killed, true);
  assert.equal(f.children[0].stdin.destroyed, true);
  assert.equal(f.runner.mcpInspector.probes.size, 0);
  const status = await checking;
  assert.match(status.message, /완료하지 못해/);
  assert.equal(f.runner.mcpInspector.inflight.size, 0);
  assert.equal(f.children[0].controls.size, 0);
  assert.ok(f.children[0].messages.every((message) => message.type !== "user" && !/^(thread|turn)\//.test(message.method ?? "")));
});

test("MCP Claude: 연결이 늦으면 여러 번 확인하고 앱 종료 뒤에는 재조회하지 않는다", async (t) => {
  let requests = 0, keepPending = false;
  const f = fixture(t, "claude", (message, child) => {
    if (message.request?.subtype === "mcp_status" && (++requests < 4 || keepPending)) {
      child.reply(message, { mcpServers: [{ name: "test-mcp", status: "pending", tools: [] }] }); return false;
    }
  });
  assert.equal((await f.runner.mcpStatus(f.session, "fake-cli")).servers[0].status, "connected");
  assert.equal(requests, 4);
  keepPending = true;
  f.runner.mcpInspector.settleMs = 40;
  const checking = f.runner.mcpStatus(f.session, "fake-cli");
  await tick();
  const before = requests;
  f.runner.stopAll();
  await checking;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests, before);
  assert.equal(f.runner.mcpInspector.probes.size, 0);
});

test("MCP Claude: 계속 pending이면 제한된 재조회 뒤 현재 상태를 반환한다", async (t) => {
  let requests = 0;
  const f = fixture(t, "claude", (message, child) => {
    if (message.request?.subtype === "mcp_status") {
      requests++;
      child.reply(message, { mcpServers: [{ name: "test-mcp", status: "pending", tools: [] }] }); return false;
    }
  });
  f.runner.mcpInspector.timeoutMs = 1000;
  const status = await f.runner.mcpStatus(f.session, "fake-cli");
  assert.equal(status.servers[0].status, "pending");
  assert.equal(requests, 13);
  assert.equal(f.children[0].killed, true);
});

test("MCP 점검은 CLI 업데이트 중 새 프로세스를 띄우지 않는다", async (t) => {
  const f = fixture(t, "claude");
  f.runner.isUpdating = () => true;
  const status = await f.runner.mcpStatus(f.session, "fake-cli");
  assert.equal(f.children.length, 0);
  assert.match(status.message, /완료하지 못해/);
  assert.equal(status.servers.find((server) => server.name === "agenthub").status, "unknown");
});

test("MCP live Claude: 조회 시간 초과 후 늦은 원본 오류를 기록에 노출하지 않는다", async (t) => {
  let request;
  const f = fixture(t, "claude", (message) => {
    if (message.request?.subtype === "mcp_status") { request = message; return false; }
  });
  f.runner.mcpInspector.timeoutMs = 15;
  f.runner.send(f.session, "가짜 작업", "fake-cli");
  await assert.rejects(f.runner.mcpStatus(f.session, "fake-cli"), /조회하지 못했습니다/);
  const child = f.children[0];
  assert.equal(child.controls.size, 0);
  child.emitLine({ type: "control_response", response: { subtype: "error", request_id: request.request_id, error: secret } });
  assert.equal(JSON.stringify(f.session.events).includes(secret), false);
});

test("MCP Codex: 반복 pagination cursor는 중단하고 원본 오류 없이 정리한다", async (t) => {
  const f = fixture(t, "codex", (message, child) => {
    if (message.method === "mcpServerStatus/list") {
      child.reply(message, { data: codexServers, nextCursor: "repeat" }); return false;
    }
  });
  const status = await f.runner.mcpStatus(f.session, "fake-cli");
  assert.match(status.message, /완료하지 못해/);
  assert.equal(f.children[0].messages.filter((message) => message.method === "mcpServerStatus/list").length, 2);
  assert.equal(f.children[0].killed, true);
  assert.equal(JSON.stringify(status).includes(secret), false);
});

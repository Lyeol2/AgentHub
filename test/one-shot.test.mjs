import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { askOnce, oneShotArgs, selectOneShotAgent } from "../server/one-shot.mjs";
import { configMcpServers } from "../server/agents/codex.mjs";

function fixture(options = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { child.killed = true; child.emit("close", null); };
  let call;
  const promise = askOnce({ cliPaths: () => ({ claude: "claude-fixture", codex: "codex-fixture" }), prompt: "draft only", cwd: process.cwd(), ...options,
    spawn: (file, args, config) => { call = { file, args, config }; return child; } });
  return { child, promise, call };
}

test("one-shot: explicit provider and model reach the matching read-only CLI", async () => {
  const codex = fixture({ agent: "codex", model: "chosen-codex-model" });
  assert.equal(codex.call.file, "codex-fixture");
  assert.ok(codex.call.args.includes("read-only"));
  assert.equal(codex.call.args[codex.call.args.indexOf("--model") + 1], "chosen-codex-model");
  codex.child.stdout.write(JSON.stringify({ item: { type: "agent_message", text: "draft" } }) + "\n"); codex.child.emit("close", 0);
  assert.equal(await codex.promise, "draft");
  const claude = fixture({ agent: "claude" });
  assert.ok(claude.call.args.includes("Read,Glob,Grep"));
  assert.ok(claude.call.args.includes("--no-session-persistence"));
  assert.ok(!claude.call.args.includes("--model"));
  claude.child.stdout.write(JSON.stringify({ result: "draft two" })); claude.child.emit("close", 0);
  assert.equal(await claude.promise, "draft two");
  assert.throws(() => selectOneShotAgent({ claude: "present" }, "codex"), /Codex CLI/);
});

test("one-shot: CLI errors and empty answers cannot masquerade as successful drafts", async () => {
  for (const [options, out, code] of [
    [{ agent: "claude" }, JSON.stringify({ is_error: true, result: "not logged in" }), 0],
    [{ agent: "codex" }, JSON.stringify({ type: "turn.failed", error: { message: "login required" } }), 0],
    [{ agent: "codex" }, "", 0],
    [{ agent: "codex" }, JSON.stringify({ item: { type: "agent_message", text: "partial" } }), 1],
  ]) {
    const f = fixture(options);
    f.child.stdout.write(out); f.child.emit("close", code);
    await assert.rejects(f.promise, (error) => error.status === 502);
  }
});

test("one-shot: timeout and output limits terminate work and return actionable errors", async () => {
  const timed = fixture({ agent: "codex", timeoutMs: 5 });
  await assert.rejects(timed.promise, (error) => error.reason === "assistant-timeout");
  assert.equal(timed.child.killed, true);
  const large = fixture({ agent: "codex" });
  large.child.stdout.write("x".repeat(2_000_001));
  await assert.rejects(large.promise, (error) => error.reason === "assistant-output");
  assert.equal(large.child.killed, true);
});

test("one-shot: Codex 사용자 MCP 서버를 끄고 실패 이유를 MCP 연결 로그로 가리지 않는다", async () => {
  assert.deepEqual(configMcpServers('model = "x"\n[mcp_servers.unityMCP]\nurl = "http://127.0.0.1:8080/mcp"\n[mcp_servers.unityMCP.tools.read_console]\n[mcp_servers.node_repl.env]\n[mcp_servers."quoted name"]\n'),
    ["unityMCP", "node_repl"]);
  const args = oneShotArgs({ agent: "codex", cwd: ".", mcpServers: ["unityMCP"] });
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "mcp_servers.unityMCP.enabled=false"]);
  assert.ok(!oneShotArgs({ agent: "claude", cwd: ".", mcpServers: ["unityMCP"] }).includes("-c"));
  const noise = 'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest("http://127.0.0.1:8080/mcp"))\n';
  const failed = fixture({ agent: "codex" });
  failed.child.stderr.write(noise);
  failed.child.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } }) + "\n");
  await new Promise((resolve) => setImmediate(resolve));
  failed.child.emit("close", 1);
  await assert.rejects(failed.promise, (error) => /usage limit/.test(error.message) && !/rmcp/.test(error.message));
  const silent = fixture({ agent: "codex" });
  silent.child.stderr.write(noise);
  await new Promise((resolve) => setImmediate(resolve));
  silent.child.emit("close", 1);
  await assert.rejects(silent.promise, (error) => /설치·로그인/.test(error.message) && !/rmcp/.test(error.message));
});

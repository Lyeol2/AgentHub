import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { askOnce, selectOneShotAgent } from "../server/one-shot.mjs";

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

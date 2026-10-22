import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { createEventStream } from "../server/transport/sse.mjs";
import { CodexAppServer } from "../server/codex-app-server.mjs";
import { WorkflowRuntime } from "../server/workflow-runtime.mjs";

test("SSE bounds a stalled client without delaying healthy subscribers", () => {
  const stream = createEventStream({ maxBufferedBytes: 4096 });
  const slow = new Writable({ highWaterMark: 1024, write() {} });
  slow.writeHead = () => {};
  let healthy = 0;
  const fast = new Writable({ write(chunk, encoding, next) { healthy++; next(); } });
  fast.writeHead = () => {};
  stream.connect(new EventEmitter(), slow);
  stream.connect(new EventEmitter(), fast);
  for (let i = 0; i < 100; i++) stream.broadcast("event", { text: "x".repeat(1000) });
  assert.equal(slow.destroyed, true);
  assert.ok(slow.writableLength <= 4096);
  assert.equal(healthy, 101);
  stream.close();
});

test("SSE shutdown releases stalled connections even below the buffer limit", () => {
  const stream = createEventStream();
  const slow = new Writable({ write() {} });
  slow.writeHead = () => {};
  stream.connect(new EventEmitter(), slow);
  stream.broadcast("event", { text: "Pending output" });
  stream.close();
  assert.equal(slow.destroyed, true);
});

test("Codex keeps approval metadata only while its item is active", () => {
  const protocol = new CodexAppServer({ stdin: { write() {} } }, {}, { resolved: {} });
  const events = [];
  protocol.on("event", event => events.push(event));
  for (let i = 0; i < 100; i++) {
    protocol.item(false, { id: String(i), type: "commandExecution", command: "git status", cwd: "C:/repo", aggregatedOutput: "x".repeat(100000) });
    assert.deepEqual(protocol.items.get(String(i)), { type: "commandExecution", command: "git status", cwd: "C:/repo" });
    protocol.item(true, { id: String(i), type: "commandExecution", aggregatedOutput: "x".repeat(100000), exitCode: 0 });
  }
  assert.equal(protocol.items.size, 0);
  assert.equal(events.filter(event => event.kind === "tool_result").length, 100);
});

test("workflow pruning and deleting nodes release obsolete flow references", () => {
  const chain = { runner: { isRunning: () => false }, runs: new Map(), queue: new Map(), links: { list: () => [] }, node: () => null,
    controls: { ensure() {}, steps: new Map(), stopped: new Set() } };
  const runtime = new WorkflowRuntime(chain);
  for (let i = 0; i < 1000; i++) runtime.set({ id: String(i) }, runtime.create());
  assert.ok(runtime.flows.size <= 256);
  assert.ok(runtime.nodes.size <= 256);
  for (const flow of runtime.nodes.values()) assert.ok(runtime.flows.has(flow.id));
  runtime.forgetNode("999");
  assert.equal(runtime.nodes.has("999"), false);
});

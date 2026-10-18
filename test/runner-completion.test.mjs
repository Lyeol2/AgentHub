import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Runner } from "../server/runner.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const GRACE_MS = 4000;

// Exercise Runner's real stream parser and close handler without starting a CLI.
function fixture(t, agent = "claude") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = { id: "completion", agent, cwd: process.cwd(), permission: agent === "codex" ? "workspace-write" : "acceptEdits", state: "idle", events: [] };
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), messages: [] });
  const emit = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  const notify = (method, params = {}) => emit({ method, params: { threadId: "thread", ...params } });
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      child.messages.push(message);
      if (agent !== "codex" || !message.method || !message.id) continue;
      queueMicrotask(() => {
        const result = message.method.startsWith("thread/") ? { thread: { id: "thread" } }
          : message.method === "turn/start" ? { turn: { id: "turn", status: "inProgress" } } : {};
        if (message.method === "turn/start") notify("turn/started", { turn: result.turn });
        emit({ id: message.id, result });
      });
    }
  });
  child.stdin.once("finish", () => queueMicrotask(() => child.emit("close", 0, null)));
  // 턴이 끝나면 CLI를 바로 닫는 설정(백그라운드 작업이 없을 때). 띄워 두는 동작은 runner-keepalive.test.mjs에서 확인한다.
  const runner = new Runner({ touch() {}, get: () => session }, { spawn: () => child, keepAlive: () => ({ idleMinutes: 0 }) });
  const ended = [];
  runner.on("turnEnd", (endedSession, ok) => ended.push([endedSession.id, ok]));
  t.after(() => {
    child.appServer?.close();
    if (runner.isRunning(session.id)) child.emit("close", 0, null);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
  runner.send(session, "작업", "fake-cli");
  const complete = () => emit({ type: "result", is_error: false, result: "완료" });
  return { runner, session, child, emit, notify, complete, ended };
}

async function assertEnded(f, ok = true) {
  assert.equal(f.child.stdin.writableEnded, true, "completion must close CLI input");
  await tick();
  assert.equal(f.runner.isRunning(f.session.id), false);
  assert.equal(f.session.state, ok ? "idle" : "error");
  assert.equal(f.session.runningStartedAt, null);
  assert.deepEqual(f.ended, [[f.session.id, ok]], "turnEnd must fire once");
}

test("runner completion: matching Claude assistant and final errors still close the turn", async (t) => {
  const f = fixture(t);
  f.emit({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Invalid API key" }] } });
  f.emit({ type: "result", is_error: true, result: "Invalid API key" });
  await assertEnded(f, false);
  assert.equal(f.session.events.filter((event) => event.kind === "error").length, 1);
});

test("runner completion: matching Codex error and failed-turn messages still shut down", async (t) => {
  const f = fixture(t, "codex");
  await tick();
  f.notify("error", { error: { message: "사용 한도 초과" }, willRetry: false });
  f.notify("turn/completed", { turn: { id: "turn", status: "failed", error: { message: "사용 한도 초과" } } });
  await assertEnded(f, false);
  assert.equal(f.session.events.filter((event) => event.kind === "error").length, 1);
});

for (const [name, trailer] of [
  ["rate-limit notification", { type: "rate_limit_event", rate_limit_info: { status: "allowed" } }],
  ["control response", { type: "control_response", response: { subtype: "success", request_id: "late-init", response: {} } }],
  ["ignored system status", { type: "system", subtype: "status", status: null }],
  ["unsupported control request", { type: "control_request", request_id: "status", request: { subtype: "status" } }],
  ["user text echo", { type: "user", message: { role: "user", content: [{ type: "text", text: "요청 입력 확인" }] } }],
]) {
  test("runner completion: injected turn closes after a trailing " + name, async (t) => {
    const f = fixture(t);
    f.runner.inject(f.session, "추가 조건");
    f.complete();
    t.mock.timers.tick(2000);
    f.emit(trailer);
    t.mock.timers.tick(GRACE_MS - 2001);
    assert.equal(f.child.stdin.writableEnded, false);
    t.mock.timers.tick(1);
    await assertEnded(f);
  });
}

for (const [name, continuing] of [
  ["streamed message start", { type: "stream_event", event: { type: "message_start", message: { role: "assistant", content: [] } } }],
  ["next assistant turn", { type: "assistant", message: { content: [{ type: "text", text: "추가 요청을 처리합니다" }] } }],
  ["tool result", { type: "user", message: { content: [{ type: "tool_result", content: "도구 출력", tool_use_id: "tool-1" }] } }],
  ["permission request", { type: "control_request", request_id: "permission", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" } } }],
  ["user question", { type: "control_request", request_id: "question", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "어느 환경?", options: [{ label: "개발" }, { label: "운영" }] }] } } }],
]) {
  test("runner completion: an actual " + name + " keeps injected work alive until its final result", async (t) => {
    const f = fixture(t);
    f.runner.inject(f.session, "추가 작업");
    f.complete();
    t.mock.timers.tick(2000);
    f.emit(continuing);
    t.mock.timers.tick(GRACE_MS);
    assert.equal(f.child.stdin.writableEnded, false);
    assert.equal(f.session.state, "running");
    assert.deepEqual(f.ended, []);
    if (continuing.type === "control_request") {
      assert.equal(f.session.waiting, true);
      f.runner.answer(continuing.request_id, continuing.request.tool_name === "AskUserQuestion"
        ? { answers: [{ selected: ["개발"] }] } : { decision: "allow" });
    }
    f.complete();
    t.mock.timers.tick(GRACE_MS);
    await assertEnded(f);
  });
}

test("runner completion: multiple injections and continued work cannot lose the last completion", async (t) => {
  const f = fixture(t);
  f.runner.inject(f.session, "첫 추가 작업");
  f.runner.inject(f.session, "두 번째 추가 작업");
  f.complete();
  t.mock.timers.tick(2000);
  f.emit({ type: "assistant", message: { content: [{ type: "text", text: "남은 요청 처리" }] } });
  t.mock.timers.tick(GRACE_MS);
  assert.equal(f.child.stdin.writableEnded, false);
  f.complete();
  f.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  f.emit({ type: "control_response", response: { subtype: "success", request_id: "late", response: {} } });
  t.mock.timers.tick(GRACE_MS);
  await assertEnded(f);
});


test("runner completion: injection during grace keeps stdin open before any next output", async (t) => {
  const f = fixture(t);
  f.runner.inject(f.session, "첫 추가 작업");
  f.complete();
  t.mock.timers.tick(2000);
  f.runner.inject(f.session, "완료 직후 새 요청");
  t.mock.timers.tick(GRACE_MS + 1);
  assert.equal(f.child.stdin.writableEnded, false, "new input must cancel the previous completion timer immediately");
  assert.equal(f.session.state, "running");
  assert.deepEqual(f.ended, []);
  f.complete();
  t.mock.timers.tick(GRACE_MS);
  await assertEnded(f);
});

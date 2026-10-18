import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Runner, ACTIVITY_NOTIFY_MS } from "../server/runner.mjs";
import { claudeToolLabel, codexToolLabel, isUnityCommand } from "../server/tool-labels.mjs";
import { stopwatch, setTimingSink } from "../server/timing.mjs";
import { runActivity, STALL_AFTER_S } from "../public/shared/activity.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("도구 라벨: Claude·Codex 도구를 한국어 동작 이름으로 묶고, 모르는 도구는 이름만 둔다", () => {
  assert.equal(claudeToolLabel("Read"), "파일 읽기");
  assert.equal(claudeToolLabel("Write"), "파일 만들기");
  assert.equal(claudeToolLabel("MultiEdit"), "파일 수정");
  assert.equal(claudeToolLabel("Bash", { command: "npm test" }), "명령 실행");
  assert.equal(claudeToolLabel("Bash", { command: "unity -batchmode -projectPath ." }), "유니티 조작");
  assert.equal(claudeToolLabel("Bash", { command: "ls C:/UnityProjects" }), "명령 실행");
  assert.equal(claudeToolLabel("Grep"), "검색");
  assert.equal(claudeToolLabel("WebFetch"), "웹 조회");
  assert.equal(claudeToolLabel("mcp__agenthub__send_message"), "MCP 도구");
  assert.equal(claudeToolLabel("mcp__unityMCP__manage_scene"), "유니티 조작");
  assert.equal(claudeToolLabel("SomethingNew"), null);
  assert.equal(codexToolLabel({ type: "commandExecution", command: "git status" }), "명령 실행");
  assert.equal(codexToolLabel({ type: "fileChange", changes: [{ kind: { type: "add" }, path: "a" }] }), "파일 만들기");
  assert.equal(codexToolLabel({ type: "fileChange", changes: [{ kind: "update", path: "a" }, { kind: "add", path: "b" }] }), "파일 수정");
  assert.equal(codexToolLabel({ type: "mcpToolCall", server: "unityMCP", tool: "x" }), "유니티 조작");
  assert.equal(codexToolLabel({ type: "webSearch" }), "웹 조회");
  assert.equal(codexToolLabel({ type: "agentMessage" }), null);
  assert.equal(isUnityCommand('"C:/Program Files/Unity/Editor/Unity.exe" -quit'), true);
});

test("진행 표시: 시작 중·응답 없음·멈춘 것 같음을 나누고, 권한·질문 대기는 멈춤으로 보지 않는다", () => {
  const now = Date.parse("2026-10-18T10:05:00.000Z");
  const at = (s) => new Date(now - s * 1000).toISOString();
  assert.equal(runActivity({ state: "idle", runPhase: "starting" }, now), null);
  assert.equal(runActivity({ state: "running", runPhase: "starting", runningStartedAt: at(1) }, now).tone, "start");
  assert.equal(runActivity({ state: "running", runPhase: "starting", runningStartedAt: at(STALL_AFTER_S + 5) }, now).tone, "stall");
  assert.equal(runActivity({ state: "running", runPhase: "working", lastOutputAt: at(3) }, now), null);
  assert.deepEqual(runActivity({ state: "running", runPhase: "working", lastOutputAt: at(12) }, now), { tone: "quiet", text: "12초째 응답 없음" });
  assert.match(runActivity({ state: "running", runPhase: "working", lastOutputAt: at(75) }, now).text, /^1분 15초째 응답 없음 · 멈춘 것 같으면/);
  assert.equal(runActivity({ state: "running", runPhase: "working", lastOutputAt: at(600), waiting: true }, now).tone, "wait");
});

test("단계별 소요 시간은 AGENTHUB_DEBUG=timing일 때만 남긴다", () => {
  const lines = [];
  const previous = process.env.AGENTHUB_DEBUG;
  setTimingSink((line) => lines.push(line));
  try {
    delete process.env.AGENTHUB_DEBUG;
    stopwatch("t", "x").step("a");
    assert.deepEqual(lines, []);
    process.env.AGENTHUB_DEBUG = "timing";
    const clock = stopwatch("task.create", "p");
    clock.step("원격 확인");
    clock.total();
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[timing\] task\.create 원격 확인 \d+ms \(p\)$/);
  } finally {
    setTimingSink(null);
    if (previous === undefined) delete process.env.AGENTHUB_DEBUG; else process.env.AGENTHUB_DEBUG = previous;
  }
});

// 실제 Runner의 스트림 처리로 Claude CLI를 흉내 낸다.
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const session = { id: "progress", agent: "claude", cwd: process.cwd(), permission: "acceptEdits", state: "idle", events: [] };
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const emit = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  child.stdin.resume();
  child.stdin.once("finish", () => queueMicrotask(() => child.emit("close", 0, null)));
  // 턴이 끝나면 CLI를 바로 닫는 설정(백그라운드 작업이 없을 때)으로 종료 처리를 확인한다.
  const runner = new Runner({ touch() {}, get: () => session }, { spawn: () => child, keepAlive: () => ({ idleMinutes: 0 }) });
  const seen = { activity: [], draft: [], updates: [], requeue: [] };
  runner.on("activity", (_, activity) => seen.activity.push(activity));
  runner.on("draft", (_, draft) => seen.draft.push(draft));
  runner.on("eventUpdate", (_, seq, patch) => seen.updates.push([seq, patch]));
  runner.on("requeue", (_, items) => seen.requeue.push(items));
  t.after(() => {
    if (runner.isRunning(session.id)) child.emit("close", 0, null);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
  runner.send(session, "작업", "fake-cli");
  return { runner, session, child, emit, seen };
}

test("Runner: 첫 출력 전에는 시작 중, 출력이 오면 마지막 출력 시각을 몇 초에 한 번만 알린다", async (t) => {
  const f = fixture(t);
  assert.equal(f.session.runPhase, "starting");
  assert.deepEqual(f.seen.activity.at(-1), { runPhase: "starting", lastOutputAt: null, waiting: false });
  f.emit({ type: "system", subtype: "init", session_id: "abc" });
  await tick();
  assert.equal(f.session.runPhase, "working");
  assert.ok(f.session.lastOutputAt);
  const count = f.seen.activity.length;
  f.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  await tick();
  assert.equal(f.seen.activity.length, count, "잦은 출력은 매번 알리지 않는다");
  t.mock.timers.tick(ACTIVITY_NOTIFY_MS);
  f.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  await tick();
  assert.equal(f.seen.activity.length, count + 1);
  f.emit({ type: "result", is_error: false, result: "완료" });
  await tick();
  await tick();
  assert.equal(f.session.state, "idle");
  assert.equal("runPhase" in f.session, false);
  assert.equal("lastOutputAt" in f.session, false);
});

test("Runner: 쓰는 중인 글은 모아서 화면에만 보내고 기록에는 최종 답변 하나만 남긴다", async (t) => {
  const f = fixture(t);
  f.emit({ type: "stream_event", event: { type: "message_start", message: {} } });
  for (const text of ["안", "녕"]) f.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  await tick();
  t.mock.timers.tick(200);
  assert.equal(f.seen.draft.length, 1);
  assert.equal(f.seen.draft[0].text, "안녕");
  f.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "!" } } });
  f.emit({ type: "assistant", message: { content: [{ type: "text", text: "안녕!" }] } });
  await tick();
  t.mock.timers.tick(200);
  assert.equal(f.seen.draft.length, 1, "최종 답변이 온 뒤에는 남은 조각을 보내지 않는다");
  assert.deepEqual(f.session.events.filter((event) => event.kind === "text").map((event) => event.text), ["안녕!"]);
});

test("Runner: 추가 요청은 CLI가 돌려주면 반영됨, 턴 종료와 겹쳐 돌려주지 않으면 대기열로 되돌린다", async (t) => {
  const f = fixture(t);
  f.emit({ type: "user", message: { role: "user", content: [{ type: "text", text: "작업" }] } });
  await tick();
  f.runner.inject(f.session, "첫 추가");
  const first = f.session.events.at(-1);
  assert.equal(first.delivery, "sent");
  f.emit({ type: "user", message: { role: "user", content: [{ type: "text", text: "첫 추가" }] } });
  await tick();
  assert.equal(first.delivery, "applied");
  assert.deepEqual(f.seen.updates.at(-1), [first.seq, { delivery: "applied" }]);
  f.runner.inject(f.session, "늦은 추가");
  const late = f.session.events.at(-1);
  f.emit({ type: "result", is_error: false, result: "완료" });
  await tick();
  t.mock.timers.tick(5000);
  await tick();
  await tick();
  assert.equal(f.runner.isRunning(f.session.id), false);
  assert.equal(late.delivery, "requeued");
  assert.deepEqual(f.seen.requeue, [[{ text: "늦은 추가", meta: {} }]]);
  assert.ok(f.session.events.some((event) => event.kind === "status" && /대기열로 되돌렸습니다/.test(event.text)));
  assert.throws(() => f.runner.inject(f.session, "끝난 뒤"), /실행 중이 아닙니다/);
});

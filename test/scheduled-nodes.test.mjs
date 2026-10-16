import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Chain } from "../server/chain.mjs";
import { WorkflowRuntime } from "../server/workflow-runtime.mjs";
import { ScheduledNodes } from "../server/scheduled-nodes.mjs";
import { MAX_SCHEDULE_TIMEOUT_MS } from "../server/schedule.mjs";

const START = Date.parse("2026-10-16T00:00:00Z");
const minute = 60_000;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function clock() {
  let now = START, id = 0;
  const timers = new Map();
  return {
    timers, now: () => now,
    setTimer(fn, delay) {
      const timer = { id: ++id, at: now + delay, delay, unref() {} };
      timers.set(timer, fn); return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    async advance(ms) {
      now += ms;
      for (let guard = 0; guard < 100; guard++) {
        const entry = [...timers].filter(([timer]) => timer.at <= now).sort(([a], [b]) => a.at - b.at)[0];
        if (!entry) break;
        timers.delete(entry[0]); entry[1](); await flush();
        assert.ok(guard < 99, "timer loop remains bounded");
      }
      await flush();
    },
  };
}

function fixture(t, fields = {}, { approve = false } = {}) {
  const time = clock();
  const node = { id: "cmd-schedule", kind: "schedule", title: "예약", projectPath: "C:/project", state: "idle", scheduleEnabled: false,
    nextRunAt: null, scheduleMode: "interval", intervalMinutes: 1, prompt: "예약 {{scheduledAt}} / 실행 {{triggeredAt}}", ...fields };
  const nodes = new Map([[node.id, node], ["next", { id: "next", state: "idle", projectPath: node.projectPath }]]);
  const running = new Set(), calls = [], errors = [], events = [], link = { id: "link", from: node.id, to: "next", approve };
  const chain = {
    disposed: false, runs: new Map(), queue: new Map(),
    runner: { isRunning: (id) => running.has(id) },
    commands: { get: (id) => nodes.get(id), list: () => [...nodes.values()].filter((node) => node.kind), update: (node, patch) => Object.assign(node, patch) },
    node: (id) => nodes.get(id), links: { list: () => [link], update: (link, patch) => Object.assign(link, patch) },
    controls: { ensure() {}, begin() {}, finish() {}, refresh() {}, fail: (node, flow, error) => errors.push({ node, flow, error }) },
    notify: (...args) => events.push(args), pickFlowLinks: () => [link], checkGroups: async () => {},
    hold: (link, node, text, depth, flow) => { link.pending = { answer: text, flow }; calls.push({ approval: true, text, flow }); },
    deliver: async (link, depth, text, sourceRun, flow) => { calls.push({ text, flow }); },
  };
  const runtime = new WorkflowRuntime(chain);
  chain.workflow = runtime;
  runtime.schedules = new ScheduledNodes(runtime, time);
  t.after(() => { chain.disposed = true; runtime.dispose(); });
  return { node, nodes, running, chain, runtime, time, calls, link, errors, events };
}

test("scheduled nodes: arming returns immediately; one-shot creates one normal flow with timestamp variables", async (t) => {
  const f = fixture(t, { scheduleMode: "once", runAt: new Date(START + minute).toISOString() });
  await f.runtime.run(f.node);
  assert.equal(f.node.state, "scheduled"); assert.equal(f.node.scheduleEnabled, true);
  assert.equal(f.calls.length, 0); assert.equal(f.chain.runs.get(f.node.id).kind, "schedule");
  await f.time.advance(minute - 1); assert.equal(f.calls.length, 0);
  await f.time.advance(1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].flow.variables, { scheduledAt: new Date(START + minute).toISOString(), triggeredAt: new Date(START + minute).toISOString() });
  assert.match(f.calls[0].text, /예약 2026-10-16T00:01:00.000Z/);
  assert.equal(f.node.scheduleEnabled, false); assert.equal(f.node.nextRunAt, null); assert.equal(f.node.state, "success");
  assert.equal(f.node.lastRun.runId, f.calls[0].flow.id);
  assert.equal(f.runtime.entry(f.calls[0].flow).results.get(f.node.id).text, f.calls[0].text);
  assert.equal(f.chain.runs.has(f.node.id), false); assert.equal(f.time.timers.size, 0);
  await f.time.advance(10 * minute); assert.equal(f.calls.length, 1);
});

test("scheduled nodes: past time and invalid templates are rejected before changing persistent state", async (t) => {
  const f = fixture(t, { scheduleMode: "once", runAt: new Date(START).toISOString() });
  await assert.rejects(f.runtime.run(f.node), { code: "SCHEDULE_EXPIRED" });
  assert.equal(f.node.scheduleEnabled, false); assert.equal(f.node.state, "idle"); assert.equal(f.time.timers.size, 0);
  f.node.runAt = new Date(START + minute).toISOString(); f.node.prompt = "{{missing}}";
  await assert.rejects(f.runtime.run(f.node), /값을 찾을 수 없습니다/);
  assert.equal(f.time.timers.size, 0); assert.equal(f.chain.runs.size, 0);
});

test("scheduled nodes: intervals skip while a downstream session, pause or queue is active", async (t) => {
  const f = fixture(t);
  f.chain.deliver = async (...args) => {
    const flow = args[4]; f.calls.push({ flow }); f.runtime.set(f.nodes.get("next"), flow); f.running.add("next");
  };
  f.runtime.startSchedule(f.node);
  await f.time.advance(minute); assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.active(f.calls[0].flow), true);
  await f.time.advance(5 * minute); assert.equal(f.calls.length, 1);
  assert.equal(f.node.nextRunAt, new Date(START + 7 * minute).toISOString());
  f.running.clear(); f.nodes.get("next").waiting = true;
  await f.time.advance(minute); assert.equal(f.calls.length, 1);
  f.nodes.get("next").waiting = false; f.chain.queue.set("next", [{ flow: f.calls[0].flow }]);
  await f.time.advance(minute); assert.equal(f.calls.length, 1);
  f.chain.queue.clear(); f.runtime.settle(); assert.equal(f.calls.length, 1, "settling never flushes missed ticks");
  await f.time.advance(minute); assert.equal(f.calls.length, 2); assert.notEqual(f.calls[0].flow.id, f.calls[1].flow.id);
  assert.equal(f.node.state, "scheduled");
});

test("scheduled nodes: approval is part of the preceding flow and skipped ticks never overwrite it", async (t) => {
  const f = fixture(t, {}, { approve: true });
  f.runtime.startSchedule(f.node); await f.time.advance(minute);
  const flow = f.link.pending.flow;
  await f.time.advance(4 * minute);
  assert.equal(f.calls.length, 1); assert.equal(f.link.pending.flow, flow);
  f.link.pending = null; f.runtime.settle(); assert.equal(f.calls.length, 1);
  await f.time.advance(minute); assert.equal(f.calls.length, 2); assert.notEqual(f.link.pending.flow.id, flow.id);
});

test("scheduled nodes: asynchronous handoff blocks overlaps even before any target starts", async (t) => {
  const f = fixture(t);
  let release;
  f.chain.deliver = (...args) => { f.calls.push({ flow: args[4] }); return new Promise((resolve) => { release = resolve; }); };
  f.runtime.startSchedule(f.node); await f.time.advance(minute);
  assert.equal(f.runtime.active(f.calls[0].flow), true);
  await f.time.advance(3 * minute); assert.equal(f.calls.length, 1);
  release(); await flush();
  assert.equal(f.runtime.active(f.calls[0].flow), false, "waiting schedule handle does not keep the flow active");
  await f.time.advance(minute); assert.equal(f.calls.length, 2);
  release(); await flush();
});

test("scheduled nodes: stopping disarms future timers without cancelling the launched workflow", async (t) => {
  const f = fixture(t);
  f.runtime.startSchedule(f.node); await f.time.advance(minute);
  const flow = f.calls[0].flow;
  f.chain.runs.get(f.node.id).stop();
  assert.equal(f.node.state, "idle"); assert.equal(f.node.scheduleEnabled, false); assert.equal(f.node.nextRunAt, null);
  assert.equal(flow.cancelled, false); assert.equal(f.time.timers.size, 0); assert.equal(f.chain.runs.size, 0);
  await f.time.advance(10 * minute); assert.equal(f.calls.length, 1);
});

test("scheduled nodes: late errors from stopped/rearmed delivery cannot disable the new schedule", async (t) => {
  const f = fixture(t);
  let reject;
  f.chain.deliver = (...args) => { f.calls.push({ flow: args[4] }); return new Promise((_, fail) => { reject = fail; }); };
  f.runtime.startSchedule(f.node); await f.time.advance(minute);
  f.chain.runs.get(f.node.id).stop(); f.runtime.startSchedule(f.node);
  await f.time.advance(minute); assert.equal(f.calls.length, 1, "old in-flight handoff is still counted after rearm");
  reject(new Error("late delivery failed")); await flush();
  assert.equal(f.node.state, "scheduled"); assert.equal(f.node.scheduleEnabled, true); assert.equal(f.errors.length, 0);
  f.chain.deliver = async (...args) => f.calls.push({ flow: args[4] });
  await f.time.advance(minute); assert.equal(f.calls.length, 2);
});

test("scheduled nodes: one-shot rearmed during an older workflow expires visibly instead of waiting forever", async (t) => {
  const f = fixture(t);
  f.chain.deliver = async (...args) => {
    const flow = args[4]; f.calls.push({ flow }); f.runtime.set(f.nodes.get("next"), flow); f.running.add("next");
  };
  f.runtime.startSchedule(f.node); await f.time.advance(minute);
  f.chain.runs.get(f.node.id).stop();
  Object.assign(f.node, { scheduleMode: "once", runAt: new Date(START + 2 * minute).toISOString() });
  f.runtime.startSchedule(f.node); await f.time.advance(minute);
  assert.equal(f.calls.length, 1); assert.equal(f.node.state, "error");
  assert.equal(f.node.scheduleEnabled, false); assert.equal(f.node.nextRunAt, null);
  assert.match(f.node.lastRun.tail, /이전 예약 실행이 아직 진행 중/);
  assert.equal(f.time.timers.size, 0); assert.equal(f.chain.runs.size, 0);
  assert.equal(f.running.has("next"), true); assert.equal(f.calls[0].flow.cancelled, false);
  assert.equal(f.errors.length, 0, "skipping an occurrence must not fail the older workflow's history");
  assert.equal(f.node.lastRun.runId, undefined, "the scheduling error must not masquerade as the preceding run");
});

test("scheduled nodes: handoff failures stop repeating and one-shot schedules with an actionable error", async (t) => {
  for (const scheduleMode of ["once", "interval"]) {
    const f = fixture(t, { scheduleMode, runAt: new Date(START + minute).toISOString() });
    f.chain.deliver = async () => { throw new Error("destination unavailable"); };
    f.runtime.startSchedule(f.node); await f.time.advance(minute);
    assert.equal(f.node.state, "error"); assert.equal(f.node.scheduleEnabled, false); assert.equal(f.node.nextRunAt, null);
    assert.match(f.node.lastRun.tail, /destination unavailable.*다시 시작/);
    assert.equal(f.errors.length, 1); assert.equal(f.chain.runs.size, 0); assert.equal(f.time.timers.size, 0);
    assert.equal(f.runtime.entry(f.errors[0].flow).results.get(f.node.id).ok, false, "failed delivery replaces the source's success snapshot for execution history");
  }
});

test("scheduled nodes: deletion and dispose release every timer; dispose preserves enabled state for restart", async (t) => {
  const f = fixture(t);
  f.runtime.startSchedule(f.node); const savedNext = f.node.nextRunAt;
  f.runtime.dispose();
  assert.equal(f.time.timers.size, 0); assert.equal(f.chain.runs.size, 0); assert.equal(f.node.scheduleEnabled, true); assert.equal(f.node.nextRunAt, savedNext);
  f.runtime.restoreSchedules(); assert.equal(f.time.timers.size, 1);
  f.nodes.delete(f.node.id); await f.time.advance(minute);
  assert.equal(f.calls.length, 0); assert.equal(f.chain.runs.size, 0); assert.equal(f.time.timers.size, 0);
});

test("scheduled nodes: restore expires missed once and advances repeating cadence without catch-up", async (t) => {
  const f = fixture(t, { scheduleEnabled: true, nextRunAt: new Date(START + minute).toISOString() });
  await f.time.advance(4 * minute);
  f.runtime.restoreSchedules(); f.runtime.restoreSchedules();
  assert.equal(f.node.nextRunAt, new Date(START + 5 * minute).toISOString()); assert.equal(f.time.timers.size, 1); assert.equal(f.calls.length, 0);
  await f.time.advance(minute); assert.equal(f.calls.length, 1);
  const expired = fixture(t, { scheduleEnabled: true, scheduleMode: "once", runAt: new Date(START - minute).toISOString() });
  expired.runtime.restoreSchedules();
  assert.equal(expired.node.scheduleEnabled, false); assert.equal(expired.node.state, "error"); assert.match(expired.node.lastRun.tail, /이미 지났습니다/);
  assert.equal(expired.calls.length, 0); assert.equal(expired.time.timers.size, 0);
});

test("scheduled nodes: future one-shot restores and waits in bounded chunks beyond the timer limit", async (t) => {
  const f = fixture(t, { scheduleEnabled: true, scheduleMode: "once", runAt: new Date(START + MAX_SCHEDULE_TIMEOUT_MS + minute).toISOString() });
  f.runtime.restoreSchedules();
  assert.equal([...f.time.timers.keys()][0].delay, MAX_SCHEDULE_TIMEOUT_MS);
  await f.time.advance(MAX_SCHEDULE_TIMEOUT_MS);
  assert.equal(f.calls.length, 0); assert.equal([...f.time.timers.keys()][0].delay, minute);
  await f.time.advance(minute); assert.equal(f.calls.length, 1); assert.equal(f.node.scheduleEnabled, false);
});

test("scheduled nodes: real Chain hands scheduled variables through transformation to a session", async (t) => {
  const time = clock(), calls = [], active = new Set();
  const node = { id: "cmd-timer", kind: "schedule", title: "예약", projectPath: "C:/project", state: "idle",
    scheduleMode: "interval", intervalMinutes: 1, prompt: "요청 {{scheduledAt}}", scheduleEnabled: false };
  const transform = { id: "cmd-transform", kind: "transform", title: "가공", projectPath: node.projectPath,
    transformMode: "template", template: "{{input}} / {{triggeredAt}}" };
  const session = { id: "session", title: "작업", agent: "claude", projectPath: node.projectPath, cwd: node.projectPath, state: "idle", events: [] };
  const commandList = [node, transform];
  const links = [{ id: "l1", from: node.id, to: transform.id, enabled: true, when: "success" }, { id: "l2", from: transform.id, to: session.id, enabled: true, when: "success" }];
  const runner = Object.assign(new EventEmitter(), {
    isRunning: (id) => active.has(id),
    append: (node, event) => node.events.push(event),
    send(node, text) { calls.push(text); active.add(node.id); node.state = "running"; node.events.push({ kind: "user", text }); },
  });
  const chain = new Chain({ runner, autoTurnEnd: false,
    store: { get: (id) => id === session.id ? session : null, list: () => [session], touch() {} },
    commands: { get: (id) => commandList.find((node) => node.id === id), list: () => commandList, update: (node, patch) => Object.assign(node, patch) },
    links: { list: () => links, from: (id) => links.filter((link) => link.from === id), update: (link, patch) => Object.assign(link, patch) },
    cliPaths: () => ({ claude: "unused-fixture-cli" }), compose: (_node, text) => text,
  });
  chain.workflow.schedules = new ScheduledNodes(chain.workflow, time);
  t.after(() => chain.dispose());
  await chain.runCommand(node); assert.equal(calls.length, 0);
  await time.advance(minute);
  assert.deepEqual(calls, ["요청 2026-10-16T00:01:00.000Z / 2026-10-16T00:01:00.000Z"]);
  const flow = chain.flowFor(session);
  assert.equal(flow.id, node.lastRun.runId); assert.equal(transform.lastRun.runId, flow.id);
  await time.advance(3 * minute); assert.equal(calls.length, 1);
  assert.equal(chain.stopCommand(node), true); assert.equal(flow.cancelled, false);
  assert.equal(node.scheduleEnabled, false); assert.equal(time.timers.size, 0);
});

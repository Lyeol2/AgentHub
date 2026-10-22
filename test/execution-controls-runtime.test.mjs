import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Chain } from "../server/chain.mjs";
import { RunHistoryStore } from "../server/run-history.mjs";
import { createHub } from "../server/bootstrap.mjs";

test("execution schedule: timed sessions share variables and history, and stopping a run disarms its reservation", async t => {
  const f = fixture(t, { nodes: [
    { id: "cmd-schedule", kind: "schedule", title: "매분 작업", scheduleMode: "interval", intervalMinutes: 1, prompt: "예약 요청 {{scheduledAt}}" },
    { id: "cmd-notify", kind: "notify", title: "예약 완료", message: "{{scheduledAt}}: {{input}}" },
  ], connections: [{ from: "cmd-schedule", to: "a" }, { from: "a", to: "cmd-notify" }] });
  let now = Date.now(), callback;
  const schedules = f.chain.workflow.schedules;
  schedules.now = () => now;
  schedules.setTimer = fn => { callback = fn; return { unref() {} }; };
  schedules.clearTimer = () => { callback = null; };
  const node = f.node("cmd-schedule");
  await f.chain.runCommand(node);
  assert.equal(f.runner.calls.length, 0);
  const firstAt = node.nextRunAt;
  now += 60_000; callback();
  await until(() => f.runner.calls.length === 1, "timer should start the connected AI session");
  assert.equal(f.runner.calls[0].prompt, `예약 요청 ${firstAt}`);
  const firstRun = node.lastRun.runId;
  assert.equal(f.history.get(firstRun).steps.find(step => step.nodeId === node.id).result.runId, firstRun);
  assert.equal(f.chain.flowFor(f.sessions.get("a")).id, firstRun);
  await f.complete("a", "정리 완료");
  await until(() => f.history.get(firstRun)?.status === "success", "the waiting reservation must not keep completed history running");
  assert.equal(f.history.get(firstRun).variables.scheduledAt, firstAt);
  assert.match(f.node("cmd-notify").lastRun.outputText, /정리 완료/);
  assert.equal(node.scheduleEnabled, true);
  now += 60_000; callback();
  await until(() => f.runner.calls.length === 2, "next occurrence creates another session invocation");
  const secondRun = node.lastRun.runId;
  assert.notEqual(secondRun, firstRun);
  assert.equal(f.history.get(secondRun).steps.find(step => step.nodeId === node.id).result.runId, secondRun);
  f.chain.stopRun(secondRun);
  assert.equal(node.scheduleEnabled, false);
  assert.equal(node.nextRunAt, null);
  assert.equal(callback, null);
  assert.deepEqual(f.runner.stops, ["a"]);
  assert.equal(f.history.get(firstRun).status, "success");
  assert.equal(f.history.get(secondRun).status, "stopped");
});

class FakeRunner extends EventEmitter {
  calls = [];
  stops = [];
  running = new Set();
  isRunning(id) { return this.running.has(id); }
  append(session, event) { session.events.push(event); }
  send(session, prompt, cli, input, meta = {}) {
    this.calls.push({ id: session.id, prompt, input, meta });
    this.running.add(session.id);
    session.state = "running";
    session.events.push({ kind: "user", text: prompt, ...meta });
  }
  stop(session) { this.stops.push(session.id); return true; }
  stopAll() { this.running.clear(); }
  setState(session, state) { session.state = state; }
  dropPrompts() {}
}

async function until(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), message);
}

function fixture(t, { nodes = [], connections = [], runGit } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-execution-controls-"));
  const dataDir = path.join(directory, "data");
  const opened = [];
  function create(history = new RunHistoryStore({ dataDir })) {
    const sessions = new Map(["a", "b", "next"].map(id => [id, { id, title: id.toUpperCase(), agent: "claude", cwd: directory, projectPath: directory, state: "idle", events: [] }]));
    const commands = nodes.map(node => ({ state: "idle", lastRun: null, projectPath: directory, ...node }));
    const links = connections.map((link, i) => ({ id: "link-" + i, enabled: true, when: "success", note: "", ...link }));
    const runner = new FakeRunner();
    const events = [], shellRuns = [];
    const chain = new Chain({ history, autoTurnEnd: false, runner,
      store: { get: id => sessions.get(id), list: () => [...sessions.values()], touch() {}, flush() {} },
      commands: { get: id => commands.find(node => node.id === id), list: () => commands, update: (node, changes) => Object.assign(node, changes) },
      links: { list: () => links, from: id => links.filter(link => link.from === id), update: (link, changes) => Object.assign(link, changes) },
      cliPaths: () => ({ claude: "fake-cli" }), compose: (_session, text) => text,
      notify: (kind, payload) => events.push({ kind, payload }),
      ...(runGit ? { runGit } : {}),
      runCommandShell: options => {
        let resolve;
        const done = new Promise(finish => { resolve = finish; });
        const run = { options, done, finish: result => resolve({ exitCode: 0, output: "command-output", durationMs: 12, stopped: false, timedOut: false, ...result }), stop: () => resolve({ exitCode: 1, output: "중지", stopped: true, durationMs: 2 }) };
        shellRuns.push(run);
        if (options.command !== "hold") run.finish();
        return run;
      },
    });
    opened.push(chain);
    const complete = async (id, text, ok = true) => {
      const session = sessions.get(id);
      runner.running.delete(id);
      session.state = ok === false ? "error" : "idle";
      session.events.push({ kind: "text", text }, { kind: "result", text: "턴 완료" });
      await chain.onTurnEnd(session, ok);
    };
    const remove = id => {
      const at = commands.findIndex(node => node.id === id);
      assert.notEqual(at, -1);
      chain.stopCommand(commands[at]);
      commands.splice(at, 1);
    };
    return { chain, runner, sessions, node: id => commands.find(node => node.id === id), remove, history, links, events, shellRuns, complete };
  }
  t.after(() => {
    for (const chain of opened.reverse()) chain.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { ...create(), directory, dataDir, create };
}

const shell = { kind: "command", title: "검사", command: "echo result", shell: process.platform === "win32" ? "powershell" : "sh", cwdMode: "project", timeoutSec: 10 };
const input = { kind: "input", title: "시작", fields: [{ key: "goal", label: "목표", type: "text", required: true, defaultValue: "" }], prompt: "{{goal}}" };

function captureHistoryWrites(t, history) {
  const writes = [];
  const save = history.repository.save.bind(history.repository);
  t.mock.method(history.repository, "save", (runs, dirty) => {
    writes.push({ ids: [...dirty], runs: structuredClone(runs) });
    return save(runs, dirty);
  });
  return writes;
}

test("execution history: queue, begin and failure persist complete transitions once", t => {
  const f = fixture(t);
  const controls = f.chain.controls;
  const node = f.sessions.get("a");
  const flow = f.chain.newFlow();
  const writes = captureHistoryWrites(t, f.history);
  const queued = controls.queue(node, flow, "queued input");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].runs[0].steps[0].status, "waiting");
  writes.length = 0;
  controls.begin(node, flow, "queued input", { historyStepId: queued });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].runs[0].steps.map(step => step.status), ["success", "running"]);
  writes.length = 0;
  const competing = f.chain.newFlow();
  controls.fail(node, competing, new Error("cannot start"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].runs.find(run => run.id === competing.id).steps[0].status, "error");
  assert.equal(controls.steps.get(node.id).flow.id, flow.id, "another run's active step stays intact");
  writes.length = 0;
  const failed = f.chain.newFlow();
  controls.fail(f.sessions.get("b"), failed, new Error("failed before start"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].runs.find(run => run.id === failed.id).steps[0].status, "error");
});

test("execution history: cancelling many queued steps batches stop and refresh", t => {
  const f = fixture(t);
  const controls = f.chain.controls;
  const first = f.chain.newFlow(), second = f.chain.newFlow();
  for (const flow of [first, second]) for (const node of f.sessions.values()) controls.queue(node, flow, "waiting");
  const writes = captureHistoryWrites(t, f.history);
  f.chain.stopRun(first.id);
  assert.equal(writes.length, 1);
  assert.ok(f.history.get(first.id).steps.every(step => step.status === "stopped"));
  writes.length = 0;
  second.cancelled = true;
  controls.refresh();
  assert.equal(writes.length, 1);
  assert.equal(f.history.get(second.id).status, "stopped");
  assert.ok(f.history.get(second.id).steps.every(step => step.status === "stopped"));
});

test("execution history: resume batches copied siblings but releases the batch before async delivery", async t => {
  const f = fixture(t, { nodes: [
    { id: "cmd-first", kind: "transform", title: "First", transformMode: "template", template: "first" },
    { id: "cmd-second", kind: "transform", title: "Second", transformMode: "template", template: "second" },
    { id: "cmd-retry", kind: "watch", title: "Watch", watchPaths: ["."], debounceMs: 100 },
  ], connections: [{ from: "cmd-retry", to: "a" }] });
  const flow = f.chain.newFlow({ original: true });
  let failed;
  f.history.batch(() => {
    f.history.start(flow, { projectPath: f.directory });
    for (const id of ["cmd-first", "cmd-second"]) {
      const step = f.history.beginStep(flow.id, { nodeId: id, kind: "transform", input: "original", cwd: f.directory });
      f.history.finishStep(flow.id, step.id, { ok: true, output: id + " output" });
    }
    failed = f.history.beginStep(flow.id, { nodeId: "cmd-retry", kind: "watch", input: "changed.txt", cwd: f.directory });
    f.history.finishStep(flow.id, failed.id, { ok: false, error: "interrupted" });
    f.history.update(flow.id, { status: "error" });
  });
  const writes = captureHistoryWrites(t, f.history);
  let release, entered = false;
  t.mock.method(f.chain, "deliver", async () => {
    entered = true;
    assert.equal(f.history.batchDepth, 0);
    await new Promise(resolve => { release = resolve; });
  });
  const pending = f.chain.resumeRun(flow.id, failed.id);
  await until(() => entered, "resume reaches asynchronous delivery");
  assert.equal(writes.length, 2, "one preparation snapshot and one completed watch snapshot");
  const prepared = writes[0].runs.find(run => run.id !== flow.id);
  assert.equal(prepared.steps.length, 2);
  assert.ok(prepared.steps.every(step => step.status === "success" && step.options.reused));
  f.history.start({ id: "unrelated", variables: {}, repeats: {} }, { projectPath: f.directory });
  assert.equal(writes.length, 3, "unrelated writes are not held while delivery waits");
  release();
  const resumed = await pending;
  assert.equal(resumed.status, "success");
  assert.equal(resumed.steps.length, 3);
  assert.equal(resumed.resumedFrom.stepId, failed.id);
});

test("execution history: session, command and notification share one invocation and completion snapshots", async t => {
  const f = fixture(t, { nodes: [{ id: "cmd-shell", ...shell }, { id: "cmd-notify", kind: "notify", title: "완료 알림", message: "{{goal}} / {{input}}", notificationTitle: "검사 종료", level: "success", sound: true }],
    connections: [{ from: "a", to: "cmd-shell" }, { from: "cmd-shell", to: "cmd-notify" }] });
  const flow = f.chain.newFlow({ goal: "검토" });
  f.chain.enqueue(f.sessions.get("a"), "원래 요청", { flow, user: true }, 0);
  await f.complete("a", "AI-result");
  await until(() => f.history.get(flow.id)?.status === "success", "the whole invocation completes");
  const run = f.history.get(flow.id);
  const steps = run.steps.filter(step => !step.options?.queued);
  assert.deepEqual(steps.map(step => step.kind), ["session", "command", "notify"]);
  assert.equal(steps[0].input, "원래 요청");
  assert.equal(steps[0].output, "AI-result");
  assert.equal(steps[1].output, "command-output");
  assert.equal(steps[2].output, "검토 / command-output");
  assert.equal(run.steps.every(step => step.status === "success"), true);
  const notification = f.events.find(event => event.kind === "notification").payload;
  assert.equal(notification.runId, flow.id);
  assert.equal(notification.nodeId, "cmd-notify");
  assert.equal(notification.title, "검사 종료");
  assert.equal(notification.message, "검토 / command-output");
  assert.equal(notification.level, "success");
  assert.equal(notification.sound, true);
});

test("execution stop: stops the chosen invocation and preserves another flow's running and queued work", { timeout: 7000 }, async t => {
  const f = fixture(t, { nodes: [{ id: "cmd-shared", ...shell, command: "hold" }] });
  const first = f.chain.newFlow({ goal: "first" }), other = f.chain.newFlow({ goal: "other" });
  f.chain.enqueue(f.sessions.get("a"), "first-active", { flow: first }, 0);
  f.chain.enqueue(f.sessions.get("a"), "other-queued", { flow: other }, 0);
  f.chain.enqueue(f.sessions.get("b"), "other-active", { flow: other }, 0);
  const firstCommand = f.chain.runCommand(f.node("cmd-shared"), { flow: first, prompt: "first-shell" });
  const otherCommand = f.chain.runCommand(f.node("cmd-shared"), { flow: other, prompt: "other-shell" });
  const stopped = f.chain.stopRun(first.id);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(f.runner.stops, ["a"]);
  assert.equal(other.cancelled, false);
  assert.equal(f.runner.isRunning("b"), true);
  assert.equal(f.chain.queue.get("a")[0].flow.id, other.id);
  await f.complete("a", "late cancelled output", null);
  await firstCommand;
  await until(() => f.shellRuns.length === 2, "another flow's queued command survives");
  assert.equal(f.runner.calls.filter(call => call.id === "a").at(-1).prompt, "other-queued");
  f.shellRuns[1].finish({ output: "other-shell-done" });
  await otherCommand;
  await f.complete("a", "other-session-done");
  await f.complete("b", "other-parallel-done");
  await until(() => f.history.get(other.id)?.status === "success", "unrelated invocation finishes normally");
  assert.equal(f.history.get(first.id).status, "stopped");
  assert.equal(f.history.get(first.id).steps.filter(step => !step.options?.queued).every(step => step.status === "stopped"), true);
});

test("execution stop: cancelled approval snapshots cannot launch a later session", async t => {
  const f = fixture(t, { nodes: [{ id: "cmd-input", ...input }], connections: [{ from: "cmd-input", to: "a", approve: true }] });
  await f.chain.runCommand(f.node("cmd-input"), { values: { goal: "승인 후 작업" } });
  const flow = f.chain.flowFor(f.node("cmd-input"));
  const pending = structuredClone(f.links[0].pending);
  assert.equal(f.history.get(flow.id).status, "waiting");
  f.chain.stopRun(flow.id);
  assert.equal(f.links[0].pending, null);
  // A stale browser request must not revive a retained approval snapshot.
  f.links[0].pending = pending;
  try { await f.chain.decide(f.links[0], true); }
  catch (error) { assert.match(error.message, /취소|중지|종료|대기/); }
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.history.get(flow.id).status, "stopped");
});

test("execution stop: interrupting repeat delay clears its timer and never delivers its output", async t => {
  const f = fixture(t, { nodes: [{ id: "cmd-repeat", kind: "repeat", title: "대기", maxIterations: 3, delayMs: 60000 }], connections: [{ from: "cmd-repeat", to: "a" }] });
  const pending = f.chain.runCommand(f.node("cmd-repeat"), { prompt: "다음 시도" });
  const flow = f.chain.flowFor(f.node("cmd-repeat"));
  assert.ok(f.chain.runs.has("cmd-repeat"));
  f.chain.stopRun(flow.id);
  await pending;
  assert.equal(f.chain.runs.has("cmd-repeat"), false);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.history.get(flow.id).status, "stopped");
  assert.equal(f.history.get(flow.id).steps[0].status, "stopped");
});

test("execution resume: reruns only a failed member and seeds successful parallel results for its join", async t => {
  const f = fixture(t, { nodes: [
    { id: "cmd-good", kind: "transform", title: "성공 구성원", transformMode: "template", template: "preserved-sibling" },
    { id: "cmd-bad", kind: "transform", title: "실패 구성원", transformMode: "json", expression: "result" },
    { id: "cmd-group", kind: "group", title: "합치기", members: ["cmd-good", "cmd-bad"] },
  ], connections: [{ from: "cmd-group", to: "next" }] });
  const flow = f.chain.newFlow({ goal: "original-variable" });
  await f.chain.runCommand(f.node("cmd-good"), { flow, prompt: "good-input" });
  await f.chain.runCommand(f.node("cmd-bad"), { flow, prompt: "failed-original-input" });
  const old = f.history.get(flow.id);
  assert.equal(old.status, "error");
  const failed = old.steps.find(step => step.nodeId === "cmd-bad");
  assert.equal(failed.status, "error");
  f.node("cmd-good").lastRun.outputText = "later-unrelated-output";
  Object.assign(f.node("cmd-bad"), { transformMode: "template", template: "fixed {{input}} / {{goal}}" });
  const resumed = await f.chain.resumeRun(old.id, failed.id);
  await until(() => f.runner.calls.some(call => call.id === "next"), "the join is fulfilled by the preserved sibling and retried member");
  assert.notEqual(resumed.id, old.id);
  assert.deepEqual(resumed.resumedFrom, { runId: old.id, stepId: failed.id });
  assert.equal(resumed.steps.filter(step => step.nodeId === "cmd-good").length, 1);
  assert.equal(resumed.steps.find(step => step.nodeId === "cmd-good").options.reused, true);
  const retry = resumed.steps.find(step => step.nodeId === "cmd-bad");
  assert.equal(retry.input, "failed-original-input");
  assert.equal(retry.output, "fixed failed-original-input / original-variable");
  const request = f.runner.calls.find(call => call.id === "next").prompt;
  assert.match(request, /preserved-sibling/);
  assert.match(request, /fixed failed-original-input \/ original-variable/);
  assert.doesNotMatch(request, /later-unrelated-output/);
  await f.complete("next", "joined-done");
  assert.equal(resumed.status, "success");
  assert.equal(old.status, "error");
});

test("execution resume: interrupted sessions remain stopped after restart until manually resumed", async t => {
  const f = fixture(t);
  f.chain.enqueue(f.sessions.get("a"), "before-crash-input", { user: true }, 0);
  const old = f.history.list()[0];
  const restoredHistory = new RunHistoryStore({ dataDir: f.dataDir });
  const restarted = f.create(restoredHistory);
  assert.equal(restoredHistory.get(old.id).status, "interrupted");
  assert.equal(restarted.runner.calls.length, 0);
  const resumed = await restarted.chain.resumeRun(old.id);
  assert.equal(restarted.runner.calls.length, 1);
  assert.equal(restarted.runner.calls[0].prompt, "before-crash-input");
  assert.notEqual(resumed.id, old.id);
  await restarted.complete("a", "after-restart-done");
  assert.equal(resumed.status, "success");
  assert.equal(restoredHistory.get(old.id).status, "interrupted");
});

test("execution notifications API: emits an SSE notice and exposes its persisted history", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-notify-sse-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false, deps: { runner: new FakeRunner(), cliPaths: () => ({ claude: "fake-cli" }), logger: { log() {} } } });
  const controller = new AbortController();
  let reader;
  t.after(async () => {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await hub.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await hub.start();
  const base = "http://127.0.0.1:" + hub.port + "/api";
  const stream = await fetch(base + "/stream", { signal: controller.signal });
  assert.equal(stream.status, 200);
  reader = stream.body.getReader();
  await reader.read();
  const api = async (method, suffix, body) => {
    const response = await fetch(base + suffix, { method, headers: { "Content-Type": "application/json", "X-AgentHub": "1" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const node = await api("POST", "/commands", { kind: "notify", projectPath, title: "완료", notificationTitle: "AgentHub 검사", message: "알림 전달 확인", level: "success", sound: false });
  await api("POST", "/commands/" + node.id + "/run", {});
  const decoder = new TextDecoder();
  let text = "";
  const deadline = setTimeout(() => controller.abort(), 5000);
  try { while (!text.includes("event: notification")) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); } }
  finally { clearTimeout(deadline); }
  assert.match(text, /event: notification/);
  assert.match(text, /알림 전달 확인/);
  const { runs } = await api("GET", "/runs?path=" + encodeURIComponent(projectPath));
  assert.equal(runs.length, 1);
  const run = await api("GET", "/runs/" + runs[0].id);
  assert.equal(run.status, "success");
  assert.equal(run.steps[0].nodeId, node.id);
  assert.equal(run.steps[0].kind, "notify");
  assert.equal(run.steps[0].output, "알림 전달 확인");
  assert.equal(hub.runHistory.get(run.id).status, "success");
});


test("execution approvals restart: interrupted handoffs require fresh approval before manual resume starts work", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-approval-resume-"));
  const projectPath = path.join(root, "project"), dataDir = path.join(root, "data");
  fs.mkdirSync(projectPath);
  const hubs = [];
  const open = async () => {
    const runner = new FakeRunner();
    const hub = createHub({ dataDir, port: 0, warmup: false, deps: { runner, cliPaths: () => ({ claude: "fake-cli" }), logger: { log() {} } } });
    hubs.push(hub);
    await hub.start();
    const api = async (method, suffix, body) => {
      const response = await fetch("http://127.0.0.1:" + hub.port + "/api" + suffix, { method, headers: { "Content-Type": "application/json", "X-AgentHub": "1" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    return { hub, runner, api };
  };
  t.after(async () => { for (const hub of hubs.reverse()) await hub.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const first = await open();
  first.hub.store.add({ id: "approval-target", title: "승인 대상", agent: "claude", permission: "acceptEdits", state: "idle", projectPath, projectName: "project", cwd: projectPath, events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const source = await first.api("POST", "/commands", { id: "ignored", kind: "input", projectPath, ...input });
  const link = await first.api("POST", "/links", { from: source.id, to: "approval-target", approve: true });
  await first.api("POST", "/commands/" + source.id + "/run", { values: { goal: "원래 승인할 입력" } });
  const summary = (await first.api("GET", "/runs?path=" + encodeURIComponent(projectPath))).runs[0];
  const old = await first.api("GET", "/runs/" + summary.id);
  assert.equal(old.status, "waiting");
  const approval = old.steps.find(step => step.options?.approval);
  assert.ok(approval, "approval wait is persisted as a resumable step");
  await first.hub.shutdown();
  const restarted = await open();
  assert.equal(restarted.hub.runHistory.get(old.id).status, "interrupted");
  assert.equal(restarted.hub.links.get(link.id).pending, null, "stale approvals are discarded when the server restarts");
  assert.equal(restarted.runner.calls.length, 0);
  const resumed = await restarted.api("POST", "/runs/" + old.id + "/resume", { stepId: approval.id });
  assert.notEqual(resumed.id, old.id);
  assert.equal(resumed.status, "waiting");
  assert.equal(restarted.runner.calls.length, 0, "manual resume must still wait for fresh approval");
  assert.equal(restarted.hub.links.get(link.id).pending.flow.id, resumed.id);
  await restarted.api("POST", "/links/" + link.id + "/decide", { action: "approve" });
  assert.equal(restarted.runner.calls.length, 1);
  assert.equal(restarted.runner.calls[0].id, "approval-target");
  assert.match(restarted.runner.calls[0].prompt, /원래 승인할 입력/);
  const session = restarted.hub.store.get("approval-target");
  restarted.runner.running.delete(session.id);
  session.state = "idle";
  session.events.push({ kind: "text", text: "승인 후 완료" }, { kind: "result", text: "턴 완료" });
  await restarted.hub.chain.onTurnEnd(session, true);
  assert.equal(restarted.hub.runHistory.get(resumed.id).status, "success");
});


test("execution stop: a running paused session is fully unpaused and can manually resume after close", async t => {
  const f = fixture(t);
  const session = f.sessions.get("a");
  f.chain.enqueue(session, "paused-original-input", { user: true }, 0);
  const old = f.history.list()[0];
  session.paused = true;
  const stopped = f.chain.stopRun(old.id);
  assert.equal(session.paused, false);
  assert.equal(stopped.status, "stopped");
  await f.complete("a", "stopped while paused", null);
  assert.equal(session.paused, false);
  const resumed = await f.chain.resumeRun(old.id);
  assert.equal(f.runner.calls.at(-1).prompt, "paused-original-input");
  assert.notEqual(resumed.id, old.id);
  await f.complete("a", "resumed-after-pause");
  assert.equal(resumed.status, "success");
});

for (const kind of ["command", "git", "repeat"]) {
  test("execution deletion: " + kind + " termination closes history even after its node is removed", { timeout: 5000 }, async t => {
    const node = kind === "command" ? { id: "cmd-deleted", ...shell, command: "hold" }
      : kind === "git" ? { id: "cmd-deleted", kind: "git", title: "Git", gitAction: "use", branch: "feature/test" }
      : { id: "cmd-deleted", kind: "repeat", title: "반복", maxIterations: 3, delayMs: 60000 };
    let gitStarted = false;
    const f = fixture(t, { nodes: [node], runGit: ({ signal }) => new Promise(resolve => {
      gitStarted = true;
      const finish = () => resolve({ ok: false, output: "중지됨", stopped: true, exitCode: 1, durationMs: 1 });
      if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
    }) });
    const pending = f.chain.runCommand(f.node(node.id), { prompt: "삭제 전 입력" });
    const flow = f.chain.flowFor(f.node(node.id));
    if (kind === "git") await until(() => gitStarted, "fake Git operation starts");
    f.remove(node.id);
    await pending;
    assert.equal(f.chain.runs.has(node.id), false);
    const run = f.history.get(flow.id);
    assert.equal(run.status, "stopped");
    assert.equal(run.steps.some(step => ["running", "waiting"].includes(step.status)), false);
    assert.equal(run.steps.at(-1).status, "stopped");
    assert.ok(run.endedAt);
    assert.ok(run.steps.at(-1).endedAt);
  });
}

test("execution resume: a missing approval connection fails before creating another history entry", async t => {
  const f = fixture(t, { nodes: [{ id: "cmd-input", ...input }], connections: [{ from: "cmd-input", to: "a", approve: true }] });
  await f.chain.runCommand(f.node("cmd-input"), { values: { goal: "삭제될 승인 연결" } });
  const old = f.history.list()[0];
  const step = old.steps.find(item => item.options?.approval);
  assert.ok(step);
  f.chain.stopRun(old.id);
  f.links.splice(0);
  const before = f.history.list().length;
  await assert.rejects(f.chain.resumeRun(old.id, step.id), /연결/);
  assert.equal(f.history.list().length, before);
  assert.equal(f.history.get(old.id).status, "stopped");
});


test("execution resume: restart clears a stale pause only when manually resuming the interrupted session", async t => {
  const f = fixture(t);
  f.chain.enqueue(f.sessions.get("a"), "interrupted-paused-input", { user: true }, 0);
  const old = f.history.list()[0];
  const restoredHistory = new RunHistoryStore({ dataDir: f.dataDir });
  const restarted = f.create(restoredHistory);
  const session = restarted.sessions.get("a");
  session.paused = true;
  session.waiting = true;
  session.state = "paused";
  assert.equal(restarted.runner.calls.length, 0);
  const resumed = await restarted.chain.resumeRun(old.id);
  assert.equal(session.paused, false);
  assert.equal(session.waiting, false);
  assert.equal(restarted.runner.calls.at(-1).prompt, "interrupted-paused-input");
  await restarted.complete("a", "manual-resume-done");
  assert.equal(resumed.status, "success");
  assert.equal(restoredHistory.get(old.id).status, "interrupted");
});


test("execution busy Git: another invocation gets a resumable failure without overwriting the active run", async t => {
  const operations = [];
  const f = fixture(t, { nodes: [{ id: "cmd-git-busy", kind: "git", title: "Git 확인", gitAction: "use", branch: "feature/test" }],
    runGit: () => new Promise(resolve => operations.push({ finish: output => resolve({ ok: true, output, branch: "feature/test", exitCode: 0, durationMs: 1 }) })) });
  const node = f.node("cmd-git-busy");
  const first = f.chain.newFlow({ goal: "first" });
  const second = f.chain.newFlow({ goal: "second" });
  const pendingFirst = f.chain.runCommand(node, { flow: first, prompt: "first-original-input" });
  await until(() => operations.length === 1, "the first Git operation starts");
  f.chain.startLinkedCommand(node, { flow: second, prompt: "second-original-input", depth: 2 });
  await until(() => f.history.get(second.id)?.steps.some(step => step.status === "error"), "busy delivery has its own resumable failed step");
  const failedRun = f.history.get(second.id);
  const failure = failedRun.steps.find(step => step.status === "error");
  assert.equal(failedRun.status, "error");
  assert.equal(failure.nodeId, node.id);
  assert.equal(failure.kind, "git");
  assert.equal(failure.input, "second-original-input");
  assert.equal(failure.variables.goal, "second");
  assert.equal(f.chain.flowFor(node).id, first.id);
  assert.equal(f.history.get(first.id).steps.at(-1).status, "running");
  assert.equal(node.state, "running");
  assert.equal(operations.length, 1);
  operations[0].finish("first-git-complete");
  await pendingFirst;
  assert.equal(f.history.get(first.id).status, "success");
  assert.equal(f.history.get(first.id).steps.at(-1).output, "first-git-complete");
  const resumed = await f.chain.resumeRun(second.id, failure.id);
  await until(() => operations.length === 2, "the failed busy invocation can manually start after the first ends");
  operations[1].finish("second-git-retry-complete");
  await until(() => resumed.status === "success", "the retried invocation completes");
  const retry = resumed.steps.find(step => step.nodeId === node.id && !step.options?.reused);
  assert.equal(retry.input, "second-original-input");
  assert.equal(retry.variables.goal, "second");
  assert.equal(retry.output, "second-git-retry-complete");
  assert.equal(failedRun.status, "error");
  assert.equal(f.history.get(first.id).status, "success");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Runner } from "../server/runner.mjs";
import { createHub } from "../server/bootstrap.mjs";
import { loadConfig, saveConfig } from "../server/config.mjs";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cli-update-"));
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false, ...options,
    deps: { logger: { log() {}, error() {} }, ...options.deps } });
  t.after(async () => {
    await hub.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { hub, root };
}

test("CLI update lifecycle: real automatic scheduler is disabled in node tests", async (t) => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  const { hub } = fixture(t);
  assert.equal(hub.cliAutoUpdater, null);
  await hub.start();
  assert.equal(hub.cliAutoUpdater, null);
});

test("CLI update lifecycle: injected scheduler starts once with the hub and is disposed on shutdown", async (t) => {
  const calls = [];
  const updater = { start: () => calls.push("start"), dispose: () => calls.push("dispose") };
  const { hub } = fixture(t, { deps: { cliAutoUpdater: updater } });
  assert.deepEqual(calls, []);
  await Promise.all([hub.start(), hub.start()]);
  assert.deepEqual(calls, ["start"]);
  await hub.shutdown(); await hub.shutdown();
  assert.deepEqual(calls, ["start", "dispose"]);
});

test("CLI update lifecycle: explicit disable wins over injection and immediate shutdown cannot start an updater", async (t) => {
  const calls = [];
  const updater = { start: () => calls.push("start"), dispose: () => calls.push("dispose") };
  const disabled = fixture(t, { cliAutoUpdate: false, deps: { cliAutoUpdater: updater } }).hub;
  await disabled.start(); await disabled.shutdown();
  assert.deepEqual(calls, []);
  const closing = fixture(t, { deps: { cliAutoUpdater: updater } }).hub;
  await Promise.all([closing.start(), closing.shutdown()]);
  assert.deepEqual(calls, ["dispose"]);
});

test("CLI update config: existing and new configuration defaults to enabled and persists a disabled choice", (t) => {
  const { root } = fixture(t);
  const dir = path.join(root, "config-check");
  const config = loadConfig(dir);
  assert.equal(config.cliAutoUpdate, true);
  saveConfig({ ...config, cliAutoUpdate: false }, dir);
  assert.equal(loadConfig(dir).cliAutoUpdate, false);
  delete config.cliAutoUpdate;
  saveConfig(config, dir);
  assert.equal(loadConfig(dir).cliAutoUpdate, true);
});

test("CLI update runner: blocked sends leave conversation, state and spawned processes untouched", () => {
  const session = { id: "test", agent: "claude", cwd: process.cwd(), state: "idle", events: [{ kind: "question", status: "pending" }] };
  const events = structuredClone(session.events);
  const runner = new Runner({ touch() { assert.fail("must not touch session"); } }, {
    isUpdating: (tool) => tool === "claude", spawn() { assert.fail("must not spawn CLI"); },
  });
  assert.throws(() => runner.send(session, "request", "fixture-cli"), /업데이트 중/);
  assert.equal(session.state, "idle");
  assert.deepEqual(session.events, events);
  assert.equal(runner.running.size, 0);
});

test("CLI update runtime: hub connects setup locks to runner and defers updates during session or command work", (t) => {
  const { hub } = fixture(t);
  const session = { id: "fixture", agent: "codex", cwd: process.cwd(), state: "idle", events: [] };
  hub.setup.jobs.set("codex", { kind: "update", state: "running" });
  assert.throws(() => hub.runner.send(session, "request", "fixture-cli"), /업데이트 중/);
  assert.deepEqual(session.events, []);
  hub.runner.running.set("busy-session", {});
  assert.equal(hub.setup.isBusy("claude"), true);
  assert.equal(hub.setup.isBusy("codex"), true);
  hub.runner.running.clear();
  hub.chain.runs.set("busy-command", {});
  assert.equal(hub.setup.isBusy("claude"), true);
  hub.chain.runs.clear();
  assert.equal(hub.setup.isBusy("claude"), false);
  hub.chain.runs.set("waiting-schedule", { kind: "schedule" });
  assert.equal(hub.setup.isBusy("claude"), false, "waiting reservations must not block CLI updates");
  hub.chain.runs.clear();
});

test("CLI update runtime: one-shot flow assistant and command generation reserve their CLI", async (t) => {
  let resolve;
  let calls = 0;
  const { hub, root } = fixture(t, { deps: { cliPaths: () => ({ claude: "fixture-cli", codex: null }),
    ask: () => { calls++; return new Promise((done) => { resolve = done; }); } } });
  hub.config.projects.push({ path: root, name: "fixture" });
  const pending = hub.services.flowAssistant.plan({ projectPath: root, prompt: "describe this graph" });
  assert.equal(hub.setup.isBusy("claude"), true);
  assert.equal(hub.setup.isBusy("codex"), false);
  resolve('{"summary":"done","actions":[]}');
  await pending;
  assert.equal(hub.setup.isBusy("claude"), false);
  const command = hub.services.commands.generate({ projectPath: root, prompt: "list files", shell: "powershell" });
  assert.equal(hub.setup.isBusy("claude"), true);
  resolve('{"title":"List","command":"Get-ChildItem"}');
  await command;
  assert.equal(hub.setup.isBusy("claude"), false);
  hub.setup.jobs.set("claude", { kind: "update", state: "running" });
  await assert.rejects(hub.services.flowAssistant.plan({ projectPath: root, prompt: "describe" }), /업데이트 중/);
  await assert.rejects(hub.services.commands.generate({ projectPath: root, prompt: "describe", shell: "powershell" }), /업데이트 중/);
  assert.equal(calls, 2);
});

test("CLI update runtime: failed one-shot work always releases its busy reservation", async (t) => {
  const { hub, root } = fixture(t, { deps: { cliPaths: () => ({ codex: "fixture-cli" }),
    ask: async () => { throw new Error("fixture failure"); } } });
  hub.config.projects.push({ path: root, name: "fixture" });
  await assert.rejects(hub.services.flowAssistant.plan({ projectPath: root, prompt: "describe" }), /fixture failure/);
  assert.equal(hub.setup.isBusy("codex"), false);
});

function queuedSession(hub, root, id = "queued-target") {
  const session = { id, title: id, agent: "claude", permission: "acceptEdits", cwd: root, projectPath: root,
    state: "idle", events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  hub.store.add(session);
  return session;
}

function fakeSpawns(hub) {
  const children = [];
  hub.runner.spawn = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    children.push(child);
    return child;
  };
  // Test cleanup must never start taskkill or any real CLI process.
  hub.runner.kill = child => child.emit("close", null, "fixture stop");
  return children;
}

for (const outcome of ["done", "error", "canceled"]) {
  test(`CLI update queue: a one-time reservation waits through an update and resumes after ${outcome}`, async (t) => {
    const { hub, root } = fixture(t, { deps: { cliPaths: () => ({ claude: "fixture-cli" }) } });
    const children = fakeSpawns(hub);
    const target = queuedSession(hub, root);
    let now = Date.now();
    const schedules = hub.chain.workflow.schedules;
    schedules.now = () => now;
    schedules.setTimer = () => ({ unref() {} });
    schedules.clearTimer = () => {};
    const node = hub.services.commands.create({ projectPath: root, kind: "schedule", scheduleMode: "once",
      runAt: new Date(now + 60_000).toISOString(), prompt: "보존할 예약 요청" });
    hub.links.add({ id: "schedule-link", from: node.id, to: target.id, when: "success", enabled: true });
    const job = { kind: "update", state: "running", log: "", automatic: true };
    hub.setup.jobs.set("claude", job);
    await hub.services.commands.run(node.id);
    now += 60_000;
    await schedules.tick(schedules.states.get(node.id));
    const run = hub.runHistory.get(node.lastRun.runId);
    const pendingStep = run.steps.find(step => step.nodeId === target.id);
    assert.equal(children.length, 0);
    assert.equal(hub.chain.pending(target.id), 1);
    assert.equal(target.events.length, 0, "update contention is not a failed turn");
    assert.equal(run.status, "waiting");
    assert.equal(pendingStep.status, "waiting");
    assert.equal(node.scheduleEnabled, false, "one-time timer cannot fire twice while queued");
    if (outcome === "canceled") job.canceled = true;
    hub.setup.finish("claude", job, outcome === "done" ? 0 : 1, outcome === "error" ? new Error("fixture update failure") : null);
    assert.equal(job.state, outcome);
    assert.equal(children.length, 1);
    assert.equal(hub.chain.pending(target.id), 0);
    assert.equal(pendingStep.status, "success", "resuming closes the existing queue marker");
    assert.equal(run.steps.filter(step => step.nodeId === target.id && step.status === "running").length, 1);
    assert.equal(target.events.filter(event => event.kind === "user").length, 1);
    assert.equal(target.events.find(event => event.kind === "user").text, "보존할 예약 요청");
    children[0].stdout.write(JSON.stringify({ type: "result", is_error: false, result: "완료" }) + "\n");
    children[0].emit("close", 0, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(run.status, "success");
    assert.equal(children.length, 1);
  });
}

test("CLI update queue: only matching update completion resumes a preserved queue; installation does not block it", (t) => {
  const { hub, root } = fixture(t, { deps: { cliPaths: () => ({ claude: "fixture-cli" }) } });
  const children = fakeSpawns(hub);
  const target = queuedSession(hub, root);
  const update = { kind: "update", state: "running", log: "" };
  hub.setup.jobs.set("claude", update);
  hub.chain.enqueue(target, "대기 요청", {}, 0);
  hub.setup.emit("finished", "codex", { kind: "update", state: "done" });
  hub.setup.emit("finished", "claude", { kind: "login", state: "done" });
  assert.equal(children.length, 0);
  assert.equal(hub.chain.pending(target.id), 1);
  hub.setup.finish("claude", update, 0);
  assert.equal(children.length, 1);
  const other = queuedSession(hub, root, "during-install");
  hub.setup.jobs.set("claude", { kind: "install", state: "running" });
  hub.chain.enqueue(other, "설치는 업데이트 잠금이 아니다", {}, 0);
  assert.equal(children.length, 2);
  assert.equal(hub.chain.pending(other.id), 0);
});

test("CLI update queue: shutdown cancellation cannot launch waiting work and removes completion listeners", async (t) => {
  const job = { kind: "update", state: "running", log: "", automatic: true, canceled: true };
  const { hub, root } = fixture(t, { deps: { cliPaths: () => ({ claude: "fixture-cli" }),
    cliAutoUpdater: { start() {}, dispose: () => hub.setup.finish("claude", job, null) } } });
  const children = fakeSpawns(hub);
  const target = queuedSession(hub, root);
  hub.setup.jobs.set("claude", job);
  hub.chain.enqueue(target, "종료 중 시작하지 않음", {}, 0);
  assert.equal(hub.chain.pending(target.id), 1);
  await hub.shutdown();
  assert.equal(children.length, 0);
  assert.equal(hub.setup.listenerCount("finished"), 0);
  hub.setup.emit("finished", "claude", { kind: "update", state: "done" });
  assert.equal(children.length, 0);
});

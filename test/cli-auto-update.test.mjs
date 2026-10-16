import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CliAutoUpdater, CLI_UPDATE_STARTUP_MS, CLI_UPDATE_INTERVAL_MS, CLI_UPDATE_RETRY_MS } from "../server/cli-auto-update.mjs";

function fixture() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  const state = { enabled: true, busy: new Set(), updating: new Set(), statusCalls: 0, calls: [], errors: [] };
  const setup = Object.assign(new EventEmitter(), {
    tools: ["claude", "codex", "gh"].map((id) => ({ id, path: `/fake/${id}`, version: "1.0", updatable: true })),
    jobs: {},
    async status() { state.statusCalls++; return { tools: this.tools, jobs: this.jobs }; },
    isUpdating(tool) { return state.updating.has(tool); },
    update(tool, options) { state.calls.push({ tool, ...options }); state.updating.add(tool); return { state: "running" }; },
  });
  const updater = new CliAutoUpdater({ setup, enabled: () => state.enabled, isBusy: (tool) => state.busy.has(tool),
    now: () => time, setTimer: (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; },
    clearTimer: (key) => timers.delete(key), logger: { error: (message) => state.errors.push(message) } });
  async function tick(ms) {
    time += ms;
    const next = timers.entries().next().value;
    assert.ok(next, "a check must be scheduled");
    timers.delete(next[0]);
    await next[1].fn();
  }
  return { updater, setup, state, timers, tick };
}

test("CLI automatic updates: construction is inert; startup, interval and disposal are explicit", async () => {
  const f = fixture();
  assert.equal(f.timers.size, 0);
  f.updater.start(); f.updater.start();
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, CLI_UPDATE_STARTUP_MS);
  await f.tick(CLI_UPDATE_STARTUP_MS);
  assert.deepEqual(f.state.calls, [{ tool: "claude", automatic: true }]);
  await f.tick(CLI_UPDATE_RETRY_MS);
  assert.equal(f.state.calls.length, 1, "only one automatic update runs at once");
  f.state.updating.clear();
  await f.tick(CLI_UPDATE_RETRY_MS);
  assert.deepEqual(f.state.calls.map(({ tool }) => tool), ["claude", "codex"]);
  f.state.updating.clear();
  const statusCalls = f.state.statusCalls;
  await f.tick(CLI_UPDATE_RETRY_MS);
  assert.equal(f.state.statusCalls, statusCalls, "idle minute polls do not query CLI status");
  await f.tick(CLI_UPDATE_INTERVAL_MS);
  assert.equal(f.state.calls.at(-1).tool, "claude");
  assert.equal(f.state.calls.some(({ tool }) => tool === "gh"), false);
  f.updater.dispose(); f.updater.dispose(); f.updater.start();
  assert.equal(f.timers.size, 0);
  assert.equal(f.setup.listenerCount("finished"), 0);
});

test("CLI automatic updates: disabled settings and busy sessions defer without consuming their due time", async () => {
  const f = fixture();
  f.state.enabled = false;
  f.updater.start();
  await f.tick(CLI_UPDATE_STARTUP_MS);
  assert.equal(f.state.statusCalls, 0);
  assert.deepEqual(f.state.calls, []);
  f.state.enabled = true;
  f.state.busy = new Set(["claude", "codex"]);
  await f.tick(CLI_UPDATE_RETRY_MS);
  assert.equal(f.state.statusCalls, 0);
  f.state.busy.clear();
  await f.tick(CLI_UPDATE_RETRY_MS);
  assert.equal(f.state.calls[0].tool, "claude");
  f.updater.dispose();
});

test("CLI automatic updates: absent, unsupported and manually managed CLIs are never installed", async () => {
  for (const field of [{ path: null }, { version: null }, { updatable: false, updateReason: "manual path" }]) {
    const f = fixture();
    f.setup.tools = f.setup.tools.map((tool) => ({ ...tool, ...field }));
    f.updater.start();
    await f.tick(CLI_UPDATE_STARTUP_MS);
    assert.deepEqual(f.state.calls, []);
    f.updater.dispose();
  }
});

test("CLI automatic updates: running setup jobs and a session starting during status discovery defer", async () => {
  const f = fixture();
  f.setup.status = async () => {
    f.state.busy.add("claude");
    return { tools: f.setup.tools, jobs: { codex: { kind: "login", state: "running" } } };
  };
  f.updater.start();
  await f.tick(CLI_UPDATE_STARTUP_MS);
  assert.deepEqual(f.state.calls, []);
  f.updater.dispose();
});

test("CLI automatic updates: manual updates started during status discovery defer every automatic update", async () => {
  const f = fixture();
  let resolve;
  f.setup.status = () => new Promise((done) => { resolve = done; });
  f.updater.start();
  const pending = f.tick(CLI_UPDATE_STARTUP_MS);
  f.state.updating.add("codex");
  resolve({ tools: f.setup.tools, jobs: { codex: { kind: "update", state: "running" } } });
  await pending;
  assert.deepEqual(f.state.calls, [], "Claude must not start while a manual Codex update runs");
  assert.equal(f.updater.nextDue.get("claude"), CLI_UPDATE_STARTUP_MS, "deferred work remains due");
  f.updater.dispose();
});

test("CLI automatic updates: transient status failures retry and update failures remain contained", async () => {
  const f = fixture();
  const status = f.setup.status;
  f.setup.status = async () => { throw new Error("offline"); };
  f.updater.start();
  await f.tick(CLI_UPDATE_STARTUP_MS);
  assert.match(f.state.errors[0], /offline/);
  f.setup.status = status;
  f.setup.update = () => { throw new Error("cannot update"); };
  await f.tick(CLI_UPDATE_RETRY_MS);
  assert.equal(f.state.errors.length, 3);
  const statusCalls = f.state.statusCalls;
  await f.tick(CLI_UPDATE_RETRY_MS);
  assert.equal(f.state.statusCalls, statusCalls);
  f.updater.dispose();
});

test("CLI automatic updates: a busy result after asynchronous plan discovery retries next minute", async () => {
  const f = fixture();
  f.updater.start();
  await f.tick(CLI_UPDATE_STARTUP_MS);
  f.state.updating.clear();
  f.setup.emit("finished", "claude", { kind: "update", automatic: true, state: "error", errorCode: "CLI_BUSY" });
  await f.tick(CLI_UPDATE_RETRY_MS);
  assert.deepEqual(f.state.calls.map(({ tool }) => tool), ["claude", "claude"]);
  f.updater.dispose();
});

test("CLI automatic updates: shutdown and a disabled setting win over an in-flight status response", async () => {
  for (const stop of [f => f.updater.dispose(), f => { f.state.enabled = false; }]) {
    const f = fixture();
    let resolve;
    f.setup.status = () => new Promise((done) => { resolve = done; });
    f.updater.start();
    const pending = f.tick(CLI_UPDATE_STARTUP_MS);
    stop(f);
    resolve({ tools: f.setup.tools, jobs: {} });
    await pending;
    assert.deepEqual(f.state.calls, []);
    f.updater.dispose();
    assert.equal(f.timers.size, 0);
  }
});

test("CLI automatic updates: shutdown cancels only running automatic update jobs", () => {
  const f = fixture();
  const canceled = [];
  const jobs = {
    claude: { kind: "update", state: "running", automatic: true },
    codex: { kind: "update", state: "running", automatic: false },
    gh: { kind: "login", state: "running", automatic: true },
  };
  f.setup.jobList = () => jobs;
  f.setup.cancel = (tool) => { canceled.push(tool); jobs[tool].state = "canceled"; };
  f.updater.start();
  f.updater.dispose(); f.updater.dispose();
  assert.deepEqual(canceled, ["claude"]);
  assert.equal(jobs.codex.state, "running");
  assert.equal(jobs.gh.state, "running");
  assert.equal(f.timers.size, 0);
});

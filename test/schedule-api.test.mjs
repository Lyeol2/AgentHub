import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHub } from "../server/bootstrap.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-schedule-api-"));
  const hubs = [];
  const create = () => {
    const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false, cliAutoUpdate: false,
      deps: { logger: { log() {}, error() {} } } });
    hubs.push(hub);
    return hub;
  };
  t.after(async () => {
    for (const hub of hubs) await hub.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = async (hub, method, pathname, body, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api${pathname}`, {
      method, headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  return { root, create, request };
}

test("schedule API: create is off, run arms, editing is guarded, stop and delete clear timers", async t => {
  const f = fixture(t);
  const hub = f.create();
  await hub.start();
  const api = (...args) => f.request(hub, ...args);
  const node = await api("POST", "/commands", { projectPath: f.root, kind: "schedule", scheduleMode: "interval", intervalMinutes: 1,
    scheduleEnabled: true, nextRunAt: "2000-01-01T00:00:00Z" });
  const endpoint = `/commands/${node.id}`;
  assert.equal(node.scheduleEnabled, false, "request cannot arm a newly created node");
  assert.equal(node.nextRunAt, null);
  const listed = await api("GET", `/commands?path=${encodeURIComponent(f.root)}`);
  assert.equal(typeof listed.timeZone, "string");
  const armed = await api("POST", endpoint + "/run", {});
  assert.equal(armed.state, "scheduled");
  assert.equal(armed.scheduleEnabled, true);
  assert.ok(Date.parse(armed.nextRunAt) > Date.now());
  assert.equal(armed.lastRun, null, "arming never fires immediately");
  await api("POST", endpoint + "/run", {}, 409);
  await api("PUT", endpoint, { intervalMinutes: 2 }, 409);
  const moved = await api("PUT", endpoint, { pos: { x: 70, y: 80 } });
  assert.deepEqual(moved.pos, { x: 70, y: 80 });
  assert.deepEqual(await api("POST", endpoint + "/stop", {}), { stopped: true });
  assert.equal(hub.chain.runs.has(node.id), false);
  assert.equal(hub.commands.get(node.id).scheduleEnabled, false);
  assert.equal(hub.commands.get(node.id).nextRunAt, null);
  await api("PUT", endpoint, { intervalMinutes: 2 });
  await api("POST", endpoint + "/run", {});
  await api("DELETE", endpoint);
  assert.equal(hub.chain.runs.has(node.id), false);
  assert.equal(hub.chain.workflow.schedules.states.size, 0);
});

test("schedule API: past one-time schedules return an actionable error and can be edited", async t => {
  const f = fixture(t);
  const hub = f.create();
  await hub.start();
  const node = await f.request(hub, "POST", "/commands", { projectPath: f.root, kind: "schedule", runAt: "2000-01-01T00:00:00Z" });
  const error = await f.request(hub, "POST", `/commands/${node.id}/run`, {}, 400);
  assert.match(error.error, /시각|예약/);
  assert.equal(hub.chain.runs.size, 0);
  await f.request(hub, "PUT", `/commands/${node.id}`, { runAt: new Date(Date.now() + 3_600_000).toISOString() });
  const armed = await f.request(hub, "POST", `/commands/${node.id}/run`, {});
  assert.equal(armed.state, "scheduled");
});

test("schedule lifecycle: shutdown preserves active intent, startup restores future reservations only", async t => {
  const f = fixture(t);
  const a = f.create();
  await a.start();
  const createNode = fields => a.services.commands.create({ projectPath: f.root, kind: "schedule", ...fields });
  const recurring = createNode({ scheduleMode: "interval", intervalMinutes: 10 });
  const future = createNode({ runAt: new Date(Date.now() + 3_600_000).toISOString() });
  const disabled = createNode({ scheduleMode: "daily", timeOfDay: "10:30" });
  for (const node of [recurring, future]) await a.services.commands.run(node.id);
  const next = recurring.nextRunAt;
  await a.shutdown();
  assert.equal(a.chain.runs.size, 0);
  assert.equal(a.commands.get(recurring.id).scheduleEnabled, true);
  // Simulate an app that was closed while these two reservations became due.
  const expired = { ...future, id: "cmd-expired", runAt: "2000-01-01T00:00:00.000Z", nextRunAt: "2000-01-01T00:00:00.000Z" };
  a.commands.add(expired);
  const missed = { ...recurring, id: "cmd-missed", nextRunAt: "2000-01-01T00:00:00.000Z" };
  a.commands.add(missed);
  const b = f.create();
  assert.equal(b.chain.runs.size, 0, "constructor must not start timers");
  await b.start();
  assert.equal(b.chain.runs.size, 3);
  assert.equal(b.commands.get(recurring.id).nextRunAt, next);
  assert.equal(b.commands.get(future.id).nextRunAt, future.runAt);
  assert.equal(b.commands.get(disabled.id).scheduleEnabled, false);
  assert.equal(b.commands.get(expired.id).scheduleEnabled, false);
  assert.equal(b.commands.get(expired.id).state, "error");
  assert.ok(Date.parse(b.commands.get(missed.id).nextRunAt) > Date.now());
  assert.equal(b.commands.get(missed.id).lastRun, null, "missed occurrences do not replay");
  await b.services.commands.stop(recurring.id);
  await b.shutdown();
  const c = f.create();
  await c.start();
  assert.equal(c.chain.runs.has(recurring.id), false, "manually stopped reservation stays off");
});

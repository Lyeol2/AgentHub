import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordCompletion, sessionReadState } from "../server/session-read.mjs";
import { createSessionReadTracker, applySessionRead, mergeSessionRead } from "../public/shared/session-read.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-session-read-"));
process.env.AGENTHUB_DATA = root;
const { SessionStore, summary } = await import("../server/store.mjs");
const { Runner } = await import("../server/runner.mjs");
const { createSessionService } = await import("../server/application/sessions.mjs");
const { sessionRoutes } = await import("../server/transport/routes/sessions.mjs");
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("agenthub-session-read-"));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(root, "case-"));
  const store = new SessionStore({ dataDir });
  const session = { id: "read-session", agent: "claude", state: "idle", createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z", cwd: dataDir, chat: true, events: [] };
  store.add(session);
  const notifications = [];
  const runner = new Runner(store, { spawn() { assert.fail("Reading must not run the CLI"); } });
  const service = createSessionService({ config: {}, dataDir, store, runner, chain: { list: () => [] }, mcpDir: path.join(dataDir, "mcp"),
    projects: { ensureProject() {}, projectSessions: () => [session] }, notify: (...args) => notifications.push(args) });
  t.after(() => store.flushAll());
  const append = (kind = "result") => runner.append(session, { kind, text: kind === "result" ? "완료" : "메시지" });
  return { session, store, service, runner, notifications, append, dataDir };
}

test("completion becomes unread, and status changes or metadata reads do not mark it read", (t) => {
  const f = fixture(t);
  assert.equal(summary(f.session).unread, false);
  f.append("user"); f.append("text"); const result = f.append(); f.append("status");
  assert.deepEqual(sessionReadState(f.session), { lastResultSeq: result.seq, readResultSeq: -1, unread: true });
  assert.equal(f.service.list()[0].unread, true);
  assert.equal(f.service.detail(f.session.id).unread, true);
  assert.equal(f.service.detailMeta(f.session.id).lastResultSeq, result.seq);
  f.runner.setState(f.session, "running");
  assert.equal(summary(f.session).unread, true);
  f.runner.setState(f.session, "idle");
  f.store.flushAll();
  assert.equal(summary(new SessionStore({ dataDir: f.dataDir }).get(f.session.id)).unread, true);
});

test("read acknowledgements are persisted, monotonic and bounded to the result actually displayed", (t) => {
  const f = fixture(t);
  const first = f.append(); const second = f.append();
  const updatedAt = f.session.updatedAt;
  const route = sessionRoutes(f.service).find(([verb, url]) => verb === "POST" && url === "sessions/:id/read")[2];
  const read = (seq) => route({ params: { id: f.session.id }, body: { seq } });
  assert.deepEqual(read(first.seq), { lastResultSeq: second.seq, readResultSeq: first.seq, unread: true });
  assert.equal(f.session.updatedAt, updatedAt);
  assert.equal(summary(new SessionStore({ dataDir: f.dataDir }).get(f.session.id)).unread, true);
  assert.equal(read(second.seq).unread, false);
  assert.equal(read(first.seq).unread, false);
  assert.equal(f.notifications.length, 2);
  assert.equal(f.notifications[1][0], "session-read");
  assert.equal(f.notifications[1][1].sessionId, f.session.id);
  assert.equal(summary(new SessionStore({ dataDir: f.dataDir }).get(f.session.id)).unread, false);
  assert.equal(f.session.state, "idle");
  f.append();
  assert.equal(summary(f.session).unread, true);
});

test("legacy and imported histories get a baseline without making old results unread", () => {
  const session = { events: [{ seq: 0, kind: "result" }] };
  assert.equal(sessionReadState(session).unread, false);
  assert.equal(Object.hasOwn(session, "readResultSeq"), false);
  recordCompletion(session);
  session.events.push({ seq: 1, kind: "result" });
  assert.deepEqual(sessionReadState(session), { lastResultSeq: 1, readResultSeq: 0, unread: true });
});

test("read API rejects locked, missing, non-result and future acknowledgements", (t) => {
  const f = fixture(t);
  f.append("text"); const result = f.append();
  for (const seq of [undefined, "1", -1, 0, 2, Infinity, 0.5]) assert.throws(() => f.service.markRead(f.session.id, { seq }), { status: 400 });
  assert.throws(() => f.service.markRead("missing", { seq: result.seq }), { status: 404 });
  f.session.locked = true;
  assert.throws(() => f.service.markRead(f.session.id, { seq: result.seq }), { status: 423 });
  assert.equal(summary(f.session).unread, true);
  assert.deepEqual(f.notifications, []);
});

function frontend(t, apiOverride) {
  const current = { id: "current", lastResultSeq: 2, readResultSeq: -1, unread: true, events: [{ seq: 2, kind: "result" }] };
  const data = { current, sessions: [{ ...current }, { id: "other", lastResultSeq: 4, readResultSeq: -1, unread: true }] };
  const navigation = { view: "session" };
  const doc = Object.assign(new EventTarget(), { hidden: false, focused: true, dialogOpen: false,
    hasFocus() { return this.focused; }, querySelector() { return this.dialogOpen ? {} : null; } });
  const win = new EventTarget();
  const list = { scrollHeight: 1000, scrollTop: 600, clientHeight: 400 };
  const calls = [];
  let changed = 0;
  const api = async (...args) => { calls.push(args); return apiOverride ? apiOverride(...args) : { lastResultSeq: 2, readResultSeq: args[2].seq, unread: false }; };
  const tracker = createSessionReadTracker({ api, data, navigation, doc, win, eventsList: () => list, onChange() { changed++; } });
  t.after(() => tracker.dispose());
  return { tracker, data, navigation, doc, win, list, calls, changed: () => changed };
}

test("read tracker requires a visible focused conversation showing the latest result", async (t) => {
  const f = frontend(t);
  for (const [object, key, value] of [[f.doc, "hidden", true], [f.doc, "focused", false], [f.doc, "dialogOpen", true], [f.navigation, "view", "project"], [f.list, "scrollTop", 200], [f.data.current, "locked", true]]) {
    const old = object[key]; object[key] = value;
    await f.tracker.readCurrent();
    object[key] = old;
  }
  assert.deepEqual(f.calls, []);
  await f.tracker.readCurrent();
  assert.deepEqual(f.calls, [["POST", "/api/sessions/current/read", { seq: 2 }]]);
  assert.equal(f.data.current.unread, false);
  assert.equal(f.data.sessions[0].unread, false);
  assert.equal(f.data.sessions[1].unread, true);
  await f.tracker.readCurrent();
  assert.equal(f.calls.length, 1);
});

test("late read responses cannot clear a newer result or the newly selected session", async (t) => {
  let finish;
  const f = frontend(t, () => new Promise((resolve) => { finish = resolve; }));
  const pending = f.tracker.readCurrent();
  await f.tracker.readCurrent();
  assert.equal(f.calls.length, 1);
  applySessionRead(f.data, "current", { lastResultSeq: 3 });
  f.data.current = { ...f.data.sessions[1], events: [{ seq: 4, kind: "result" }] };
  finish({ lastResultSeq: 2, readResultSeq: 2, unread: false });
  await pending;
  assert.equal(f.data.sessions[0].unread, true);
  assert.equal(f.data.current.unread, true);
  assert.equal(f.data.current.readResultSeq, -1);
  applySessionRead(f.data, "current", { lastResultSeq: 3, readResultSeq: 3 });
  assert.equal(f.data.sessions[0].unread, false);
  mergeSessionRead(f.data.sessions[0], { lastResultSeq: 2, readResultSeq: -1 });
  assert.equal(f.data.sessions[0].unread, false);
});

test("read errors keep badges and allow a retry when focus returns", async (t) => {
  let fail = true;
  const f = frontend(t, async (_, __, body) => { if (fail) throw Error("offline"); return { lastResultSeq: body.seq, readResultSeq: body.seq }; });
  await f.tracker.readCurrent();
  assert.equal(f.data.current.unread, true);
  fail = false;
  f.win.dispatchEvent(new Event("focus"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.data.current.unread, false);
  assert.equal(f.changed(), 1);
});

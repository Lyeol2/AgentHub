import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-lock-test-"));
process.env.AGENTHUB_DATA = path.join(root, "config");
const { SessionStore, summary } = await import("../server/store.mjs");
const { createSessionService } = await import("../server/application/sessions.mjs");

test.after(() => {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("agenthub-lock-test-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function fixture(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(root, "case-"));
  const store = new SessionStore({ dataDir });
  const now = new Date().toISOString();
  const session = {
    id: "lock-fixture", title: "세션 잠금", agent: "codex", model: "", effort: "", permission: "workspace-write",
    kind: "worker", projectName: "project", projectPath: root, cwd: root, worktree: null,
    agentSessionId: "cli-fixture", state: "idle", createdAt: now, updatedAt: now,
    events: [{ kind: "text", text: "완료 메시지" }], ...extra,
  };
  store.add(session);
  t.after(() => store.flushAll());
  const calls = { sends: [], notifications: [], flushes: [] };
  const runner = {
    isRunning: () => session.state === "running",
    send: (...args) => calls.sends.push(args),
    setState: (s, state) => { s.state = state; },
    append: (s, event) => s.events.push(event),
  };
  const chain = {
    list: () => [], queue: new Map(),
    flush: (s) => calls.flushes.push(s.id),
  };
  const service = createSessionService({
    config: { hiddenSessions: [] }, dataDir, store, runner, chain,
    links: { list: () => [], update() {} },
    mailbox: {}, mcpTokens: {}, mcpDir: path.join(dataDir, "mcp"), chatDir: path.join(dataDir, "chat"),
    cliPaths: () => ({ codex: "unused-codex" }), notify: (...args) => calls.notifications.push(args),
    saveConfig() {}, projects: { ensureProject: () => ({ name: "project", path: root }), projectSessions: () => [session] },
    workflows: () => ({}),
  });
  return { session, store, service, calls, dataDir };
}

test("session lock: toggle persists immediately, hides detail, and unlock restores the same chat", async (t) => {
  const { session, service, dataDir } = fixture(t);
  assert.equal(summary(session).locked, false);
  assert.deepEqual(service.detail(session.id).events, session.events);

  const locked = await service.update(session.id, { locked: true });
  assert.equal(locked.locked, true);
  assert.equal(service.list()[0].locked, true);
  assert.equal(new SessionStore({ dataDir }).get(session.id).locked, true);
  assert.throws(() => service.detail(session.id), (error) => error.status === 423 && error.reason === "locked");
  assert.equal(service.getSession(session.id), session);

  await service.update(session.id, { locked: false });
  assert.equal(new SessionStore({ dataDir }).get(session.id).locked, false);
  assert.deepEqual(service.detail(session.id).events, [{ kind: "text", text: "완료 메시지" }]);
});

test("session lock: rejects nonboolean values before applying other edits", async (t) => {
  const { session, service } = fixture(t);
  for (const locked of ["false", "true", 0, 1, null, {}]) {
    await assert.rejects(service.update(session.id, { locked, title: "바뀌면 안 됨" }), (error) => error.status === 400);
    assert.equal(session.title, "세션 잠금");
    assert.equal(summary(session).locked, false);
  }
});

test("session lock: lock toggles during execution without pausing or restarting it", async (t) => {
  const { session, service, calls } = fixture(t, { state: "running", runningStartedAt: "2026-10-16T00:00:00.000Z" });
  await service.update(session.id, { locked: true });
  assert.equal(session.state, "running");
  assert.equal(session.runningStartedAt, "2026-10-16T00:00:00.000Z");
  assert.equal(calls.sends.length, 0);
  assert.deepEqual(calls.notifications, [["sessions", {}]]);
  await service.update(session.id, { locked: false });
  assert.equal(session.state, "running");
});

test("session lock: automatic execution can still start a locked session", async (t) => {
  const { session, service, calls } = fixture(t, { locked: true, chat: true });
  service.startTurn(service.getSession(session.id), "다음 작업", 2);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0][0], session);
  assert.equal(calls.sends[0][1], "다음 작업");
  assert.equal(session.chainDepth, 2);
  assert.equal(session.locked, true);
});

test("session lock: recreating a session preserves its lock", async (t) => {
  const { session, service, store } = fixture(t, { locked: true, chat: true });
  const created = await service.recreate(session.id);
  assert.notEqual(created.id, session.id);
  assert.equal(created.locked, true);
  assert.equal(store.get(session.id), undefined);
  assert.throws(() => service.detail(created.id), (error) => error.status === 423);
});

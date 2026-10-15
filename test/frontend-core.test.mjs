import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../public/shared/api.js";
import { connectEventStream } from "../public/shared/stream.js";
import { createStore, applySessionState } from "../public/shared/store.js";

test("HTTP client sends the shared header and preserves response error reasons", async () => {
  const requests = [];
  const api = createApiClient({ fetch: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ done: true }) }; } });
  assert.deepEqual(await api("POST", "/api/example", { title: "새 요청" }), { done: true });
  assert.deepEqual(requests[0], ["/api/example", { method: "POST", headers: { "Content-Type": "application/json", "X-AgentHub": "1" }, body: '{"title":"새 요청"}' }]);
  const failing = createApiClient({ fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: "blocked", reason: "not-connected" }) }) });
  await assert.rejects(failing("POST", "/api/messages"), (error) => error.message === "blocked" && error.reason === "not-connected");
});

test("HTTP client handles empty responses and non-JSON server failures", async () => {
  const api = createApiClient({ fetch: async (_url, request) => {
    assert.equal(request.body, undefined);
    return { ok: false, status: 503, json: async () => { throw Error("not JSON"); } };
  } });
  await assert.rejects(api("GET", "/api/status"), /503/);
});

test("HTTP client preserves uncertain write outcomes for reconciliation without retry", async () => {
  let calls = 0;
  const api = createApiClient({ fetch: async () => {
    calls++;
    return { ok: false, status: 504, json: async () => ({ error: "완료 여부 확인 필요", reason: "github-timeout", outcomeUnknown: true }) };
  } });
  await assert.rejects(api("POST", "/api/tasks/task-1/finish", {}), (error) =>
    error.reason === "github-timeout" && error.outcomeUnknown === true);
  assert.equal(calls, 1);
});

test("SSE transport forwards registered events unchanged and can be closed", () => {
  const sources = [];
  class Source {
    constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    close() { this.closed = true; }
  }
  const received = [], event = { data: '{"sessionId":"s1"}' };
  const stream = connectEventStream({ EventSource: Source, handlers: { session: (value) => received.push(value) } });
  assert.equal(sources[0].url, "/api/stream");
  sources[0].handlers.session(event);
  assert.equal(received[0], event);
  stream.close();
  assert.equal(sources[0].closed, true);
});

test("server snapshots and navigation are isolated between windows", () => {
  const a = createStore(), b = createStore();
  a.data.sessions.push({ id: "s1" }); a.navigation.project = "C:/repo"; a.data.hubs.set("repo", {});
  assert.deepEqual(b.data.sessions, []);
  assert.equal(b.navigation.project, null);
  assert.equal(b.data.hubs.size, 0);
});

test("live execution metadata updates both list and open-detail snapshots without erasing start times", () => {
  const { data } = createStore();
  data.sessions = [{ id: "s1", state: "idle" }];
  data.current = { id: "s1", state: "idle", events: [] };
  const startedAt = "2026-10-01T00:00:00Z";
  applySessionState(data, { sessionId: "s1", state: "running", runningStartedAt: startedAt });
  assert.equal(data.sessions[0].runningStartedAt, startedAt);
  assert.equal(data.current.runningStartedAt, startedAt);
  applySessionState(data, { sessionId: "s1", state: "running" });
  assert.equal(data.current.runningStartedAt, startedAt);
  applySessionState(data, { sessionId: "s1", state: "idle" });
  assert.equal(data.current.runningStartedAt, null);
  assert.equal(data.sessions[0].runningStartedAt, null);
});

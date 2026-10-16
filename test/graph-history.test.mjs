import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createGraphHistory, commandBody, linkBody } from "../public/features/graph/history.js";
import { createHub } from "../server/bootstrap.mjs";

function setup() {
  const refreshed = [];
  let changes = 0;
  const history = createGraphHistory({ refresh: async (projectPath) => { refreshed.push(projectPath); }, onChange: () => { changes++; }, limit: 3 });
  return { history, refreshed, changes: () => changes };
}

test("graph history: undo and redo replay entries in order and a new change clears redo", async () => {
  const { history, refreshed } = setup();
  const log = [];
  const entry = (name) => ({ label: name, undo: async () => log.push(`undo ${name}`), redo: async () => log.push(`redo ${name}`) });
  history.record("C:/repo", entry("a"));
  history.record("C:/repo", entry("b"));
  assert.deepEqual(history.state("C:/repo"), { undo: "b", redo: null, running: false });
  assert.deepEqual(await history.undo("C:/repo"), { ok: true, label: "b" });
  await history.undo("C:/repo");
  assert.equal(await history.undo("C:/repo"), null, "nothing left to undo");
  await history.redo("C:/repo");
  assert.deepEqual(log, ["undo b", "undo a", "redo a"]);
  assert.equal(history.state("C:/repo").redo, "b");
  history.record("C:/repo", entry("c"));
  assert.equal(history.state("C:/repo").redo, null, "a new change discards redo");
  assert.deepEqual(refreshed, ["C:/repo", "C:/repo", "C:/repo"]);
});

test("graph history: entries belong to one project and the oldest drop past the limit", async () => {
  const { history } = setup();
  const noop = (label) => ({ label, undo: async () => {}, redo: async () => {} });
  history.record("C:/one", noop("one"));
  assert.equal(await history.undo("C:/two"), null, "another project cannot undo it");
  assert.equal(history.state("C:/two").undo, null);
  history.record("C:/two", noop("two"));
  assert.equal(history.state("C:/one").undo, null, "switching projects starts a fresh history");
  for (const label of ["x", "y", "z"]) history.record("C:/two", noop(label));
  const undone = [];
  for (let result; (result = await history.undo("C:/two"));) undone.push(result.label);
  assert.deepEqual(undone, ["z", "y", "x"]);
});

test("graph history: recreated ids follow through repeated undo and redo, and failures drop the entry", async () => {
  const { history } = setup();
  const live = new Set(["node-1"]);
  let next = 2;
  // 노드를 지운 기록: 되돌리면 새 id로 다시 만든다.
  history.record("C:/repo", { label: "삭제",
    undo: async ({ remap }) => { const id = `node-${next++}`; live.add(id); remap("node-1", id); },
    redo: async ({ resolve }) => { if (!live.delete(resolve("node-1"))) throw new Error("missing"); } });
  live.delete("node-1");
  await history.undo("C:/repo");
  assert.equal(history.resolve("node-1"), "node-2");
  await history.redo("C:/repo");
  await history.undo("C:/repo");
  assert.equal(history.resolve("node-1"), "node-3");
  assert.deepEqual([...live], ["node-3"]);

  live.clear(); // 다른 창에서 지웠다.
  const failed = await history.redo("C:/repo");
  assert.equal(failed.ok, false);
  assert.equal(failed.error.message, "missing");
  assert.equal(history.state("C:/repo").undo, null);
  assert.equal(history.state("C:/repo").redo, null, "a failed step is not retried");
});

test("graph history: tabs isolate stacks but share recreated IDs for cross-tab links", async () => {
  let tabId = "one";
  const history = createGraphHistory({ refresh: async () => {}, getScope: () => tabId });
  const seen = [];
  history.record("C:/repo", { label: "one", undo: async ({ remap }) => remap("old-link", "new-link"), redo: async () => {} });
  tabId = "two";
  history.record("C:/repo", { label: "two", undo: async ({ resolve }) => seen.push(resolve("old-link")), redo: async () => {} });
  history.record("C:/repo", { tabId: "one", label: "late one", undo: async () => {}, redo: async () => {} });
  assert.equal(history.state("C:/repo").undo, "two", "a delayed write belongs to its starting tab");
  tabId = "one";
  await history.undo("C:/repo"); await history.undo("C:/repo");
  tabId = "two";
  await history.undo("C:/repo");
  assert.deepEqual(seen, ["new-link"]);
  history.invalidate("C:/repo", ["one"]);
  assert.equal(history.state("C:/repo").redo, "two", "moving another tab does not erase this stack");
  tabId = "one";
  assert.equal(history.state("C:/repo").redo, null);
});

test("graph history: restore payloads recreate every node kind and link through the real API", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthub-history-"));
  const projectPath = path.join(root, "project");
  await mkdir(projectPath);
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await rm(root, { recursive: true, force: true }); });
  const api = async (method, pathname, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api${pathname}`, { method, headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${pathname}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const definitions = [
    { kind: "command", command: "echo hi", title: "명령" }, { kind: "button", prompt: "시작" }, { kind: "input" }, { kind: "repeat", maxIterations: 4 },
    { kind: "transform", transformMode: "template", template: "{{input}}!" }, { kind: "notify", message: "끝" }, { kind: "markdown" },
    { kind: "webhook", url: "https://example.test/hook", headers: "X-A: 1" }, { kind: "webhook-in", prompt: "{{body}}" }, { kind: "watch", watchPaths: ["."] },
    { kind: "schedule", scheduleMode: "daily", timeOfDay: "10:30", prompt: "{{scheduledAt}}" },
  ];
  for (const definition of definitions) {
    const original = await api("POST", "/commands", { projectPath, pos: { x: 40, y: 80 }, ...definition });
    await api("DELETE", `/commands/${original.id}`);
    const restored = await api("POST", "/commands", commandBody(original));
    assert.notEqual(restored.id, original.id);
    assert.deepEqual(commandBody(restored), commandBody(original), `${definition.kind} keeps its settings`);
    if (definition.kind === "webhook-in") assert.notEqual(restored.hookToken, original.hookToken, "a restored receiver gets a new address");
    if (definition.kind === "schedule") {
      const payload = commandBody({ ...original, scheduleEnabled: true, nextRunAt: "2030-01-01T00:00:00Z" });
      assert.equal(payload.scheduleEnabled, undefined);
      assert.equal(payload.nextRunAt, undefined);
      assert.equal(restored.scheduleEnabled, false);
    }
  }
  const [from, to] = (await api("GET", `/commands?path=${encodeURIComponent(projectPath)}`)).commands.filter((c) => ["command", "notify"].includes(c.kind ?? "command"));
  const link = await api("POST", "/links", { from: from.id, to: to.id, when: "keyword", keyword: "통과", note: "넘김", approve: true });
  await api("DELETE", `/links/${link.id}`);
  const again = await api("POST", "/links", linkBody(link));
  assert.deepEqual(linkBody(again), linkBody(link));
});

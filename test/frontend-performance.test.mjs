import test from "node:test";
import assert from "node:assert/strict";
import { projectSummaries } from "../public/features/projects/model.js";
import { layoutGraph } from "../public/features/graph/model.js";
import { createLabelPlacer } from "../public/features/graph/edge-layout.js";
import { createFrameTask } from "../public/shared/frame-task.js";
import { connectLiveUpdates } from "../public/application/live-updates.js";

test("project summaries visit each session once and share canonical Windows paths", () => {
  let visits = 0;
  const sessions = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), get projectPath() { visits++; return `e:/git/project${i % 100}/`; }, updatedAt: String(i).padStart(5, "0") }));
  const projects = Array.from({ length: 100 }, (_, i) => ({ path: `E:\\Git\\Project${i}`, lastActive: "00000" }));
  const summaries = projectSummaries(projects, sessions);
  assert.equal(visits, sessions.length);
  assert.equal(summaries.get("e:\\git\\project0").sessions.length, 20);
  assert.equal(summaries.get("e:\\git\\project0").lastActive, "01900");
});

test("graph layout visits edges linearly and handles a deep cycle without recursion", () => {
  const count = 12000;
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `s${i}` }));
  let visits = 0;
  const links = nodes.map((node, i) => ({ get from() { visits++; return node.id; }, get to() { visits++; return nodes[(i + 1) % count].id; } }));
  const positions = layoutGraph(nodes, links);
  assert.equal(positions.size, count);
  assert.ok(positions.get(`s${count - 1}`).x > positions.get("s0").x);
  assert.ok(visits < count * 15, `edge reads: ${visits}`);
  visits = 0;
  const placed = nodes.map((node, i) => ({ ...node, pos: { x: i, y: 4 } }));
  assert.deepEqual(layoutGraph(placed, links).get("s11"), { x: 11, y: 4 });
  assert.equal(visits, 0, "saved positions do not require topology traversal");
});

test("dense edge labels skip an occupied stack and keep every label separated", () => {
  const place = createLabelPlacer();
  for (let i = 0; i < 15000; i++) assert.deepEqual(place({ x: 10, y: 3 }, 40), { x: 10, y: 3 + i * 22 });
  assert.deepEqual(place({ x: 1000, y: 3 }, 40), { x: 1000, y: 3 });
});

test("frame tasks retain the latest move and synchronously flush before a gesture ends", () => {
  const pending = new Map(), seen = []; let id = 0;
  const task = createFrameTask((value) => seen.push(value), { request(fn) { pending.set(++id, fn); return id; }, cancel(id) { pending.delete(id); } });
  for (let i = 0; i < 100; i++) task.schedule(i);
  assert.equal(pending.size, 1);
  task.flush();
  assert.deepEqual(seen, [99]);
  assert.equal(pending.size, 0);
  task.schedule("cancelled"); task.cancel(); task.flush();
  assert.deepEqual(seen, [99]);
});

test("SSE bursts update state immediately but render once and only for the affected project", () => {
  const previous = { EventSource: globalThis.EventSource, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map(); let id = 0, handlers;
  globalThis.requestAnimationFrame = (fn) => { frames.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.EventSource = class { constructor() { handlers = {}; } addEventListener(key, fn) { handlers[key] = fn; } close() {} };
  try {
    const calls = { list: 0, nav: 0, project: 0 };
    const data = { sessions: [{ id: "one", agent: "claude", projectPath: "C:/one" }], current: null };
    const navigation = { view: "project", project: "C:/two" };
    const stream = connectLiveUpdates({ data, navigation, renderSessionList: () => calls.list++, renderProjectNav: () => calls.nav++, renderProjectSessions: () => calls.project++, projectTab: () => "flow" });
    for (let i = 0; i < 100; i++) handlers.state({ data: JSON.stringify({ sessionId: "one", state: "running" }) });
    assert.equal(data.sessions[0].state, "running");
    assert.equal(calls.list, 0);
    assert.equal(frames.size, 1);
    const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn()); };
    flush();
    assert.deepEqual(calls, { list: 1, nav: 1, project: 0 });
    navigation.project = "c:\\one\\";
    handlers.state({ data: JSON.stringify({ sessionId: "one", state: "idle" }) });
    flush();
    assert.equal(calls.project, 1);
    handlers.state({ data: JSON.stringify({ sessionId: "one", state: "running" }) });
    stream.close();
    assert.equal(frames.size, 0);
  } finally { Object.assign(globalThis, previous); }
});

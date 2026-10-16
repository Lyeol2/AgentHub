import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createCommandService } from "../server/application/commands.mjs";
import { createWorkflowService } from "../server/application/workflows.mjs";

function fixture() {
  const projectPath = process.cwd();
  const session = { id: "session", title: "세션", projectPath, state: "idle" };
  const sessions = new Map([[session.id, session]]);
  const nodes = new Map();
  const links = [];
  const calls = [];
  const commands = { get: id => nodes.get(id), list: () => [...nodes.values()], add: node => nodes.set(node.id, node), update: (node, fields) => Object.assign(node, fields), remove: id => nodes.delete(id) };
  const store = { get: id => sessions.get(id), list: () => [...sessions.values()] };
  const linkStore = { list: () => links, add: link => links.push(link), removeForSession() {}, update: (link, fields) => Object.assign(link, fields) };
  const chain = { runs: new Map(), runCommand: async (node, options) => calls.push({ node, options }), stopCommand: () => true };
  const projects = { ensureProject: value => ({ path: path.resolve(value) }), projectSessions: () => [...sessions.values()] };
  const service = createCommandService({ commands, store, chain, links: linkStore, projects, cliPaths: () => ({}), notify() {} });
  const workflows = createWorkflowService({ commands, store, chain, links: linkStore, projects, runner: {}, sessions: { getSession: id => sessions.get(id) }, notify() {} });
  const create = (kind, fields = {}) => service.create({ projectPath, kind, ...fields });
  return { projectPath, sessions, nodes, links, commands, chain, service, workflows, calls, create };
}

test("flow API: stores typed schemas and rejects editing active nodes", () => {
  const f = fixture();
  const input = f.create("input");
  const transform = f.create("transform", { transformMode: "lines", expression: "FAIL" });
  const repeat = f.create("repeat", { maxIterations: 5, delayMs: 100 });
  const watch = f.create("watch", { watchPaths: ["."] });
  assert.equal(input.fields[0].key, "request");
  assert.equal(transform.expression, "FAIL");
  assert.equal(repeat.maxIterations, 5);
  f.chain.runs.set(repeat.id, {});
  assert.throws(() => f.service.update(repeat.id, { maxIterations: 10 }), error => error.status === 409);
  f.service.update(repeat.id, { pos: { x: 40, y: 80 } });
  assert.deepEqual(repeat.pos, { x: 40, y: 80 });
  watch.state = "watching";
  assert.throws(() => f.service.update(watch.id, { debounceMs: 1000 }), error => error.status === 409);
  watch.state = "idle";
  f.service.update(watch.id, { debounceMs: 1000 });
  assert.equal(watch.debounceMs, 1000);
  assert.throws(() => f.service.update(input.id, { fields: [{ key: "bad key" }] }), error => error.status === 400);
});

test("flow API: validates form values before running and forwards supplied values", async () => {
  const f = fixture();
  const input = f.create("input");
  await assert.rejects(f.service.run(input.id, { values: {} }), error => error.status === 400 && /필수/.test(error.message));
  assert.equal(f.calls.length, 0);
  const values = { request: "수정하세요" };
  await f.service.run(input.id, { values });
  assert.deepEqual(f.calls[0].options.values, values);
  const watch = f.create("watch", { watchPaths: ["."] });
  f.chain.runCommand = async () => { throw new Error("감시할 경로가 없습니다"); };
  await assert.rejects(f.service.run(watch.id), error => error.status === 400 && /경로/.test(error.message));
});

test("flow API: result collectors accept executable nodes from the same project only", () => {
  const f = fixture();
  const command = f.create("command", { command: "echo ready" });
  const git = f.create("git", { branch: "main" });
  const input = f.create("input");
  const transform = f.create("transform");
  const repeat = f.create("repeat");
  const members = ["session", command.id, git.id, input.id, transform.id, repeat.id];
  const group = f.create("group", { members });
  assert.deepEqual(group.members, members);
  for (const node of [f.create("watch"), f.create("markdown"), f.create("button", { prompt: "run" }), group]) {
    assert.throws(() => f.service.update(group.id, { members: [node.id] }), error => error.status === 400);
  }
  assert.throws(() => f.service.update(group.id, { members: ["missing"] }), error => error.status === 400);
  f.sessions.set("outside", { id: "outside", projectPath: path.dirname(f.projectPath) });
  assert.throws(() => f.service.update(group.id, { members: ["outside"] }), error => error.status === 400);
});

test("flow API: deleting executable members repairs every collector and leaves empty collectors editable", () => {
  const f = fixture();
  const members = [f.create("command", { command: "echo ready" }), f.create("git", { branch: "main" }), f.create("input"), f.create("transform"), f.create("repeat")];
  const group = f.create("group", { members: ["session", ...members.map((node) => node.id)] });
  const single = f.create("group", { members: [members[0].id] });
  assert.deepEqual(f.service.remove(members[0].id), { ok: true });
  assert.equal(f.nodes.has(members[0].id), false);
  assert.deepEqual(group.members, ["session", ...members.slice(1).map((node) => node.id)]);
  assert.deepEqual(single.members, []);
  f.service.update(single.id, { members: ["session"] });
  assert.deepEqual(single.members, ["session"]);
  for (const node of members.slice(1)) f.service.remove(node.id);
  assert.deepEqual(group.members, ["session"]);
  assert.deepEqual(single.members, ["session"]);
});

test("flow API: source nodes reject incoming edges while mixed outputs can reach collectors and Markdown", () => {
  const f = fixture();
  const input = f.create("input");
  const watch = f.create("watch");
  const button = f.create("button", { prompt: "run" });
  const command = f.create("command", { command: "echo ready" });
  const git = f.create("git", { branch: "main" });
  const transform = f.create("transform");
  const repeat = f.create("repeat");
  const markdown = f.create("markdown");
  const group = f.create("group", { members: ["session", command.id] });
  const connect = (from, to, when = "success") => f.workflows.createLink({ from, to, when });
  for (const node of [input, watch, button]) assert.throws(() => connect("session", node.id), error => error.status === 400);
  for (const node of [command, git, transform, repeat, group]) connect(button.id, node.id);
  for (const node of [input, watch, command, git, transform, repeat, group]) connect(node.id, markdown.id);
  connect(git.id, group.id);
  connect(repeat.id, "session", "success");
  connect(repeat.id, "session", "error");
  assert.throws(() => connect(repeat.id, "session", "keyword"), error => error.status === 400);
  assert.throws(() => connect(markdown.id, "session"), error => error.status === 400);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHub } from "../server/bootstrap.mjs";

class FakeRunner extends EventEmitter {
  calls = [];
  isRunning() { return false; }
  append(session, event) { session.events.push(event); }
  send(...args) { this.calls.push(args); }
  stopAll() {}
}

async function fixture(t, { git = false, targetBranch = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-group-templates-"));
  const project = path.join(root, "source"), target = path.join(root, "target"), dataDir = path.join(root, "data");
  for (const dir of [project, target]) {
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, "src"));
    if (git) {
      execFileSync("git", ["init", "--initial-branch=main", dir], { windowsHide: true, stdio: "ignore" });
      execFileSync("git", ["-C", dir, "-c", "user.name=Template Test", "-c", "user.email=template@example.test", "commit", "--allow-empty", "-m", "initial"], { windowsHide: true, stdio: "ignore" });
      if (dir === project || targetBranch) execFileSync("git", ["-C", dir, "branch", "feature/review"], { windowsHide: true, stdio: "ignore" });
    }
  }
  const runner = new FakeRunner(), opened = [];
  const start = async () => {
    const hub = createHub({ dataDir, port: 0, warmup: false,
      deps: { runner, cliPaths: () => ({ claude: "fake", codex: "fake" }), logger: { log() {}, error() {} } } });
    opened.push(hub); await hub.start(); return hub;
  };
  const f = { root, project, target, dataDir, runner, hub: await start() };
  t.after(async () => {
    for (const hub of opened.reverse()) await hub.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("agenthub-group-templates-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  f.api = async (method, suffix, body) => {
    const response = await fetch("http://127.0.0.1:" + f.hub.port + "/api" + suffix, { method,
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  };
  f.ok = async (method, suffix, body) => {
    const response = await f.api(method, suffix, body);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  };
  f.session = async (changes = {}) => {
    const item = await f.ok("POST", "/sessions", { projectPath: project, agent: "claude", permission: "acceptEdits", title: "구현", role: "코드를 구현한다.", ...changes });
    if (changes.graphPos) return f.ok("PUT", "/sessions/" + item.id, { graphPos: changes.graphPos });
    return item;
  };
  f.command = (kind, changes = {}) => f.ok("POST", "/commands", { projectPath: project, kind, title: kind,
    ...(kind === "command" ? { command: "echo test" } : {}),
    ...(kind === "button" ? { prompt: "작업 시작" } : {}),
    ...(kind === "git" ? { gitAction: "use", branch: "feature/review" } : {}), ...changes });
  f.group = (members, changes = {}) => f.ok("POST", "/node-groups", { projectPath: project, title: "개발 묶음", members,
    rect: { x: 40, y: 60, w: 1200, h: 800 }, ...changes });
  f.save = (groupId, title = "재사용 템플릿") => f.ok("POST", "/group-templates", { groupId, title });
  f.restart = async () => { await f.hub.shutdown(); f.hub = await start(); };
  f.counts = () => [f.hub.store.list().length, f.hub.commands.list().length, f.hub.links.list().length, f.hub.nodeGroups.list().length];
  return f;
}

test("group templates API: mixed node definitions, internal links, collector references and boundary ports instantiate with fresh IDs", async t => {
  const f = await fixture(t, { git: true });
  const implementation = await f.session({ graphPos: { x: 100, y: 180 }, roleName: "구현" });
  const review = await f.session({ agent: "codex", permission: "workspace-write", title: "검토", orchestrator: true,
    role: "변경을 검토한다.", model: "gpt-5", effort: "high", graphPos: { x: 500, y: 180 } });
  const cmd = await f.command("command", { pos: { x: 800, y: 180 }, timeoutSec: 42, cwdMode: "project" });
  const kinds = ["button", "git", "markdown", "input", "repeat", "transform", "watch", "notify"];
  const definitions = [];
  for (const kind of kinds) definitions.push(await f.command(kind, { pos: { x: 100 + definitions.length * 20, y: 400 } }));
  const collector = await f.command("group", { members: [implementation.id, cmd.id], pos: { x: 500, y: 400 } });
  const group = await f.group([implementation.id, review.id, cmd.id, collector.id, ...definitions.map(item => item.id)], {
    collapsed: true, ports: [{ id: "entry", direction: "input", nodeId: implementation.id, label: "시작" },
      { id: "exit", direction: "output", nodeId: review.id, label: "검토 완료", when: "success" }] });
  const edge = await f.ok("POST", "/links", { from: implementation.id, to: cmd.id, when: "success", approve: true, note: "테스트한다." });
  f.hub.links.update(f.hub.links.get(edge.id), { pending: { text: "이전 승인 대기", flowId: "old-flow" }, lastRun: "old" });
  const source = f.hub.store.get(implementation.id);
  Object.assign(source, { agentSessionId: "old-cli", cliSessionIds: ["old-cli"], taskId: "old-task", createdBy: review.id,
    worktree: { dir: "/old-tree", branch: "old" }, cwd: "/old-tree", gitContext: { branch: "old" }, state: "running",
    paused: true, waiting: true, allowedTools: ["Bash"], flowId: "old-flow", handover: "old secret",
    events: [{ kind: "permission", status: "pending", text: "old permission" }] });
  f.hub.store.touch(source);
  for (const command of f.hub.commands.list()) Object.assign(command, { state: command.kind === "watch" ? "watching" : "running",
    live: { tail: "old output" }, lastRun: { tail: "old output" }, queued: { request: "old input" }, flowId: "old-flow" });
  const template = await f.save(group.id);
  assert.equal(template.nodes.length, group.members.length);
  assert.equal(template.links.length, 1);
  const serialized = JSON.stringify(template);
  for (const forbidden of ["old-cli", "old-task", "/old-tree", "old-flow", "old secret", "old permission", "old output", "old input", f.project]) assert.ok(!serialized.includes(forbidden), forbidden);
  const before = f.counts();
  const result = await f.ok("POST", "/group-templates/" + template.id + "/instantiate", { projectPath: f.target, pos: { x: 300, y: 250 } });
  assert.notEqual(result.group.id, group.id);
  assert.equal(result.group.projectPath, f.target);
  assert.equal(result.group.collapsed, true);
  assert.deepEqual(result.group.rect, { x: 300, y: 250, w: 1200, h: 800 });
  assert.equal(result.group.members.length, group.members.length);
  assert.ok(result.group.members.every(id => !group.members.includes(id)));
  const restoredImplementation = result.nodes.sessions.find(item => item.title === "구현");
  const restoredReview = result.nodes.sessions.find(item => item.title === "검토");
  assert.deepEqual(restoredImplementation.graphPos, { x: 360, y: 370 });
  assert.equal(restoredImplementation.cwd, f.target);
  assert.equal(restoredImplementation.createdBy, null);
  assert.equal(restoredImplementation.agentSessionId, null);
  assert.equal(restoredImplementation.worktree, null);
  assert.equal(restoredImplementation.state, "idle");
  assert.equal(restoredImplementation.eventCount, 0);
  assert.equal(restoredImplementation.gitContext, undefined);
  assert.equal(restoredImplementation.taskId, undefined);
  assert.equal(restoredImplementation.allowedTools, undefined);
  assert.equal(restoredReview.kind, "orchestrator");
  assert.equal(restoredReview.effort, "high");
  assert.equal(restoredReview.role, "변경을 검토한다.");
  const restoredCommand = result.nodes.commands.find(item => item.kind === "command");
  const restoredCollector = result.nodes.commands.find(item => item.kind === "group");
  assert.deepEqual(restoredCollector.members, [restoredImplementation.id, restoredCommand.id]);
  assert.equal(restoredCommand.timeoutSec, 42);
  for (const command of result.nodes.commands) {
    assert.equal(command.state, "idle");
    assert.equal(command.lastRun, null);
    assert.equal(command.live, undefined);
    assert.equal(command.queued, undefined);
    assert.equal(command.flowId, undefined);
  }
  assert.equal(result.links[0].from, restoredImplementation.id);
  assert.equal(result.links[0].to, restoredCommand.id);
  assert.equal(result.links[0].approve, true);
  assert.equal(result.links[0].pending, null);
  assert.equal(result.links[0].lastRun, undefined);
  assert.notEqual(result.links[0].id, edge.id);
  assert.equal(result.group.ports.find(port => port.label === "시작").nodeId, restoredImplementation.id);
  assert.ok(result.group.ports.every(port => !group.ports.some(old => old.id === port.id)));
  assert.equal(f.runner.calls.length, 0);
  assert.deepEqual(f.counts(), [before[0] + 2, before[1] + kinds.length + 2, before[2] + 1, before[3] + 1]);
});

test("group templates API: reusable snapshots survive source deletion and server restart", async t => {
  const f = await fixture(t);
  const session = await f.session();
  const transform = await f.command("transform", { transformMode: "template", template: "{{input}}" });
  const group = await f.group([session.id, transform.id]);
  const saved = await f.save(group.id, "다른 프로젝트용");
  await f.ok("DELETE", "/node-groups/" + group.id);
  await f.ok("DELETE", "/sessions/" + session.id);
  await f.ok("DELETE", "/commands/" + transform.id);
  await f.restart();
  const list = await f.ok("GET", "/group-templates?path=" + encodeURIComponent(f.target));
  assert.deepEqual(list.templates.map(item => item.id), [saved.id]);
  const result = await f.ok("POST", "/group-templates/" + saved.id + "/instantiate", { projectPath: f.target });
  assert.equal(result.nodes.sessions.length, 1);
  assert.equal(result.nodes.commands[0].template, "{{input}}");
  await f.ok("DELETE", "/group-templates/" + saved.id);
  assert.deepEqual((await f.ok("GET", "/group-templates")).templates, []);
  assert.equal((await f.api("POST", "/group-templates/" + saved.id + "/instantiate", { projectPath: f.target })).status, 404);
  assert.equal(f.hub.store.get(result.nodes.sessions[0].id).state, "idle");
});

test("group templates API: external collector dependencies are rejected without partial snapshots", async t => {
  const f = await fixture(t);
  const inside = await f.session(), outside = await f.session({ title: "바깥" });
  const collector = await f.command("group", { members: [inside.id, outside.id] });
  const group = await f.group([inside.id, collector.id]);
  const before = f.counts();
  const result = await f.api("POST", "/group-templates", { groupId: group.id });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /모든 구성원/);
  assert.deepEqual((await f.ok("GET", "/group-templates")).templates, []);
  assert.deepEqual(f.counts(), before);
});

test("group templates API: unavailable target branch fails preflight without creating any graph nodes", async t => {
  const f = await fixture(t, { git: true, targetBranch: false });
  const session = await f.session(), git = await f.command("git");
  const group = await f.group([session.id, git.id]);
  const template = await f.save(group.id);
  const before = f.counts();
  const result = await f.api("POST", "/group-templates/" + template.id + "/instantiate", { projectPath: f.target });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /로컬 브랜치/);
  assert.deepEqual(f.counts(), before);
});

test("group templates API: late creation failure rolls back only nodes and links belonging to that instantiation", async t => {
  const f = await fixture(t);
  const session = await f.session(), command = await f.command("command");
  const group = await f.group([session.id, command.id]);
  await f.ok("POST", "/links", { from: session.id, to: command.id });
  const template = await f.save(group.id);
  const before = f.counts(), original = structuredClone({ group, session: f.hub.store.get(session.id), command: f.hub.commands.get(command.id), links: f.hub.links.list() });
  const realCreate = f.hub.services.nodeGroups.create;
  f.hub.services.nodeGroups.create = (...args) => { realCreate(...args); throw new Error("simulated group storage failure after insert"); };
  try {
    const result = await f.api("POST", "/group-templates/" + template.id + "/instantiate", { projectPath: f.target });
    assert.equal(result.status, 500);
  } finally { f.hub.services.nodeGroups.create = realCreate; }
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(f.hub.store.get(session.id), original.session);
  assert.deepEqual(f.hub.commands.get(command.id), original.command);
  assert.deepEqual(f.hub.links.list(), original.links);
  assert.deepEqual(f.hub.nodeGroups.get(group.id), original.group);
});

test("group templates API: persisted invalid references and options fail before mutation", async t => {
  const f = await fixture(t);
  const session = await f.session();
  const group = await f.group([session.id]);
  const template = await f.save(group.id);
  await f.hub.shutdown();
  const file = path.join(f.dataDir, "group-templates.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored[0].nodes[0].config.agent = "unsupported";
  fs.writeFileSync(file, JSON.stringify(stored));
  await f.restart();
  const before = f.counts();
  const result = await f.api("POST", "/group-templates/" + template.id + "/instantiate", { projectPath: f.target });
  assert.equal(result.status, 400);
  assert.deepEqual(f.counts(), before);
});

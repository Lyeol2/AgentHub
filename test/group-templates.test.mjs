import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GroupTemplateStore } from "../server/group-templates.mjs";
import { createGroupTemplateService } from "../server/application/group-templates.mjs";
import { NodeGroupStore, createNodeGroupService } from "../server/node-groups.mjs";
import { SessionStore } from "../server/store.mjs";
import { CommandStore, checkCommand } from "../server/commands.mjs";
import { LinkStore } from "../server/links.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-group-template-unit-"));
  const project = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(project); fs.mkdirSync(target);
  const store = new SessionStore({ dataDir: root }), commands = new CommandStore({ dataDir: root });
  const links = new LinkStore({ dataDir: root }), groups = new NodeGroupStore({ dataDir: root });
  const projects = { ensureProject: (projectPath) => {
    assert.ok([project, target].includes(projectPath)); return { path: projectPath, name: path.basename(projectPath) };
  } };
  let next = 0;
  const sessions = {
    checkSessionOptions(item) {
      if (!["claude", "codex"].includes(item.agent)) throw new Error("invalid agent");
      return { agent: item.agent, model: item.model ?? "", effort: item.effort ?? "", permission: item.permission ?? "acceptEdits" };
    },
    async createSession({ project, title, role, roleName, orchestrator, ...options }) {
      const created = { id: "new-session-" + ++next, projectPath: project.path, projectName: project.name, cwd: project.path,
        title, role, roleName, kind: orchestrator ? "orchestrator" : "worker", ...this.checkSessionOptions(options),
        createdBy: null, worktree: null, agentSessionId: null, state: "idle", locked: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
      store.add(created); return created;
    },
    setSessionSkills() {},
  };
  const nodeGroups = createNodeGroupService({ groups, store, commands, links, projects });
  const service = createGroupTemplateService({ dataDir: root, store, commands, links, nodeGroups, projects, sessions });
  const now = new Date().toISOString();
  store.add({ id: "source-ai", projectPath: project, title: "구현", agent: "claude", role: "구현 역할", roleName: "구현", createdAt: now, updatedAt: now,
    graphPos: { x: 100, y: 180 }, events: [{ kind: "text", text: "previous answer" }], state: "running", agentSessionId: "old-cli", taskId: "old-task" });
  commands.add({ id: "cmd-test", projectPath: project, ...checkCommand({ kind: "command", command: "echo test" }), pos: { x: 400, y: 180 }, state: "error", lastRun: { tail: "old output" } });
  commands.add({ id: "cmd-collect", projectPath: project, ...checkCommand({ kind: "group", members: ["source-ai", "cmd-test"] }), pos: { x: 700, y: 180 }, state: "idle" });
  links.add({ id: "edge", from: "source-ai", to: "cmd-test", when: "success", note: "검증", approve: true, pending: { prompt: "old" } });
  const group = nodeGroups.create({ projectPath: project, title: "작업 묶음", members: ["source-ai", "cmd-test", "cmd-collect"], rect: { x: 40, y: 60, w: 1000, h: 700 },
    ports: [{ id: "entry", nodeId: "source-ai", direction: "input", label: "시작" }] });
  t.after(() => {
    store.flushAll();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("agenthub-group-template-unit-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { root, project, target, store, commands, links, groups, nodeGroups, service, sessions, group };
}

test("group template definitions persist without runtime data and instantiate with independent references", async t => {
  const f = fixture(t), template = f.service.create({ groupId: f.group.id, title: "새 템플릿" });
  assert.match(template.id, /^gtpl-/);
  assert.equal(new GroupTemplateStore({ dataDir: f.root }).get(template.id).title, "새 템플릿");
  for (const stale of ["old-cli", "old-task", "old output", "previous answer", f.project]) assert.ok(!JSON.stringify(template).includes(stale), stale);
  const result = await f.service.instantiate(template.id, { projectPath: f.target, pos: { x: 300, y: 300 } });
  assert.equal(result.group.members.length, 3);
  assert.equal(result.nodes.sessions[0].eventCount, 0);
  assert.equal(result.nodes.sessions[0].taskId, undefined);
  assert.deepEqual(result.nodes.sessions[0].graphPos, { x: 360, y: 420 });
  const cmd = result.nodes.commands.find(item => item.kind === "command");
  const collector = result.nodes.commands.find(item => item.kind === "group");
  assert.deepEqual(collector.members, [result.nodes.sessions[0].id, cmd.id]);
  assert.equal(result.links[0].to, cmd.id);
  assert.equal(result.links[0].pending, null);
  assert.equal(result.group.ports[0].nodeId, result.nodes.sessions[0].id);
  assert.notEqual(result.group.ports[0].id, "entry");
  result.nodes.commands[0].title = "returned clone changed";
  assert.notEqual(f.commands.get(result.nodes.commands[0].id).title, "returned clone changed");
});

test("group template preflight rejects external collector dependencies without saving a partial definition", t => {
  const f = fixture(t);
  f.commands.get("cmd-collect").members.push("external-node");
  assert.throws(() => f.service.create({ groupId: f.group.id }), /모든 구성원/);
  assert.deepEqual(f.service.list().templates, []);
});

test("group template creation failure after inserting its box removes only that instantiation", async t => {
  const f = fixture(t), template = f.service.create({ groupId: f.group.id });
  const before = { sessions: structuredClone(f.store.list()), commands: structuredClone(f.commands.list()), links: structuredClone(f.links.list()), groups: structuredClone(f.groups.list()) };
  const create = f.nodeGroups.create;
  f.nodeGroups.create = (...args) => { create(...args); throw new Error("late write error"); };
  await assert.rejects(f.service.instantiate(template.id, { projectPath: f.target }), /late write error/);
  assert.deepEqual(f.store.list(), before.sessions);
  assert.deepEqual(f.commands.list(), before.commands);
  assert.deepEqual(f.links.list(), before.links);
  assert.deepEqual(f.groups.list(), before.groups);
});

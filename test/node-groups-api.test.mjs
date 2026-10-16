import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHub } from "../server/bootstrap.mjs";

class FakeRunner extends EventEmitter {
  calls = [];
  running = new Set();
  isRunning(id) { return this.running.has(id); }
  append(session, event) { session.events.push(event); }
  send(session, prompt, cli, input, meta) {
    this.calls.push({ id: session.id, prompt, input, meta, permission: session.permission, cwd: session.cwd });
    this.running.add(session.id);
  }
  stopAll() { this.running.clear(); }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-node-groups-api-"));
  const project = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  fs.mkdirSync(project);
  fs.mkdirSync(otherProject);
  const dataDir = path.join(root, "data");
  const runner = new FakeRunner();
  const opened = [];
  const start = async () => {
    const hub = createHub({ dataDir, port: 0, warmup: false,
      deps: { runner, cliPaths: () => ({ claude: "fake-no-process", codex: "fake-no-process" }), logger: { log() {} } } });
    opened.push(hub);
    await hub.start();
    return hub;
  };
  const f = { root, project, otherProject, dataDir, runner, hub: await start() };
  for (const id of ["source", "target", "other", "foreign", "chat"]) f.hub.store.add({
    id, title: id, agent: id === "other" ? "codex" : "claude", permission: "acceptEdits", state: "idle",
    locked: id === "target", chat: id === "chat", projectPath: id === "foreign" ? otherProject : project,
    projectName: "project", cwd: id === "foreign" ? otherProject : project,
    graphPos: { x: id === "source" ? 100 : 500, y: 180 }, events: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  t.after(async () => {
    for (const hub of opened.reverse()) await hub.shutdown();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("agenthub-node-groups-api-"));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  f.api = async (method, suffix, body) => {
    const response = await fetch("http://127.0.0.1:" + f.hub.port + "/api" + suffix, { method,
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  };
  f.ok = async (method, suffix, body) => {
    const response = await f.api(method, suffix, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  f.create = (kind, changes = {}) => f.ok("POST", "/commands", {
    kind, projectPath: project, title: kind, ...(kind === "button" ? { prompt: "요청을 실행하세요." } : {}),
    ...(kind === "command" ? { command: 'node -e "console.log(123)"' } : {}),
    ...(kind === "git" ? { gitAction: "use", branch: "feature/existing" } : {}),
    ...(kind === "group" ? { members: ["source", "target"] } : {}), ...changes,
  });
  f.group = (members, changes = {}) => f.ok("POST", "/node-groups", {
    projectPath: project, title: "작업 그룹", members, rect: { x: 40, y: 60, w: 1200, h: 800 }, collapsed: false, ports: [], ...changes,
  });
  f.list = async (projectPath = project) => (await f.ok("GET", "/node-groups?path=" + encodeURIComponent(projectPath))).groups;
  f.restart = async () => { await f.hub.shutdown(); f.hub = await start(); };
  f.complete = async (id, answer, success = true) => {
    const session = f.hub.store.get(id);
    f.runner.running.delete(id);
    session.events.push({ kind: "user", text: "작업" }, { kind: "text", text: answer }, { kind: "result", text: "턴 완료" });
    await f.hub.chain.onTurnEnd(session, success);
  };
  return f;
}

async function eventually(check, message) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("node groups API: all graph node kinds share a persistent container without becoming command nodes", async t => {
  const f = await fixture(t);
  const nodes = await Promise.all(["command", "button", "git", "markdown", "group"].map(kind => f.create(kind)));
  const members = ["source", "target", ...nodes.map(node => node.id)];
  const group = await f.group(members, { title: "개발 · Git · 명령 · 결과" });
  assert.match(group.id, /^grp-/);
  assert.deepEqual(new Set(group.members), new Set(members));
  assert.equal(f.hub.commands.get(group.id), undefined);
  assert.equal(f.hub.store.get(group.id), undefined);
  assert.deepEqual(await f.list(f.otherProject), []);
  await f.ok("PUT", "/node-groups/" + group.id, { collapsed: true, title: "접힌 작업 그룹" });
  await f.restart();
  const restored = (await f.list()).find(item => item.id === group.id);
  assert.ok(restored);
  assert.equal(restored.collapsed, true);
  assert.equal(restored.title, "접힌 작업 그룹");
  assert.deepEqual(restored.rect, group.rect);
  assert.deepEqual(new Set(restored.members), new Set(members));
  assert.equal(f.hub.commands.list(f.project).length, nodes.length);
  assert.equal(f.runner.calls.length, 0);
});

test("node groups API: membership rejects foreign, chat, missing, nested and already grouped nodes atomically", async t => {
  const f = await fixture(t);
  const group = await f.group(["source"]);
  for (const members of [["foreign"], ["chat"], ["missing"], [group.id], ["source", "other"]]) {
    const rejected = await f.api("POST", "/node-groups", { projectPath: f.project, members });
    assert.ok([400, 404, 409].includes(rejected.status), JSON.stringify(rejected));
  }
  const second = await f.group(["target"]);
  const rejected = await f.api("PUT", "/node-groups/" + second.id, { members: ["target", "source"] });
  assert.ok([400, 409].includes(rejected.status), JSON.stringify(rejected));
  const groups = await f.list();
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find(item => item.id === group.id).members, ["source"]);
  assert.deepEqual(groups.find(item => item.id === second.id).members, ["target"]);
  const badPort = await f.api("PUT", "/node-groups/" + second.id, { ports: [{ id: "bad", direction: "input", nodeId: "other", label: "외부 노드" }] });
  assert.equal(badPort.status, 400);
  assert.deepEqual((await f.list()).find(item => item.id === second.id).ports, []);
});

test("node groups API: moving the box moves every member while collapsing and resizing preserve graph execution state", async t => {
  const f = await fixture(t);
  const command = await f.create("command", { pos: { x: 260, y: 310 } });
  const link = await f.ok("POST", "/links", { from: "source", to: command.id, approve: true, note: "검사" });
  const group = await f.group(["source", command.id]);
  const before = structuredClone(f.hub.links.get(link.id));
  await f.ok("PUT", "/node-groups/" + group.id, { rect: { ...group.rect, x: group.rect.x + 140, y: group.rect.y + 80 } });
  assert.deepEqual(f.hub.store.get("source").graphPos, { x: 240, y: 260 });
  assert.deepEqual(f.hub.commands.get(command.id).pos, { x: 400, y: 390 });
  const moved = (await f.list())[0];
  await f.ok("PUT", "/node-groups/" + group.id, { collapsed: true, rect: { ...moved.rect, w: moved.rect.w + 300, h: moved.rect.h + 200 } });
  assert.deepEqual(f.hub.store.get("source").graphPos, { x: 240, y: 260 });
  assert.deepEqual(f.hub.commands.get(command.id).pos, { x: 400, y: 390 });
  assert.deepEqual(f.hub.links.get(link.id), before);
  assert.equal(f.hub.store.get("source").state, "idle");
  assert.equal(f.hub.commands.get(command.id).state, "idle");
  assert.equal(f.runner.calls.length, 0);
});

test("node groups API: existing crossing edges expose ports and aliases retain real endpoints and Git failure conditions", async t => {
  const f = await fixture(t);
  const git = await f.create("git");
  const incoming = await f.ok("POST", "/links", { from: "source", to: git.id });
  const outgoing = await f.ok("POST", "/links", { from: git.id, to: "target", when: "success" });
  const group = await f.group([git.id]);
  const listed = (await f.list()).find(item => item.id === group.id);
  assert.ok(listed.ports.some(port => port.direction === "input" && port.nodeId === git.id));
  assert.ok(listed.ports.some(port => port.direction === "output" && port.nodeId === git.id && port.when === "success"));
  const failure = { id: "git-failure", direction: "output", nodeId: git.id, label: "병합 실패", when: "error" };
  await f.ok("PUT", "/node-groups/" + group.id, { ports: [...listed.ports, failure] });
  const alias = await f.ok("POST", "/links", { from: group.id, fromPort: failure.id, to: "target", approve: true, note: "충돌을 분석하세요." });
  assert.equal(alias.from, git.id);
  assert.equal(alias.to, "target");
  assert.equal(alias.when, "error");
  assert.equal(alias.useGitWorktree, false);
  assert.equal(alias.approve, true);
  assert.equal(alias.note, "충돌을 분석하세요.");
  assert.equal(f.hub.links.get(incoming.id).to, git.id);
  assert.equal(f.hub.links.get(outgoing.id).from, git.id);
  const invalid = await f.api("POST", "/links", { from: group.id, fromPort: "missing-port", to: "other" });
  assert.ok([400, 404].includes(invalid.status), JSON.stringify(invalid));
  assert.equal((await f.api("POST", "/links", { from: group.id, to: "other" })).status, 400);
  const stored = await f.ok("GET", "/links");
  assert.ok(stored.every(link => !link.from.startsWith("grp-") && !link.to.startsWith("grp-")));
});

test("node groups execution: collapsed input aliases preserve approval snapshots, conditions and session permissions", async t => {
  const f = await fixture(t);
  const group = await f.group(["target"], { ports: [{ id: "start", direction: "input", nodeId: "target", label: "검토 시작" }] });
  const link = await f.ok("POST", "/links", { from: "source", to: group.id, toPort: "start", when: "keyword", keyword: "검토", approve: true, note: "한 번만 실행하세요." });
  assert.equal(link.to, "target");
  await f.complete("source", "검토할 첫 결과");
  assert.equal(f.runner.calls.length, 0);
  const snapshot = structuredClone(f.hub.links.get(link.id).pending);
  assert.match(snapshot.answer, /검토할 첫 결과/);
  await f.ok("PUT", "/node-groups/" + group.id, { collapsed: true });
  assert.deepEqual(f.hub.links.get(link.id).pending, snapshot);
  f.hub.store.get("source").events.push({ kind: "user", text: "새 작업" }, { kind: "text", text: "나중 결과" });
  await f.ok("POST", "/links/" + link.id + "/decide", { action: "approve" });
  assert.equal(f.runner.calls.length, 1);
  assert.equal(f.runner.calls[0].id, "target");
  assert.match(f.runner.calls[0].prompt, /검토할 첫 결과/);
  assert.doesNotMatch(f.runner.calls[0].prompt, /나중 결과/);
  assert.equal(f.runner.calls[0].permission, "acceptEdits");
  assert.equal(f.hub.store.get("target").locked, true);
  f.runner.running.clear();
  await f.ok("PUT", "/node-groups/" + group.id, { collapsed: false });
  await f.complete("source", "조건에 없는 결과");
  assert.equal(f.runner.calls.length, 1);
  assert.equal(f.hub.links.get(link.id).pending, null);
});

test("node groups execution: a collapsed shell node still runs once and delivers its successful output", async t => {
  const f = await fixture(t);
  const command = await f.create("command", { command: 'node -e "console.log(123456789)"' });
  const group = await f.group(["source", command.id], { collapsed: true,
    ports: [{ id: "shell-done", direction: "output", nodeId: command.id, label: "명령 성공", when: "success" }] });
  await f.ok("POST", "/links", { from: "source", to: command.id });
  await f.ok("POST", "/links", { from: group.id, fromPort: "shell-done", to: "target" });
  await f.complete("source", "명령을 실행하세요.");
  await eventually(() => f.hub.commands.get(command.id).lastRun, "grouped shell did not finish");
  const current = f.hub.commands.get(command.id);
  assert.equal(current.state, "success", JSON.stringify(current.lastRun));
  await eventually(() => f.runner.calls.length === 1, "grouped shell output was not delivered");
  assert.equal(current.lastRun.exitCode, 0);
  assert.equal(current.lastRun.cwd, f.project);
  assert.match(current.lastRun.tail, /123456789/);
  assert.equal(f.runner.calls[0].id, "target");
  assert.match(f.runner.calls[0].prompt, /123456789/);
  assert.equal((await f.list()).find(item => item.id === group.id).collapsed, true);
});

test("node groups execution: grouping the legacy collector retains its wait-for-all behavior", async t => {
  const f = await fixture(t);
  const collector = await f.create("group", { members: ["source", "target"] });
  const group = await f.group(["source", "target", collector.id], { collapsed: true,
    ports: [{ id: "collected", direction: "output", nodeId: collector.id, label: "전체 결과", when: "success" }] });
  await f.ok("POST", "/links", { from: group.id, fromPort: "collected", to: "other" });
  f.runner.running.add("target");
  await f.complete("source", "첫 작업 완료");
  assert.equal(f.runner.calls.length, 0);
  await f.complete("target", "두 번째 작업 완료");
  assert.equal(f.runner.calls.length, 1);
  assert.equal(f.runner.calls[0].id, "other");
  assert.match(f.runner.calls[0].prompt, /첫 작업 완료/);
  assert.match(f.runner.calls[0].prompt, /두 번째 작업 완료/);
  assert.equal(f.hub.commands.get(collector.id).state, "success");
});

test("node groups API: ungrouping preserves nodes and edges; recreating and removing nodes repair membership and ports", async t => {
  const f = await fixture(t);
  const command = await f.create("command");
  const group = await f.group(["source", command.id], { ports: [{ id: "result", direction: "output", nodeId: "source", label: "결과", when: "success" }] });
  const edge = await f.ok("POST", "/links", { from: group.id, fromPort: "result", to: "target" });
  const replacement = await f.ok("POST", "/sessions/source/recreate", {});
  assert.notEqual(replacement.id, "source");
  const repaired = (await f.list()).find(item => item.id === group.id);
  assert.ok(repaired.members.includes(replacement.id));
  assert.ok(!repaired.members.includes("source"));
  assert.equal(repaired.ports.find(port => port.id === "result").nodeId, replacement.id);
  assert.equal(f.hub.links.get(edge.id).from, replacement.id);
  await f.ok("DELETE", "/commands/" + command.id);
  assert.deepEqual((await f.list()).find(item => item.id === group.id).members, [replacement.id]);
  await f.ok("DELETE", "/node-groups/" + group.id);
  assert.deepEqual(await f.list(), []);
  assert.ok(f.hub.store.get(replacement.id));
  assert.ok(f.hub.store.get("target"));
  assert.equal(f.hub.links.get(edge.id).from, replacement.id);
  const cleanup = await f.group([replacement.id, "target"], { ports: [{ id: "input", direction: "input", nodeId: replacement.id, label: "시작" }] });
  await f.ok("DELETE", "/sessions/" + replacement.id);
  const pruned = (await f.list()).find(item => item.id === cleanup.id);
  assert.deepEqual(pruned.members, ["target"]);
  assert.ok(pruned.ports.every(port => port.nodeId !== replacement.id));
  const foreign = await f.group(["foreign"], { projectPath: f.otherProject });
  await f.ok("DELETE", "/projects?path=" + encodeURIComponent(f.project));
  assert.deepEqual(await f.list(), []);
  assert.equal((await f.list(f.otherProject))[0].id, foreign.id);
});


test("node groups API: distinct outputs may reach one receiver, preserve routing and remain editable after ungrouping", async t => {
  const f = await fixture(t);
  const ports = [
    { id: "ok", direction: "output", nodeId: "source", label: "성공", when: "success" },
    { id: "error", direction: "output", nodeId: "source", label: "실패", when: "error" },
    { id: "review", direction: "output", nodeId: "source", label: "검토", when: "keyword", keyword: "검토" },
    { id: "deploy", direction: "output", nodeId: "source", label: "배포", when: "keyword", keyword: "배포" },
  ];
  const group = await f.group(["source"], { ports });
  const edges = [];
  for (const port of ports) {
    const edge = await f.ok("POST", "/links", { from: group.id, fromPort: port.id, to: "target", note: "경로:" + port.id });
    assert.equal(edge.from, "source");
    assert.equal(edge.to, "target");
    assert.equal(edge.when, port.when);
    assert.equal(edge.keyword, port.keyword ?? "");
    edges.push(edge);
    assert.equal((await f.api("POST", "/links", { from: group.id, fromPort: port.id, to: "target" })).status, 409);
  }
  await f.ok("PUT", "/node-groups/" + group.id, { collapsed: true });
  for (const [answer, success, expected] of [
    ["일반 작업 완료", true, "ok"], ["명령 실패", false, "error"],
    ["검토", true, "review"], ["배포", true, "deploy"],
  ]) {
    f.runner.running.clear();
    const previous = f.runner.calls.length;
    await f.complete("source", answer, success);
    assert.equal(f.runner.calls.length, previous + 1, "one matching output must launch exactly one turn");
    assert.equal(f.runner.calls.at(-1).id, "target");
    assert.match(f.runner.calls.at(-1).prompt, new RegExp("경로:" + expected));
  }
  const sourceEdges = (await f.ok("GET", "/links")).filter(edge => edge.from === "source");
  assert.equal(sourceEdges.length, ports.length);
  assert.ok(sourceEdges.every(edge => edge.to === "target"));
  await f.ok("DELETE", "/node-groups/" + group.id);
  for (const edge of edges) {
    const changed = await f.ok("PUT", "/links/" + edge.id, { note: "그룹 해제 후 수정:" + edge.id });
    assert.equal(changed.note, "그룹 해제 후 수정:" + edge.id);
    assert.equal(changed.when, edge.when);
    assert.equal(changed.keyword, edge.keyword);
  }
  assert.equal((await f.api("PUT", "/links/" + edges[1].id, { when: "success" })).status, 409);
  assert.equal((await f.api("POST", "/links", { from: "source", to: "target", when: "always" })).status, 409,
    "ungrouped session pairs retain their existing creation restriction");
});

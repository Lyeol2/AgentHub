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
  send(session, prompt, cli, input, meta) { this.calls.push({ id: session.id, prompt, input, meta }); this.running.add(session.id); }
  stopAll() { this.running.clear(); }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-graph-tabs-api-"));
  const projectPath = path.join(root, "project");
  const foreignPath = path.join(root, "foreign");
  fs.mkdirSync(projectPath); fs.mkdirSync(foreignPath);
  const dataDir = path.join(root, "data");
  const runner = new FakeRunner(), notifications = [], asked = [], opened = [];
  let answer = { actions: [] };
  const start = async () => {
    const hub = createHub({ dataDir, port: 0, warmup: false,
      deps: { runner, cliPaths: () => ({ claude: "fake-cli", codex: "fake-cli" }), logger: { log() {} },
        ask: async ({ prompt }) => { asked.push(prompt); return JSON.stringify(answer); },
        events: { broadcast: (...event) => notifications.push(event), start() {}, close() {}, connect() {} } } });
    opened.push(hub);
    await hub.start();
    return hub;
  };
  const f = { root, dataDir, projectPath, foreignPath, runner, notifications, asked, hub: await start() };
  t.after(async () => {
    for (const hub of opened.reverse()) await hub.shutdown();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("agenthub-graph-tabs-api-"));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  f.request = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${f.hub.port}/api${route}`, { method,
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  };
  f.api = async (...args) => { const result = await f.request(...args); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  f.tabs = (dir = projectPath) => f.api("GET", "/graph-tabs?path=" + encodeURIComponent(dir));
  f.session = (body = {}) => f.api("POST", "/sessions", { projectPath, agent: "claude", title: "세션", ...body });
  f.command = (body = {}) => f.api("POST", "/commands", { projectPath, kind: "button", title: "시작", prompt: "실행", ...body });
  f.newTab = (title = "검토") => f.api("POST", "/graph-tabs", { projectPath, title });
  f.restart = async () => { await f.hub.shutdown(); f.hub = await start(); };
  f.answer = (value) => { answer = value; };
  return f;
}

test("graph tabs API: a project gets one default, user tabs reorder and rename, and restart preserves the catalog", async (t) => {
  const f = await fixture(t);
  const initial = await f.tabs();
  assert.equal(f.hub.config.projects.length, 0, "viewing tabs does not register a discovered project");
  assert.equal(initial.tabs.length, 1);
  assert.equal(initial.tabs[0].id, initial.defaultTabId);
  const session = await f.session(), command = await f.command();
  assert.equal(session.tabId, initial.defaultTabId);
  assert.equal(command.tabId, initial.defaultTabId);
  assert.deepEqual(await f.tabs(), initial);
  const second = await f.newTab();
  await f.api("PUT", "/graph-tabs/" + second.id, { title: "리뷰" });
  await f.api("POST", "/graph-tabs/reorder", { projectPath: f.projectPath, ids: [second.id, initial.defaultTabId] });
  const catalog = await f.tabs();
  assert.equal(catalog.tabs[0].title, "리뷰");
  assert.equal(catalog.defaultTabId, initial.defaultTabId, "reordering must not change the legacy default");
  assert.equal((await f.request("POST", "/graph-tabs/reorder", { projectPath: f.projectPath, ids: [second.id, second.id] })).status, 400);
  assert.equal((await f.request("PUT", "/graph-tabs/" + second.id, { title: " " })).status, 400);
  await f.restart();
  assert.deepEqual(await f.tabs(), catalog);
  assert.equal((await f.api("GET", "/sessions")).find((item) => item.id === session.id).tabId, initial.defaultTabId);
  assert.ok(f.notifications.some(([event]) => event === "graph-tabs"));
});

test("graph tabs API: legacy summaries resolve to default and creation inherits origin without extra tabs", async (t) => {
  const f = await fixture(t);
  f.hub.store.add({ id: "legacy", title: "기존", projectPath: f.projectPath, cwd: f.projectPath, agent: "claude", updatedAt: new Date().toISOString(), events: [] });
  f.hub.commands.add({ id: "cmd-legacy", title: "기존 명령", kind: "command", projectPath: f.projectPath });
  f.hub.nodeGroups.add({ id: "grp-legacy", title: "기존 그룹", projectPath: f.projectPath, members: ["legacy", "cmd-legacy"], ports: [], rect: { x: 0, y: 0, w: 900, h: 600 } });
  const initial = await f.tabs();
  assert.equal((await f.api("GET", "/sessions"))[0].tabId, initial.defaultTabId);
  assert.equal((await f.api("GET", "/commands?path=" + encodeURIComponent(f.projectPath))).commands[0].tabId, initial.defaultTabId);
  assert.equal((await f.api("GET", "/node-groups?path=" + encodeURIComponent(f.projectPath))).groups[0].tabId, initial.defaultTabId);
  const tab = await f.newTab();
  const source = await f.session({ tabId: tab.id, title: "원본" });
  const child = await f.session({ createdBy: source.id });
  const linked = await f.session({ connectFrom: source.id });
  const command = await f.command({ connectFrom: source.id });
  for (const item of [child, linked, command]) assert.equal(item.tabId, tab.id);
  const replacement = await f.api("POST", `/sessions/${source.id}/recreate`, {});
  assert.equal(replacement.tabId, tab.id);
  assert.equal((await f.tabs()).tabs.length, 2);
  const foreign = (await f.tabs(f.foreignPath)).defaultTabId;
  for (const route of ["/sessions", "/commands"]) for (const tabId of [foreign, "missing", null]) {
    const body = route === "/sessions" ? { agent: "claude" } : { kind: "button", prompt: "실행" };
    assert.equal((await f.request("POST", route, { projectPath: f.projectPath, ...body, tabId })).status, 400);
  }
  const invalidTask = await f.request("POST", "/tasks", { projectPath: f.projectPath, title: "잘못된 탭의 작업", tabId: foreign });
  assert.equal(invalidTask.status, 400);
  assert.match(invalidTask.body.error, /그리드 탭/);
  assert.equal(fs.readdirSync(path.join(f.dataDir, "tasks")).length, 0);
});

test("graph tabs API: moving any member moves its visual group and cross-tab links keep running", async (t) => {
  const f = await fixture(t);
  const initial = await f.tabs(), target = await f.newTab();
  const source = await f.session({ title: "출발" }), receiver = await f.session({ title: "도착" });
  const button = await f.command();
  await f.api("PUT", "/sessions/" + source.id, { graphPos: { x: 123, y: 234 } });
  const group = await f.api("POST", "/node-groups", { projectPath: f.projectPath, members: [source.id, button.id] });
  const link = await f.api("POST", "/links", { from: source.id, to: receiver.id, when: "manual", note: "탭 간 전달" });
  const snapshot = structuredClone(f.hub.links.get(link.id));
  await f.api("POST", `/graph-tabs/${target.id}/move`, { nodeIds: [source.id] });
  assert.deepEqual(f.notifications.filter(([event]) => event === "graph-tabs").at(-1)[1].affectedTabIds, [initial.defaultTabId, target.id]);
  assert.equal(f.hub.store.get(source.id).tabId, target.id);
  assert.equal(f.hub.commands.get(button.id).tabId, target.id);
  assert.equal(f.hub.nodeGroups.get(group.id).tabId, target.id);
  assert.equal(f.hub.services.graphTabs.tabFor(f.hub.store.get(receiver.id)), initial.defaultTabId);
  assert.deepEqual(f.hub.store.get(source.id).graphPos, { x: 123, y: 234 });
  assert.deepEqual(f.hub.links.get(link.id), snapshot);
  const foreign = (await f.tabs(f.foreignPath)).defaultTabId;
  assert.equal((await f.request("POST", `/graph-tabs/${foreign}/move`, { nodeIds: [source.id] })).status, 400);
  assert.equal((await f.request("POST", `/graph-tabs/${initial.defaultTabId}/move`, { nodeIds: [source.id, "missing"] })).status, 400);
  assert.equal(f.hub.store.get(source.id).tabId, target.id, "invalid moves do not partially move the selected group");
  f.hub.store.get(source.id).events.push({ kind: "user", text: "작업" }, { kind: "text", text: "다른 탭으로 전달할 결과" });
  await f.api("POST", `/links/${link.id}/run`, {});
  assert.equal(f.runner.calls.at(-1).id, receiver.id);
  assert.match(f.runner.calls.at(-1).prompt, /다른 탭으로 전달할 결과/);
  assert.equal((await f.request("POST", "/node-groups", { projectPath: f.projectPath, tabId: target.id, members: [receiver.id] })).status, 400);
  await f.api("POST", "/links", { from: receiver.id, to: source.id });
  await f.restart();
  assert.equal(f.hub.store.get(source.id).tabId, target.id);
  assert.equal(f.hub.nodeGroups.get(group.id).tabId, target.id);
});

test("graph tabs API: deleting a tab moves contents, preserves connections and rejects deleting the last tab", async (t) => {
  const f = await fixture(t);
  const initial = await f.tabs(), target = await f.newTab();
  const source = await f.session(), receiver = await f.session({ tabId: target.id });
  const link = await f.api("POST", "/links", { from: source.id, to: receiver.id, approve: true });
  f.hub.links.update(f.hub.links.get(link.id), { pending: { answer: "승인 대기 결과", depth: 1, createdAt: new Date().toISOString() } });
  const snapshot = structuredClone(f.hub.links.get(link.id));
  const foreign = await f.tabs(f.foreignPath);
  assert.equal((await f.request("DELETE", `/graph-tabs/${initial.defaultTabId}?target=${foreign.defaultTabId}`)).status, 400);
  await f.api("DELETE", `/graph-tabs/${initial.defaultTabId}?target=${target.id}`);
  assert.deepEqual(f.notifications.filter(([event]) => event === "graph-tabs").at(-1)[1].affectedTabIds, [initial.defaultTabId, target.id]);
  assert.equal(f.hub.store.get(source.id).tabId, target.id);
  assert.deepEqual(f.hub.links.get(link.id), snapshot);
  assert.equal((await f.tabs()).defaultTabId, target.id);
  assert.equal((await f.session()).tabId, target.id);
  assert.equal((await f.request("DELETE", `/graph-tabs/${target.id}?target=${initial.defaultTabId}`)).status, 409);
  const empty = await f.newTab("빈 탭");
  await f.api("DELETE", `/graph-tabs/${empty.id}?target=${target.id}`);
  assert.deepEqual(f.notifications.filter(([event]) => event === "graph-tabs").at(-1)[1].affectedTabIds, [empty.id]);
  await f.api("DELETE", "/projects?path=" + encodeURIComponent(f.projectPath));
  const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, "graph-tabs.json"), "utf8"));
  assert.ok(saved.tabs.every((tab) => tab.projectPath !== f.projectPath));
  assert.equal((await f.tabs(f.foreignPath)).tabs.length, 1);
});

test("graph tabs API: flow assistant sees and edits only the requested tab and creates all new nodes there", async (t) => {
  const f = await fixture(t);
  const hidden = await f.session({ title: "숨은 세션" }), tab = await f.newTab();
  const shown = await f.session({ tabId: tab.id, title: "현재 세션" });
  f.answer({ actions: [{ type: "create_session", key: "review", title: "리뷰", agent: "claude" },
    { type: "create_node", key: "start", title: "시작", kind: "button", prompt: "시작" }] });
  const plan = await f.api("POST", "/flow-assistant/plan", { projectPath: f.projectPath, tabId: tab.id, prompt: "검토 추가" });
  assert.match(f.asked[0], new RegExp(shown.id));
  assert.doesNotMatch(f.asked[0], new RegExp(hidden.id));
  const result = await f.api("POST", "/flow-assistant/apply", { projectPath: f.projectPath, tabId: tab.id, actions: plan.actions });
  for (const id of result.created) assert.equal((f.hub.store.get(id) ?? f.hub.commands.get(id)).tabId, tab.id);
  assert.equal((await f.request("POST", "/flow-assistant/apply", { projectPath: f.projectPath, tabId: tab.id,
    actions: [{ type: "rename", target: hidden.id, title: "잘못된 변경" }] })).status, 400);
  assert.equal(f.hub.store.get(hidden.id).title, "숨은 세션");
});

test("graph tabs API: template placement and orchestrator creation preserve the chosen tab", async (t) => {
  const f = await fixture(t);
  const source = await f.session(), button = await f.command();
  const group = await f.api("POST", "/node-groups", { projectPath: f.projectPath, members: [source.id, button.id] });
  const template = await f.api("POST", "/group-templates", { groupId: group.id });
  const tab = await f.newTab();
  const placed = await f.api("POST", `/group-templates/${template.id}/instantiate`, { projectPath: f.projectPath, tabId: tab.id });
  for (const item of [placed.group, ...placed.nodes.sessions, ...placed.nodes.commands]) assert.equal(item.tabId, tab.id);
  const orchestrator = await f.session({ orchestrator: true, tabId: tab.id, title: "지휘" });
  await f.hub.services.workflows.applyPlan(f.hub.store.get(orchestrator.id), { sessions: [{ key: "child", title: "담당", role: "구현" }] });
  const child = f.hub.store.list().find((item) => item.createdBy === orchestrator.id);
  assert.ok(child);
  assert.equal(child.tabId, tab.id);
  const input = f.hub.services.sessions.composeInput(f.hub.store.get(orchestrator.id), "계획을 세우세요.");
  assert.match(input, new RegExp(child.id));
  assert.doesNotMatch(input, new RegExp(source.id));
});

test("graph tabs API: imported records use the requested tab or the default without creating tabs", async (t) => {
  const f = await fixture(t);
  const initial = await f.tabs(), target = await f.newTab();
  const content = "# 가져온 기록\n\n- 세션: old-record\n- AI: Claude Code\n\n## 사용자\n\n이전 요청\n\n## 답변\n\n이전 결과\n";
  const imported = await f.api("POST", "/sessions/import-record", { projectPath: f.projectPath, fileName: "record.md", content, tabId: target.id });
  assert.equal(imported.tabId, target.id);
  const fallback = await f.api("POST", "/sessions/import-record", { projectPath: f.projectPath, fileName: "record.md", content });
  assert.equal(fallback.tabId, initial.defaultTabId);
  assert.equal((await f.tabs()).tabs.length, 2);
  const before = f.hub.store.list().length;
  assert.equal((await f.request("POST", "/sessions/import-record", { projectPath: f.projectPath, fileName: "record.md", content, tabId: "missing" })).status, 400);
  assert.equal(f.hub.store.list().length, before);
});

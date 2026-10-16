import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphTabStore, createGraphTabService } from "../server/graph-tabs.mjs";
import { SessionStore } from "../server/store.mjs";
import { CommandStore } from "../server/commands.mjs";
import { NodeGroupStore } from "../server/node-groups.mjs";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-graph-tabs-"));
  const projectPath = path.join(dataDir, "project");
  const store = new SessionStore({ dataDir });
  const commands = new CommandStore({ dataDir });
  const groups = new NodeGroupStore({ dataDir });
  const tabs = new GraphTabStore({ dataDir });
  const service = createGraphTabService({ tabs, store, commands, groups, projects: { ensureProject: (dir) => ({ path: path.resolve(dir) }) } });
  store.add({ id: "old-session", projectPath, updatedAt: new Date().toISOString(), events: [], graphPos: { x: 120, y: 240 } });
  commands.add({ id: "cmd-old", projectPath, kind: "command", pos: { x: 420, y: 240 } });
  groups.add({ id: "grp-old", projectPath, members: ["old-session", "cmd-old"], rect: { x: 60, y: 60, w: 900, h: 600 }, ports: [] });
  t.after(() => {
    store.flushAll();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("agenthub-graph-tabs-"));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dataDir, projectPath, store, commands, groups, tabs, service };
}

test("graph tabs: legacy data uses one persistent default without rewriting node data", (t) => {
  const f = fixture(t);
  const files = [path.join(f.dataDir, "sessions", "old-session.json"), f.commands.file, f.groups.file];
  const original = files.map((file) => fs.readFileSync(file, "utf8"));
  const first = f.service.list(f.projectPath);
  assert.equal(first.tabs.length, 1);
  assert.equal(first.defaultTabId, first.tabs[0].id);
  for (let i = 0; i < 8; i++) assert.deepEqual(f.service.list(f.projectPath), first);
  for (const item of [...f.store.list(), ...f.commands.list(), ...f.groups.list()]) assert.equal(f.service.tabFor(item), first.defaultTabId);
  assert.deepEqual(files.map((file) => fs.readFileSync(file, "utf8")), original);
  assert.deepEqual(new GraphTabStore({ dataDir: f.dataDir }).list(f.projectPath), first.tabs);
  assert.equal(f.service.tabFor({ chat: true, projectPath: f.projectPath }), null);
});

test("graph tabs: failed node persistence rolls the complete visual group back", (t) => {
  const f = fixture(t);
  const initial = f.service.list(f.projectPath);
  const target = f.service.create({ projectPath: f.projectPath });
  const save = f.commands.save.bind(f.commands);
  let fail = true;
  f.commands.save = () => { if (fail) { fail = false; throw new Error("injected command save failure"); } return save(); };
  assert.throws(() => f.service.move(target.id, { nodeIds: ["old-session"] }), /injected/);
  assert.equal(f.service.tabFor(f.store.get("old-session")), initial.defaultTabId);
  assert.equal(f.service.tabFor(f.commands.get("cmd-old")), initial.defaultTabId);
  assert.equal(f.service.tabFor(f.groups.get("grp-old")), initial.defaultTabId);
  assert.equal(new SessionStore({ dataDir: f.dataDir }).get("old-session").tabId, undefined);
  assert.equal(new CommandStore({ dataDir: f.dataDir }).get("cmd-old").tabId, undefined);
  assert.equal(new NodeGroupStore({ dataDir: f.dataDir }).get("grp-old").tabId, undefined);
  assert.equal(f.tabs.list(f.projectPath).length, 2);
});

test("graph tabs: catalog failure during deletion preserves tab and all previous memberships", (t) => {
  const f = fixture(t);
  const initial = f.service.list(f.projectPath);
  const target = f.service.create({ projectPath: f.projectPath, title: "대상" });
  const catalog = structuredClone(f.tabs.data);
  f.tabs.commit = () => { throw new Error("injected catalog save failure"); };
  assert.throws(() => f.service.remove(initial.defaultTabId, target.id), /injected/);
  assert.deepEqual(f.tabs.data, catalog);
  assert.equal(f.service.tabFor(f.store.get("old-session")), initial.defaultTabId);
  assert.equal(new SessionStore({ dataDir: f.dataDir }).get("old-session").tabId, undefined);
  assert.equal(new CommandStore({ dataDir: f.dataDir }).get("cmd-old").tabId, undefined);
  assert.equal(new NodeGroupStore({ dataDir: f.dataDir }).get("grp-old").tabId, undefined);
  assert.deepEqual(new GraphTabStore({ dataDir: f.dataDir }).data, catalog);
});

test("graph tabs: moving a group member preserves coordinates and a deleted default is replaced by its target", (t) => {
  const f = fixture(t);
  const oldDefault = f.service.list(f.projectPath).defaultTabId;
  const target = f.service.create({ projectPath: f.projectPath, title: "검토" });
  const snapshots = [f.store.get("old-session"), f.commands.get("cmd-old"), f.groups.get("grp-old")].map((item) => structuredClone(item));
  f.service.move(target.id, { nodeIds: ["cmd-old"] });
  for (const old of snapshots) {
    const current = f.store.get(old.id) ?? f.commands.get(old.id) ?? f.groups.get(old.id);
    assert.deepEqual(current, { ...old, tabId: target.id });
  }
  f.service.remove(oldDefault, target.id);
  assert.equal(f.service.list(f.projectPath).defaultTabId, target.id);
  assert.equal(f.service.resolve(f.projectPath), target.id);
  assert.equal(f.service.list(f.projectPath).tabs.length, 1);
  assert.throws(() => f.service.remove(target.id, oldDefault), { status: 409 });
  f.service.removeProject(f.projectPath);
  assert.deepEqual(f.tabs.list(f.projectPath), []);
});

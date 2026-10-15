import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../server/config.mjs";
import { SessionStore } from "../server/store.mjs";
import { CommandStore } from "../server/commands.mjs";

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-persistence-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { first: path.join(root, "first"), second: path.join(root, "second") };
}

test("persistence: 명시한 데이터 경로마다 설정을 독립적으로 읽고 저장한다", (t) => {
  const { first, second } = sandbox(t);
  const a = loadConfig(first);
  const b = loadConfig(second);
  a.port = 12345;
  a.projects.push({ path: "C:/first", name: "first" });
  saveConfig(a, first);
  assert.equal(loadConfig(first).port, 12345);
  assert.equal(loadConfig(second).port, b.port);
  assert.deepEqual(loadConfig(second).projects, []);
});

test("persistence: 같은 세션 ID도 저장소별로 분리하고 실행 상태 복구를 해당 경로에 저장한다", (t) => {
  const { first, second } = sandbox(t);
  const a = new SessionStore({ dataDir: first });
  const b = new SessionStore({ dataDir: second });
  const base = { id: "same", agent: "claude", chat: true, events: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  a.add({ ...base, title: "first", state: "running", runningStartedAt: "2026-01-01T01:00:00Z" });
  b.add({ ...base, title: "second", state: "idle" });
  const restored = new SessionStore({ dataDir: first });
  assert.equal(restored.get("same").title, "first");
  assert.equal(restored.get("same").state, "interrupted");
  assert.equal(restored.get("same").runningStartedAt, null);
  assert.equal(b.get("same").title, "second");
  assert.equal(b.get("same").state, "idle");
  assert.equal(JSON.parse(fs.readFileSync(path.join(first, "sessions", "same.json"), "utf8")).state, "interrupted");
  a.remove("same");
  assert.equal(fs.existsSync(path.join(first, "sessions", "same.json")), false);
  assert.equal(fs.existsSync(path.join(second, "sessions", "same.json")), true);
});

test("persistence: 명령 저장소의 추가·수정·삭제가 다른 데이터 경로에 영향을 주지 않는다", (t) => {
  const { first, second } = sandbox(t);
  const a = new CommandStore({ dataDir: first });
  const b = new CommandStore({ dataDir: second });
  a.add({ id: "cmd-same", title: "first", state: "running", projectPath: "C:/project" });
  b.add({ id: "cmd-same", title: "second", state: "idle", projectPath: "C:/project" });
  const restored = new CommandStore({ dataDir: first });
  assert.equal(restored.get("cmd-same").state, "error");
  restored.update(restored.get("cmd-same"), { title: "changed" });
  assert.equal(new CommandStore({ dataDir: first }).get("cmd-same").title, "changed");
  assert.equal(new CommandStore({ dataDir: second }).get("cmd-same").title, "second");
  restored.remove("cmd-same");
  assert.deepEqual(new CommandStore({ dataDir: first }).list(), []);
  assert.equal(new CommandStore({ dataDir: second }).list().length, 1);
});

test("persistence: 이전 설정에 없는 중첩 기본값도 인스턴스별로 분리한다", (t) => {
  const { first, second } = sandbox(t);
  for (const directory of [first, second]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ port: 4517 }));
  }
  const a = loadConfig(first);
  const b = loadConfig(second);
  a.projects.push({ path: "C:/first", name: "first" });
  a.hiddenSessions.push("first-only");
  a.hiddenProjects.push("C:/hidden");
  a.skillLayout.first = { x: 10, y: 20 };
  a.cli.codex = "first-only";
  assert.deepEqual(b.projects, []);
  assert.deepEqual(b.hiddenSessions, []);
  assert.deepEqual(b.hiddenProjects, []);
  assert.deepEqual(b.skillLayout, {});
  assert.equal(b.cli.codex, "");
  assert.deepEqual(loadConfig(first).projects, []);
});

// 강제 종료로 데이터 파일이 NUL 바이트로 채워져도 서버가 나머지 데이터로 시작하는지 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic, readJsonFile } from "../server/infrastructure/persistence/json-file.mjs";

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-corrupted-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const nul = (size = 512) => Buffer.alloc(size);

function corruptedFiles(dataDir) {
  const base = path.join(dataDir, "corrupted");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { recursive: true })
    .filter((name) => fs.statSync(path.join(base, name)).isFile())
    .map((name) => name.split(path.sep).slice(1).join("/"))
    .sort();
}

test("NUL로 채워진 세션·설정·저장 파일이 있어도 서버가 시작되고 깨진 파일은 corrupted로 옮긴다", async (t) => {
  const root = temporary(t);
  const dataDir = path.join(root, "data");
  const sessions = path.join(dataDir, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
  const good = {
    id: "good", title: "good", agent: "codex", model: "", permission: "workspace-write", chat: true,
    projectName: "", projectPath: "", cwd: root, worktree: null, state: "idle",
    createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z", events: [],
  };
  fs.writeFileSync(path.join(sessions, "good.json"), JSON.stringify(good));
  fs.writeFileSync(path.join(sessions, "broken.json"), nul());
  fs.writeFileSync(path.join(sessions, "half.json"), '{"id": "half", "events": [');
  fs.writeFileSync(path.join(sessions, "good.json.123.abcd.tmp"), nul());
  for (const name of ["config.json", "commands.json", "links.json", "messages.json", "tasks/task-1.json"])
    fs.writeFileSync(path.join(dataDir, name), nul());

  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  const { createHub } = await import("../server/bootstrap.mjs");
  const hub = createHub({ dataDir, port: 0, warmup: false });
  t.after(() => hub.shutdown());
  await hub.start();

  const response = await fetch(`http://127.0.0.1:${hub.port}/api/sessions`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map((session) => session.id), ["good"]);

  assert.deepEqual(corruptedFiles(dataDir), [
    "commands.json", "config.json", "links.json", "messages.json",
    "sessions/broken.json", "sessions/half.json", "tasks/task-1.json",
  ]);
  assert.deepEqual(fs.readdirSync(sessions), ["good.json"]);
  assert.ok(warnings.some((message) => message.includes("broken.json") && message.includes("NUL")));
  // 설정은 기본값으로 다시 만들어진다.
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).projects));
});

test("원자적 쓰기는 임시 파일을 남기지 않고 내용을 통째로 바꾼다", (t) => {
  const root = temporary(t);
  const file = path.join(root, "nested", "value.json");
  writeFileAtomic(file, JSON.stringify({ n: 1 }));
  writeFileAtomic(file, JSON.stringify({ n: 2 }));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["value.json"]);
  assert.deepEqual(readJsonFile(file, { dataDir: root, fallback: () => null }), { n: 2 });
});

test("형식 검사를 통과하지 못한 파일도 격리하고 기본값을 돌려준다", (t) => {
  const root = temporary(t);
  const file = path.join(root, "links.json");
  fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(readJsonFile(file, { dataDir: root, fallback: () => [], valid: Array.isArray }), []);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(corruptedFiles(root), ["links.json"]);
  assert.deepEqual(readJsonFile(path.join(root, "missing.json"), { dataDir: root, fallback: () => "none" }), "none");
});

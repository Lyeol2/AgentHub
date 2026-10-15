// 임시 데이터 폴더와 임시 git 저장소로 서버를 띄워 API 경로를 확인한다. CLI는 실행하지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-test-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });
fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });

process.env.AGENTHUB_DATA = path.join(tmp, "data");
process.env.PORT = "45177";
const server = await import("../server/index.mjs");
await server.listening;

async function api(method, url, body) {
  const res = await fetch(`http://127.0.0.1:45177/api${url}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test.after(() => {
  server.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("api: 세션 수정·연결·삭제", async () => {
  const make = (title) => api("POST", "/sessions", { agent: "claude", projectPath: repo, title, permission: "acceptEdits" });
  const a = (await make("A")).body;
  const b = (await make("B")).body;
  assert.equal(a.kind, "worker");

  const edited = await api("PUT", `/sessions/${a.id}`, { role: "프론트", graphPos: { x: 10, y: 20 } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.role, "프론트");
  assert.deepEqual(edited.body.graphPos, { x: 10, y: 20 });

  const link = (await api("POST", "/links", { from: a.id, to: b.id, when: "keyword", keyword: "끝" })).body;
  assert.equal((await api("PUT", `/links/${link.id}`, { when: "always" })).body.when, "always");
  assert.equal((await api("POST", "/links", { from: a.id, to: b.id })).status, 409);

  assert.equal((await api("DELETE", `/sessions/${b.id}`)).status, 200);
  assert.equal((await api("GET", "/links")).body.length, 0); // 지운 세션의 연결도 지운다.
  assert.equal((await api("GET", `/sessions/${b.id}`)).status, 404);
  assert.equal((await api("DELETE", `/sessions/${a.id}`)).status, 200);
});

test("api: 작업 폴더를 직접 지운 세션도 삭제된다", async () => {
  const s = (await api("POST", "/sessions", { agent: "claude", projectPath: repo, title: "W", permission: "acceptEdits", isolate: true })).body;
  fs.rmSync(s.cwd, { recursive: true, force: true });
  assert.equal((await api("DELETE", `/sessions/${s.id}?removeWorktree=1`)).status, 200);
  assert.equal((await api("GET", `/sessions/${s.id}`)).status, 404);
});

test("api: 세션 다시 시작은 CLI 대화와 수명만 비운다", async () => {
  const s = (await api("POST", "/sessions", { agent: "claude", projectPath: repo, title: "R", permission: "acceptEdits" })).body;
  const restarted = await api("POST", `/sessions/${s.id}/restart`);
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.agentSessionId, null);
  assert.equal(restarted.body.compactions, 0);
  assert.equal(restarted.body.title, "R");
  assert.equal((await api("DELETE", `/sessions/${s.id}`)).status, 200);
});

test("api: AGENTHUB.md 만들기와 흐름 시작", async () => {
  assert.equal((await api("GET", `/hub?path=${encodeURIComponent(repo)}`)).body.exists, false);
  const hub = (await api("POST", "/hub/init", { path: repo })).body;
  assert.equal(hub.roles.length, 2);
  assert.equal((await api("POST", "/hub/init", { path: repo })).status, 409);

  const created = await api("POST", "/hub/flows", { projectPath: repo, flowName: "구현과 리뷰", name: "작업" });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.map((s) => [s.title, s.agent, !!s.worktree]),
    [["작업 · 구현", "claude", true], ["작업 · 리뷰", "codex", false]]);
  assert.equal((await api("GET", "/links")).body.length, 2);
  for (const s of created.body) await api("DELETE", `/sessions/${s.id}?removeWorktree=1`);
});

test("api: 오케스트레이터 세션과 계획 처리 경로", async () => {
  const orc = (await api("POST", "/sessions", { agent: "claude", projectPath: repo, permission: "default", orchestrator: true })).body;
  assert.equal(orc.kind, "orchestrator");
  assert.equal(orc.permission, "default");
  assert.equal((await api("POST", `/sessions/${orc.id}/plans/nope`, { action: "approve" })).status, 404);
  await api("DELETE", `/sessions/${orc.id}`);
});

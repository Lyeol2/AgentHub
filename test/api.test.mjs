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
// 실제 개인 스킬(~/.claude/skills, ~/.agents/skills)을 읽지 않도록 홈 폴더도 임시 폴더로 바꾼다.
process.env.USERPROFILE = process.env.HOME = path.join(tmp, "home");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "home", ".claude");
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
  const changed = (await api("PUT", `/links/${link.id}`, { when: "always" })).body;
  assert.equal(changed.when, "always");
  assert.equal(changed.keyword, ""); // 키워드 조건이 아니면 키워드를 남기지 않는다.
  assert.equal((await api("PUT", `/links/${link.id}`, { when: "otherwise", enabled: 0 })).body.enabled, false);
  assert.equal((await api("PUT", `/links/${link.id}`, { when: "keyword", keyword: " " })).status, 400);
  assert.equal((await api("PUT", `/links/${link.id}`, { when: "가끔" })).status, 400);
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

test("api: Claude Code·Codex 기록은 목록에서 숨기고 다시 보일 수 있다", async () => {
  assert.equal((await api("POST", "/projects/hide", { agentSessionId: "abc" })).status, 200);
  const config = JSON.parse(fs.readFileSync(path.join(tmp, "data", "config.json"), "utf8"));
  assert.deepEqual(config.hiddenSessions, ["abc"]);
  await api("POST", "/projects/hide", { agentSessionId: "abc", hidden: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, "data", "config.json"), "utf8")).hiddenSessions, []);
  assert.equal((await api("POST", "/projects/hide", {})).status, 400);
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

test("api: 스킬을 만들고 세션에 이은 뒤 지우면 세션에서도 빠진다", async () => {
  const made = await api("POST", "/skills", { projectPath: repo, name: "review", description: "리뷰할 때", body: "# 리뷰", pos: { x: 10, y: 400 } });
  assert.equal(made.status, 200);
  assert.equal((await api("POST", "/skills", { projectPath: repo, name: "review", description: "x" })).status, 400);
  const list = (await api("GET", `/skills?path=${encodeURIComponent(repo)}`)).body;
  assert.deepEqual(list.map((k) => [k.name, k.pos]), [["review", { x: 10, y: 400 }]]);

  const s = (await api("POST", "/sessions", { agent: "claude", projectPath: repo, title: "S", permission: "acceptEdits" })).body;
  const edited = await api("PUT", `/sessions/${s.id}`, { skills: ["review", "없는스킬"] });
  assert.deepEqual(edited.body.skills, ["review"]);

  assert.equal((await api("DELETE", `/skills/review?path=${encodeURIComponent(repo)}`)).status, 200);
  assert.deepEqual((await api("GET", `/sessions/${s.id}`)).body.skills, []);
  await api("DELETE", `/sessions/${s.id}`);
});

test("api: 공유 노트·메시지 목록과 MCP 주소 검사", async () => {
  assert.deepEqual((await api("GET", `/board?path=${encodeURIComponent(repo)}`)).body, { text: "" });
  assert.equal((await api("PUT", "/board", { path: repo, text: "## 약속\nstatus는 string" })).body.text, "## 약속\nstatus는 string\n");
  assert.match((await api("GET", `/board?path=${encodeURIComponent(repo)}`)).body.text, /status는 string/);
  assert.equal((await api("PUT", "/board", { path: repo, text: "" })).body.text, "");
  assert.equal((await api("GET", "/board")).status, 400);
  assert.deepEqual((await api("GET", `/messages?path=${encodeURIComponent(repo)}`)).body, []);

  const rpc = (headers = {}) => fetch(`http://127.0.0.1:45177/mcp/${"0".repeat(48)}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal((await rpc()).status, 404); // 모르는 토큰
  assert.equal((await rpc({ Origin: "http://evil.example" })).status, 403); // 브라우저에서 온 요청
});

test("api: 쉬고 있는 세션을 일시중지·재개·중지한다", async () => {
  const s = (await api("POST", "/sessions", { agent: "claude", projectPath: repo, title: "P", permission: "acceptEdits" })).body;
  const paused = await api("POST", `/sessions/${s.id}/pause`);
  assert.equal(paused.body.state, "paused");
  assert.equal(paused.body.paused, true);
  assert.equal((await api("POST", `/sessions/${s.id}/pause`)).status, 409);
  const resumed = await api("POST", `/sessions/${s.id}/resume`);
  assert.equal(resumed.body.state, "idle");
  assert.equal(resumed.body.paused, undefined);
  assert.equal((await api("POST", `/sessions/${s.id}/resume`)).status, 409);

  await api("POST", `/sessions/${s.id}/pause`);
  assert.equal((await api("POST", `/sessions/${s.id}/stop`)).body.stopped, true); // 일시중지를 풀고 중지
  const after = (await api("GET", `/sessions/${s.id}`)).body;
  assert.equal(after.state, "idle");
  assert.match(after.events.at(-1).text, /중지했습니다/);
  await api("DELETE", `/sessions/${s.id}`);
});

test("api: 세션의 AI를 바꾸고 진행 상황을 넘긴다", async () => {
  const s = (await api("POST", "/sessions", { agent: "claude", projectPath: repo, title: "S", permission: "acceptEdits", model: "opus" })).body;
  // 기록이 없으면 넘길 것도 없다.
  const plain = (await api("PUT", `/sessions/${s.id}`, { agent: "codex" })).body;
  assert.deepEqual([plain.agent, plain.model, plain.permission, plain.handoverPending], ["codex", "", "workspace-write", false]);
  assert.equal((await api("PUT", `/sessions/${s.id}`, { agent: "gemini" })).status, 400);
  assert.equal((await api("PUT", `/sessions/${s.id}`, { agent: "claude", permission: "read-only" })).status, 400); // Codex 권한은 Claude에 없다.

  const back = (await api("PUT", `/sessions/${s.id}`, { agent: "claude", permission: "plan" })).body;
  assert.deepEqual([back.agent, back.permission, back.agentSessionId], ["claude", "plan", null]);
  const full = (await api("GET", `/sessions/${s.id}`)).body;
  assert.match(full.events.at(-1).text, /Codex에서 Claude\(으\)로 바꿨습니다/);
  await api("DELETE", `/sessions/${s.id}`);
});

test("api: 프로젝트를 제거하면 AgentHub 세션·연결은 지우고 폴더는 남기며, 다시 쓰면 다시 보인다", async () => {
  const make = (title) => api("POST", "/sessions", { agent: "claude", projectPath: repo, title, permission: "acceptEdits" });
  const a = (await make("A")).body;
  const b = (await make("B")).body;
  await api("POST", "/links", { from: a.id, to: b.id });
  await api("PUT", "/board", { path: repo, text: "메모" });
  assert.ok((await api("GET", "/projects/all")).body.some((p) => p.path.toLowerCase() === path.resolve(repo).toLowerCase()));

  assert.equal((await api("DELETE", "/projects")).status, 400);
  const removed = await api("DELETE", `/projects?path=${encodeURIComponent(repo)}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.sessions, 2);
  assert.deepEqual(removed.body.worktreeErrors, []);
  assert.ok(fs.existsSync(path.join(repo, "README.md"))); // 프로젝트 파일은 그대로다.
  const sessions = (await api("GET", "/sessions")).body;
  assert.ok(!sessions.some((s) => s.id === a.id || s.id === b.id));
  assert.equal((await api("GET", "/links")).body.length, 0);
  assert.equal((await api("GET", `/board?path=${encodeURIComponent(repo)}`)).body.text, "");
  assert.ok(!(await api("GET", "/projects/all")).body.some((p) => p.path.toLowerCase() === path.resolve(repo).toLowerCase()));

  // 같은 폴더에서 다시 세션을 만들면 다시 등록된다.
  const again = (await make("C")).body;
  assert.ok((await api("GET", "/projects/all")).body.some((p) => p.registered && p.path.toLowerCase() === path.resolve(repo).toLowerCase()));
  await api("DELETE", `/sessions/${again.id}`);
});

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
// 계획 승인을 검증할 저장 세션. 실제 CLI 출력이나 개인 데이터는 사용하지 않는다.
const planSessionId = "plan-fixture";
const planFixture = {
  id: planSessionId, title: "계획 검증", agent: "claude", model: "", permission: "default",
  projectName: "repo", projectPath: repo, cwd: repo, worktree: null, kind: "orchestrator", state: "idle",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  events: [
    { seq: 0, kind: "plan", planId: "collision", status: "pending", raw: { sessions: [
      { key: "first", isolate: true, worktreeName: "plan-unmade" },
      { key: "second", isolate: true, worktreeName: "plan-conflict" },
    ] } },
    { seq: 1, kind: "plan", planId: "named", status: "pending", raw: { sessions: [
      { key: "default", agent: "codex" },
      { key: "isolated", agent: "codex", isolate: true, worktreeName: "plan-work" },
    ] } },
  ],
};
fs.mkdirSync(path.join(tmp, "data", "sessions"), { recursive: true });
fs.writeFileSync(path.join(tmp, "data", "sessions", planSessionId + ".json"), JSON.stringify(planFixture));
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

test("api: 새 세션은 기본으로 원본을 쓰며 이름만 보내도 워크트리를 만들지 않는다", async () => {
  fs.writeFileSync(path.join(repo, "uncommitted.txt"), "원본의 현재 수정\n");
  for (const agent of ["claude", "codex"]) {
    for (const options of [{}, { isolate: false }, { worktreeName: "ignored" }, { isolate: "false", worktreeName: "ignored" }]) {
      const made = await api("POST", "/sessions", { agent, projectPath: repo, ...options });
      assert.equal(made.status, 200);
      assert.equal(made.body.cwd, repo);
      assert.equal(made.body.worktree, null);
      assert.equal(fs.readFileSync(path.join(made.body.cwd, "uncommitted.txt"), "utf8"), "원본의 현재 수정\n");
      assert.equal((await api("DELETE", `/sessions/${made.body.id}?removeWorktree=1`)).status, 200);
      assert.ok(fs.existsSync(repo));
    }
  }
  assert.equal(fs.existsSync(repo + ".agenthub"), false);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.equal(worktrees.match(/^worktree /gm).length, 1);
});

test("api: 워크트리를 명시 선택하면 필수 이름으로 분리하고 원본의 수정을 가져가지 않는다", async () => {
  for (const agent of ["claude", "codex"]) {
    const name = `bag-ui-${agent}`;
    const made = await api("POST", "/sessions", { agent, projectPath: repo, isolate: true, worktreeName: ` ${name} ` });
    assert.equal(made.status, 200);
    assert.equal(made.body.cwd, path.join(repo + ".agenthub", name));
    assert.deepEqual(made.body.worktree, { dir: made.body.cwd, branch: `agenthub/${name}` });
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: made.body.cwd, encoding: "utf8" }).trim(), `agenthub/${name}`);
    assert.equal(fs.existsSync(path.join(made.body.cwd, "uncommitted.txt")), false);
    assert.ok(fs.existsSync(path.join(made.body.cwd, "README.md")));
    assert.equal(made.body.baseCommit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim());
    const duplicate = await api("POST", "/sessions", { agent, projectPath: repo, isolate: true, worktreeName: name });
    assert.equal(duplicate.status, 400);
    assert.equal((await api("DELETE", `/sessions/${made.body.id}?removeWorktree=1`)).status, 200);
    assert.equal(fs.existsSync(made.body.cwd), false);
    assert.equal(fs.readFileSync(path.join(repo, "uncommitted.txt"), "utf8"), "원본의 현재 수정\n");
  }
});

test("api: 이름 없는 워크트리와 잘못된 이름은 세션이나 작업 폴더를 만들지 않는다", async () => {
  const before = (await api("GET", "/sessions")).body.map((s) => s.id);
  for (const worktreeName of [undefined, "", " ", "../x", "bad/name", "C:\\temp", "-x", "CON", "x".repeat(65), 123]) {
    const made = await api("POST", "/sessions", { agent: "claude", projectPath: repo, isolate: true, worktreeName });
    assert.equal(made.status, 400, String(worktreeName));
    assert.match(made.body.error, /워크트리 이름/);
  }
  assert.deepEqual((await api("GET", "/sessions")).body.map((s) => s.id), before);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.equal(worktrees.match(/^worktree /gm).length, 1);
});

test("api: git 저장소가 아닌 프로젝트는 기본 원본이며 워크트리 선택은 오류를 알린다", async () => {
  const folder = path.join(tmp, "plain");
  fs.mkdirSync(folder);
  const made = await api("POST", "/sessions", { agent: "claude", projectPath: folder });
  assert.equal(made.status, 200);
  assert.equal(made.body.cwd, folder);
  assert.equal(made.body.worktree, null);
  assert.equal(made.body.baseCommit, null);
  const isolated = await api("POST", "/sessions", { agent: "claude", projectPath: folder, isolate: true, worktreeName: "feature" });
  assert.equal(isolated.status, 400);
  assert.match(isolated.body.error, /Git 저장소/);
  assert.equal(fs.existsSync(folder + ".agenthub"), false);
  assert.equal((await api("DELETE", `/sessions/${made.body.id}`)).status, 200);
});

test("api: 이전 worktree의 CLI 기록을 가져와도 원본에서 시작하고 중복으로 가져오지 않는다", async () => {
  const oldFolder = path.join(repo, ".claude", "worktrees", "old");
  fs.mkdirSync(oldFolder, { recursive: true });
  fs.writeFileSync(path.join(oldFolder, "pending.txt"), "이전 작업\n");
  const records = path.join(tmp, "home", ".claude", "projects", "legacy");
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, "legacy-import.jsonl"), [
    { type: "user", cwd: oldFolder, timestamp: new Date().toISOString(), message: { role: "user", content: "계속 구현한다" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "진행 중인 작업" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const body = { agent: "claude", projectPath: repo, agentSessionId: "legacy-import" };
  const imported = await api("POST", "/sessions/import", body);
  assert.equal(imported.status, 200);
  assert.equal(imported.body.cwd, repo);
  assert.equal(imported.body.worktree, null);
  assert.equal(imported.body.previousCwd, oldFolder);
  assert.equal(imported.body.agentSessionId, null);
  assert.equal(imported.body.handoverPending, true);
  assert.deepEqual(imported.body.cliSessionIds, ["legacy-import"]);
  const duplicate = await api("POST", "/sessions/import", body);
  assert.equal(duplicate.body.id, imported.body.id);
  assert.equal(fs.readFileSync(path.join(oldFolder, "pending.txt"), "utf8"), "이전 작업\n");
  await api("DELETE", `/sessions/${imported.body.id}`);
  await api("POST", "/projects/hide", { agentSessionId: "legacy-import", hidden: false });
  fs.rmSync(path.join(records, "legacy-import.jsonl"));
});

test("api: 세션 재생성도 원본 폴더와 설정·연결을 유지한다", async () => {
  const made = await api("POST", "/sessions", { agent: "codex", projectPath: repo, title: "새로 만들기", role: "구현" });
  const other = (await api("POST", "/sessions", { agent: "claude", projectPath: repo })).body;
  await api("PUT", `/sessions/${made.body.id}`, { graphPos: { x: 11, y: 22 } });
  await api("POST", "/links", { from: made.body.id, to: other.id });
  const recreated = await api("POST", `/sessions/${made.body.id}/recreate`);
  assert.equal(recreated.status, 200);
  assert.notEqual(recreated.body.id, made.body.id);
  assert.equal(recreated.body.cwd, repo);
  assert.equal(recreated.body.worktree, null);
  assert.equal(recreated.body.title, "새로 만들기");
  assert.equal(recreated.body.role, "구현");
  assert.deepEqual(recreated.body.graphPos, { x: 11, y: 22 });
  assert.equal((await api("GET", "/links")).body[0].from, recreated.body.id);
  await api("DELETE", `/sessions/${recreated.body.id}`);
  await api("DELETE", `/sessions/${other.id}`);
});

test("api: 워크트리 세션 재생성은 기존 폴더와 수정 파일을 그대로 이어 쓴다", async () => {
  const made = await api("POST", "/sessions", { agent: "codex", projectPath: repo, isolate: true, worktreeName: "recreate-ui" });
  assert.equal(made.status, 200);
  fs.writeFileSync(path.join(made.body.cwd, "pending.txt"), "keep work\n");
  const recreated = await api("POST", `/sessions/${made.body.id}/recreate`);
  assert.equal(recreated.status, 200);
  assert.notEqual(recreated.body.id, made.body.id);
  assert.equal(recreated.body.cwd, made.body.cwd);
  assert.deepEqual(recreated.body.worktree, made.body.worktree);
  assert.equal(recreated.body.agentSessionId, null);
  assert.equal(fs.readFileSync(path.join(recreated.body.cwd, "pending.txt"), "utf8"), "keep work\n");
  assert.equal((await api("GET", `/sessions/${made.body.id}`)).status, 404);
  fs.rmSync(path.join(recreated.body.cwd, "pending.txt"));
  assert.equal((await api("DELETE", `/sessions/${recreated.body.id}?removeWorktree=1`)).status, 200);
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
    [["작업 · 구현", "claude", false], ["작업 · 리뷰", "codex", false]]);
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

test("api: 계획은 이름 충돌을 미리 거부하고 명시한 워크트리만 생성한다", async () => {
  execFileSync("git", ["branch", "agenthub/plan-conflict", "HEAD"], { cwd: repo });
  const before = (await api("GET", "/sessions")).body.map((s) => s.id);
  const collision = await api("POST", `/sessions/${planSessionId}/plans/collision`, { action: "approve" });
  assert.equal(collision.status, 400);
  assert.match(collision.body.error, /이미 있습니다/);
  assert.deepEqual((await api("GET", "/sessions")).body.map((s) => s.id), before);
  assert.equal(fs.existsSync(path.join(repo + ".agenthub", "plan-unmade")), false);
  const applied = await api("POST", `/sessions/${planSessionId}/plans/named`, { action: "approve" });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.status, "applied");
  const created = (await api("GET", "/sessions")).body.filter((s) => s.createdBy === planSessionId);
  assert.equal(created.length, 2);
  assert.equal(created.find((s) => s.title === "default").cwd, repo);
  assert.equal(created.find((s) => s.title === "default").worktree, null);
  const isolated = created.find((s) => s.title === "isolated");
  assert.equal(isolated.cwd, path.join(repo + ".agenthub", "plan-work"));
  assert.equal(isolated.worktree.branch, "agenthub/plan-work");
  for (const session of created) await api("DELETE", `/sessions/${session.id}?removeWorktree=1`);
  await api("DELETE", `/sessions/${planSessionId}`);
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

test("api: Git 패널 조회와 입력 검사", async () => {
  const overview = await api("GET", `/git?path=${encodeURIComponent(repo)}`);
  assert.equal(overview.status, 200);
  assert.ok(Array.isArray(overview.body.files) && Array.isArray(overview.body.commits) && Array.isArray(overview.body.branches));
  assert.ok(Array.isArray(overview.body.graph.commits));
  assert.equal(typeof overview.body.graph.truncated, "boolean");
  assert.ok(overview.body.graph.commits.every((c) => /^[0-9a-f]{40}$/.test(c.hash) && Array.isArray(c.parents) && Array.isArray(c.refs)));
  assert.ok(overview.body.branches.every((b) => /^[0-9a-f]{40}$/.test(b.tip)));
  assert.equal((await api("GET", "/git")).status, 400);
  const plain = fs.mkdtempSync(path.join(tmp, "plain-"));
  const notGit = await api("GET", `/git?path=${encodeURIComponent(plain)}`);
  assert.deepEqual([notGit.status, notGit.body.reason], [400, "not-git"]);
  assert.equal((await api("GET", `/git/show?path=${encodeURIComponent(repo)}&hash=--all`)).status, 400);
  assert.equal((await api("POST", "/git/merge", { path: repo, branch: "--abort" })).status, 400);
  assert.equal((await api("POST", "/git/commit", { path: repo, message: "x", session: "없는세션" })).status, 404);
});


test("api: Git 영역별 diff·스테이징·취소·index 전용 커밋을 연결한다", async () => {
  const dir = path.join(tmp, "git-staging-api");
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "partial.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "partial.txt"), "base\nindex\n");
  const query = "?path=" + encodeURIComponent(dir);
  assert.equal((await api("POST", "/git/stage", { path: dir, files: [] })).status, 400);
  assert.equal((await api("POST", "/git/stage", { path: dir, files: "partial.txt" })).status, 400);
  assert.equal((await api("POST", "/git/stage", { path: dir, files: ["../escape"] })).status, 400);
  const staged = await api("POST", "/git/stage", { path: dir, files: ["partial.txt"] });
  assert.deepEqual(staged, { status: 200, body: { ok: true, count: 1 } });
  fs.writeFileSync(path.join(dir, "partial.txt"), "base\nindex\nwork\n");
  fs.writeFileSync(path.join(dir, "other.txt"), "other\n");
  const overview = (await api("GET", "/git" + query)).body;
  assert.deepEqual([overview.stagedCount, overview.unstagedCount], [1, 2]);
  const partial = overview.files.find((f) => f.path === "partial.txt");
  assert.deepEqual([partial.staged, partial.unstaged, partial.stageLabel, partial.workLabel], [true, true, "수정", "수정"]);
  const stagedDiff = await api("GET", "/git/diff" + query + "&file=partial.txt&area=staged");
  assert.equal(stagedDiff.status, 200);
  assert.match(stagedDiff.body.diff, /\+index/);
  assert.doesNotMatch(stagedDiff.body.diff, /work/);
  const workDiff = await api("GET", "/git/diff" + query + "&file=partial.txt&area=unstaged");
  assert.equal(workDiff.status, 200);
  assert.match(workDiff.body.diff, /\+work/);
  assert.doesNotMatch(workDiff.body.diff, /\+index/);
  assert.equal((await api("GET", "/git/diff" + query + "&file=partial.txt&area=wrong")).status, 400);
  assert.equal((await api("POST", "/git/unstage", { path: dir, files: ["partial.txt", "missing.txt"] })).status, 400);
  assert.equal((await api("GET", "/git" + query)).body.stagedCount, 1);
  assert.equal((await api("POST", "/git/unstage", { path: dir, files: ["partial.txt"] })).status, 200);
  assert.equal((await api("GET", "/git" + query)).body.stagedCount, 0);
  assert.equal(fs.readFileSync(path.join(dir, "partial.txt"), "utf8"), "base\nindex\nwork\n");
  assert.equal((await api("POST", "/git/stage", { path: dir, files: ["partial.txt"] })).status, 200);
  fs.appendFileSync(path.join(dir, "partial.txt"), "later\n");
  const committed = await api("POST", "/git/commit", { path: dir, message: "index만", staged: true });
  assert.equal(committed.status, 200);
  assert.match(committed.body.result, /index만/);
  assert.equal(git("show", "HEAD:partial.txt").replace(/\r\n/g, "\n"), "base\nindex\nwork\n");
  assert.equal(git("ls-tree", "--name-only", "HEAD").trim(), "partial.txt");
  const after = (await api("GET", "/git" + query)).body;
  assert.deepEqual([after.stagedCount, after.unstagedCount], [0, 2]);
  assert.equal((await api("POST", "/git/commit", { path: dir, message: "empty", staged: true })).status, 400);
});


test("api: PR 목록·상세·생성·병합·닫기·푸시 경로와 오류를 연결한다", async () => {
  const { githubPulls, GitHubError } = await import("../server/github.mjs");
  const noRemote = await api("GET", "/git/pulls?path=" + encodeURIComponent(repo));
  assert.deepEqual([noRemote.status, noRemote.body.reason], [400, "github-remote"]);
  const names = ["list", "detail", "create", "merge", "close", "push"];
  const original = Object.fromEntries(names.map((name) => [name, githubPulls[name]]));
  const calls = [];
  const pull = { number: 7, title: "PR", state: "OPEN", url: "https://github.com/acme/widget/pull/7" };
  try {
    for (const name of names) githubPulls[name] = async (...args) => {
      calls.push({ name, args });
      return name === "list" ? { context: { repo: "acme/widget" }, pulls: [pull] }
        : name === "detail" ? { pull, diff: "+new", diffError: null } : { ok: true, pull };
    };
    const query = "?path=" + encodeURIComponent(repo) + "&remote=upstream";
    assert.equal((await api("GET", "/git/pulls" + query + "&state=all")).body.pulls[0].number, 7);
    assert.deepEqual(calls.at(-1), { name: "list", args: [repo, { remote: "upstream", state: "all" }] });
    assert.equal((await api("GET", "/git/pulls/7" + query)).body.diff, "+new");
    assert.deepEqual(calls.at(-1), { name: "detail", args: [repo, "7", { remote: "upstream" }] });
    const body = { path: repo, repo: "acme/widget", remote: "upstream", branch: "feature", state: "draft", title: "PR", body: "text", head: "feature", base: "main", expectedHead: "a".repeat(40) };
    for (const [route, name] of [["/git/pulls", "create"], ["/git/pulls/7/merge", "merge"], ["/git/pulls/7/close", "close"], ["/git/push", "push"]]) {
      assert.equal((await api("POST", route, body)).status, 200);
      assert.equal(calls.at(-1).name, name);
      assert.deepEqual(calls.at(-1).args, ["merge", "close"].includes(name) ? [repo, "7", body] : [repo, body]);
    }
    const count = calls.length;
    for (const route of ["/git/push/7/merge", "/git/push/7/close", "/git/pulls/7/review"])
      assert.equal((await api("POST", route, body)).status, 404);
    assert.equal((await api("GET", "/git/push" + query)).status, 404);
    assert.equal(calls.length, count);
    githubPulls.create = async () => { throw new GitHubError("먼저 푸시하세요.", "branch-unpublished", 409); };
    const unpublished = await api("POST", "/git/pulls", body);
    assert.deepEqual([unpublished.status, unpublished.body.reason, unpublished.body.outcomeUnknown], [409, "branch-unpublished", false]);
    githubPulls.create = async () => { throw new GitHubError("완료 여부를 확인하세요.", "github-timeout", 504, true); };
    const unknown = await api("POST", "/git/pulls", body);
    assert.deepEqual([unknown.status, unknown.body.reason, unknown.body.outcomeUnknown], [504, "github-timeout", true]);
  } finally {
    for (const name of names) githubPulls[name] = original[name];
  }
});


test("api: 실행 시작 시각 필드를 목록·상세·상태 스트림에서 제공한다", async () => {
  const session = (await api("POST", "/sessions", { agent: "claude", projectPath: repo, title: "timer API" })).body;
  const controller = new AbortController();
  let reader;
  try {
    assert.equal(session.runningStartedAt, null);
    assert.equal((await api("GET", "/sessions/" + session.id)).body.runningStartedAt, null);
    assert.equal((await api("GET", "/sessions")).body.find((s) => s.id === session.id).runningStartedAt, null);
    const stream = await fetch("http://127.0.0.1:45177/api/stream", { signal: controller.signal });
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    await api("POST", "/sessions/" + session.id + "/pause");
    let data = "";
    let payload;
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      while (!payload) {
        const chunk = await reader.read();
        if (chunk.done) break;
        data += decoder.decode(chunk.value, { stream: true });
        payload = data.split("\n\n").slice(0, -1).find((event) => event.startsWith("event: state\n"));
      }
      assert.ok(payload, data);
      assert.deepEqual(JSON.parse(payload.split("\ndata: ")[1]), { sessionId: session.id, state: "paused", runningStartedAt: null });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await api("DELETE", "/sessions/" + session.id);
  }
});

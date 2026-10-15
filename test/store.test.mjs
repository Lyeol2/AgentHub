// 저장한 세션의 폴더 전환을 임시 데이터로 검증한다. 실제 CLI와 git worktree는 만들지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-store-test-"));
const dataDir = path.join(tmp, "data");
const sessionsDir = path.join(dataDir, "sessions");
const project = path.join(tmp, "project");
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "file.txt"), "project contents\n");
process.env.AGENTHUB_DATA = dataDir;
const { SessionStore, useProjectFolder } = await import("../server/store.mjs");

test.after(() => {
  const resolved = path.resolve(tmp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("agenthub-store-test-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function fixture(id, extra = {}) {
  const session = {
    id, title: id, agent: "codex", model: "", permission: "workspace-write",
    projectName: "project", projectPath: project, cwd: project, worktree: null,
    agentSessionId: "cli-current", cliSessionIds: ["cli-earlier", "cli-current"],
    compactions: 2, context: { tokens: 123 }, waiting: true, roleChanged: true,
    state: "idle", createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z",
    events: [
      { seq: 0, ts: "2026-10-15T00:00:00.000Z", kind: "user", text: "기능을 구현한다." },
      { seq: 1, ts: "2026-10-15T00:00:01.000Z", kind: "text", text: "구현 중이다." },
    ],
    ...extra,
  };
  fs.writeFileSync(path.join(sessionsDir, id + ".json"), JSON.stringify(session, null, 2));
  return session;
}

function persisted(id) {
  return JSON.parse(fs.readFileSync(path.join(sessionsDir, id + ".json"), "utf8"));
}

test("store: 기존 분리 세션은 원본으로 옮기고 이전 파일·브랜치·기록·역할을 보존한다", () => {
  const previousCwd = path.join(tmp, "project.agenthub", "feature");
  fs.mkdirSync(previousCwd, { recursive: true });
  fs.writeFileSync(path.join(previousCwd, "file.txt"), "uncommitted work\n");
  const worktree = { dir: previousCwd, branch: "agenthub/feature" };
  const question = { seq: 2, kind: "question", status: "pending", questions: [{ question: "다음 작업?" }] };
  const before = fixture("legacy", {
    cwd: previousCwd, worktree, state: "paused", paused: true, pausedMidTurn: true,
    role: "UI 구현", roleName: "구현", skills: ["review"], graphPos: { x: 12, y: 34 },
    createdBy: "orchestrator", chainDepth: 3, handover: "앞서 인계받은 내용",
  });
  before.events.push(question);
  fs.writeFileSync(path.join(sessionsDir, "legacy.json"), JSON.stringify(before, null, 2));

  const store = new SessionStore();
  const session = store.get("legacy");
  assert.equal(session.cwd, project);
  assert.equal(session.worktree, null);
  assert.equal(session.previousCwd, previousCwd);
  assert.deepEqual(session.previousWorktree, worktree);
  assert.equal(fs.readFileSync(path.join(previousCwd, "file.txt"), "utf8"), "uncommitted work\n");
  assert.equal(fs.readFileSync(path.join(project, "file.txt"), "utf8"), "project contents\n");
  assert.equal(session.agentSessionId, null);
  assert.deepEqual(session.cliSessionIds, ["cli-earlier", "cli-current"]);
  assert.equal(session.compactions, 0);
  assert.equal(session.context, null);
  assert.equal(session.waiting, false);
  assert.equal("roleChanged" in session, false);
  assert.deepEqual(session.events.slice(0, before.events.length), before.events);
  for (const key of ["state", "paused", "pausedMidTurn", "role", "roleName", "skills", "graphPos", "createdBy", "chainDepth", "createdAt", "updatedAt"]) {
    assert.deepEqual(session[key], before[key], key);
  }
  assert.ok(session.handover.split("\n").includes("작업 폴더: " + project));
  assert.ok(session.handover.includes("이전 작업 폴더: " + previousCwd + " (브랜치 agenthub/feature)"));
  assert.match(session.handover, /변경을 원본으로 자동으로 옮기지는 않았다/);
  assert.match(session.handover, /이전 경로에서 작업하거나 새 worktree를 만들지 않는다/);
  assert.ok(session.handover.includes("기능을 구현한다."));
  assert.ok(session.handover.includes("앞서 인계받은 내용"));
  const event = session.events.at(-1);
  assert.equal(event.kind, "status");
  assert.ok(event.text.includes(project));
  assert.ok(event.text.includes(previousCwd));
  assert.match(event.text, /변경은 자동으로 합치지 않았습니다/);
  assert.deepEqual(persisted("legacy"), session);
});

test("store: 이전 폴더가 없어도 원본으로 전환하고 실행 중 상태를 중단으로 저장한다", () => {
  const previousCwd = path.join(tmp, "missing-worktree");
  const worktree = { dir: previousCwd, branch: "agenthub/missing" };
  fixture("missing", { cwd: previousCwd, worktree, state: "running", cliSessionIds: ["cli-earlier"] });
  const session = new SessionStore().get("missing");
  assert.equal(session.cwd, project);
  assert.equal(session.state, "interrupted");
  assert.equal(session.agentSessionId, null);
  assert.deepEqual(session.cliSessionIds, ["cli-earlier", "cli-current"]);
  assert.deepEqual(session.previousWorktree, worktree);
  assert.equal(session.previousCwd, previousCwd);
  assert.equal(fs.existsSync(previousCwd), false);
  assert.deepEqual(persisted("missing"), session);
});

test("store: worktree 메타데이터가 없는 가져온 세션도 원본에서 새 CLI 대화를 시작한다", () => {
  const previousCwd = path.join(project, ".claude", "worktrees", "imported");
  fixture("imported", { cwd: previousCwd, worktree: null, imported: true });
  const session = new SessionStore().get("imported");
  assert.equal(session.cwd, project);
  assert.equal(session.worktree, null);
  assert.equal(session.previousCwd, previousCwd);
  assert.equal(session.previousWorktree, undefined);
  assert.equal(session.imported, true);
  assert.equal(session.agentSessionId, null);
  assert.deepEqual(session.cliSessionIds, ["cli-earlier", "cli-current"]);
  assert.ok(session.handover.split("\n").includes("작업 폴더: " + project));
  assert.ok(session.handover.includes("이전 작업 폴더: " + previousCwd));
  assert.deepEqual(persisted("imported"), session);
});

test("store: 일반 채팅과 이미 원본인 세션의 CLI·기록·저장 파일은 그대로 둔다", () => {
  const original = fixture("original");
  const chat = fixture("chat", { chat: true, projectPath: null, cwd: path.join(dataDir, "chat") });
  const originalFile = fs.readFileSync(path.join(sessionsDir, "original.json"), "utf8");
  const chatFile = fs.readFileSync(path.join(sessionsDir, "chat.json"), "utf8");
  const store = new SessionStore();
  assert.deepEqual(store.get("original"), original);
  assert.deepEqual(store.get("chat"), chat);
  assert.equal(fs.readFileSync(path.join(sessionsDir, "original.json"), "utf8"), originalFile);
  assert.equal(fs.readFileSync(path.join(sessionsDir, "chat.json"), "utf8"), chatFile);
});

test("store: 이미 전환한 세션을 다시 읽거나 정규화해도 안내와 인계를 중복하지 않는다", () => {
  const previousCwd = path.join(tmp, "reload-worktree");
  fixture("reload", { cwd: previousCwd, worktree: { dir: previousCwd, branch: "agenthub/reload" } });
  const first = new SessionStore().get("reload");
  const before = structuredClone(first);
  const file = fs.readFileSync(path.join(sessionsDir, "reload.json"), "utf8");
  assert.equal(useProjectFolder(first), false);
  assert.deepEqual(first, before);
  const reloaded = new SessionStore().get("reload");
  assert.deepEqual(reloaded, before);
  assert.equal(fs.readFileSync(path.join(sessionsDir, "reload.json"), "utf8"), file);
  assert.equal(reloaded.events.filter((event) => event.kind === "status").length, 1);
});

test("store: 같은 Windows 경로의 대소문자·구분자 차이는 CLI 대화를 초기화하지 않는다", { skip: process.platform !== "win32" }, () => {
  const cwd = project.toUpperCase().split(path.sep).join("/");
  const before = fixture("equivalent", { cwd });
  const session = new SessionStore().get("equivalent");
  assert.deepEqual(session, before);
});

test("store: cwd가 없거나 원본 경로로 남아도 이전 worktree 재개 ID를 초기화한다", () => {
  for (const [id, cwd] of [["no-cwd", undefined], ["stale-cwd", project]]) {
    const previousCwd = path.join(tmp, id + "-worktree");
    fixture(id, { cwd, worktree: { dir: previousCwd, branch: "agenthub/" + id } });
    const session = new SessionStore().get(id);
    assert.equal(session.cwd, project);
    assert.equal(session.worktree, null);
    assert.equal(session.previousCwd, previousCwd);
    assert.equal(session.agentSessionId, null);
    assert.ok(session.handover.includes("작업 폴더: " + project));
    assert.deepEqual(persisted(id), session);
  }
});

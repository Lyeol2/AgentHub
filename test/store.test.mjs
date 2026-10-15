// 저장한 워크트리 유지와 누락 폴더 인계를 임시 데이터로 검증한다. 실제 CLI와 git worktree는 만들지 않는다.
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

test("store: 기존 워크트리 세션은 재시작해도 폴더·CLI 대화·진행 기록을 유지한다", () => {
  const cwd = path.join(tmp, "project.agenthub", "feature");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "file.txt"), "uncommitted work\n");
  const before = fixture("legacy", {
    cwd, worktree: { dir: cwd, branch: "agenthub/feature" },
    state: "paused", paused: true, pausedMidTurn: true,
    role: "UI 구현", roleName: "구현", skills: ["review"], graphPos: { x: 12, y: 34 },
    createdBy: "orchestrator", chainDepth: 3, handover: "앞서 인계받은 내용",
  });
  const file = fs.readFileSync(path.join(sessionsDir, "legacy.json"), "utf8");
  const session = new SessionStore().get("legacy");
  assert.deepEqual(session, before);
  assert.equal(fs.readFileSync(path.join(sessionsDir, "legacy.json"), "utf8"), file);
  assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "uncommitted work\n");
  assert.equal(fs.readFileSync(path.join(project, "file.txt"), "utf8"), "project contents\n");
  assert.equal(useProjectFolder(session), false);
  assert.deepEqual(new SessionStore().get("legacy"), before);
});

test("store: 실행 중이던 워크트리의 타이머만 종료하고 작업 폴더와 CLI는 유지한다", () => {
  const cwd = path.join(tmp, "active-worktree");
  fs.mkdirSync(cwd);
  const before = fixture("active", { cwd, worktree: { dir: cwd, branch: "agenthub/active" }, state: "running", runningStartedAt: "2026-10-15T00:00:00.000Z" });
  const session = new SessionStore().get("active");
  assert.deepEqual(session, { ...before, state: "interrupted", runningStartedAt: null });
  assert.deepEqual(persisted("active"), session);
});

test("store: 원본으로 전환된 세션의 이전 워크트리 기록은 자동 복구하지 않는다", () => {
  const dir = path.join(tmp, "previous-worktree");
  fs.mkdirSync(dir);
  const before = fixture("already-original", { previousCwd: dir, previousWorktree: { dir, branch: "agenthub/previous" } });
  assert.deepEqual(new SessionStore().get("already-original"), before);
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

test("store: 작업 소유 폴더가 정리되어도 세션을 원본 브랜치로 옮기지 않는다", () => {
  const cwd = path.join(tmp, "cleaned-task-worktree");
  const before = fixture("cleaned-task", { taskId: "task-1", cwd, worktree: { dir: cwd, branch: "feature/task-1" } });
  const session = new SessionStore().get(before.id);
  assert.deepEqual(session, before);
  assert.equal(session.cwd, cwd);
  assert.equal(useProjectFolder(session), false);
  assert.deepEqual(persisted(before.id), before);
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

test("store: 서버 재시작은 원본 폴더의 실행 세션도 중단하고 타이머 종료를 저장한다", () => {
  fixture("running-timer", { state: "running", runningStartedAt: "2026-10-15T00:00:00.000Z" });
  const session = new SessionStore().get("running-timer");
  assert.equal(session.state, "interrupted");
  assert.equal(session.runningStartedAt, null);
  assert.deepEqual(persisted("running-timer"), session);
  assert.deepEqual(new SessionStore().get("running-timer"), session);
});

test("store: 이전 버전의 실행 세션과 종료된 세션의 남은 타이머를 정리한다", () => {
  fixture("legacy-running-timer", { state: "running" });
  fixture("paused-stale-timer", { state: "paused", runningStartedAt: "2026-10-15T00:00:00.000Z" });
  const store = new SessionStore();
  for (const [id, state] of [["legacy-running-timer", "interrupted"], ["paused-stale-timer", "paused"]]) {
    const session = store.get(id);
    assert.equal(session.state, state);
    assert.equal(session.runningStartedAt, null);
    assert.deepEqual(persisted(id), session);
  }
});

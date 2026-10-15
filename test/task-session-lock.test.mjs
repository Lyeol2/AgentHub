import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskService } from "../server/application/tasks.mjs";
import { createSessionService } from "../server/application/sessions.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-task-session-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = path.join(root, "repo"), dataDir = path.join(root, "data");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Task Test");
  git("config", "user.email", "task@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-qm", "base");

  const task = { id: "task-race", projectPath: repo, cwd: repo, gitCommonDir: path.join(repo, ".git"),
    sessionIds: ["session-old"], state: "working", branch: "main", createdAt: new Date().toISOString() };
  fs.mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "tasks", task.id + ".json"), JSON.stringify(task));
  const stored = new Map([["session-old", { id: "session-old", taskId: task.id, projectPath: repo, cwd: repo,
    worktree: { dir: repo, branch: "main" }, agent: "codex", permission: "workspace-write", events: [],
    title: "Task", state: "idle", baseCommit: git("rev-parse", "HEAD") }]]);
  const store = { get: (id) => stored.get(id), list: () => [...stored.values()],
    add: (session) => stored.set(session.id, session), remove: (id) => stored.delete(id), touch() {} };
  const runner = { isRunning: () => false };
  const projects = { ensureProject: () => ({ name: "repo", path: repo }), projectSessions: () => store.list() };
  let sessions;
  const options = { dataDir, store, runner, sessions: () => sessions, projects };
  const tasks = createTaskService(options);
  sessions = createSessionService({ config: { hiddenSessions: [] }, dataDir, store, runner,
    chain: { queue: new Map() }, links: { list: () => [], removeForSession() {} },
    mailbox: { removeForSession() {} }, mcpTokens: { forget() {} }, mcpDir: dataDir,
    notify() {}, saveConfig() {}, projects, tasks: () => tasks });
  function assertRemoved() {
    assert.deepEqual(tasks.list(repo).tasks, []);
    assert.deepEqual(store.list(), []);
    assert.equal(fs.existsSync(path.join(dataDir, "tasks", task.id + ".json")), false);
    assert.deepEqual(createTaskService(options).list(repo).tasks, []);
    assert.ok(fs.existsSync(repo));
    assert.equal(git("branch", "--show-current"), "main");
  }
  return { tasks, sessions, task, assertRemoved };
}

test("tasks: deletion queued before session recreation prevents an orphan task session", async (t) => {
  const f = fixture(t);

  const [deletion, recreation] = await Promise.allSettled([
    f.tasks.remove(f.task.id),
    f.sessions.recreate("session-old"),
  ]);

  assert.equal(deletion.status, "fulfilled");
  assert.equal(recreation.status, "rejected");
  assert.equal(recreation.reason.reason, "task-missing");
  f.assertRemoved();
});

test("tasks: deletion queued after session recreation removes the replacement session", async (t) => {
  const f = fixture(t);

  const [recreation, deletion] = await Promise.allSettled([
    f.sessions.recreate("session-old"),
    f.tasks.remove(f.task.id),
  ]);

  assert.equal(recreation.status, "fulfilled");
  assert.equal(deletion.status, "fulfilled");
  assert.notEqual(recreation.value.id, "session-old");
  assert.equal(recreation.value.taskId, f.task.id);
  f.assertRemoved();
});

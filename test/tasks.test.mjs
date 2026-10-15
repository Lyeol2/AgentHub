import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskService } from "../server/application/tasks.mjs";
import { GitHubError, normalizePull } from "../server/github.mjs";

function fixture(t, { develop = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-tasks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = path.join(root, "repo"), remote = path.join(root, "origin.git"), dataDir = path.join(root, "data");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", "-q", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Task Test"); git(repo, "config", "user.email", "task@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", remote); git(repo, "push", "-q", "origin", "main");
  if (develop) { git(repo, "branch", "develop"); git(repo, "push", "-q", "origin", "develop"); }
  const state = { pulls: [], writes: [], running: new Set(), timeout: null };
  const stored = new Map(); let serial = 0;
  const store = { list: () => [...stored.values()], get: (id) => stored.get(id) };
  const sessions = { checkSessionOptions() {}, async createSession(body, internal) {
    const session = { id: `session-${++serial}`, title: body.title, projectPath: body.project.path, cwd: internal.worktree.dir,
      taskId: internal.taskId, worktree: internal.worktree, state: "idle", events: [] };
    stored.set(session.id, session); return session;
  } };
  const remoteSha = (branch) => git(repo, "ls-remote", remote, `refs/heads/${branch}`).split(/\s+/)[0] || null;
  const github = {
    async target(dir, selected) { return { dir, repo: "acme/widget", name: selected, pushMatches: true }; },
    async api(target, method, endpoint, body) {
      if (method === "GET" && endpoint.includes("/pulls?")) return state.pulls.filter((pull) =>
        (endpoint.includes("state=all") || pull.state === "open") && endpoint.includes(encodeURIComponent(`acme:${pull.head.ref}`))
        && endpoint.includes(`base=${encodeURIComponent(pull.base.ref)}`));
      if (method === "POST" && endpoint.endsWith("/git/refs")) {
        state.writes.push("develop");
        if (remoteSha("develop")) throw new GitHubError("HTTP 422 exists");
        git(repo, "push", "-q", remote, `${body.sha}:${body.ref}`); return { ref: body.ref };
      }
      throw Error(`Unexpected GitHub call: ${method} ${endpoint}`);
    },
    async push(dir, body) {
      state.writes.push("push");
      assert.equal(git(dir, "rev-parse", "HEAD"), body.expectedHead);
      git(dir, "push", "-q", remote, `${body.expectedHead}:refs/heads/${body.branch}`);
      for (const pull of state.pulls.filter((pull) => pull.head.ref === body.branch && pull.state === "open")) pull.head.sha = body.expectedHead;
      if (state.timeout === "push") throw new GitHubError("timeout", "github-timeout", 504, true);
      return { ok: true };
    },
    async create(dir, body) {
      state.writes.push("pull");
      const raw = { number: state.pulls.length + 1, title: body.title, body: body.body, state: "open",
        head: { ref: body.head, sha: body.expectedHead }, base: { ref: body.base } };
      state.pulls.push(raw);
      if (state.timeout === "pull") throw new GitHubError("timeout", "github-timeout", 504, true);
      return { pull: normalizePull(raw, "acme/widget") };
    },
    async detail(dir, number) { return { pull: normalizePull(state.pulls.find((pull) => pull.number === number), "acme/widget") }; },
    async remoteHead(target, branch) { return remoteSha(branch); },
  };
  const options = { dataDir, store, runner: { isRunning: (id) => state.running.has(id) }, sessions,
    projects: { ensureProject: (projectPath) => ({ name: "repo", path: projectPath }) }, github };
  let service = createTaskService(options);
  const create = (type = "feature", extra = {}) => service.create({ projectPath: repo, title: "새 작업", type, agent: "codex", ...extra });
  function change(dir, filename = "change.txt", text = "change\n") { fs.writeFileSync(path.join(dir, filename), text); }
  function commit(dir, filename = "remote-change.txt") { change(dir, filename); git(dir, "add", "."); git(dir, "commit", "-qm", filename); }
  return { repo, remote, state, git, create, change, commit, stored, get service() { return service; }, restart() { service = createTaskService(options); return service; } };
}

test("tasks: missing develop starts from latest main without modifying the source worktree", async (t) => {
  const f = fixture(t, { develop: false });
  f.change(f.repo, "keep-local.txt", "source changes\n");
  const before = f.git(f.repo, "rev-parse", "HEAD");
  const { task, session } = await f.create();
  assert.equal(task.baseCommit, before); assert.equal(task.needsDevelopSetup, true);
  assert.equal(session.cwd, task.cwd); assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
  assert.equal(fs.existsSync(path.join(task.cwd, "keep-local.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.repo, "keep-local.txt"), "utf8"), "source changes\n");
  assert.equal(f.restart().list(f.repo).tasks[0].id, task.id);
  f.change(task.cwd);
  const result = await f.service.finish(task.id, { verification: "테스트 통과" });
  assert.equal(result.task.state, "review"); assert.equal(result.pull.baseRefName, "develop");
  assert.deepEqual(f.state.writes, ["develop", "push", "pull"]);
});

test("tasks: develop must include main before creating a feature but hotfix remains available", async (t) => {
  const f = fixture(t);
  f.commit(f.repo); f.git(f.repo, "push", "-q", "origin", "main");
  const context = await f.service.context(f.repo);
  assert.equal(context.mainMissing, true); assert.equal(context.state, "needs-update");
  await assert.rejects(f.create(), (error) => error.reason === "gitflow-develop-behind");
  const { task } = await f.create("hotfix");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), f.git(f.repo, "rev-parse", "main"));
});

test("tasks: fetch failure never reports current and preserves existing work", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.git(f.repo, "remote", "set-url", "origin", path.join(f.repo, "missing-origin.git"));
  const context = await f.service.context(f.repo);
  assert.equal(context.state, "error");
  await assert.rejects(f.service.sync(task.id));
  assert.equal(f.service.list(f.repo).tasks[0].freshness.state, "error");
  assert.ok(fs.existsSync(task.cwd));
});

test("tasks: target sync rejects dirty changes and only merges the development target", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo); f.git(f.repo, "push", "-q", "origin", "develop");
  f.change(task.cwd);
  await assert.rejects(f.service.sync(task.id), (error) => error.reason === "task-dirty");
  f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "local");
  await f.service.sync(task.id);
  assert.equal(f.service.list(f.repo).tasks[0].freshness.state, "current");
  assert.ok(fs.existsSync(path.join(task.cwd, "remote-change.txt")));
});

test("tasks: finishing commits, publishes and reuses a PR; running sessions block mutations", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create();
  f.change(task.cwd);
  f.state.running.add(session.id);
  await assert.rejects(f.service.finish(task.id), (error) => error.reason === "running");
  f.state.running.clear();
  const first = await f.service.finish(task.id, { message: "feat: 테스트 작업", description: "작업 설명", verification: "검증 결과" });
  assert.equal(first.task.state, "review"); assert.equal(first.pull.number, 1);
  assert.match(first.pull.body, /검증 결과/);
  const second = await f.service.finish(task.id);
  assert.equal(second.pull.number, 1); assert.equal(f.state.pulls.length, 1);
  assert.equal(f.state.writes.filter((value) => value === "pull").length, 1);
});

test("tasks: uncertain PR write survives restart and resolves by lookup without duplicate creation", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); f.state.timeout = "pull";
  await assert.rejects(f.service.finish(task.id), (error) => error.outcomeUnknown);
  assert.equal(f.restart().list(f.repo).tasks[0].pendingAction.action, "pull");
  await assert.rejects(f.service.finish(task.id), (error) => error.reason === "task-outcome-unknown");
  const refreshed = await f.service.refresh(task.id);
  assert.equal(refreshed.task.state, "review"); assert.equal(refreshed.task.pendingAction, undefined);
  assert.equal(f.state.writes.filter((value) => value === "pull").length, 1);
});

test("tasks: uncertain push resolves against the remote SHA", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); f.state.timeout = "push";
  await assert.rejects(f.service.finish(task.id), (error) => error.outcomeUnknown);
  assert.equal(f.service.list(f.repo).tasks[0].pendingAction.action, "push");
  assert.equal((await f.service.refresh(task.id)).task.pendingAction, undefined);
  f.state.timeout = null;
  assert.equal((await f.service.finish(task.id)).task.state, "review");
});

test("tasks: cleanup uses merged PR head for squash, preserves sessions, and blocks future execution", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create(); f.change(task.cwd);
  await f.service.finish(task.id);
  const raw = f.state.pulls[0]; raw.merged = true; raw.state = "closed";
  // The merged SHA need not be an ancestor after squash; GitHub metadata identifies the reviewed head.
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--squash", task.branch); f.git(f.repo, "commit", "-qm", "squashed PR");
  f.git(f.repo, "push", "-q", "origin", "develop");
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned"); assert.equal(fs.existsSync(task.cwd), false);
  assert.ok(f.stored.has(session.id));
  assert.throws(() => f.service.assertSession(f.stored.get(session.id)), (error) => error.reason === "task-completed");
});

test("tasks: cleanup refuses dirty files and extra commits created after merge", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.change(task.cwd, "untracked.txt");
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "task-dirty");
  f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "after merge");
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "task-unmerged-commits");
  assert.ok(fs.existsSync(task.cwd));
});

test("tasks: hotfix cleanup waits for propagation from main to develop", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("hotfix"); f.change(task.cwd); await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "merge", "--no-edit", task.branch); f.git(f.repo, "push", "-q", "origin", "main");
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "gitflow-develop-pending");
  f.git(f.repo, "switch", "-q", "develop"); f.git(f.repo, "merge", "--no-edit", "main"); f.git(f.repo, "push", "-q", "origin", "develop");
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
});

test("tasks: one running session owns the task and switching the worktree branch blocks execution", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create();
  const second = await f.service.addSession(task.id, { agent: "claude" });
  f.state.running.add(second.session.id);
  assert.throws(() => f.service.assertSession(f.stored.get(session.id)), (error) => error.reason === "running");
  f.state.running.clear(); f.git(task.cwd, "checkout", "--detach", "-q");
  assert.throws(() => f.service.assertSession(f.stored.get(session.id)), (error) => error.reason === "task-worktree");
});

test("tasks: standard GitFlow dual merges do not falsely block development or hotfix cleanup", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("hotfix"); f.change(task.cwd); await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "merge", "--no-ff", "-m", "hotfix into main", task.branch);
  f.git(f.repo, "push", "-q", "origin", "main");
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--no-ff", "-m", "hotfix into develop", task.branch);
  f.git(f.repo, "push", "-q", "origin", "develop");
  assert.notEqual(f.git(f.repo, "rev-parse", "main"), f.git(f.repo, "rev-parse", "develop"));
  const context = await f.service.context(f.repo);
  assert.equal(context.mainMissing, false); assert.equal(context.state, "current");
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
  assert.equal((await f.create()).task.baseBranch, "develop");
});

test("tasks: explicit refresh permits a safe retry when an uncertain write never reached GitHub", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd);
  const file = path.join(path.dirname(path.dirname(task.cwd)), "data", "tasks", `${task.id}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.pendingAction = { action: "pull", expectedHead: f.git(task.cwd, "rev-parse", "HEAD"), startedAt: new Date().toISOString(), outcomeUnknown: true };
  fs.writeFileSync(file, JSON.stringify(stored));
  f.restart();
  const refreshed = await f.service.refresh(task.id);
  assert.equal(refreshed.task.pendingAction, undefined);
  assert.equal(refreshed.task.lastRecovery.result, "not-observed");
  assert.equal(f.state.writes.length, 0);
  assert.equal((await f.service.finish(task.id)).task.state, "review");
});

test("tasks: invalid finish input and existing Git operations cause no external writes", async (t) => {
  const f = fixture(t, { develop: false });
  const { task } = await f.create(); f.change(task.cwd);
  await assert.rejects(f.service.finish(task.id, { message: " " }), (error) => error.status === 400);
  assert.equal(f.state.writes.length, 0);
  const marker = f.git(task.cwd, "rev-parse", "--git-path", "MERGE_HEAD");
  fs.writeFileSync(path.resolve(task.cwd, marker), f.git(task.cwd, "rev-parse", "HEAD") + "\n");
  await assert.rejects(f.service.sync(task.id), (error) => error.reason === "task-git-operation");
  await assert.rejects(f.service.finish(task.id), (error) => error.reason === "task-git-operation");
  assert.equal(fs.existsSync(path.resolve(task.cwd, marker)), true);
  assert.equal(f.state.writes.length, 0);
});

test("tasks: a failed worktree hook preserves provisioning records and session creation recovers the branch", async (t) => {
  const f = fixture(t);
  const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(f.create());
  const [task] = f.service.list(f.repo).tasks;
  assert.ok(task); assert.equal(task.provisioning, true);
  assert.equal(f.git(f.repo, "rev-parse", `refs/heads/${task.branch}`), task.baseCommit);
  fs.unlinkSync(hook);
  // Recover even if only the created branch remains after the original operation.
  if (fs.existsSync(task.cwd)) f.git(f.repo, "worktree", "remove", task.cwd);
  f.restart();
  const recovered = await f.service.addSession(task.id, { agent: "codex" });
  assert.equal(recovered.task.provisioning, undefined);
  assert.equal(recovered.task.sessionIds.length, 1);
  assert.equal(recovered.session.cwd, task.cwd);
  assert.equal(f.git(task.cwd, "branch", "--show-current"), task.branch);
});

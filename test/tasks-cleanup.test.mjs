import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../test-support/tasks-fixture.mjs";

test("tasks: an existing workbranch preserves its shared folder and branch after task cleanup", async (t) => {
  const f = fixture(t);
  const branch = "agenthub/borrowed";
  const cwd = path.join(path.dirname(f.repo), "borrowed-work");
  f.git(f.repo, "worktree", "add", "-b", branch, cwd, "develop");
  const legacy = { id: "legacy", title: "Legacy session", projectPath: f.repo, cwd, worktree: { dir: cwd, branch }, state: "idle", events: [] };
  f.stored.set(legacy.id, legacy);
  f.change(cwd, "pending.txt", "keep existing changes\n");
  const { task } = await f.create("feature", { workBranch: branch });
  assert.equal(path.resolve(task.cwd), path.resolve(cwd));
  assert.equal(task.ownsWorktree, false);
  assert.equal(task.ownsBranch, false);
  assert.equal(legacy.taskId, task.id);
  assert.ok(task.sessionIds.includes(legacy.id));
  assert.equal(fs.readFileSync(path.join(cwd, "pending.txt"), "utf8"), "keep existing changes\n");
  await assert.rejects(f.create("feature", { workBranch: branch }), (error) => error.reason === "task-branch-exists");
  await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--no-edit", branch); f.git(f.repo, "push", "-q", "origin", "develop");
  const result = await f.service.cleanup(task.id);
  assert.equal(result.task.state, "cleaned");
  assert.equal(result.task.worktreePreserved, true);
  assert.equal(result.task.localBranchRemoved, false);
  assert.equal(fs.existsSync(cwd), true);
  assert.ok(f.git(f.repo, "rev-parse", `refs/heads/${branch}`));
});

test("tasks: choosing an unchecked-out branch only cleans the new folder, preserving the branch", async (t) => {
  const f = fixture(t);
  const branch = "feature/existing";
  f.git(f.repo, "branch", branch, "develop");
  const { task } = await f.create("feature", { workBranch: branch });
  assert.equal(task.branch, branch);
  assert.equal(task.ownsWorktree, true);
  assert.equal(task.ownsBranch, false);
  f.change(task.cwd); await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--no-edit", branch); f.git(f.repo, "push", "-q", "origin", "develop");
  await f.service.cleanup(task.id);
  assert.equal(fs.existsSync(task.cwd), false);
  assert.ok(f.git(f.repo, "rev-parse", `refs/heads/${branch}`));
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

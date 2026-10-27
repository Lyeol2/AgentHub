import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTaskService } from "../server/application/tasks.mjs";
import { DEFAULT_GITFLOW_SETTINGS } from "../server/gitflow-settings.mjs";
import { fixture } from "../test-support/tasks-fixture.mjs";

test("task review: behind PR creation, updates and merge preserve the source head", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  f.commit(task.cwd, "mine.txt");
  f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo, "base-update.txt"); f.git(f.repo, "push", "-q", "origin", "develop");
  const target = f.git(f.repo, "rev-parse", "develop");
  let reviewed = await f.service.review(task.id);
  assert.equal(reviewed.task.freshness.behind, true);
  await f.service.finish(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token });
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
  assert.equal(f.git(f.repo, "rev-parse", "develop"), target);
  f.commit(task.cwd, "more.txt");
  reviewed = await f.service.review(task.id);
  await f.service.finish(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, verification: "tested" });
  assert.equal(f.state.pulls.length, 1);
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
  reviewed = await f.service.review(task.id);
  await f.service.mergePull(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, expectedPullHead: reviewed.head, method: "merge" });
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
  assert.equal(fs.existsSync(path.join(task.cwd, "base-update.txt")), false);
  assert.equal(f.service.get(task.id).state, "merged");
});

test("task review: PR publishing allows missing main changes and conflicts without integrating them", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  f.change(task.cwd, "base.txt", "feature\n"); f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "feature");
  f.commit(f.repo, "main-only.txt"); f.git(f.repo, "push", "-q", "origin", "main");
  f.git(f.repo, "switch", "-q", "develop"); f.change(f.repo, "base.txt", "develop\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "develop"); f.git(f.repo, "push", "-q", "origin", "develop");
  const reviewed = await f.service.review(task.id);
  assert.equal(reviewed.task.freshness.mainMissing, true);
  await f.service.finish(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token });
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
  assert.equal(f.git(task.cwd, "show", "HEAD:base.txt"), "feature");
  assert.equal(f.service.get(task.id).state, "review");
});

test("task review: selected commit preserves other staged files and rejects stale previews", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  f.change(task.cwd, "chosen.txt", "chosen\n"); f.change(task.cwd, "staged.txt", "keep staged\n");
  f.git(task.cwd, "add", "staged.txt");
  const reviewed = await f.service.review(task.id);
  f.change(task.cwd, "chosen.txt", "edited after review\n");
  await assert.rejects(f.service.commitReview(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, files: ["chosen.txt"], message: "choose" }), error => error.reason === "task-stale-review");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
  const current = await f.service.review(task.id);
  await f.service.commitReview(task.id, { expectedHead: current.head, reviewToken: current.token, files: ["chosen.txt"], message: "choose" });
  assert.equal(f.git(task.cwd, "show", "HEAD:chosen.txt"), "edited after review");
  assert.equal(f.git(task.cwd, "diff", "--cached", "--name-only"), "staged.txt");
  assert.throws(() => f.git(task.cwd, "show", "HEAD:staged.txt"));
  const remaining = await f.service.review(task.id);
  await assert.rejects(f.service.finish(task.id, { expectedHead: remaining.head, reviewToken: remaining.token }), error => error.reason === "task-dirty");
  assert.equal(f.state.writes.length, 0);
});

test("task review: dirty and behind work can commit, integrate, review and publish in order", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo); f.git(f.repo, "push", "-q", "origin", "develop");
  f.change(task.cwd, "local.txt");
  let review = await f.service.review(task.id);
  assert.equal(review.task.freshness.behind, true);
  await f.service.commitReview(task.id, { expectedHead: review.head, reviewToken: review.token, files: ["local.txt"], message: "local" });
  review = await f.service.review(task.id);
  const synced = await f.service.sync(task.id, { expectedHead: review.head, reviewToken: review.token });
  assert.equal(synced.task.verification, '');
  const stale = review; review = await f.service.review(task.id);
  assert.equal(review.clean, true); assert.equal(review.task.freshness.behind, false);
  await assert.rejects(f.service.finish(task.id, { expectedHead: stale.head, reviewToken: stale.token }), error => error.reason === "task-stale-review");
  const result = await f.service.finish(task.id, { expectedHead: review.head, reviewToken: review.token, message: "", verification: "반영 후 확인" });
  assert.equal(result.task.state, "review"); assert.match(result.pull.body, /반영 후 확인/);
});

test("task review: local finish reuses clean target worktree, pushes normally, and cleans only task folder", async (t) => {
  const f = fixture(t);
  await f.service.updateSettings(f.repo, { settings: DEFAULT_GITFLOW_SETTINGS, finishMode: "local" });
  const { task } = await f.create();
  assert.equal(task.finishMode, "local");
  f.commit(task.cwd, "completed.txt");
  const reviewed = await f.service.review(task.id);
  const result = await f.service.finish(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead, push: true });
  assert.equal(result.task.state, "merged"); assert.equal(result.task.completion.publishState, "done");
  assert.equal(f.git(f.repo, "ls-remote", "origin", "refs/heads/develop").split(/\s+/)[0], result.task.completion.targetHead);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
  assert.equal(f.state.writes.length, 0, "local flow never needs GitHub APIs");
  assert.equal((await f.service.refresh(task.id)).task.state, "merged");
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned"); assert.equal(fs.existsSync(task.cwd), false);
  assert.equal(fs.existsSync(result.task.completion.cwd), false, "병합에 쓴 임시 대상 폴더는 남기지 않는다");
  assert.equal((await f.restart().settings(f.repo)).finishMode, "local");
});

test("task review: local finish rejects moved or dirty targets without changing source", async (t) => {
  const f = fixture(t); const { task } = await f.create(); f.commit(task.cwd, "completed.txt");
  const before = await f.service.review(task.id);
  f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo, "target.txt");
  await assert.rejects(f.service.finish(task.id, { mode: "local", expectedHead: before.head, reviewToken: before.token, expectedTargetHead: before.localTargetHead }), error => error.reason === "task-stale-review");
  await f.service.sync(task.id, { mode: "local" });
  const reviewed = await f.service.review(task.id); f.change(f.repo, "dirty.txt");
  await assert.rejects(f.service.finish(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead }), error => error.reason === "git-target-dirty");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
  assert.equal(f.service.get(task.id).state, "working");
});

test("task review: existing PR description updates and merge pins reviewed head", async (t) => {
  const f = fixture(t); const { task } = await f.create(); f.change(task.cwd);
  await f.service.finish(task.id, { description: "첫 설명" });
  const updated = await f.service.finish(task.id, { description: "수정 설명", verification: "검증 완료" });
  assert.match(updated.pull.body, /수정 설명/); assert.equal(f.state.pulls.length, 1);
  const reviewed = await f.service.review(task.id);
  await assert.rejects(f.service.mergePull(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, expectedPullHead: "0".repeat(40) }), error => error.reason === "task-stale-head");
  const merged = await f.service.mergePull(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, expectedPullHead: reviewed.head, method: "merge" });
  assert.equal(merged.task.state, "merged");
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
});

test("task review: local integration blocks running ordinary sessions in source or target subfolders", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "switch", "-q", "develop");
  fs.mkdirSync(path.join(f.repo, "nested"));
  f.commit(f.repo, "nested/keep.txt");
  f.git(f.repo, "push", "-q", "origin", "develop");
  const { task } = await f.create();
  f.commit(task.cwd, "completed.txt");
  const reviewed = await f.service.review(task.id);
  const body = { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead };
  for (const cwd of [path.join(f.repo, "nested"), path.join(task.cwd, "nested")]) {
    f.stored.set("nested-worker", { id: "nested-worker", projectPath: cwd, cwd, state: "running", events: [] });
    f.state.running.add("nested-worker");
    await assert.rejects(f.service.finish(task.id, body), error => error.reason === "git-session-running" || error.reason === "running");
    assert.equal(f.git(f.repo, "rev-parse", "develop"), reviewed.localTargetHead);
    assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
    assert.equal(f.service.get(task.id).state, "working");
  }
  assert.equal(f.state.writes.length, 0);
});

test("task review: commit and sync persist a newly selected local integration mode", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  assert.equal(task.finishMode, "pr");
  f.change(task.cwd, "chosen.txt");
  let reviewed = await f.service.review(task.id);
  const committed = await f.service.commitReview(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, files: ["chosen.txt"], message: "chosen" });
  assert.equal(committed.task.finishMode, "local");
  assert.equal(f.restart().get(task.id).finishMode, "local");

  const file = path.join(f.dataDir, "tasks", `${task.id}.json`);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.finishMode = "pr";
  fs.writeFileSync(file, JSON.stringify(persisted));
  f.restart();
  reviewed = await f.service.review(task.id);
  const synced = await f.service.sync(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token });
  assert.equal(synced.task.finishMode, "local");
  assert.equal(f.restart().get(task.id).finishMode, "local");
});

test("task review: uncertain local commit can be confirmed without GitHub access", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  const before = f.git(task.cwd, "rev-parse", "HEAD");
  f.commit(task.cwd, "committed-before-disconnect.txt");
  const after = f.git(task.cwd, "rev-parse", "HEAD");
  const file = path.join(f.dataDir, "tasks", `${task.id}.json`);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.pendingAction = { action: "commit", expectedHead: before, outcomeUnknown: true, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(persisted));
  let githubCalls = 0;
  const recovering = createTaskService({ dataDir: f.dataDir,
    store: { list: () => [...f.stored.values()], get: id => f.stored.get(id) },
    runner: { isRunning: id => f.state.running.has(id) },
    github: { async target() { githubCalls++; throw Error("GitHub is unavailable"); } },
  });
  const recovered = await recovering.refresh(task.id);
  assert.equal(githubCalls, 0);
  assert.equal(recovered.task.pendingAction, undefined);
  assert.equal(recovered.task.lastRecovery.result, "confirmed");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), after);
  assert.equal(f.restart().get(task.id).pendingAction, undefined);
});

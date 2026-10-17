import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { taskBranchSlug } from "../server/tasks.mjs";
import { fixture } from "../test-support/tasks-fixture.mjs";

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

test("tasks: 단계 표시용 상태는 변경·커밋·게시를 차례로 반영하고 작업 기록을 바꾸지 않는다", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create();
  let status = await f.service.status(task.id);
  assert.deepEqual({ dirty: status.dirty, commits: status.commits, pushed: status.pushed, sessions: status.sessions, running: status.running, folder: status.folder },
    { dirty: 0, commits: 0, pushed: false, sessions: 1, running: 0, folder: true });
  f.change(task.cwd, "a.txt"); f.change(task.cwd, "b.txt");
  f.state.running.add(session.id);
  status = await f.service.status(task.id);
  assert.equal(status.dirty, 2); assert.equal(status.running, 1);
  f.state.running.clear();
  f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "work");
  status = await f.service.status(task.id);
  assert.equal(status.dirty, 0); assert.equal(status.commits, 1); assert.equal(status.pushed, false);
  assert.equal(status.shortHead, status.head.slice(0, 7));
  const before = JSON.stringify(f.service.get(task.id));
  const review = await f.service.review(task.id);
  await f.service.finish(task.id, { expectedHead: review.head, reviewToken: review.token, message: "" });
  status = await f.service.status(task.id);
  assert.equal(status.state, "review"); assert.equal(status.pushed, true); assert.equal(status.commits, 1);
  assert.notEqual(before, JSON.stringify(f.service.get(task.id)));
  const stable = JSON.stringify(f.service.get(task.id));
  await f.service.status(task.id);
  assert.equal(JSON.stringify(f.service.get(task.id)), stable);
});

test("tasks: 유형별 분기 기준과 PR 대상이 GitFlow 설정과 같다", async (t) => {
  const f = fixture(t);
  const feature = (await f.create("feature")).task;
  const hotfix = (await f.create("hotfix", { title: "긴급" })).task;
  const release = (await f.create("release", { title: "배포", version: "1.2.0" })).task;
  assert.deepEqual([feature.baseBranch, feature.targetBranch, feature.branch.startsWith("feature/")], ["develop", "develop", true]);
  assert.deepEqual([hotfix.baseBranch, hotfix.targetBranch, hotfix.branch.startsWith("hotfix/")], ["main", "main", true]);
  assert.deepEqual([release.baseBranch, release.targetBranch, release.branch], ["develop", "main", "release/1.2.0"]);
});

test("tasks: 기준 반영 충돌은 원문 대신 한국어 설명과 해결 방법을 남긴다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.git(f.repo, "switch", "-q", "develop"); f.change(f.repo, "same.txt", "develop\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "develop");
  f.git(f.repo, "push", "-q", "origin", "develop");
  f.change(task.cwd, "same.txt", "task\n"); f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "task");
  await assert.rejects(f.service.sync(task.id), (error) => {
    assert.equal(error.reason, "task-conflict");
    assert.doesNotMatch(error.message, /CONFLICT|Automatic merge/);
    assert.match(error.hint, /충돌/);
    assert.match(error.raw, /CONFLICT/);
    return true;
  });
  const stored = f.service.get(task.id);
  assert.equal(stored.errorReason, "task-conflict"); assert.match(stored.errorHint, /충돌/);
});

test("task branch slug: 제목을 소문자 단어로 이어 40자 안의 단어 경계에서 자른다", () => {
  assert.equal(taskBranchSlug("Fix: Login 버튼이 모바일에서 안 눌림!!"), "fix-login-버튼이-모바일에서-안-눌림");
  assert.equal(taskBranchSlug("  ..  "), "work");
  assert.equal(taskBranchSlug("ＡＢＣ　테스트"), "abc-테스트", "전각 문자는 NFKC로 바꾼다");
  const long = taskBranchSlug("alpha bravo charlie delta echo foxtrot golf hotel");
  assert.ok(long.length <= 40 && !long.endsWith("-") && "alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel".startsWith(long), long);
  assert.equal(taskBranchSlug("a".repeat(60)).length, 40, "한 단어가 길면 그 단어를 자른다");
});

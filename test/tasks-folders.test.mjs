import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_GITFLOW_SETTINGS } from "../server/gitflow-settings.mjs";
import { fixture, mergePullOnRemote } from "../test-support/tasks-fixture.mjs";

test("tasks: 작업 폴더가 이미 사라졌어도 정리는 남은 Git 기록과 브랜치를 지우고 끝낸다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); await f.service.finish(task.id);
  mergePullOnRemote(f, task);
  fs.rmSync(task.cwd, { recursive: true, force: true });
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned");
  assert.equal(cleaned.task.localBranchRemoved, true);
  assert.ok(!f.git(f.repo, "branch", "--list", task.branch));
  assert.doesNotMatch(f.git(f.repo, "worktree", "list", "--porcelain"), new RegExp(path.basename(task.cwd)));
});

test("tasks: PR 병합 뒤 기준 반영으로 생긴 병합 커밋만 있으면 정리를 막지 않는다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); await f.service.finish(task.id);
  mergePullOnRemote(f, task);
  f.commit(f.repo, "after-merge.txt"); f.git(f.repo, "push", "-q", "origin", "develop");
  await f.service.sync(task.id);
  assert.notEqual(f.git(task.cwd, "rev-parse", "HEAD"), f.state.pulls[0].head.sha, "기준 반영으로 병합 커밋이 생겼다");
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned"); assert.equal(fs.existsSync(task.cwd), false);
});

test("tasks: 병합 뒤 실제 내용이 있는 커밋이 남으면 정리를 막고 그 커밋을 알려 준다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); await f.service.finish(task.id);
  mergePullOnRemote(f, task);
  f.change(task.cwd, "late.txt"); f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "late change");
  await assert.rejects(f.service.cleanup(task.id), (error) => {
    assert.equal(error.reason, "task-unmerged-commits");
    assert.match(error.hint, /late change/);
    return true;
  });
  assert.ok(fs.existsSync(task.cwd));
});

test("tasks: 로컬 반영에 쓴 임시 대상 작업 폴더는 병합 뒤 지워 대상 브랜치를 점유하지 않는다", async (t) => {
  const f = fixture(t);
  await f.service.updateSettings(f.repo, { settings: DEFAULT_GITFLOW_SETTINGS, finishMode: "local" });
  const { task } = await f.create();
  f.commit(task.cwd, "completed.txt");
  const reviewed = await f.service.review(task.id);
  const result = await f.service.finish(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead });
  assert.equal(result.task.state, "merged");
  assert.equal(result.merge.temporaryWorktreeRemoved, true);
  assert.equal(fs.existsSync(result.task.completion.cwd), false);
  assert.doesNotMatch(f.git(f.repo, "worktree", "list", "--porcelain"), /branch refs\/heads\/develop/);
  // 원본 폴더에서 대상 브랜치로 바로 전환할 수 있다.
  f.git(f.repo, "switch", "-q", "develop");
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), result.task.completion.targetHead);
});

test("tasks: 반쯤 지워져 Git 작업 폴더가 아니게 된 폴더도 작업 삭제로 지울 수 있다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("feature", { session: false });
  fs.rmSync(path.join(task.cwd, ".git"), { force: true });
  // 변경 여부를 알 수 없으므로 먼저 확인을 받고, 강제 삭제를 고르면 지운다.
  await assert.rejects(f.service.remove(task.id), (error) => error.reason === "task-dirty");
  assert.ok(fs.existsSync(task.cwd));
  const result = await f.service.remove(task.id, { force: true });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(task.cwd), false);
  assert.doesNotMatch(f.git(f.repo, "worktree", "list", "--porcelain"), new RegExp(path.basename(task.cwd)));
});

test("tasks: 프로젝트 폴더와 작업 폴더가 모두 사라져도 남은 작업은 삭제할 수 있다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("feature", { session: false });
  fs.rmSync(task.cwd, { recursive: true, force: true });
  fs.rmSync(f.repo, { recursive: true, force: true });
  const result = await f.service.remove(task.id, { deleteBranch: true });
  assert.equal(result.ok, true);
  assert.equal(f.service.list().tasks.some((item) => item.id === task.id), false);
});

test("tasks: 원본 폴더에서 한 작업을 지우면 브랜치를 남겨도 원본 폴더는 작업 전 브랜치로 돌아간다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("feature", { worktree: false, session: false });
  assert.equal(task.inPlace, true);
  assert.equal(f.git(f.repo, "branch", "--show-current"), task.branch);
  await f.service.remove(task.id, { deleteBranch: false });
  assert.notEqual(f.git(f.repo, "branch", "--show-current"), task.branch);
  assert.ok(f.git(f.repo, "branch", "--list", task.branch), "브랜치는 남긴다");
});

test("tasks: 중간에 멈춘 병합은 작업을 막지만 취소하면 실행 전 상태로 돌아와 다시 진행할 수 있다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.git(f.repo, "switch", "-q", "develop"); f.change(f.repo, "same.txt", "develop\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "develop");
  f.change(task.cwd, "same.txt", "task\n"); f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "task");
  const before = f.git(task.cwd, "rev-parse", "HEAD");
  assert.throws(() => f.git(task.cwd, "merge", "--no-edit", "develop"));
  await assert.rejects(f.service.sync(task.id), (error) => error.reason === "task-git-operation");
  const result = await f.service.abortOperation(task.id);
  assert.equal(result.aborted, "merge");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), before);
  assert.equal(f.git(task.cwd, "status", "--porcelain"), "");
  await assert.rejects(f.service.abortOperation(task.id), (error) => error.reason === "task-git-idle");
});

test("tasks: 기준 반영 충돌은 충돌 파일 목록을 함께 알려 준다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.git(f.repo, "switch", "-q", "develop"); f.change(f.repo, "same.txt", "develop\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "develop");
  f.git(f.repo, "push", "-q", "origin", "develop");
  f.change(task.cwd, "same.txt", "task\n"); f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "task");
  await assert.rejects(f.service.sync(task.id), (error) => {
    assert.equal(error.reason, "task-conflict");
    assert.deepEqual(error.conflicts, ["same.txt"]);
    assert.match(error.message, /충돌 파일: same\.txt/);
    return true;
  });
});

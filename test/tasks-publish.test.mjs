import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../test-support/tasks-fixture.mjs";

// 작업 반영(최신화·푸시·PR) 흐름에서 버튼으로 풀 수 있는 상태와 안내를 확인한다.

test("작업 반영: 원격 작업 브랜치의 새 커밋은 기준 반영이 먼저 합친다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.commit(task.cwd, "mine.txt");
  // 다른 컴퓨터에서 같은 작업 브랜치에 올린 커밋
  const other = path.join(path.dirname(f.repo), "other");
  f.git(path.dirname(f.repo), "clone", "-q", f.remote, other);
  f.git(other, "config", "user.name", "o"); f.git(other, "config", "user.email", "o@o"); f.git(other, "config", "commit.gpgsign", "false");
  f.git(other, "switch", "-q", "-c", task.branch, "origin/develop"); f.commit(other, "theirs.txt"); f.git(other, "push", "-q", "origin", task.branch);
  await f.service.refresh(task.id);
  const status = await f.service.status(task.id);
  assert.equal(status.remoteAhead, true);
  await f.service.sync(task.id);
  assert.ok(fs.existsSync(path.join(task.cwd, "theirs.txt")), "원격 작업 브랜치의 커밋을 합친다");
  assert.ok(fs.existsSync(path.join(task.cwd, "mine.txt")));
  assert.equal((await f.service.status(task.id)).remoteAhead, false);
  const done = await f.service.finish(task.id);
  assert.equal(done.task.state, "review");
});

test("작업 반영: 푸시 직후 기준이 움직여도 작업 브랜치에 합치지 않고 PR을 만든다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.change(task.cwd);
  // 푸시 순간에 다른 사람이 develop을 올린 것처럼 만든다.
  f.state.afterPush = () => { f.state.afterPush = null; f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo, "dev.txt"); f.git(f.repo, "push", "-q", "origin", "develop"); f.git(f.repo, "switch", "-q", "main"); };
  await f.service.finish(task.id);
  const saved = f.service.get(task.id);
  const head = f.git(task.cwd, "rev-parse", "HEAD");
  assert.equal(f.git(f.repo, "ls-remote", f.remote, `refs/heads/${task.branch}`).split(/\s+/)[0], head);
  assert.equal(saved.publishedHead, head); assert.equal(saved.state, "review");
  assert.equal(saved.freshness.behind, true);
  assert.equal(f.state.writes.includes("pull"), true);
  assert.equal(fs.existsSync(path.join(task.cwd, "dev.txt")), false);
});

test("작업 반영: 카드 상태는 푸시 안 된 커밋 수와 지금 HEAD 기준 최신 여부를 알려 준다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.commit(task.cwd, "a.txt"); f.commit(task.cwd, "b.txt");
  let status = await f.service.status(task.id);
  assert.equal(status.unpushed, 2);
  assert.equal(status.freshness.state, "current");
  // develop이 앞서면 최신 확인 뒤 반영 필요, 세션이 직접 develop을 병합하면 다시 확인하지 않아도 최신이다.
  f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo, "dev.txt"); f.git(f.repo, "push", "-q", "origin", "develop"); f.git(f.repo, "switch", "-q", "main");
  await f.service.refresh(task.id);
  status = await f.service.status(task.id);
  assert.equal(status.behind, true); assert.equal(status.freshness.state, "needs-update");
  f.git(task.cwd, "fetch", "-q", "origin"); f.git(task.cwd, "merge", "-q", "--no-edit", "origin/develop");
  status = await f.service.status(task.id);
  assert.equal(status.behind, false); assert.equal(status.freshness.state, "current");
  assert.equal(status.freshness.stale, true, "HEAD가 바뀌면 다시 확인할 대상이다");
  const rechecked = await f.service.recheck(task.id);
  assert.equal(rechecked.checked, true); assert.equal(rechecked.task.freshness.state, "current");
  assert.equal((await f.service.status(task.id)).freshness.stale, false);
});

test("작업 반영: 원격에 백업은 작업 브랜치만 푸시하고 대상 브랜치와 PR은 건드리지 않는다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.commit(task.cwd, "a.txt");
  const develop = f.git(f.repo, "ls-remote", f.remote, "refs/heads/develop");
  const { task: saved } = await f.service.backup(task.id);
  const head = f.git(task.cwd, "rev-parse", "HEAD");
  assert.equal(f.git(f.repo, "ls-remote", f.remote, `refs/heads/${task.branch}`).split(/\s+/)[0], head);
  assert.equal(f.git(f.repo, "ls-remote", f.remote, "refs/heads/develop"), develop);
  assert.equal(saved.publishedHead, head); assert.equal(saved.state, "working"); assert.equal(saved.pull, null);
  assert.equal(f.state.writes.length, 0, "GitHub에 PR을 만들지 않는다");
  assert.equal((await f.service.status(task.id)).unpushed, 0);
  // 원격이 앞서 있으면 덮지 않고 원격 변경 합치기를 안내한다.
  f.git(f.repo, "switch", "-q", "-c", "elsewhere", head); f.commit(f.repo, "elsewhere.txt");
  f.git(f.repo, "push", "-q", f.remote, `elsewhere:refs/heads/${task.branch}`); f.git(f.repo, "switch", "-q", "main");
  f.commit(task.cwd, "b.txt");
  await assert.rejects(f.service.backup(task.id), (error) => error.reason === "git-push-rejected" && /업데이트 프롬 develop/.test(error.hint));
});

test("작업 반영: 원본 폴더가 작업 브랜치를 벗어나면 그 폴더의 Git 동작을 막지 않고 정리는 기록만 정리로 안내한다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("feature", { worktree: false, session: false });
  await assert.rejects(f.service.assertGitOperation(f.repo, "checkout"), (error) => error.reason === "task-worktree");
  f.git(f.repo, "switch", "-q", "main");
  await f.service.assertGitOperation(f.repo, "checkout");
  let status = await f.service.status(task.id);
  assert.equal(status.offBranch, true); assert.equal(status.currentBranch, "main"); assert.equal(status.branchMissing, false);
  f.git(f.repo, "branch", "-D", task.branch);
  status = await f.service.status(task.id);
  assert.equal(status.branchMissing, true);
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "task-record-only" && /기록만 정리/.test(error.hint));
  assert.equal((await f.service.remove(task.id)).ok, true);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
});

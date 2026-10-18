import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, mergePullOnRemote } from "../test-support/tasks-fixture.mjs";

const listed = async (f, cwd) => (await f.service.workbranches(f.repo)).worktrees.find((item) => item.cwd === path.resolve(cwd));

async function mergedTask(f) {
  const { task } = await f.create("feature", { session: false });
  f.change(task.cwd); await f.service.finish(task.id);
  mergePullOnRemote(f, task);
  const refreshed = await f.service.refresh(task.id);
  assert.equal(refreshed.task.state, "merged");
  return refreshed.task;
}

test("tasks: 병합한 작업의 워크트리를 골라 그 폴더에서 새 작업 브랜치로 시작하고, 두 작업을 정리해도 폴더는 남는다", async (t) => {
  const f = fixture(t);
  const first = await mergedTask(f);
  const item = await listed(f, first.cwd);
  assert.equal(item.selectableForTask, true);
  assert.equal(item.taskId, first.id);

  const { task } = await f.create("feature", { session: false, title: "다음 작업", worktreePath: first.cwd });
  assert.equal(task.cwd, first.cwd);
  assert.equal(task.reusedWorktree, true);
  assert.equal(task.ownsWorktree, false);
  assert.equal(task.previousBranch, null, "병합한 작업의 브랜치로는 되돌아가지 않는다");
  assert.equal(f.git(task.cwd, "branch", "--show-current"), task.branch);
  const handed = f.service.get(first.id);
  assert.equal(handed.folderHandedTo, task.id);
  assert.equal(handed.ownsWorktree, false);
  assert.equal((await listed(f, first.cwd)).selectableForTask, false, "새 작업이 쓰는 동안은 다시 고를 수 없다");

  // 폴더를 넘긴 작업은 남은 브랜치만 정리하고 폴더는 건드리지 않는다.
  const cleaned = await f.service.cleanup(first.id);
  assert.equal(cleaned.task.state, "cleaned");
  assert.ok(!f.git(f.repo, "branch", "--list", first.branch));
  assert.ok(fs.existsSync(task.cwd));
  assert.equal(f.git(task.cwd, "branch", "--show-current"), task.branch);

  const removed = await f.service.remove(task.id, { deleteBranch: true });
  assert.equal(removed.worktreeRemoved, false);
  assert.ok(fs.existsSync(task.cwd), "이어받은 워크트리는 지우지 않는다");
  assert.equal(f.git(task.cwd, "branch", "--show-current"), "", "대상 브랜치를 차지하지 않도록 커밋에 그대로 둔다");
  assert.ok(!f.git(f.repo, "branch", "--list", task.branch));
  assert.equal((await listed(f, task.cwd)).selectableForTask, true, "다음 작업이 다시 고를 수 있다");
});

test("tasks: 이어받은 워크트리에서 한 작업은 정리할 때 작업 전 브랜치로 되돌리고 폴더를 남긴다", async (t) => {
  const f = fixture(t);
  const dir = `${f.repo}.agenthub/manual`;
  f.git(f.repo, "worktree", "add", "-q", "-b", "feature/manual", dir, "develop");
  const { task } = await f.create("feature", { worktreePath: dir });
  assert.equal(task.previousBranch, "feature/manual");
  f.change(task.cwd); await f.service.finish(task.id);
  mergePullOnRemote(f, task);
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned");
  assert.ok(fs.existsSync(dir));
  assert.equal(f.git(dir, "branch", "--show-current"), "feature/manual");
  assert.ok(!f.git(f.repo, "branch", "--list", task.branch));
});

test("tasks: 진행 중인 작업이나 커밋하지 않은 변경이 있는 워크트리는 고를 수 없다", async (t) => {
  const f = fixture(t);
  const { task: active } = await f.create("feature", { session: false });
  const item = await listed(f, active.cwd);
  assert.equal(item.selectableForTask, false);
  assert.match(item.reason, /작업에서 쓰는 중/);
  await assert.rejects(f.create("feature", { session: false, title: "겹침", worktreePath: active.cwd }), { status: 409 });

  const dir = `${f.repo}.agenthub/dirty`;
  f.git(f.repo, "worktree", "add", "-q", "-b", "feature/dirty", dir, "develop");
  f.change(dir, "dirty.txt");
  assert.equal((await listed(f, dir)).selectableForTask, false);
  await assert.rejects(f.create("feature", { session: false, title: "변경 있음", worktreePath: dir }), { status: 409 });
  assert.equal(f.git(dir, "branch", "--show-current"), "feature/dirty");
});

test("tasks: 기존 워크트리 선택은 원본 폴더·기존 브랜치·작업 폴더 이름과 함께 쓸 수 없고 원본 폴더는 고를 수 없다", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.create("feature", { worktreePath: f.repo, worktree: false }), { status: 400 });
  await assert.rejects(f.create("feature", { worktreePath: f.repo, worktreeName: "x" }), { status: 400 });
  await assert.rejects(f.create("feature", { worktreePath: f.repo, session: false }), { status: 409 });
  assert.equal((await f.service.workbranches(f.repo)).worktrees.some((item) => item.original), false);
});

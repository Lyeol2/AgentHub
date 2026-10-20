import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../test-support/tasks-fixture.mjs";

test("tasks: 원본 폴더에서 작업을 여러 개 만들면 폴더가 있는 브랜치의 작업만 진행하고 나머지는 전환을 기다린다", async (t) => {
  const f = fixture(t);
  const first = await f.create("feature", { worktree: false, title: "첫 작업" });
  f.commit(f.repo, "first.txt");
  const second = await f.create("feature", { worktree: false, title: "둘째 작업" });
  assert.equal(f.git(f.repo, "branch", "--show-current"), second.task.branch);
  // 다른 작업의 브랜치로는 정리할 때 되돌아가지 않도록 첫 작업이 돌아갈 브랜치를 이어받는다.
  assert.equal(second.task.previousBranch, "main");
  assert.equal(f.service.get(first.task.id).state, "working");

  // 대기 중인 작업의 세션은 실행하지 못하고, 진행 중인 작업의 세션은 실행한다.
  assert.throws(() => f.service.assertSession(first.session), (error) => error.reason === "task-parked" && /둘째 작업/.test(error.message));
  f.service.assertSession(second.session);
  const parked = await f.service.status(first.task.id);
  assert.equal(parked.offBranch, true);
  assert.equal(parked.sessions, 1, "같은 원본 폴더를 쓰는 다른 작업의 세션은 세지 않는다");

  // 실행 중인 세션이나 커밋하지 않은 변경이 있으면 전환하지 않는다.
  f.state.running.add(second.session.id);
  await assert.rejects(f.service.activate(first.task.id), (error) => error.reason === "running");
  f.state.running.delete(second.session.id);
  f.change(f.repo, "wip.txt");
  await assert.rejects(f.service.activate(first.task.id), (error) => error.reason === "task-dirty" && /wip\.txt/.test(error.hint));
  assert.equal(f.git(f.repo, "branch", "--show-current"), second.task.branch);
  assert.ok(fs.existsSync(path.join(f.repo, "wip.txt")));
  fs.rmSync(path.join(f.repo, "wip.txt"));

  const switched = await f.service.activate(first.task.id);
  assert.equal(switched.task.id, first.task.id);
  assert.equal(f.git(f.repo, "branch", "--show-current"), first.task.branch);
  assert.ok(fs.existsSync(path.join(f.repo, "first.txt")), "첫 작업의 커밋이 원본 폴더에 돌아온다");
  f.service.assertSession(first.session);
  assert.throws(() => f.service.assertSession(second.session), (error) => error.reason === "task-parked");
  // 이미 진행 중인 작업을 다시 전환해도 아무것도 바꾸지 않는다.
  await f.service.activate(first.task.id);
  assert.equal(f.git(f.repo, "branch", "--show-current"), first.task.branch);
});

test("tasks: 병합한 작업과 워크트리 작업은 전환할 수 없고, 대기 작업은 마무리 대신 전환을 안내한다", async (t) => {
  const f = fixture(t);
  const isolated = await f.create("feature", { title: "워크트리 작업" });
  await assert.rejects(f.service.activate(isolated.task.id), (error) => error.reason === "task-not-in-place");
  const first = await f.create("feature", { worktree: false, title: "첫 작업" });
  await f.create("feature", { worktree: false, title: "둘째 작업" });
  f.change(f.repo);
  await assert.rejects(f.service.finish(first.task.id), (error) => error.reason === "task-branch");
  fs.rmSync(path.join(f.repo, "change.txt"));
  f.git(f.repo, "branch", "-D", first.task.branch);
  await assert.rejects(f.service.activate(first.task.id), (error) => error.reason === "task-branch-missing");
});

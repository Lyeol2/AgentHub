import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, customGitflow, mergePullOnRemote } from "../test-support/tasks-fixture.mjs";

test("tasks: 기존 브랜치를 원본에서 쓰면 ref를 새로 만들지 않고 해당 브랜치의 최신 상태를 판단한다", async (t) => {
  const f = fixture(t);
  const branch = "feature/existing";
  f.git(f.repo, "branch", branch);
  const selectedHead = f.git(f.repo, "rev-parse", branch);
  f.commit(f.repo, "new-base.txt");
  f.git(f.repo, "push", "-q", "origin", "main");
  f.git(f.repo, "switch", "-q", "develop"); f.git(f.repo, "merge", "--ff-only", "main");
  f.git(f.repo, "push", "-q", "origin", "develop"); f.git(f.repo, "switch", "-q", "main");
  const refs = f.git(f.repo, "show-ref", "--heads");
  const body = { workBranch: branch, worktree: false, requestId: "existing-in-place-1" };
  const { task, session } = await f.create("feature", body);
  assert.equal(path.resolve(task.cwd), path.resolve(f.repo));
  assert.equal(task.inPlace, true); assert.equal(task.selectedWorkBranch, true);
  assert.equal(task.ownsWorktree, false); assert.equal(task.ownsBranch, false);
  assert.equal(task.previousBranch, "main"); assert.equal(task.freshness.behind, true);
  assert.equal(task.worktreeRoot, null);
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), selectedHead);
  assert.equal(f.git(f.repo, "show-ref", "--heads"), refs);
  assert.equal(fs.existsSync(f.repo + ".agenthub"), false);
  assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  assert.equal(path.resolve(session.cwd), path.resolve(f.repo));
  f.service.assertSession(session);
  const retry = await f.create("feature", body);
  assert.equal(retry.reused, true); assert.equal(retry.task.id, task.id);
  assert.equal(f.service.list().tasks.length, 1);
  await assert.rejects(f.create("feature", { ...body, requestId: undefined }), (error) => error.reason === "task-branch-exists");
  assert.equal((await f.service.workbranches(f.repo, { inPlace: true })).branches.find((item) => item.name === branch).selectableForTask, false);
});

test("tasks: 이미 원본에서 쓰던 기존 브랜치는 작업 삭제 후에도 그대로 체크아웃한다", async (t) => {
  const f = fixture(t);
  const branch = "feature/current";
  f.git(f.repo, "switch", "-q", "-c", branch);
  const head = f.git(f.repo, "rev-parse", "HEAD");
  const { task } = await f.create("feature", { workBranch: branch, worktree: false, session: false });
  assert.equal(task.previousBranch, branch);
  const removed = await f.service.remove(task.id, { deleteBranch: true });
  assert.equal(removed.worktreeRemoved, false); assert.equal(removed.branchRemoved, false);
  assert.equal(f.git(f.repo, "branch", "--show-current"), branch);
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), head);
  assert.ok(fs.existsSync(f.repo));
});

test("tasks: 기존 브랜치를 원본에서 골라도 변경 파일·실행 세션·진행 중 Git·별도 워크트리를 보호한다", async (t) => {
  const f = fixture(t);
  const branch = "feature/protected";
  f.git(f.repo, "branch", branch);
  const create = () => f.create("feature", { workBranch: branch, worktree: false, session: false });
  f.change(f.repo, "unfinished.txt");
  await assert.rejects(create(), (error) => error.reason === "task-dirty");
  fs.rmSync(path.join(f.repo, "unfinished.txt"));
  const childDir = path.join(f.repo, "subfolder"); fs.mkdirSync(childDir);
  f.stored.set("busy", { id: "busy", cwd: childDir, events: [] }); f.state.running.add("busy");
  await assert.rejects(create(), (error) => error.reason === "running");
  f.state.running.clear(); f.stored.delete("busy");
  fs.writeFileSync(path.join(f.repo, ".git", "MERGE_HEAD"), f.git(f.repo, "rev-parse", "HEAD") + "\n");
  await assert.rejects(create(), (error) => error.reason === "task-git-operation");
  fs.rmSync(path.join(f.repo, ".git", "MERGE_HEAD"));
  const linked = path.join(path.dirname(f.repo), "linked");
  f.git(f.repo, "worktree", "add", "-q", linked, branch);
  await assert.rejects(create(), (error) => error.reason === "workbranch-unavailable");
  assert.equal(f.service.list().tasks.length, 0);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
  assert.equal(f.git(linked, "branch", "--show-current"), branch);
});

test("tasks: 이름을 바꾼 기준 브랜치는 보호하고 하위 폴더 프로젝트도 저장소 루트에서 기존 브랜치를 쓴다", async (t) => {
  const f = fixture(t, { main: "Main", developBranch: "Develop", settings: customGitflow });
  const branch = "Feature/existing", childDir = path.join(f.repo, "subfolder");
  f.git(f.repo, "branch", branch); fs.mkdirSync(childDir);
  const branches = (await f.service.workbranches(childDir, { inPlace: true })).branches;
  for (const name of ["Main", "Develop"]) {
    assert.equal(branches.find((item) => item.name === name).selectableForTask, false);
    await assert.rejects(f.create("feature", { projectPath: childDir, workBranch: name, worktree: false }), (error) => error.reason === "workbranch-protected");
  }
  const { task } = await f.create("feature", { projectPath: childDir, workBranch: branch, worktree: false, session: false });
  assert.equal(path.resolve(task.cwd), path.resolve(f.repo));
  assert.equal(task.branch, branch); assert.equal(task.targetBranch, "Develop");
  assert.equal(f.git(f.repo, "branch", "--show-current"), branch);
});

test("tasks: 기존 브랜치 전환이 실패하면 작업 기록을 남기지 않아 같은 요청을 다시 시도할 수 있다", async (t) => {
  const f = fixture(t);
  const branch = "feature/retry";
  f.git(f.repo, "branch", branch);
  const body = { workBranch: branch, worktree: false, session: false, requestId: "existing-retry-1" };
  fs.writeFileSync(path.join(f.repo, ".git", "index.lock"), "fixture lock\n");
  await assert.rejects(f.create("feature", body));
  assert.equal(f.service.list().tasks.length, 0);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
  fs.rmSync(path.join(f.repo, ".git", "index.lock"));
  const { task } = await f.create("feature", body);
  assert.equal(task.branch, branch); assert.equal(task.provisioning, undefined);
  assert.equal(f.service.list().tasks.length, 1);
});

test("tasks: 전환 뒤 hook이 실패하면 기록을 보존하고 재시도로 중복 작업을 만들지 않는다", async (t) => {
  const f = fixture(t);
  const branch = "feature/hook-failure";
  f.git(f.repo, "branch", branch);
  const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const body = { workBranch: branch, worktree: false, session: false, requestId: "existing-hook-failure-1" };
  await assert.rejects(f.create("feature", body));
  assert.equal(f.git(f.repo, "branch", "--show-current"), branch);
  const [retained] = f.service.list().tasks;
  assert.equal(retained.provisioning, true);
  fs.rmSync(hook);
  const retry = await f.create("feature", body);
  assert.equal(retry.reused, true); assert.equal(retry.task.id, retained.id);
  assert.equal(f.service.list().tasks.length, 1);
  const added = await f.service.addSession(retained.id, {});
  assert.equal(added.task.provisioning, undefined);
  f.service.assertSession(added.session);
});

test("tasks: 기존 원본 브랜치 작업은 병합 정리 후에도 폴더·브랜치·원래 체크아웃을 보존한다", async (t) => {
  const f = fixture(t);
  const branch = "feature/cleanup";
  f.git(f.repo, "switch", "-q", "-c", branch);
  const { task } = await f.create("feature", { workBranch: branch, worktree: false, session: false });
  f.change(f.repo); await f.service.finish(task.id);
  mergePullOnRemote(f, task);
  f.git(f.repo, "switch", "-q", branch);
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned"); assert.equal(cleaned.task.localBranchRemoved, false);
  assert.ok(fs.existsSync(f.repo));
  assert.equal(f.git(f.repo, "branch", "--show-current"), branch);
  assert.ok(f.git(f.repo, "rev-parse", `refs/heads/${branch}`));
});

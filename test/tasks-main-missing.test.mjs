import test from "node:test";
import assert from "node:assert/strict";
import { mainChangesMissing, taskGit } from "../server/tasks.mjs";
import { fixture } from "../test-support/tasks-fixture.mjs";

// git 2.38 전처럼 merge-tree --write-tree를 모르는 git을 흉내 낸다.
const oldGit = (dir, args, options) => args.includes("merge-tree")
  ? Promise.reject(Object.assign(Error("error: unknown option `write-tree'"), { reason: "git-error" })) : taskGit(dir, args, options);
const missing = async (f, git) => [await mainChangesMissing(f.repo, "main", "develop", git), await mainChangesMissing(f.repo, "main", "develop", oldGit)];
function write(f, text, message, file = "base.txt") { f.change(f.repo, file, text); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", message); }
function publish(f) { f.git(f.repo, "push", "-q", "origin", "main", "develop"); f.git(f.repo, "switch", "-q", "main"); }

test("main 미반영: develop에 같은 hotfix를 다른 SHA로 넣은 뒤 같은 줄을 더 고쳐도 반영된 것으로 본다", async (t) => {
  const f = fixture(t);
  write(f, "fix\n", "hotfix");
  f.git(f.repo, "switch", "-q", "develop"); f.git(f.repo, "cherry-pick", "main"); write(f, "fix and more\n", "develop work");
  publish(f);
  assert.deepEqual(await missing(f), [false, false]);
  const context = await f.service.context(f.repo);
  assert.equal(context.mainMissing, false); assert.equal(context.state, "current");
  assert.equal((await f.create()).task.baseBranch, "develop");
});

test("main 미반영: develop에서 반영한 hotfix를 의도적으로 되돌린 경우는 막지 않는다", async (t) => {
  const f = fixture(t);
  write(f, "fix\n", "hotfix");
  f.git(f.repo, "switch", "-q", "develop"); f.git(f.repo, "cherry-pick", "main"); f.git(f.repo, "revert", "--no-edit", "HEAD");
  publish(f);
  assert.deepEqual(await missing(f), [false, false]);
});

test("main 미반영: main에 하나로 합쳐(squash) 넣은 release를 develop이 이어서 고쳐도 반영된 것으로 본다", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "switch", "-q", "develop"); write(f, "v1\n", "v1"); write(f, "v2\n", "v2");
  f.git(f.repo, "switch", "-q", "main"); f.git(f.repo, "merge", "--squash", "develop"); f.git(f.repo, "commit", "-qm", "release (squash)");
  f.git(f.repo, "switch", "-q", "develop"); write(f, "v3\n", "v3");
  publish(f);
  assert.deepEqual(await missing(f), [false, false]);
});

test("main 미반영: develop에 없는 main 변경은 충돌하거나 git이 오래돼도 미반영으로 알린다", async (t) => {
  const f = fixture(t);
  write(f, "hot\n", "hotfix only on main");
  f.git(f.repo, "switch", "-q", "develop"); write(f, "dev\n", "develop change");
  publish(f);
  assert.deepEqual(await missing(f), [true, true]);
  write(f, "new\n", "new file on main", "added.txt"); f.git(f.repo, "push", "-q", "origin", "main");
  f.git(f.repo, "switch", "-q", "develop"); f.git(f.repo, "reset", "-q", "--hard", "origin/main~2"); f.git(f.repo, "switch", "-q", "main");
  assert.deepEqual(await missing(f), [true, true]);
  const context = await f.service.context(f.repo);
  assert.equal(context.mainMissing, true);
  await assert.rejects(f.create(), (error) => error.reason === "gitflow-develop-behind");
});

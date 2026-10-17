import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_GITFLOW_SETTINGS, gitflowSettingsKey } from "../server/gitflow-settings.mjs";
import { fixture, customGitflow } from "../test-support/tasks-fixture.mjs";

test("tasks: project settings preserve case and normalize prefixes without changing Git branches", async (t) => {
  const f = fixture(t);
  assert.deepEqual((await f.service.settings(f.repo)).settings, DEFAULT_GITFLOW_SETTINGS);
  const branches = f.git(f.repo, "show-ref");
  const head = f.git(f.repo, "rev-parse", "HEAD");
  const saved = await f.service.updateSettings(f.repo, { settings: {
    main: " Main ", develop: " Develop ", featurePrefix: " Feature ", hotfixPrefix: " Fix/ ", releasePrefix: "Release",
  } });
  assert.deepEqual(saved, { projectPath: f.git(f.repo, "rev-parse", "--show-toplevel"), settings: customGitflow, finishMode: "pr" });
  assert.deepEqual(f.config.gitflow[gitflowSettingsKey(f.repo)], customGitflow);
  assert.equal(f.state.saves, 1);
  assert.equal(f.git(f.repo, "show-ref"), branches);
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), head);
  assert.equal(f.state.writes.length, 0);
  const context = await f.service.context(f.repo);
  assert.equal(context.state, "error");
  assert.deepEqual(context.settings, customGitflow);
  assert.match(context.error, /Main/);
  assert.equal((await f.service.context(path.join(f.repo, "not-a-repo"))).settings.main, "main");
});

test("tasks: invalid branch settings and failed persistence leave the prior settings intact", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "switch", "-q", "develop"); f.git(f.repo, "switch", "-q", "main");
  assert.equal(f.git(f.repo, "check-ref-format", "--branch", "@{-1}"), "develop");
  for (const settings of [{ main: "same", develop: "same" }, { main: "bad..name" }, { main: "@{-1}" }, { featurePrefix: "bad[" }, { hotfixPrefix: "bad prefix" }]) {
    await assert.rejects(f.service.updateSettings(f.repo, { settings }), (error) => error.status === 400 && error.reason === "gitflow-settings");
  }
  assert.equal(f.state.saves, 0);
  assert.equal(f.config.gitflow, undefined);
  f.state.saveError = Error("disk full");
  await assert.rejects(f.service.updateSettings(f.repo, { settings: customGitflow }), /disk full/);
  assert.equal(f.config.gitflow, undefined);
  f.state.saveError = null;
  await f.service.updateSettings(f.repo, { settings: customGitflow });
  const previous = f.config.gitflow;
  f.state.saveError = Error("disk full");
  await assert.rejects(f.service.updateSettings(f.repo, { settings: { develop: "Next" } }), /disk full/);
  assert.equal(f.config.gitflow, previous);
  assert.deepEqual((await f.service.settings(f.repo)).settings, customGitflow);
});

test("tasks: custom GitFlow names drive context, all task prefixes and PR targets", async (t) => {
  const f = fixture(t, { main: "Main", developBranch: "Develop", settings: customGitflow });
  const context = await f.service.context(f.repo);
  assert.equal(context.main.branch, "Main"); assert.equal(context.develop.branch, "Develop");
  assert.deepEqual(context.settings, customGitflow);
  for (const [type, prefix, base, target] of [
    ["feature", "Feature/", "Develop", "Develop"], ["hotfix", "Fix/", "Main", "Main"], ["release", "Release/", "Develop", "Main"],
  ]) {
    const { task } = await f.create(type, { version: "1.2.0" });
    assert.ok(task.branch.startsWith(prefix));
    if (type === "release") assert.equal(task.branch, "Release/1.2.0");
    assert.equal(task.baseBranch, base); assert.equal(task.targetBranch, target);
    assert.deepEqual(task.gitflow, customGitflow);
    f.change(task.cwd, `${type}.txt`);
    const finished = await f.service.finish(task.id);
    assert.equal(finished.pull.baseRefName, target);
    assert.equal(finished.pull.headRefName, task.branch);
  }
});

test("tasks: a missing custom development branch is created under its exact configured name", async (t) => {
  const f = fixture(t, { main: "Main", develop: false, settings: customGitflow });
  const { task } = await f.create();
  assert.equal(task.needsDevelopSetup, true);
  assert.equal(task.baseCommit, f.git(f.repo, "rev-parse", "Main"));
  f.change(task.cwd);
  const result = await f.service.finish(task.id);
  assert.equal(result.pull.baseRefName, "Develop");
  assert.deepEqual(f.state.refs, ["refs/heads/Develop"]);
  assert.ok(f.git(f.repo, "ls-remote", f.remote, "refs/heads/Develop"));
  assert.equal(f.git(f.repo, "ls-remote", f.remote, "refs/heads/develop"), "");
});

test("tasks: existing task snapshots survive settings changes through refresh, sync and finish", async (t) => {
  const f = fixture(t, { main: "Main", developBranch: "Develop", settings: customGitflow });
  const { task } = await f.create();
  await f.service.updateSettings(f.repo, { settings: { main: "production", develop: "integration" } });
  assert.equal((await f.service.context(f.repo)).state, "error");
  f.git(f.repo, "switch", "-q", "Develop"); f.commit(f.repo); f.git(f.repo, "push", "-q", "origin", "Develop");
  const refreshed = await f.restart().refresh(task.id);
  assert.equal(refreshed.task.freshness.develop.branch, "Develop");
  assert.equal(refreshed.task.freshness.behind, true);
  const synced = await f.service.sync(task.id);
  assert.equal(synced.task.freshness.state, "current");
  assert.ok(fs.existsSync(path.join(task.cwd, "remote-change.txt")));
  f.change(task.cwd);
  const finished = await f.service.finish(task.id);
  assert.equal(finished.pull.baseRefName, "Develop");
  assert.deepEqual(finished.task.gitflow, customGitflow);
});

test("tasks: custom hotfix cleanup uses its original branches after settings change", async (t) => {
  const f = fixture(t, { main: "Main", developBranch: "Develop", settings: customGitflow });
  const { task } = await f.create("hotfix");
  await f.service.updateSettings(f.repo, { settings: { main: "production", develop: "integration" } });
  f.change(task.cwd); await f.service.finish(task.id);
  assert.equal(f.state.pulls[0].base.ref, "Main");
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "merge", "--no-edit", task.branch); f.git(f.repo, "push", "-q", "origin", "Main");
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "gitflow-develop-pending" && /Main.*Develop/.test(error.message));
  f.git(f.repo, "switch", "-q", "Develop"); f.git(f.repo, "merge", "--no-edit", "Main"); f.git(f.repo, "push", "-q", "origin", "Develop");
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
});

test("tasks: records without GitFlow snapshots keep legacy branch names after project settings change", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  const file = path.join(f.dataDir, "tasks", `${task.id}.json`);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  delete persisted.gitflow;
  fs.writeFileSync(file, JSON.stringify(persisted));
  await f.service.updateSettings(f.repo, { settings: customGitflow });
  f.restart();
  assert.equal((await f.service.refresh(task.id)).task.freshness.develop.branch, "develop");
  f.change(task.cwd);
  assert.equal((await f.service.finish(task.id)).pull.baseRefName, "develop");
});

test("tasks: a branch name typed with its own prefix is not prefixed twice, other prefixes are rejected", async (t) => {
  const f = fixture(t);
  assert.equal((await f.create("feature", { branchName: "feature/login" })).task.branch, "feature/login");
  assert.equal((await f.create("release", { version: "1.4.0", branchName: "release/1.4.0" })).task.branch, "release/1.4.0");
  for (const branchName of ["hotfix/login", "feature/"])
    await assert.rejects(f.create("feature", { branchName }), (error) => error.status === 400 && error.reason === "task-branch-name");
  assert.equal(f.service.list(f.repo).tasks.length, 2);
});

test("tasks: local hotfix finish merges into main and develop, pushes both and then cleans up", async (t) => {
  const f = fixture(t);
  await f.service.updateSettings(f.repo, { settings: DEFAULT_GITFLOW_SETTINGS, finishMode: "local" });
  const { task } = await f.create("hotfix");
  f.commit(task.cwd, "fix.txt");
  const reviewed = await f.service.review(task.id);
  const result = await f.service.finish(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead });
  const done = result.task;
  assert.equal(done.state, "merged"); assert.equal(done.developPending, false);
  assert.equal(f.git(f.repo, "merge-base", "--is-ancestor", done.mergedHead, "develop"), "");
  assert.equal(done.completion.publishState, "not-requested"); assert.equal(done.completion.developPublishState, "not-requested");
  const pushed = await f.service.pushTarget(task.id);
  assert.equal(pushed.task.completion.publishState, "done"); assert.equal(pushed.task.completion.developPublishState, "done");
  assert.equal(f.git(f.repo, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], done.completion.targetHead);
  assert.equal(f.git(f.repo, "ls-remote", "origin", "refs/heads/develop").split(/\s+/)[0], done.completion.developHead);
  assert.equal((await f.service.refresh(task.id)).task.developPending, false);
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
  assert.equal(f.state.writes.length, 0, "local flow never needs GitHub APIs");
});

test("tasks: a local develop conflict keeps the main merge and can be retried from the card", async (t) => {
  const f = fixture(t);
  await f.service.updateSettings(f.repo, { settings: DEFAULT_GITFLOW_SETTINGS, finishMode: "local" });
  f.git(f.repo, "switch", "-q", "develop"); f.change(f.repo, "base.txt", "develop side\n"); f.git(f.repo, "commit", "-qam", "develop side");
  f.git(f.repo, "switch", "-q", "main");
  const { task } = await f.create("hotfix");
  f.change(task.cwd, "base.txt", "hotfix side\n"); f.git(task.cwd, "commit", "-qam", "hotfix side");
  const reviewed = await f.service.review(task.id);
  const developBefore = f.git(f.repo, "rev-parse", "develop");
  const { task: merged } = await f.service.finish(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead });
  assert.equal(merged.state, "merged"); assert.equal(merged.developPending, true); assert.match(merged.error, /충돌/);
  assert.equal(f.git(f.repo, "rev-parse", "develop"), developBefore, "a conflicting develop merge is rolled back");
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "gitflow-develop-pending");
  // 사용자가 develop에서 충돌을 해결하면 최신 확인이 반영을 인정한다.
  const worktree = f.git(f.repo, "worktree", "list", "--porcelain").split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9))
    .find((dir) => { try { return f.git(dir, "branch", "--show-current") === "develop"; } catch { return false; } }) ?? f.repo;
  if (worktree === f.repo) f.git(f.repo, "switch", "-q", "develop");
  try { f.git(worktree, "merge", "--no-edit", task.branch); } catch {}
  f.change(worktree, "base.txt", "resolved\n"); f.git(worktree, "commit", "-qam", "resolve");
  if (worktree === f.repo) f.git(f.repo, "switch", "-q", "main");
  const refreshed = await f.service.refresh(task.id);
  assert.equal(refreshed.task.developPending, false);
});

test("tasks: a merged hotfix PR opens one main to develop back-merge PR and cleans up after it lands", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("hotfix"); f.change(task.cwd); await f.service.finish(task.id);
  const reviewed = await f.service.review(task.id);
  const merged = await f.service.mergePull(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, expectedPullHead: reviewed.head, method: "merge" });
  assert.equal(merged.task.developPending, true);
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "gitflow-develop-pending");
  const opened = await f.service.mergeDevelop(task.id);
  assert.equal(opened.task.developPull.baseRefName, "develop"); assert.equal(opened.task.developPull.headRefName, "main");
  assert.equal((await f.service.mergeDevelop(task.id)).task.developPull.number, opened.task.developPull.number, "an open back-merge PR is reused");
  assert.equal(f.state.writes.filter((write) => write === "develop-pull").length, 1);
  f.git(f.repo, "switch", "-q", "develop"); f.git(f.repo, "merge", "--no-edit", "main"); f.git(f.repo, "push", "-q", "origin", "develop");
  const back = f.state.pulls.find((pull) => pull.number === opened.task.developPull.number); back.merged = true; back.state = "closed";
  const refreshed = await f.service.refresh(task.id);
  assert.equal(refreshed.task.developPending, false); assert.equal(refreshed.task.developPull.state, "MERGED");
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
});

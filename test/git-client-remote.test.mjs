import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run } from "../test-support/git-fixture.mjs";
import { counter, fixture, remoteFixture } from "../test-support/git-client-fixture.mjs";

test("git client: generic push handles new upstream, blocks remote rewrites and protects published history", async () => {
  const f = fixture();
  const bare = path.join(path.dirname(f.repo), "origin-" + counter + ".git");
  run(f.repo, "init", "--bare", bare); run(f.repo, "remote", "add", "origin", bare);
  const first = await f.client.preview(await f.ctx(), { action: "push", remote: "origin", setUpstream: true });
  assert.equal(first.remoteHead, null);
  await f.client.execute(await f.ctx(), { previewId: first.previewId });
  assert.equal(run(bare, "rev-parse", "refs/heads/main").trim(), f.root);
  assert.equal(run(f.repo, "config", "branch.main.remote").trim(), "origin");
  const local = f.add("published.txt", "published\n");
  await f.client.push(await f.ctx(), { remote: "origin", expectedHead: local });
  const blocked = await f.client.preview(await f.ctx(), { action: "uncommit", commit: local });
  assert.equal(blocked.published, true); assert.match(blocked.blockedReason, /게시된/);
  await assert.rejects(f.client.execute(await f.ctx(), { previewId: blocked.previewId }), e => e.reason === "git-blocked");
  const undo = await f.client.preview(await f.ctx(), { action: "revert", commit: local });
  assert.ok(!undo.blockedReason); await f.client.execute(await f.ctx(), { previewId: undo.previewId });
  const other = path.join(path.dirname(f.repo), "other-" + counter);
  run(f.repo, "clone", "--branch", "main", bare, other);
  fs.writeFileSync(path.join(other, "remote.txt"), "remote\n"); run(other, "add", "."); run(other, "commit", "-qm", "remote changes"); run(other, "push", "origin", "main");
  await f.client.fetch(await f.ctx(), { remote: "origin" });
  const info = await f.client.remotes(await f.ctx(), "origin");
  assert.ok(info.behind > 0 && info.ahead > 0);
  await assert.rejects(f.client.push(await f.ctx(), { remote: "origin", expectedHead: f.head() }), e => e.reason === "git-non-fast-forward");
  assert.equal(run(bare, "rev-parse", "refs/heads/main").trim(), run(other, "rev-parse", "HEAD").trim());
});

test("git client: publication after preview is rechecked before rewrite", async () => {
  const f = fixture(); const tip = f.add("change.txt", "change\n");
  const bare = path.join(path.dirname(f.repo), "origin-race-" + counter + ".git");
  run(f.repo, "init", "--bare", bare); run(f.repo, "remote", "add", "origin", bare);
  const preview = await f.client.preview(await f.ctx(), { action: "reset", commit: f.root });
  assert.ok(!preview.blockedReason);
  run(f.repo, "push", "origin", "main");
  await assert.rejects(f.client.execute(await f.ctx(), { previewId: preview.previewId }), e => e.reason === "git-published");
  assert.equal(f.head(), tip);
});

test("git client: different push URLs are included in published-history checks", async () => {
  const f = fixture(); const tip = f.add("change.txt", "published elsewhere\n");
  const fetchRepo = path.join(path.dirname(f.repo), "fetch-url-" + counter + ".git");
  const pushRepo = path.join(path.dirname(f.repo), "push-url-" + counter + ".git");
  run(f.repo, "init", "--bare", fetchRepo); run(f.repo, "init", "--bare", pushRepo);
  run(f.repo, "remote", "add", "origin", fetchRepo); run(f.repo, "remote", "set-url", "--push", "origin", pushRepo);
  await f.client.push(await f.ctx(), { remote: "origin", expectedHead: tip });
  assert.equal((await f.client.remotes(await f.ctx(), "origin")).remoteHead, tip);
  const preview = await f.client.preview(await f.ctx(), { action: "uncommit", commit: tip });
  assert.equal(preview.published, true); assert.match(preview.blockedReason, /게시된/);
});

test("git client: deleting a worktree cannot delete another branch at the same HEAD", async () => {
  const f = fixture(); const made = await f.client.create(await f.ctx(), { name: "changing", branch: "before" });
  run(made.worktree.cwd, "switch", "-c", "after");
  await assert.rejects(f.client.remove(await f.client.context(f.repo, made.worktree.cwd), {
    removeFolder: true, deleteBranch: true, expectedHead: f.head(), expectedBranch: "before",
  }), e => e.reason === "stale-head");
  assert.ok(fs.existsSync(made.worktree.cwd)); assert.ok(run(f.repo, "branch", "--list", "after").trim());
});

test("git client: pull fast-forwards, asks for a strategy when diverged and restores the folder on conflict", async () => {
  const f = remoteFixture();
  const remoteHead = f.push("remote.txt", "remote\n");
  run(f.repo, "fetch", "-q", "origin");
  let state = await f.client.pullState(await f.ctx());
  assert.deepEqual([state.branch, state.upstream, state.ahead, state.behind], ["main", "origin/main", 0, 1]);
  await f.client.pull(await f.ctx(), { expectedHead: state.head });
  assert.equal(f.head(), remoteHead);

  f.add("local.txt", "local\n");
  f.push("remote-2.txt", "remote 2\n");
  run(f.repo, "fetch", "-q", "origin");
  await assert.rejects(f.client.pull(await f.ctx()), e => e.reason === "git-diverged" && /앞으로 감기/.test(e.message) && /Merge|Rebase/.test(e.hint));
  const merged = await f.client.pull(await f.ctx(), { strategy: "merge" });
  assert.equal(merged.strategy, "merge");
  assert.ok(fs.existsSync(path.join(f.repo, "remote-2.txt")) && fs.existsSync(path.join(f.repo, "local.txt")));

  f.add("same.txt", "local\n");
  f.push("same.txt", "remote\n");
  run(f.repo, "fetch", "-q", "origin");
  const before = f.head();
  await assert.rejects(f.client.pull(await f.ctx(), { strategy: "merge" }), e => e.reason === "git-conflict" && /충돌/.test(e.message) && !!e.hint);
  assert.equal(f.head(), before);
  assert.equal(f.status(), "");
  await assert.rejects(f.client.pull(await f.ctx(), { strategy: "rebase" }), e => e.reason === "git-conflict");
  assert.equal(f.head(), before);
  assert.ok(!fs.existsSync(path.join(f.repo, ".git", "rebase-merge")));
});

test("git client: pull needs a tracking branch and a fixed starting commit", async () => {
  const f = remoteFixture();
  run(f.repo, "switch", "-q", "-c", "local-only");
  await assert.rejects(f.client.pullState(await f.ctx()), e => e.reason === "git-no-upstream" && !!e.hint);
  run(f.repo, "switch", "-q", "main");
  await assert.rejects(f.client.pull(await f.ctx(), { expectedHead: f.root.replace(/./, (c) => c === "0" ? "1" : "0") }), e => e.reason === "stale-head");
  await assert.rejects(f.client.pull(await f.ctx(), { strategy: "force" }), e => e.status === 400);
});

test("git client: branch creation validates names, refuses duplicates and can switch from a chosen start", async () => {
  const f = fixture();
  const second = f.add("second.txt", "second\n");
  await assert.rejects(f.client.createBranch(await f.ctx(), { name: "bad name" }), e => e.status === 400 && e.reason === "git-branch");
  await assert.rejects(f.client.createBranch(await f.ctx(), { name: "-x" }), e => e.status === 400);
  const made = await f.client.createBranch(await f.ctx(), { name: "feature/new" });
  assert.equal(made.checkedOut, false);
  assert.equal(run(f.repo, "branch", "--show-current").trim(), "main");
  assert.equal(run(f.repo, "rev-parse", "feature/new").trim(), second);
  await assert.rejects(f.client.createBranch(await f.ctx(), { name: "feature/new" }), e => e.reason === "git-branch-exists");
  const switched = await f.client.createBranch(await f.ctx(), { name: "hotfix/old", startPoint: f.root, checkout: true });
  assert.equal(switched.checkedOut, true);
  assert.equal(run(f.repo, "branch", "--show-current").trim(), "hotfix/old");
  assert.equal(f.head(), f.root);
});

test("git client: 무시하는 파일은 함께 지우기로 골라야 지우고, 다른 브랜치에 반영된 커밋은 막지 않으며, 사라진 폴더 기록을 prune한다", async () => {
  const f = fixture();
  f.add(".gitignore", "node_modules/\n");
  const made = await f.client.create(await f.ctx(), { name: "ignored", branch: "feature/ignored" });
  const cwd = made.worktree.cwd;
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feature\n");
  run(cwd, "add", "."); run(cwd, "commit", "-qm", "feature");
  const tip = run(cwd, "rev-parse", "HEAD").trim();
  // 원본 폴더는 main에 있고 작업은 develop에만 병합됐다.
  run(f.repo, "branch", "develop", tip);
  fs.mkdirSync(path.join(cwd, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "node_modules", "pkg", "index.js"), "x");
  const ctx = await f.client.context(f.repo, cwd);
  const body = { removeFolder: true, expectedHead: tip, expectedBranch: "feature/ignored" };
  await assert.rejects(f.client.remove(ctx, body), e => e.reason === "git-ignored-files" && /node_modules/.test(e.message));
  assert.ok(fs.existsSync(cwd));
  const removed = await f.client.remove(ctx, { ...body, removeIgnored: true });
  assert.equal(removed.worktreeRemoved, true); assert.equal(fs.existsSync(cwd), false);

  const gone = (await f.client.create(await f.ctx(), { name: "gone", branch: "feature/gone" })).worktree.cwd;
  fs.rmSync(gone, { recursive: true, force: true });
  assert.ok((await f.client.list(await f.ctx())).worktrees.some(tree => tree.missing));
  assert.equal((await f.client.prune(await f.ctx())).pruned, 1);
  assert.ok(!(await f.client.list(await f.ctx())).worktrees.some(tree => tree.missing));
});

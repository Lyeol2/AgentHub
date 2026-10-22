import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run } from "../test-support/git-fixture.mjs";
import { createGitClient, resolveGitContext } from "../server/git-client.mjs";
import { createGitService } from "../server/application/git.mjs";
import { gitOverview } from "../server/gitpanel.mjs";
import { counter, fixture } from "../test-support/git-client-fixture.mjs";

test("git client: worktree context rejects foreign repository, child directory and spoofed .git; selected reads use worktree", async () => {
  const f = fixture(), other = fixture();
  const made = await f.client.create(await f.ctx(), { name: "feature", branch: "feature/context" });
  const cwd = made.worktree.cwd;
  fs.writeFileSync(path.join(cwd, "only-worktree.txt"), "selected folder\n");
  await assert.rejects(resolveGitContext(f.repo, other.repo), e => e.reason === "git-context");
  const child = path.join(cwd, "child"); fs.mkdirSync(child);
  await assert.rejects(resolveGitContext(f.repo, child), e => e.reason === "git-context");
  const fake = path.join(path.dirname(f.repo), "spoof-" + counter); fs.mkdirSync(fake);
  fs.copyFileSync(path.join(cwd, ".git"), path.join(fake, ".git"));
  await assert.rejects(resolveGitContext(f.repo, fake), e => e.reason === "git-context");
  const service = createGitService({ sessions: { list: () => [] }, projects: { projectSessions: () => [] }, runner: { isRunning: () => false }, notify: () => {} });
  const overview = await service.execute("overview", { projectPath: f.repo, cwd });
  assert.equal(overview.branch, "feature/context");
  assert.ok(overview.files.some(file => file.path === "only-worktree.txt"));
  assert.ok(!(await service.execute("overview", { projectPath: f.repo })).files.length);
  const diff = await service.execute("diff", { projectPath: f.repo, cwd, file: "only-worktree.txt" });
  assert.match(diff.diff, /selected folder/);
});

test("git client: worktree creation validates branch/path, reuses existing branch, deletion protects references/dirty/unmerged", async () => {
  const f = fixture();
  await assert.rejects(f.client.create(await f.ctx(), { name: "../escape" }));
  await assert.rejects(f.client.create(await f.ctx(), { name: "bad", branch: "@{-1}" }));
  await assert.rejects(f.client.create(await f.ctx(), { name: "bad", branch: "main" }));
  run(f.repo, "branch", "feature/existing");
  const made = await f.client.create(await f.ctx(), { name: "existing", existingBranch: "feature/existing" });
  const cwd = made.worktree.cwd, ctx = await f.client.context(f.repo, cwd);
  assert.equal(run(cwd, "branch", "--show-current").trim(), "feature/existing");
  await assert.rejects(f.client.remove(await f.ctx(), { removeFolder: true, expectedHead: f.head() }), e => e.reason === "git-original");
  const referenced = createGitClient({ getSessions: () => [{ id: "s", cwd, state: "idle" }] });
  await assert.rejects(referenced.remove(ctx, { removeFolder: true, expectedHead: f.head() }), e => e.reason === "git-referenced");
  const tasked = createGitClient({ getTasks: () => [{ id: "t", cwd, state: "working" }] });
  await assert.rejects(tasked.remove(ctx, { removeFolder: true, expectedHead: f.head() }), e => e.reason === "git-referenced");
  fs.writeFileSync(path.join(cwd, "pending.txt"), "keep\n");
  await assert.rejects(f.client.remove(ctx, { removeFolder: true, expectedHead: f.head() }), e => e.reason === "git-dirty");
  run(cwd, "add", "."); run(cwd, "commit", "-qm", "feature");
  const tip = run(cwd, "rev-parse", "HEAD").trim();
  await assert.rejects(f.client.remove(ctx, { removeFolder: true, expectedHead: tip }), e => e.reason === "git-unmerged");
  run(f.repo, "merge", "--ff-only", "feature/existing");
  const result = await f.client.remove(ctx, { removeFolder: true, deleteBranch: true, expectedHead: tip, expectedBranch: "feature/existing" });
  assert.equal(result.branchRemoved, true); assert.ok(!fs.existsSync(cwd));
  assert.ok(!run(f.repo, "branch", "--list", "feature/existing").trim());
});

test("git client: source and target are pinned; merge runs in selected worktree and conflict abort is verified", async () => {
  const f = fixture();
  const target = (await f.client.create(await f.ctx(), { name: "target", branch: "target" })).worktree.cwd;
  const source = (await f.client.create(await f.ctx(), { name: "source", branch: "source" })).worktree.cwd;
  fs.writeFileSync(path.join(source, "feature.txt"), "feature\n"); run(source, "add", "."); run(source, "commit", "-qm", "feature");
  const ctx = await f.client.context(f.repo, target);
  const stale = await f.client.preview(ctx, { action: "merge", branch: "source" });
  fs.writeFileSync(path.join(source, "next.txt"), "next\n"); run(source, "add", "."); run(source, "commit", "-qm", "next");
  await assert.rejects(f.client.execute(ctx, { previewId: stale.previewId }), e => e.reason === "stale-head");
  const preview = await f.client.preview(ctx, { action: "merge", branch: "source" });
  assert.match(preview.diff, /feature/);
  const result = await f.client.execute(ctx, { previewId: preview.previewId });
  assert.ok(result.recoveryId); assert.equal(f.head(), f.root);
  assert.ok(fs.existsSync(path.join(target, "feature.txt")));
  fs.writeFileSync(path.join(target, "base.txt"), "target\n"); run(target, "add", "."); run(target, "commit", "-qm", "target edits");
  fs.writeFileSync(path.join(source, "base.txt"), "source\n"); run(source, "add", "."); run(source, "commit", "-qm", "source edits");
  const before = run(target, "rev-parse", "HEAD").trim();
  const conflict = await f.client.preview(ctx, { action: "merge", branch: "source" });
  await assert.rejects(f.client.execute(ctx, { previewId: conflict.previewId }), e => e.reason === "git-conflict");
  assert.equal(run(target, "rev-parse", "HEAD").trim(), before);
  assert.equal(run(target, "status", "--porcelain").trim(), "");
  assert.equal(fs.readFileSync(path.join(target, "base.txt"), "utf8").trim(), "target");
});

test("git client: uncommit preserves files and recovery restores only the exact resulting working state", async () => {
  const f = fixture(); const tip = f.add("change.txt", "retained\n", "change");
  const result = await f.execute("uncommit", tip);
  assert.equal(f.head(), f.root); assert.equal(fs.readFileSync(path.join(f.repo, "change.txt"), "utf8"), "retained\n");
  assert.match(f.status(), /change.txt/);
  fs.appendFileSync(path.join(f.repo, "change.txt"), "new work\n");
  await assert.rejects(f.client.restore(await f.ctx(), { recoveryId: result.recoveryId, expectedHead: f.head() }), e => e.reason === "git-dirty");
  fs.writeFileSync(path.join(f.repo, "change.txt"), "retained\n");
  await f.client.restore(await f.ctx(), { recoveryId: result.recoveryId, expectedHead: f.head() });
  assert.equal(f.head(), tip); assert.equal(f.status(), "");
  assert.ok((await f.client.recovery(await f.ctx())).recoveries.length >= 2);
});

test("git client: reset discards descendants, revert adds inverse commit, middle drop preserves later commits", async () => {
  const reset = fixture(); reset.add("a.txt", "a\n"); const oldHead = reset.add("b.txt", "b\n");
  const result = await reset.execute("reset", reset.root);
  assert.equal(reset.head(), reset.root); assert.ok(!fs.existsSync(path.join(reset.repo, "a.txt")));
  await reset.client.restore(await reset.ctx(), { recoveryId: result.recoveryId, expectedHead: reset.root });
  assert.equal(reset.head(), oldHead); assert.ok(fs.existsSync(path.join(reset.repo, "b.txt")));

  const revert = fixture(); const selected = revert.add("revert.txt", "remove me\n");
  await revert.execute("revert", selected);
  assert.notEqual(revert.head(), selected); assert.equal(run(revert.repo, "rev-list", "--count", "HEAD").trim(), "3");
  assert.ok(!fs.existsSync(path.join(revert.repo, "revert.txt")));

  const drop = fixture(); const selectedDrop = drop.add("drop.txt", "remove middle\n", "middle");
  drop.add("later.txt", "keep later\n", "later");
  await drop.execute("drop", selectedDrop);
  assert.ok(!fs.existsSync(path.join(drop.repo, "drop.txt"))); assert.equal(fs.readFileSync(path.join(drop.repo, "later.txt"), "utf8"), "keep later\n");
  assert.equal(run(drop.repo, "log", "-1", "--format=%s").trim(), "later");
  assert.equal(run(drop.repo, "rev-list", "--count", "HEAD").trim(), "2");
});

test("git client: failed descendant replay restores the complete original history", async () => {
  const f = fixture(); const middle = f.add("depends.txt", "initial\n", "middle");
  const tip = f.add("depends.txt", "changed\n", "dependent");
  const preview = await f.client.preview(await f.ctx(), { action: "drop", commit: middle });
  await assert.rejects(f.client.execute(await f.ctx(), { previewId: preview.previewId }), e => e.reason === "git-conflict");
  assert.equal(f.head(), tip); assert.equal(f.status(), "");
  assert.equal(fs.readFileSync(path.join(f.repo, "depends.txt"), "utf8").trim(), "changed");
});

test("git client: stale previews, busy sessions, dirty state and task ownership cannot be bypassed", async () => {
  const f = fixture(); const tip = f.add("change.txt", "change\n");
  const preview = await f.client.preview(await f.ctx(), { action: "uncommit", commit: tip });
  f.add("next.txt", "next\n");
  await assert.rejects(f.client.execute(await f.ctx(), { previewId: preview.previewId }), e => e.reason === "stale-head");
  const busy = createGitClient({ getSessions: () => [{ id: "s", cwd: f.repo, state: "running" }] });
  const blocked = await busy.preview(await busy.context(f.repo), { action: "uncommit", commit: f.head() });
  assert.match(blocked.blockedReason, /실행 중/);
  const task = createGitClient({ getTasks: () => [{ id: "t", cwd: f.repo, state: "review", pull: { number: 1 } }] });
  assert.match((await task.preview(await task.context(f.repo), { action: "uncommit", commit: f.head() })).blockedReason, /검토/);
  const operation = createGitClient({ assertTaskOperation: () => { throw new Error("task-busy"); } });
  await assert.rejects(operation.write(await operation.context(f.repo), "commit", () => {}), /task-busy/);
  fs.writeFileSync(path.join(f.repo, "uncommitted.txt"), "preserve");
  assert.match((await f.client.preview(await f.ctx(), { action: "reset", commit: f.root })).blockedReason, /커밋하지 않은/);
  await assert.rejects(f.client.preview(await f.ctx(), { action: "reset", commit: "HEAD~1" }), e => e.reason === "git-commit");
});

test("git client: reset preserves ignored local files that would otherwise be overwritten", async () => {
  const f = fixture(); const target = f.add("private.cache", "committed\n");
  run(f.repo, "rm", "private.cache");
  fs.writeFileSync(path.join(f.repo, ".gitignore"), "*.cache\n"); run(f.repo, "add", ".gitignore"); run(f.repo, "commit", "-qm", "stop tracking cache");
  fs.writeFileSync(path.join(f.repo, "private.cache"), "private local data\n");
  assert.equal(f.status(), "");
  const preview = await f.client.preview(await f.ctx(), { action: "reset", commit: target });
  assert.match(preview.blockedReason, /무시하는 파일/);
  await assert.rejects(f.client.execute(await f.ctx(), { previewId: preview.previewId }), e => e.reason === "git-blocked");
  assert.equal(fs.readFileSync(path.join(f.repo, "private.cache"), "utf8"), "private local data\n");
});
test("git client: worktree list resolves every folder with the original, dirty and reference state", async () => {
  const f = fixture();
  const clean = (await f.client.create(await f.ctx(), { name: "clean" })).worktree.cwd;
  const edited = (await f.client.create(await f.ctx(), { name: "edited" })).worktree.cwd;
  const used = (await f.client.create(await f.ctx(), { name: "used" })).worktree.cwd;
  fs.writeFileSync(path.join(edited, "pending.txt"), "keep\n");
  const client = createGitClient({ getSessions: () => [{ id: "s", cwd: used, state: "idle" }] });
  const { worktrees, currentCwd } = await client.list(await client.context(f.repo, clean));
  assert.equal(currentCwd, fs.realpathSync.native(clean));
  const row = (cwd) => worktrees.find(item => item.cwd.toLowerCase() === path.resolve(cwd).toLowerCase());
  assert.equal(worktrees.length, 4);
  assert.deepEqual([row(f.repo).original, row(f.repo).dirty, row(f.repo).canRemove], [true, false, false]);
  assert.deepEqual([row(clean).original, row(clean).dirty, row(clean).canRemove, row(clean).reason], [false, false, true, null]);
  assert.deepEqual([row(edited).dirty, row(edited).canRemove], [true, false]);
  assert.deepEqual([row(used).sessionIds, row(used).canRemove], [["s"], false]);
  const plain = path.join(path.dirname(f.repo), "plain-" + counter); fs.mkdirSync(plain);
  await assert.rejects(resolveGitContext(plain), e => e.reason === "not-git");
});

test("git overview: upstream ahead/behind and branch counts are reported together", async () => {
  const f = fixture();
  run(f.repo, "branch", "base");
  f.add("local.txt", "local\n");
  run(f.repo, "switch", "-q", "base");
  f.add("upstream-1.txt", "1\n"); f.add("upstream-2.txt", "2\n");
  run(f.repo, "switch", "-q", "main");
  run(f.repo, "branch", "--set-upstream-to=base");
  const firstRead = gitOverview(f.repo);
  assert.equal(gitOverview(f.repo), firstRead, "overlapping overview requests share their work");
  const overview = await firstRead;
  assert.deepEqual([overview.branch, overview.upstream, overview.ahead, overview.behind], ["main", "base", 1, 2]);
  assert.deepEqual(overview.branches.map(b => [b.name, b.current, b.ahead]), [["main", true, 0], ["base", false, 2]]);
  run(f.repo, "branch", "--unset-upstream");
  const nextRead = gitOverview(f.repo);
  assert.notEqual(nextRead, firstRead, "completed overviews are not a freshness cache");
  const plain = await nextRead;
  assert.deepEqual([plain.upstream, plain.ahead, plain.behind], [null, null, null]);
});

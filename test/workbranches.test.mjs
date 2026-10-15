import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listWorkbranches, resolveWorkbranch, workbranchLocation } from "../server/workbranches.mjs";
import { taskRepo } from "../server/tasks.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-workbranches-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = path.join(root, "한글 원본 repo");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Workbranch Test"); git(repo, "config", "user.email", "workbranch@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "branch", "develop");
  const add = (branch, name) => {
    const dir = path.join(root, name ?? branch.replaceAll("/", "-"));
    git(repo, "worktree", "add", "-q", "-b", branch, dir, "HEAD");
    return dir;
  };
  return { root, repo, git, add };
}

test("workbranches: lists local branches and safely reuses existing feature and legacy worktrees", async (t) => {
  const f = fixture(t);
  const feature = f.add("feature/기존-작업", "한글 feature folder");
  const legacy = f.add("agenthub/legacy", "legacy folder");
  fs.writeFileSync(path.join(feature, "unfinished.txt"), "keep feature work\n");
  const before = f.git(f.repo, "show-ref", "--heads");
  const result = await listWorkbranches(f.repo);
  assert.equal(result.currentBranch, "main");
  const selected = result.branches.find((item) => item.name === "feature/기존-작업");
  assert.equal(selected.selectable, true); assert.equal(selected.checkedOut, true);
  assert.equal(path.resolve(selected.cwd), path.resolve(feature));
  for (const [branch, dir] of [["feature/기존-작업", feature], ["agenthub/legacy", legacy]]) {
    const resolved = await resolveWorkbranch(f.repo, branch);
    assert.equal(path.resolve(resolved.dir), path.resolve(dir));
    assert.equal(resolved.branch, branch); assert.equal(resolved.created, false); assert.equal(resolved.managed, false);
  }
  assert.equal(fs.readFileSync(path.join(feature, "unfinished.txt"), "utf8"), "keep feature work\n");
  assert.equal(f.git(f.repo, "show-ref", "--heads"), before);
});

test("workbranches: materializes an existing unchecked branch without forking or changing source files", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "branch", "feature/local-existing");
  fs.writeFileSync(path.join(f.repo, "source-uncommitted.txt"), "keep source\n");
  const refs = f.git(f.repo, "show-ref", "--heads");
  const head = f.git(f.repo, "rev-parse", "feature/local-existing");
  const initial = (await listWorkbranches(f.repo)).branches.find((item) => item.name === "feature/local-existing");
  assert.equal(initial.checkedOut, false); assert.equal(initial.cwd, null); assert.equal(initial.selectable, true);
  const result = await resolveWorkbranch(f.repo, "feature/local-existing");
  assert.equal(result.created, true); assert.equal(result.managed, true);
  assert.match(path.basename(result.dir), /^work-[a-f0-9]{24}$/);
  assert.equal(path.dirname(result.dir), f.repo + ".agenthub");
  assert.equal(f.git(result.dir, "branch", "--show-current"), "feature/local-existing");
  assert.equal(f.git(result.dir, "rev-parse", "HEAD"), head);
  assert.equal(f.git(f.repo, "show-ref", "--heads"), refs);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
  assert.equal(fs.existsSync(path.join(result.dir, "source-uncommitted.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.repo, "source-uncommitted.txt"), "utf8"), "keep source\n");
  const again = await resolveWorkbranch(f.repo, "feature/local-existing");
  assert.equal(again.dir, result.dir); assert.equal(again.created, false); assert.equal(again.managed, false);
});

test("workbranches: primary original and main/develop branches cannot be selected", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "switch", "-q", "-c", "feature/original-checkout");
  const list = await listWorkbranches(f.repo);
  const original = list.branches.find((item) => item.name === "feature/original-checkout");
  assert.equal(original.original, true); assert.equal(original.selectable, false);
  for (const branch of ["main", "develop", "feature/original-checkout"])
    await assert.rejects(resolveWorkbranch(f.repo, branch), (error) => error.status === 409);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "feature/original-checkout");
});

test("workbranches: missing and locked worktrees are listed but cannot be reused", async (t) => {
  const f = fixture(t);
  const missing = f.add("feature/missing");
  const locked = f.add("feature/locked");
  fs.rmSync(missing, { recursive: true, force: true });
  f.git(f.repo, "worktree", "lock", "--reason", "사용자가 잠근 작업", locked);
  const { branches } = await listWorkbranches(f.repo);
  const missingBranch = branches.find((item) => item.name === "feature/missing");
  const lockedBranch = branches.find((item) => item.name === "feature/locked");
  assert.equal(missingBranch.missing, true); assert.equal(missingBranch.selectable, false);
  assert.equal(lockedBranch.locked, true); assert.equal(lockedBranch.selectable, false);
  for (const branch of ["feature/missing", "feature/locked"])
    await assert.rejects(resolveWorkbranch(f.repo, branch), (error) => error.status === 409);
  assert.equal(fs.existsSync(missing), false);
  assert.ok(fs.existsSync(locked));
});

test("workbranches: invalid, remote-only, and nonexistent refs cannot create folders or branches", async (t) => {
  const f = fixture(t);
  const before = f.git(f.repo, "show-ref");
  for (const branch of [undefined, null, {}, "", "--detach", "../escape", "feature/../escape", "feature/bad name", "@{-1}", "HEAD", "refs/heads/main\0", "feature/missing", "origin/feature/remote-only"]) {
    await assert.rejects(resolveWorkbranch(f.repo, branch), (error) => [400, 409].includes(error.status), String(branch));
  }
  assert.equal(f.git(f.repo, "show-ref"), before);
  assert.equal(fs.existsSync(f.repo + ".agenthub"), false);
});

test("workbranches: linked project paths use the canonical original location and permit linked worktree reuse", async (t) => {
  const f = fixture(t);
  const linked = f.add("agenthub/project");
  f.git(f.repo, "branch", "feature/unassigned");
  const current = await listWorkbranches(linked);
  assert.equal(current.currentBranch, "agenthub/project");
  assert.equal(current.branches.find((item) => item.name === "agenthub/project").selectable, true);
  const reused = await resolveWorkbranch(linked, "agenthub/project");
  assert.equal(path.resolve(reused.dir), path.resolve(linked));
  const materialized = await resolveWorkbranch(linked, "feature/unassigned");
  assert.equal(path.dirname(materialized.dir), f.repo + ".agenthub");
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
});

test("workbranches: simultaneous resolutions serialize through their shared Git directory", async (t) => {
  const f = fixture(t);
  const linked = f.add("agenthub/parallel-project");
  f.git(f.repo, "branch", "feature/concurrent");
  const results = await Promise.all([
    resolveWorkbranch(f.repo, "feature/concurrent"), resolveWorkbranch(linked, "feature/concurrent"),
    resolveWorkbranch(f.repo, "feature/concurrent"),
  ]);
  assert.equal(new Set(results.map((item) => item.dir)).size, 1);
  assert.equal(results.filter((item) => item.created).length, 1);
  assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").match(/^branch refs\/heads\/feature\/concurrent$/gm).length, 1);
});

test("workbranches: an unrelated folder at the managed path is preserved", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "branch", "feature/collision");
  const location = workbranchLocation(await taskRepo(f.repo), "feature/collision");
  fs.mkdirSync(location.dir, { recursive: true });
  fs.writeFileSync(path.join(location.dir, "keep.txt"), "do not replace\n");
  await assert.rejects(resolveWorkbranch(f.repo, "feature/collision"), (error) => error.reason === "workbranch-path-exists");
  assert.equal(fs.readFileSync(path.join(location.dir, "keep.txt"), "utf8"), "do not replace\n");
  assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});

test("workbranches: registration whose folder points to another repository is rejected", async (t) => {
  const f = fixture(t);
  const linked = f.add("feature/cross-repo");
  const other = path.join(f.root, "other"); fs.mkdirSync(other);
  f.git(other, "init", "-q", "-b", "main");
  // Corrupt only a temporary fixture's worktree link; the API accepts no client folder.
  fs.unlinkSync(path.join(linked, ".git"));
  fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
  const branch = (await listWorkbranches(f.repo)).branches.find((item) => item.name === "feature/cross-repo");
  assert.equal(branch.selectable, false);
  await assert.rejects(resolveWorkbranch(f.repo, "feature/cross-repo"), (error) => error.status === 409);
  assert.equal(f.git(other, "branch", "--show-current"), "main");
});

test("workbranches: a same-named tag cannot redirect an existing local branch checkout", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "branch", "feature/tagged");
  const expected = f.git(f.repo, "rev-parse", "refs/heads/feature/tagged");
  fs.writeFileSync(path.join(f.repo, "later.txt"), "later main commit\n");
  f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "later main");
  f.git(f.repo, "tag", "feature/tagged");
  const resolved = await resolveWorkbranch(f.repo, "feature/tagged");
  assert.equal(f.git(resolved.dir, "symbolic-ref", "HEAD"), "refs/heads/feature/tagged");
  assert.equal(f.git(resolved.dir, "rev-parse", "HEAD"), expected);
});

test("workbranches: linked worktrees of bare repositories use the bare repository as canonical source", async (t) => {
  const f = fixture(t);
  const bare = path.join(f.root, "shared.git"), linked = path.join(f.root, "bare-linked");
  f.git(f.root, "clone", "-q", "--bare", f.repo, bare);
  f.git(bare, "worktree", "add", "-q", linked, "main");
  f.git(bare, "branch", "feature/from-bare");
  const result = await resolveWorkbranch(linked, "feature/from-bare");
  assert.equal(path.dirname(result.dir), bare + ".agenthub");
  assert.equal(f.git(result.dir, "branch", "--show-current"), "feature/from-bare");
  await assert.rejects(resolveWorkbranch(linked, "main"), (error) => error.reason === "workbranch-protected");
});

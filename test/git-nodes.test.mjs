import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listGitNodeBranches, runGitNode } from "../server/git-nodes.mjs";
import { withGitRepoLock } from "../server/git-lock.mjs";
import { stage } from "../server/gitpanel.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-git-nodes-"));
  t.after(async () => {
    // Git-for-Windows hook descendants may release their cwd after the parent exits.
    const deadline = Date.now() + 20_000;
    while (true) {
      try { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }); return; }
      catch (error) { if (Date.now() >= deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
  });
  const repo = path.join(root, "한글 repo");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Git Node Test");
  git(repo, "config", "user.email", "git-node@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "branch", "develop");
  const add = (branch) => {
    const cwd = path.join(root, "tree-" + branch.replaceAll("/", "-"));
    git(repo, "worktree", "add", "-q", "-b", branch, cwd, "HEAD");
    return cwd;
  };
  const commit = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, "add", "."); git(cwd, "commit", "-qm", file); };
  const run = (branch, targetBranch, extra = {}) => runGitNode({ command: { projectPath: repo, gitAction: targetBranch ? "merge" : "use", branch, targetBranch, timeoutSec: 20 }, ...extra });
  return { root, repo, git, add, commit, run };
}

test("git nodes: local branch policy allows protected targets and reports dirty/running reasons", async (t) => {
  const f = fixture(t);
  const cwd = f.add("feature/busy");
  fs.writeFileSync(path.join(cwd, "pending.txt"), "keep");
  const sessions = [{ state: "running", cwd, worktree: { branch: "feature/busy", dir: cwd } }];
  const list = await listGitNodeBranches(f.repo, { sessions });
  assert.equal(list.currentBranch, "main");
  const main = list.branches.find((branch) => branch.name === "main");
  assert.equal(main.useSelectable, false); assert.equal(main.targetSelectable, true);
  const busy = list.branches.find((branch) => branch.name === "feature/busy");
  assert.equal(busy.busy, true); assert.equal(busy.dirty, true);
  assert.equal(busy.useSelectable, false); assert.equal(busy.targetSelectable, false);
  assert.match(busy.targetReason, /실행 중/);
  const run = await f.run("feature/busy", undefined, { sessions });
  assert.equal(run.ok, false); assert.equal(run.reason, "git-session-running");
});

test("git nodes: use reuses a dirty branch and materializes an unchecked branch without moving refs", async (t) => {
  const f = fixture(t);
  const cwd = f.add("feature/기존");
  fs.writeFileSync(path.join(cwd, "pending.txt"), "preserve");
  const existing = await f.run("feature/기존");
  assert.equal(existing.ok, true); assert.equal(path.resolve(existing.cwd), path.resolve(cwd));
  assert.equal(existing.context.branch, "feature/기존");
  f.git(f.repo, "branch", "feature/new");
  const refs = f.git(f.repo, "show-ref", "--heads");
  const created = await f.run("feature/new");
  assert.equal(created.ok, true); assert.match(path.basename(created.cwd), /^work-[a-f0-9]{24}$/);
  assert.equal(f.git(f.repo, "show-ref", "--heads"), refs);
  assert.equal(fs.readFileSync(path.join(cwd, "pending.txt"), "utf8"), "preserve");
  assert.equal((await f.run("main")).ok, false);
  assert.equal((await f.run("not-a-branch")).reason, "git-branch-missing");
  assert.equal((await f.run("@{-1}")).reason, "git-branch-invalid");
});

test("git nodes: merges committed source into main, preserves source dirt, and succeeds when already merged", async (t) => {
  const f = fixture(t);
  const cwd = f.add("feature/merge");
  f.commit(cwd, "feature.txt", "committed\n");
  fs.writeFileSync(path.join(cwd, "unfinished.txt"), "not committed");
  const initial = f.git(f.repo, "rev-parse", "HEAD");
  const result = await f.run("feature/merge", "main");
  assert.equal(result.ok, true, result.output); assert.equal(result.reason, "git-merged");
  assert.equal(result.beforeHead, initial); assert.equal(result.afterHead, f.git(f.repo, "rev-parse", "HEAD"));
  assert.equal(f.git(f.repo, "rev-list", "--parents", "-1", "HEAD").split(" ").length, 3);
  assert.equal(result.context.branch, "main"); assert.match(result.output, /커밋하지 않은 변경은 포함하지/);
  assert.equal(fs.existsSync(path.join(f.repo, "unfinished.txt")), false);
  assert.equal(fs.readFileSync(path.join(cwd, "unfinished.txt"), "utf8"), "not committed");
  const again = await f.run("feature/merge", "main");
  assert.equal(again.ok, true); assert.equal(again.reason, "git-already-merged");
  assert.equal(again.beforeHead, again.afterHead);
});

test("git nodes: creates target worktree for develop without changing original checkout", async (t) => {
  const f = fixture(t);
  const cwd = f.add("feature/to-develop");
  f.commit(cwd, "feature.txt", "feature\n");
  const mainHead = f.git(f.repo, "rev-parse", "HEAD");
  const result = await f.run("feature/to-develop", "develop");
  assert.equal(result.ok, true, result.output);
  assert.equal(result.context.branch, "develop");
  assert.equal(f.git(result.cwd, "branch", "--show-current"), "develop");
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
});

test("git nodes: dirty target and ongoing operations are rejected without modifying files or refs", async (t) => {
  const f = fixture(t);
  const cwd = f.add("feature/blocked");
  f.commit(cwd, "feature.txt", "feature\n");
  const before = f.git(f.repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.repo, "keep.txt"), "keep");
  assert.equal((await f.run("feature/blocked", "main")).reason, "git-target-dirty");
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(f.repo, "keep.txt"), "utf8"), "keep");
  fs.unlinkSync(path.join(f.repo, "keep.txt"));
  fs.mkdirSync(path.join(f.repo, ".git", "rebase-merge"));
  const result = await f.run("feature/blocked", "main");
  assert.equal(result.reason, "git-operation-active");
  assert.equal(fs.existsSync(path.join(f.repo, ".git", "rebase-merge")), true);
});

test("git nodes: conflicts are collected and this merge is aborted back to clean original HEAD", async (t) => {
  const f = fixture(t);
  const cwd = f.add("feature/conflict");
  f.commit(cwd, "base.txt", "source\n");
  f.commit(f.repo, "base.txt", "target\n");
  const before = f.git(f.repo, "rev-parse", "HEAD");
  const result = await f.run("feature/conflict", "main");
  assert.equal(result.ok, false); assert.equal(result.reason, "git-merge-conflict");
  assert.deepEqual(result.conflicts, ["base.txt"]); assert.equal(result.recoveryRequired, undefined);
  assert.equal(result.afterHead, before); assert.equal(f.git(f.repo, "rev-parse", "HEAD"), before);
  assert.equal(f.git(f.repo, "status", "--porcelain"), "");
  assert.equal(fs.existsSync(path.join(f.repo, ".git", "MERGE_HEAD")), false);
  assert.equal(fs.readFileSync(path.join(f.repo, "base.txt"), "utf8"), "target\n");
});

test("git nodes: existing user merge remains untouched and same-branch merge is rejected", async (t) => {
  const f = fixture(t);
  const first = f.add("feature/first"); const second = f.add("feature/second");
  f.commit(first, "base.txt", "source\n"); f.commit(f.repo, "base.txt", "target\n");
  assert.throws(() => f.git(f.repo, "merge", "--no-edit", "feature/first"));
  const existing = f.git(f.repo, "rev-parse", "MERGE_HEAD");
  const result = await f.run("feature/second", "main");
  assert.equal(result.reason, "git-operation-active");
  assert.equal(f.git(f.repo, "rev-parse", "MERGE_HEAD"), existing);
  f.git(f.repo, "merge", "--abort");
  assert.equal((await f.run("main", "main")).reason, "git-same-branch");
});

test("git nodes: cancellation before execution does not prepare a worktree", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "branch", "feature/cancelled");
  const controller = new AbortController(); controller.abort();
  const result = await f.run("feature/cancelled", undefined, { signal: controller.signal });
  assert.equal(result.ok, false); assert.equal(result.stopped, true);
  assert.equal(result.recoveryRequired, undefined);
  assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});

test("git nodes: timeout during merge hook preserves uncertain state and never retries", async (t) => {
  const f = fixture(t);
  const cwd = f.add("feature/slow"); f.commit(cwd, "feature.txt", "feature\n");
  const hook = path.join(f.repo, ".git", "hooks", "pre-merge-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho attempted >> .git/merge-attempts\necho AGENTHUB_MERGE_HOOK_READY\nsleep 10\n", { mode: 0o755 });
  // Advance the deadline timer only after Git has entered its write hook. A
  // loaded test machine must not accidentally test a preflight read timeout.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered = false, result;
  try {
    result = await runGitNode({ command: { projectPath: f.repo, gitAction: "merge", branch: "feature/slow", targetBranch: "main", timeoutSec: 60 },
      onOutput(output) {
        if (!entered && output.includes("AGENTHUB_MERGE_HOOK_READY")) { entered = true; t.mock.timers.tick(60_000); }
      },
    });
  } finally { t.mock.timers.reset(); }
  assert.equal(entered, true);
  assert.equal(result.ok, false, result.output); assert.equal(result.timedOut, true);
  assert.equal(result.recoveryRequired, true); assert.match(result.output, /자동으로 재시도하지/);
  assert.equal(fs.readFileSync(path.join(f.repo, ".git", "merge-attempts"), "utf8").trim(), "attempted");
});

test("git nodes: repository lock serializes Git panel writes across nested worktree operations", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "branch", "feature/queued");
  fs.writeFileSync(path.join(f.repo, "panel.txt"), "panel");
  let release, entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const blocker = withGitRepoLock(path.join(f.repo, ".git"), async () => { entered(); await new Promise((resolve) => { release = resolve; }); });
  await enteredPromise;
  const preparing = f.run("feature/queued");
  const staging = stage(f.repo, ["panel.txt"]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(f.git(f.repo, "diff", "--cached", "--name-only"), "");
  release(); await blocker;
  const result = await preparing; await staging;
  assert.equal(result.ok, true, result.output);
  assert.equal(f.git(f.repo, "diff", "--cached", "--name-only"), "panel.txt");
});


test("git nodes: actual busy callback blocks this repository and ignores same branch names elsewhere", async (t) => {
  const f = fixture(t); const other = fixture(t);
  const cwd = f.add("feature/shared-name"); const otherCwd = other.add("feature/shared-name");
  const unrelated = [{ state: "running", cwd: otherCwd, worktree: { branch: "feature/shared-name", dir: otherCwd } }, { state: "running", cwd: other.repo }];
  const list = await listGitNodeBranches(f.repo, { sessions: unrelated });
  assert.equal(list.branches.find((branch) => branch.name === "main").targetSelectable, true);
  assert.equal(list.branches.find((branch) => branch.name === "feature/shared-name").useSelectable, true);
  const allowed = await f.run("feature/shared-name", undefined, { sessions: unrelated });
  assert.equal(allowed.ok, true, allowed.output);
  const blocked = await f.run("feature/shared-name", undefined, {
    sessions: [{ state: "idle", cwd, worktree: { branch: "feature/shared-name", dir: cwd } }],
    isSessionBusy: () => true,
  });
  assert.equal(blocked.reason, "git-session-running");
});


test("git nodes: failed restoration reports recovery required and leaves evidence intact", async (t) => {
  const f = fixture(t);
  const cwd = f.add("feature/abort-fails"); f.commit(cwd, "feature.txt", "feature\n");
  const hook = path.join(f.repo, ".git", "hooks", "pre-merge-commit");
  fs.writeFileSync(hook, "#!/bin/sh\n: > .git/index.lock\nexit 1\n", { mode: 0o755 });
  const before = f.git(f.repo, "rev-parse", "HEAD");
  const result = await f.run("feature/abort-fails", "main");
  assert.equal(result.ok, false); assert.equal(result.reason, "git-recovery-required", result.output);
  assert.equal(result.recoveryRequired, true);
  assert.equal(fs.existsSync(path.join(f.repo, ".git", "index.lock")), true);
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), before);
});

test("git nodes: cancelled queued runs return promptly and never execute after lock release", async (t) => {
  const f = fixture(t); f.git(f.repo, "branch", "feature/queued-cancel");
  let release, entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const blocker = withGitRepoLock(path.join(f.repo, ".git"), async () => { entered(); await new Promise((resolve) => { release = resolve; }); });
  await enteredPromise;
  const controller = new AbortController();
  const pending = f.run("feature/queued-cancel", undefined, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  const result = await pending;
  assert.equal(result.stopped, true); assert.equal(result.recoveryRequired, undefined);
  release(); await blocker;
  await withGitRepoLock(path.join(f.repo, ".git"), () => {});
  assert.equal(f.git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskService } from "../server/application/tasks.mjs";
import { GitHubError, normalizePull } from "../server/github.mjs";
import { normalizeIssue } from "../server/issues.mjs";
import { DEFAULT_GITFLOW_SETTINGS, gitflowSettingsKey } from "../server/gitflow-settings.mjs";

function fixture(t, { develop = true, main = "main", developBranch = "develop", settings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-tasks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = path.join(root, "repo"), remote = path.join(root, "origin.git"), dataDir = path.join(root, "data");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", "-q", remote);
  git(repo, "init", "-q", "-b", main);
  git(repo, "config", "user.name", "Task Test"); git(repo, "config", "user.email", "task@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", remote); git(repo, "push", "-q", "origin", main);
  if (develop) { git(repo, "branch", developBranch); git(repo, "push", "-q", "origin", developBranch); }
  const state = { pulls: [], issues: [], writes: [], refs: [], sends: [], running: new Set(), timeout: null, saves: 0, saveError: null, sendError: null, issueError: null };
  const config = settings ? { gitflow: { [gitflowSettingsKey(repo)]: settings } } : {};
  const stored = new Map(); let serial = 0;
  const store = { list: () => [...stored.values()], get: (id) => stored.get(id) };
  const sessions = { checkSessionOptions() {}, async createSession(body, internal) {
    if (state.createSessionError) throw state.createSessionError;
    const session = { id: `session-${++serial}`, title: body.title, projectPath: body.project.path, cwd: internal.worktree.dir,
      taskId: internal.taskId, worktree: internal.worktree, state: "idle", events: [] };
    stored.set(session.id, session); return session;
  }, sendMessage(id, body) { state.sends.push({ id, ...body }); if (state.sendError) throw state.sendError; return { ok: true }; } };
  const remoteSha = (branch) => git(repo, "ls-remote", remote, `refs/heads/${branch}`).split(/\s+/)[0] || null;
  const github = {
    async target(dir, selected) { return { dir, repo: "acme/widget", name: selected, pushMatches: true }; },
    async api(target, method, endpoint, body) {
      if (method === "GET" && endpoint.includes("/pulls?")) return state.pulls.filter((pull) =>
        (endpoint.includes("state=all") || pull.state === "open") && endpoint.includes(encodeURIComponent(`acme:${pull.head.ref}`))
        && endpoint.includes(`base=${encodeURIComponent(pull.base.ref)}`));
      if (method === "POST" && endpoint.endsWith("/git/refs")) {
        state.writes.push("develop");
        state.refs.push(body.ref);
        if (remoteSha(body.ref.replace(/^refs\/heads\//, ""))) throw new GitHubError("HTTP 422 exists");
        git(repo, "push", "-q", remote, `${body.sha}:${body.ref}`); return { ref: body.ref };
      }
      if (method === "GET" && /\/issues\/\d+$/.test(endpoint)) {
        if (state.issueError) throw state.issueError;
        const issue = state.issues.find((item) => item.number === Number(endpoint.split("/").at(-1)));
        if (!issue) throw new GitHubError("gh: Not Found (HTTP 404)");
        return issue;
      }
      if (method === "GET" && /\/pulls\/\d+$/.test(endpoint)) return state.pulls.find((item) => item.number === Number(endpoint.split("/").at(-1)));
      if (method === "POST" && endpoint.endsWith("/pulls")) {
        state.writes.push("develop-pull");
        const raw = { number: state.pulls.length + 1, title: body.title, body: body.body, state: "open", head: { ref: body.head, sha: remoteSha(body.head) }, base: { ref: body.base } };
        state.pulls.push(raw); return raw;
      }
      if (method === "PATCH" && /\/pulls\/\d+$/.test(endpoint)) {
        state.writes.push("pull-update");
        const pull = state.pulls.find((item) => item.number === Number(endpoint.split("/").at(-1)));
        pull.body = body.body; return pull;
      }
      throw Error(`Unexpected GitHub call: ${method} ${endpoint}`);
    },
    async push(dir, body) {
      state.writes.push("push");
      assert.equal(git(dir, "rev-parse", "HEAD"), body.expectedHead);
      git(dir, "push", "-q", remote, `${body.expectedHead}:refs/heads/${body.branch}`);
      for (const pull of state.pulls.filter((pull) => pull.head.ref === body.branch && pull.state === "open")) pull.head.sha = body.expectedHead;
      if (state.timeout === "push") throw new GitHubError("timeout", "github-timeout", 504, true);
      return { ok: true };
    },
    async create(dir, body) {
      state.writes.push("pull");
      const raw = { number: state.pulls.length + 1, title: body.title, body: body.body, state: "open",
        head: { ref: body.head, sha: body.expectedHead }, base: { ref: body.base } };
      state.pulls.push(raw);
      if (state.timeout === "pull") throw new GitHubError("timeout", "github-timeout", 504, true);
      return { pull: normalizePull(raw, "acme/widget") };
    },
    async detail(dir, number) { return { pull: normalizePull(state.pulls.find((pull) => pull.number === number), "acme/widget") }; },
    async merge(dir, number, body) {
      const pull = state.pulls.find((item) => item.number === number);
      assert.equal(body.sha, pull.head.sha);
      git(repo, "switch", "-q", pull.base.ref); git(repo, "merge", "--no-ff", "--no-edit", body.sha); git(repo, "push", "-q", "origin", pull.base.ref);
      state.writes.push("merge"); pull.merged = true; pull.state = "closed";
      return { pull: normalizePull(pull, "acme/widget") };
    },
    async remoteHead(target, branch) { return remoteSha(branch); },
  };
  const issues = {
    async viewer() { return "me"; },
    async create(dir, body) {
      state.writes.push("issue");
      const raw = { number: 100 + state.issues.length, title: body.title, body: body.body, state: "open", user: { login: "me" }, assignees: [{ login: body.assignee }] };
      state.issues.push(raw); return { ok: true, issue: normalizeIssue(raw, "acme/widget") };
    },
  };
  const options = { dataDir, store, config, saveConfig: (value) => { assert.equal(value, config); state.saves++; if (state.saveError) throw state.saveError; }, runner: { isRunning: (id) => state.running.has(id) }, sessions,
    projects: { ensureProject: (projectPath) => ({ name: "repo", path: projectPath }) }, github, issues };
  let service = createTaskService(options);
  const create = (type = "feature", extra = {}) => service.create({ projectPath: repo, title: "새 작업", type, agent: "codex", ...extra });
  function change(dir, filename = "change.txt", text = "change\n") { fs.writeFileSync(path.join(dir, filename), text); }
  function commit(dir, filename = "remote-change.txt") { change(dir, filename); git(dir, "add", "."); git(dir, "commit", "-qm", filename); }
  return { repo, remote, dataDir, config, state, git, create, change, commit, stored, get service() { return service; }, restart() { service = createTaskService(options); return service; } };
}

test("task review: selected commit preserves other staged files and rejects stale previews", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  f.change(task.cwd, "chosen.txt", "chosen\n"); f.change(task.cwd, "staged.txt", "keep staged\n");
  f.git(task.cwd, "add", "staged.txt");
  const reviewed = await f.service.review(task.id);
  f.change(task.cwd, "chosen.txt", "edited after review\n");
  await assert.rejects(f.service.commitReview(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, files: ["chosen.txt"], message: "choose" }), error => error.reason === "task-stale-review");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
  const current = await f.service.review(task.id);
  await f.service.commitReview(task.id, { expectedHead: current.head, reviewToken: current.token, files: ["chosen.txt"], message: "choose" });
  assert.equal(f.git(task.cwd, "show", "HEAD:chosen.txt"), "edited after review");
  assert.equal(f.git(task.cwd, "diff", "--cached", "--name-only"), "staged.txt");
  assert.throws(() => f.git(task.cwd, "show", "HEAD:staged.txt"));
  const remaining = await f.service.review(task.id);
  await assert.rejects(f.service.finish(task.id, { expectedHead: remaining.head, reviewToken: remaining.token }), error => error.reason === "task-dirty");
  assert.equal(f.state.writes.length, 0);
});

test("task review: dirty and behind work can commit, integrate, review and publish in order", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo); f.git(f.repo, "push", "-q", "origin", "develop");
  f.change(task.cwd, "local.txt");
  let review = await f.service.review(task.id);
  assert.equal(review.task.freshness.behind, true);
  await f.service.commitReview(task.id, { expectedHead: review.head, reviewToken: review.token, files: ["local.txt"], message: "local" });
  review = await f.service.review(task.id);
  await f.service.sync(task.id, { expectedHead: review.head, reviewToken: review.token });
  const stale = review; review = await f.service.review(task.id);
  assert.equal(review.clean, true); assert.equal(review.task.freshness.behind, false);
  await assert.rejects(f.service.finish(task.id, { expectedHead: stale.head, reviewToken: stale.token }), error => error.reason === "task-stale-review");
  const result = await f.service.finish(task.id, { expectedHead: review.head, reviewToken: review.token, message: "", verification: "반영 후 확인" });
  assert.equal(result.task.state, "review"); assert.match(result.pull.body, /반영 후 확인/);
});

test("task review: local finish reuses clean target worktree, pushes normally, and cleans only task folder", async (t) => {
  const f = fixture(t);
  await f.service.updateSettings(f.repo, { settings: DEFAULT_GITFLOW_SETTINGS, finishMode: "local" });
  const { task } = await f.create();
  assert.equal(task.finishMode, "local");
  f.commit(task.cwd, "completed.txt");
  const reviewed = await f.service.review(task.id);
  const result = await f.service.finish(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead, push: true });
  assert.equal(result.task.state, "merged"); assert.equal(result.task.completion.publishState, "done");
  assert.equal(f.git(f.repo, "ls-remote", "origin", "refs/heads/develop").split(/\s+/)[0], result.task.completion.targetHead);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
  assert.equal(f.state.writes.length, 0, "local flow never needs GitHub APIs");
  assert.equal((await f.service.refresh(task.id)).task.state, "merged");
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned"); assert.equal(fs.existsSync(task.cwd), false);
  assert.equal(fs.existsSync(result.task.completion.cwd), true);
  assert.equal((await f.restart().settings(f.repo)).finishMode, "local");
});

test("task review: local finish rejects moved or dirty targets without changing source", async (t) => {
  const f = fixture(t); const { task } = await f.create(); f.commit(task.cwd, "completed.txt");
  const before = await f.service.review(task.id);
  f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo, "target.txt");
  await assert.rejects(f.service.finish(task.id, { mode: "local", expectedHead: before.head, reviewToken: before.token, expectedTargetHead: before.localTargetHead }), error => error.reason === "task-stale-review");
  await f.service.sync(task.id, { mode: "local" });
  const reviewed = await f.service.review(task.id); f.change(f.repo, "dirty.txt");
  await assert.rejects(f.service.finish(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead }), error => error.reason === "git-target-dirty");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
  assert.equal(f.service.get(task.id).state, "working");
});

test("task review: existing PR description updates and merge pins reviewed head", async (t) => {
  const f = fixture(t); const { task } = await f.create(); f.change(task.cwd);
  await f.service.finish(task.id, { description: "첫 설명" });
  const updated = await f.service.finish(task.id, { description: "수정 설명", verification: "검증 완료" });
  assert.match(updated.pull.body, /수정 설명/); assert.equal(f.state.pulls.length, 1);
  const reviewed = await f.service.review(task.id);
  await assert.rejects(f.service.mergePull(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, expectedPullHead: "0".repeat(40) }), error => error.reason === "task-stale-head");
  const merged = await f.service.mergePull(task.id, { expectedHead: reviewed.head, reviewToken: reviewed.token, expectedPullHead: reviewed.head, method: "merge" });
  assert.equal(merged.task.state, "merged");
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
});

test("tasks: missing develop starts from latest main without modifying the source worktree", async (t) => {
  const f = fixture(t, { develop: false });
  f.change(f.repo, "keep-local.txt", "source changes\n");
  const before = f.git(f.repo, "rev-parse", "HEAD");
  const { task, session } = await f.create();
  assert.equal(task.baseCommit, before); assert.equal(task.needsDevelopSetup, true);
  assert.equal(session.cwd, task.cwd); assert.equal(f.git(f.repo, "branch", "--show-current"), "main");
  assert.equal(fs.existsSync(path.join(task.cwd, "keep-local.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.repo, "keep-local.txt"), "utf8"), "source changes\n");
  assert.equal(f.restart().list(f.repo).tasks[0].id, task.id);
  f.change(task.cwd);
  const result = await f.service.finish(task.id, { verification: "테스트 통과" });
  assert.equal(result.task.state, "review"); assert.equal(result.pull.baseRefName, "develop");
  assert.deepEqual(f.state.writes, ["develop", "push", "pull"]);
});

test("tasks: develop must include main before creating a feature but hotfix remains available", async (t) => {
  const f = fixture(t);
  f.commit(f.repo); f.git(f.repo, "push", "-q", "origin", "main");
  const context = await f.service.context(f.repo);
  assert.equal(context.mainMissing, true); assert.equal(context.state, "needs-update");
  await assert.rejects(f.create(), (error) => error.reason === "gitflow-develop-behind");
  const { task } = await f.create("hotfix");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), f.git(f.repo, "rev-parse", "main"));
});

test("tasks: fetch failure never reports current and preserves existing work", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.git(f.repo, "remote", "set-url", "origin", path.join(f.repo, "missing-origin.git"));
  const context = await f.service.context(f.repo);
  assert.equal(context.state, "error");
  await assert.rejects(f.service.sync(task.id));
  assert.equal(f.service.list(f.repo).tasks[0].freshness.state, "error");
  assert.ok(fs.existsSync(task.cwd));
});

test("tasks: target sync rejects dirty changes and only merges the development target", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.git(f.repo, "switch", "-q", "develop"); f.commit(f.repo); f.git(f.repo, "push", "-q", "origin", "develop");
  f.change(task.cwd);
  await assert.rejects(f.service.sync(task.id), (error) => error.reason === "task-dirty");
  f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "local");
  await f.service.sync(task.id);
  assert.equal(f.service.list(f.repo).tasks[0].freshness.state, "current");
  assert.ok(fs.existsSync(path.join(task.cwd, "remote-change.txt")));
});

test("tasks: finishing commits, publishes and reuses a PR; running sessions block mutations", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create();
  f.change(task.cwd);
  f.state.running.add(session.id);
  await assert.rejects(f.service.finish(task.id), (error) => error.reason === "running");
  f.state.running.clear();
  const first = await f.service.finish(task.id, { message: "feat: 테스트 작업", description: "작업 설명", verification: "검증 결과" });
  assert.equal(first.task.state, "review"); assert.equal(first.pull.number, 1);
  assert.match(first.pull.body, /검증 결과/);
  const second = await f.service.finish(task.id);
  assert.equal(second.pull.number, 1); assert.equal(f.state.pulls.length, 1);
  assert.equal(f.state.writes.filter((value) => value === "pull").length, 1);
});

test("tasks: uncertain PR write survives restart and resolves by lookup without duplicate creation", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); f.state.timeout = "pull";
  await assert.rejects(f.service.finish(task.id), (error) => error.outcomeUnknown);
  assert.equal(f.restart().list(f.repo).tasks[0].pendingAction.action, "pull");
  await assert.rejects(f.service.finish(task.id), (error) => error.reason === "task-outcome-unknown");
  const refreshed = await f.service.refresh(task.id);
  assert.equal(refreshed.task.state, "review"); assert.equal(refreshed.task.pendingAction, undefined);
  assert.equal(f.state.writes.filter((value) => value === "pull").length, 1);
});

test("tasks: uncertain push resolves against the remote SHA", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); f.state.timeout = "push";
  await assert.rejects(f.service.finish(task.id), (error) => error.outcomeUnknown);
  assert.equal(f.service.list(f.repo).tasks[0].pendingAction.action, "push");
  assert.equal((await f.service.refresh(task.id)).task.pendingAction, undefined);
  f.state.timeout = null;
  assert.equal((await f.service.finish(task.id)).task.state, "review");
});

test("tasks: cleanup uses merged PR head for squash, preserves sessions, and blocks future execution", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create(); f.change(task.cwd);
  await f.service.finish(task.id);
  const raw = f.state.pulls[0]; raw.merged = true; raw.state = "closed";
  // The merged SHA need not be an ancestor after squash; GitHub metadata identifies the reviewed head.
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--squash", task.branch); f.git(f.repo, "commit", "-qm", "squashed PR");
  f.git(f.repo, "push", "-q", "origin", "develop");
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned"); assert.equal(fs.existsSync(task.cwd), false);
  assert.ok(f.stored.has(session.id));
  assert.throws(() => f.service.assertSession(f.stored.get(session.id)), (error) => error.reason === "task-completed");
});

test("tasks: cleanup refuses dirty files and extra commits created after merge", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd); await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.change(task.cwd, "untracked.txt");
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "task-dirty");
  f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "after merge");
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "task-unmerged-commits");
  assert.ok(fs.existsSync(task.cwd));
});

test("tasks: an existing workbranch preserves its shared folder and branch after task cleanup", async (t) => {
  const f = fixture(t);
  const branch = "agenthub/borrowed";
  const cwd = path.join(path.dirname(f.repo), "borrowed-work");
  f.git(f.repo, "worktree", "add", "-b", branch, cwd, "develop");
  const legacy = { id: "legacy", title: "Legacy session", projectPath: f.repo, cwd, worktree: { dir: cwd, branch }, state: "idle", events: [] };
  f.stored.set(legacy.id, legacy);
  f.change(cwd, "pending.txt", "keep existing changes\n");
  const { task } = await f.create("feature", { workBranch: branch });
  assert.equal(path.resolve(task.cwd), path.resolve(cwd));
  assert.equal(task.ownsWorktree, false);
  assert.equal(task.ownsBranch, false);
  assert.equal(legacy.taskId, task.id);
  assert.ok(task.sessionIds.includes(legacy.id));
  assert.equal(fs.readFileSync(path.join(cwd, "pending.txt"), "utf8"), "keep existing changes\n");
  await assert.rejects(f.create("feature", { workBranch: branch }), (error) => error.reason === "task-branch-exists");
  await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--no-edit", branch); f.git(f.repo, "push", "-q", "origin", "develop");
  const result = await f.service.cleanup(task.id);
  assert.equal(result.task.state, "cleaned");
  assert.equal(result.task.worktreePreserved, true);
  assert.equal(result.task.localBranchRemoved, false);
  assert.equal(fs.existsSync(cwd), true);
  assert.ok(f.git(f.repo, "rev-parse", `refs/heads/${branch}`));
});

test("tasks: choosing an unchecked-out branch only cleans the new folder, preserving the branch", async (t) => {
  const f = fixture(t);
  const branch = "feature/existing";
  f.git(f.repo, "branch", branch, "develop");
  const { task } = await f.create("feature", { workBranch: branch });
  assert.equal(task.branch, branch);
  assert.equal(task.ownsWorktree, true);
  assert.equal(task.ownsBranch, false);
  f.change(task.cwd); await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--no-edit", branch); f.git(f.repo, "push", "-q", "origin", "develop");
  await f.service.cleanup(task.id);
  assert.equal(fs.existsSync(task.cwd), false);
  assert.ok(f.git(f.repo, "rev-parse", `refs/heads/${branch}`));
});

test("tasks: hotfix cleanup waits for propagation from main to develop", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("hotfix"); f.change(task.cwd); await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "merge", "--no-edit", task.branch); f.git(f.repo, "push", "-q", "origin", "main");
  await assert.rejects(f.service.cleanup(task.id), (error) => error.reason === "gitflow-develop-pending");
  f.git(f.repo, "switch", "-q", "develop"); f.git(f.repo, "merge", "--no-edit", "main"); f.git(f.repo, "push", "-q", "origin", "develop");
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
});

test("tasks: one running session owns the task and switching the worktree branch blocks execution", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create();
  const second = await f.service.addSession(task.id, { agent: "claude" });
  f.state.running.add(second.session.id);
  assert.throws(() => f.service.assertSession(f.stored.get(session.id)), (error) => error.reason === "running");
  f.state.running.clear(); f.git(task.cwd, "checkout", "--detach", "-q");
  assert.throws(() => f.service.assertSession(f.stored.get(session.id)), (error) => error.reason === "task-worktree");
});

test("tasks: standard GitFlow dual merges do not falsely block development or hotfix cleanup", async (t) => {
  const f = fixture(t);
  const { task } = await f.create("hotfix"); f.change(task.cwd); await f.service.finish(task.id);
  f.state.pulls[0].merged = true; f.state.pulls[0].state = "closed";
  f.git(f.repo, "merge", "--no-ff", "-m", "hotfix into main", task.branch);
  f.git(f.repo, "push", "-q", "origin", "main");
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--no-ff", "-m", "hotfix into develop", task.branch);
  f.git(f.repo, "push", "-q", "origin", "develop");
  assert.notEqual(f.git(f.repo, "rev-parse", "main"), f.git(f.repo, "rev-parse", "develop"));
  const context = await f.service.context(f.repo);
  assert.equal(context.mainMissing, false); assert.equal(context.state, "current");
  assert.equal((await f.service.cleanup(task.id)).task.state, "cleaned");
  assert.equal((await f.create()).task.baseBranch, "develop");
});

test("tasks: explicit refresh permits a safe retry when an uncertain write never reached GitHub", async (t) => {
  const f = fixture(t);
  const { task } = await f.create(); f.change(task.cwd);
  const file = path.join(path.dirname(path.dirname(task.cwd)), "data", "tasks", `${task.id}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.pendingAction = { action: "pull", expectedHead: f.git(task.cwd, "rev-parse", "HEAD"), startedAt: new Date().toISOString(), outcomeUnknown: true };
  fs.writeFileSync(file, JSON.stringify(stored));
  f.restart();
  const refreshed = await f.service.refresh(task.id);
  assert.equal(refreshed.task.pendingAction, undefined);
  assert.equal(refreshed.task.lastRecovery.result, "not-observed");
  assert.equal(f.state.writes.length, 0);
  assert.equal((await f.service.finish(task.id)).task.state, "review");
});

test("tasks: invalid finish input and existing Git operations cause no external writes", async (t) => {
  const f = fixture(t, { develop: false });
  const { task } = await f.create(); f.change(task.cwd);
  await assert.rejects(f.service.finish(task.id, { message: " " }), (error) => error.status === 400);
  assert.equal(f.state.writes.length, 0);
  const marker = f.git(task.cwd, "rev-parse", "--git-path", "MERGE_HEAD");
  fs.writeFileSync(path.resolve(task.cwd, marker), f.git(task.cwd, "rev-parse", "HEAD") + "\n");
  await assert.rejects(f.service.sync(task.id), (error) => error.reason === "task-git-operation");
  await assert.rejects(f.service.finish(task.id), (error) => error.reason === "task-git-operation");
  assert.equal(fs.existsSync(path.resolve(task.cwd, marker)), true);
  assert.equal(f.state.writes.length, 0);
});

test("tasks: a failed worktree hook preserves provisioning records and session creation recovers the branch", async (t) => {
  const f = fixture(t);
  const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(f.create());
  const [task] = f.service.list(f.repo).tasks;
  assert.ok(task); assert.equal(task.provisioning, true);
  assert.equal(f.git(f.repo, "rev-parse", `refs/heads/${task.branch}`), task.baseCommit);
  fs.unlinkSync(hook);
  // Recover even if only the created branch remains after the original operation.
  if (fs.existsSync(task.cwd)) f.git(f.repo, "worktree", "remove", task.cwd);
  f.restart();
  const recovered = await f.service.addSession(task.id, { agent: "codex" });
  assert.equal(recovered.task.provisioning, undefined);
  assert.equal(recovered.task.sessionIds.length, 1);
  assert.equal(recovered.session.cwd, task.cwd);
  assert.equal(f.git(task.cwd, "branch", "--show-current"), task.branch);
});

const customGitflow = { main: "Main", develop: "Develop", featurePrefix: "Feature/", hotfixPrefix: "Fix/", releasePrefix: "Release/" };

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

test("tasks: without a worktree the source folder switches to the task branch and returns on cleanup", async (t) => {
  const f = fixture(t);
  f.change(f.repo, "dirty.txt");
  await assert.rejects(f.create("feature", { worktree: false }), (error) => error.reason === "task-dirty");
  fs.rmSync(path.join(f.repo, "dirty.txt"));
  await assert.rejects(f.create("feature", { worktree: false, workBranch: "feature/x" }), /새 작업 브랜치만/);

  const { task, session } = await f.create("feature", { worktree: false });
  assert.equal(task.inPlace, true); assert.equal(task.previousBranch, "main"); assert.equal(task.ownsWorktree, false);
  assert.equal(path.resolve(task.cwd), path.resolve(f.repo)); assert.equal(session.cwd, task.cwd);
  assert.equal(f.git(f.repo, "branch", "--show-current"), task.branch);
  assert.equal(fs.existsSync(path.join(path.dirname(f.repo), "repo.agenthub")), false); // 워크트리 폴더를 만들지 않는다.
  await assert.rejects(f.create("feature", { worktree: false }), (error) => error.reason === "task-in-place");

  f.change(task.cwd);
  await f.service.finish(task.id);
  const raw = f.state.pulls[0]; raw.merged = true; raw.state = "closed";
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned"); assert.equal(cleaned.task.localBranchRemoved, true);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main"); // 작업 전 브랜치로 돌아온다.
  assert.ok(fs.existsSync(f.repo));
});

test("tasks: concurrent create and start requests reuse one task, session and initial dispatch after restart", async (t) => {
  const f = fixture(t);
  const body = { title: "Start once", content: "Implement the requested change", start: true, requestId: "start-concurrent-001" };
  const results = await Promise.all([f.create("feature", body), f.create("feature", body)]);
  assert.equal(results[0].task.id, results[1].task.id);
  assert.equal(results[0].session.id, results[1].session.id);
  assert.equal(results.filter((result) => result.reused).length, 1);
  assert.equal(f.service.list(f.repo).tasks.length, 1);
  assert.equal(f.stored.size, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal(results[0].task.initialStart.state, "sent");
  assert.equal(results[0].task.initialStart.sessionId, results[0].session.id);

  f.restart();
  f.state.running.add(results[0].session.id);
  f.git(f.repo, "remote", "set-url", "origin", path.join(f.repo, "missing-origin.git"));
  const replay = await f.create("feature", body);
  assert.equal(replay.reused, true);
  assert.equal(replay.task.id, results[0].task.id);
  assert.equal(replay.session.id, results[0].session.id);
  assert.equal(replay.startError, undefined);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.stored.size, 1);
});

test("tasks: a create request id cannot silently apply a changed draft", async (t) => {
  const f = fixture(t);
  const body = { title: "Original draft", content: "Original request", start: true, requestId: "start-draft-change-001" };
  const first = await f.create("feature", body);
  await assert.rejects(f.create("feature", { ...body, content: "A different request" }),
    (error) => error.status === 409 && error.reason === "task-request-changed");
  assert.equal(f.service.list(f.repo).tasks.length, 1);
  assert.equal(f.service.list(f.repo).tasks[0].content, body.content);
  assert.equal(f.stored.size, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal((await f.create("feature", body)).task.id, first.task.id);
});

test("tasks: create and start dispatches the persisted title, content and acceptance criteria", async (t) => {
  const f = fixture(t);
  const body = { title: "  Task title  ", content: "  Implement this\nwith these details  ", acceptance: "  Check A\nCheck B  ",
    start: true, requestId: "start-prompt-content-001", initialPrompt: "Untrusted replacement prompt" };
  const { task, session } = await f.create("feature", body);
  assert.equal(task.title, "Task title");
  assert.equal(task.content, "Implement this\nwith these details");
  assert.equal(task.acceptance, "Check A\nCheck B");
  assert.deepEqual(f.state.sends, [{ id: session.id, prompt: "Task title\n\nImplement this\nwith these details\n\n완료 기준:\nCheck A\nCheck B" }]);
  const persisted = f.restart().list(f.repo).tasks[0];
  assert.equal(persisted.content, task.content);
  assert.equal(persisted.acceptance, task.acceptance);
  assert.equal(persisted.initialStart.state, "sent");
});

test("tasks: a failed initial dispatch preserves the task and never automatically sends again", async (t) => {
  const f = fixture(t);
  const body = { title: "Retain partial result", start: true, requestId: "start-send-failure-001" };
  f.state.sendError = Error("connection lost after dispatch");
  const first = await f.create("feature", body);
  assert.equal(first.task.initialStart.state, "failed");
  assert.equal(first.task.initialStart.sessionId, first.session.id);
  assert.match(first.startError, /connection lost after dispatch/);
  assert.ok(fs.existsSync(first.task.cwd));
  assert.equal(f.git(first.task.cwd, "branch", "--show-current"), first.task.branch);
  assert.equal(f.state.sends[0].prompt, body.title);
  f.state.sendError = null;
  for (const restart of [false, true]) {
    if (restart) f.restart();
    const replay = await f.create("feature", body);
    assert.equal(replay.reused, true);
    assert.equal(replay.task.id, first.task.id);
    assert.equal(replay.session.id, first.session.id);
    assert.equal(replay.startError, first.startError);
  }
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.stored.size, 1);
  assert.equal(f.service.list(f.repo).tasks.length, 1);
});

test("tasks: interrupted initial dispatch records remain reviewable without replaying on restart", async (t) => {
  const f = fixture(t);
  const body = { title: "Interrupted start", start: true, requestId: "start-interrupted-001" };
  const first = await f.create("feature", body);
  const file = path.join(f.dataDir, "tasks", `${first.task.id}.json`);
  for (const state of [undefined, "sending"]) {
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state) persisted.initialStart = { state, sessionId: first.session.id, startedAt: new Date().toISOString() };
    else delete persisted.initialStart;
    fs.writeFileSync(file, JSON.stringify(persisted));
    f.restart();
    const replay = await f.create("feature", body);
    assert.equal(replay.reused, true);
    assert.equal(replay.task.id, first.task.id);
    assert.equal(replay.session.id, first.session.id);
    assert.equal(typeof replay.startError, "string");
    assert.ok(replay.startError.length > 0);
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.stored.size, 1);
  }
});

test("tasks: initial session creation failure returns a reusable task without retrying creation", async (t) => {
  const f = fixture(t);
  const body = { title: "Session failure", start: true, requestId: "start-session-failure-001" };
  f.state.createSessionError = Error("provider unavailable");
  const first = await f.create("feature", body);
  assert.equal(first.session, undefined);
  assert.equal(first.task.initialStart.state, "failed");
  assert.deepEqual(first.task.sessionIds, []);
  assert.match(first.startError, /provider unavailable/);
  assert.ok(fs.existsSync(first.task.cwd));
  f.state.createSessionError = null;
  f.restart();
  const replay = await f.create("feature", body);
  assert.equal(replay.reused, true);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.session, undefined);
  assert.equal(replay.startError, first.startError);
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.stored.size, 0);
  assert.equal(f.service.list(f.repo).tasks.length, 1);
});

test("tasks: start requires an explicit boolean, request id and session before any task is created", async (t) => {
  const f = fixture(t);
  for (const start of ["true", "false", 1, 0, null, {}]) {
    await assert.rejects(f.create("feature", { start }), (error) => error.status === 400);
  }
  await assert.rejects(f.create("feature", { start: true }), (error) => error.status === 400);
  await assert.rejects(f.create("feature", { start: true, requestId: "start-invalid-session-001", session: false }),
    (error) => error.status === 400);
  assert.equal(f.service.list(f.repo).tasks.length, 0);
  assert.equal(f.stored.size, 0);
  assert.equal(f.state.sends.length, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(f.repo), "repo.agenthub")), false);
  const created = await f.create("feature", { start: false });
  assert.ok(created.session);
  assert.equal(created.task.initialStart, undefined);
  assert.equal(f.state.sends.length, 0);
});

test("task review: local integration blocks running ordinary sessions in source or target subfolders", async (t) => {
  const f = fixture(t);
  f.git(f.repo, "switch", "-q", "develop");
  fs.mkdirSync(path.join(f.repo, "nested"));
  f.commit(f.repo, "nested/keep.txt");
  f.git(f.repo, "push", "-q", "origin", "develop");
  const { task } = await f.create();
  f.commit(task.cwd, "completed.txt");
  const reviewed = await f.service.review(task.id);
  const body = { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, expectedTargetHead: reviewed.localTargetHead };
  for (const cwd of [path.join(f.repo, "nested"), path.join(task.cwd, "nested")]) {
    f.stored.set("nested-worker", { id: "nested-worker", projectPath: cwd, cwd, state: "running", events: [] });
    f.state.running.add("nested-worker");
    await assert.rejects(f.service.finish(task.id, body), error => error.reason === "git-session-running" || error.reason === "running");
    assert.equal(f.git(f.repo, "rev-parse", "develop"), reviewed.localTargetHead);
    assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), reviewed.head);
    assert.equal(f.service.get(task.id).state, "working");
  }
  assert.equal(f.state.writes.length, 0);
});

test("task review: commit and sync persist a newly selected local integration mode", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  assert.equal(task.finishMode, "pr");
  f.change(task.cwd, "chosen.txt");
  let reviewed = await f.service.review(task.id);
  const committed = await f.service.commitReview(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token, files: ["chosen.txt"], message: "chosen" });
  assert.equal(committed.task.finishMode, "local");
  assert.equal(f.restart().get(task.id).finishMode, "local");

  const file = path.join(f.dataDir, "tasks", `${task.id}.json`);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.finishMode = "pr";
  fs.writeFileSync(file, JSON.stringify(persisted));
  f.restart();
  reviewed = await f.service.review(task.id);
  const synced = await f.service.sync(task.id, { mode: "local", expectedHead: reviewed.head, reviewToken: reviewed.token });
  assert.equal(synced.task.finishMode, "local");
  assert.equal(f.restart().get(task.id).finishMode, "local");
});

test("task review: uncertain local commit can be confirmed without GitHub access", async (t) => {
  const f = fixture(t); const { task } = await f.create();
  const before = f.git(task.cwd, "rev-parse", "HEAD");
  f.commit(task.cwd, "committed-before-disconnect.txt");
  const after = f.git(task.cwd, "rev-parse", "HEAD");
  const file = path.join(f.dataDir, "tasks", `${task.id}.json`);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.pendingAction = { action: "commit", expectedHead: before, outcomeUnknown: true, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(persisted));
  let githubCalls = 0;
  const recovering = createTaskService({ dataDir: f.dataDir,
    store: { list: () => [...f.stored.values()], get: id => f.stored.get(id) },
    runner: { isRunning: id => f.state.running.has(id) },
    github: { async target() { githubCalls++; throw Error("GitHub is unavailable"); } },
  });
  const recovered = await recovering.refresh(task.id);
  assert.equal(githubCalls, 0);
  assert.equal(recovered.task.pendingAction, undefined);
  assert.equal(recovered.task.lastRecovery.result, "confirmed");
  assert.equal(f.git(task.cwd, "rev-parse", "HEAD"), after);
  assert.equal(f.restart().get(task.id).pendingAction, undefined);
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

test("tasks: issues link by number or creation, survive restart, close through the PR and sync state", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create();
  f.state.issues.push({ number: 7, title: "로그인 버튼", body: "", state: "open", user: { login: "lead" } });
  await assert.rejects(f.service.linkIssue(task.id, { number: "abc" }), (error) => error.status === 400);
  await assert.rejects(f.service.linkIssue(task.id, { number: 8 }), (error) => error.status === 404 && /#8/.test(error.message));
  f.state.running.add(session.id);
  const linked = await f.service.linkIssue(task.id, { number: "#7" });
  f.state.running.clear();
  assert.deepEqual([linked.task.issue.number, linked.task.issue.state, linked.task.issue.url], [7, "open", "https://github.com/acme/widget/issues/7"]);
  const other = await f.create();
  await assert.rejects(f.service.linkIssue(other.task.id, { number: 7 }), (error) => error.reason === "task-issue-linked");
  const created = await f.service.linkIssue(other.task.id, { create: true });
  assert.equal(created.task.issue.number, 101); assert.equal(f.state.issues.at(-1).title, "새 작업");
  assert.equal(f.restart().get(task.id).issue.number, 7, "the link is stored with the task");
  f.change(task.cwd);
  const finished = await f.service.finish(task.id, { verification: "확인" });
  assert.match(finished.pull.body, /Closes #7/);
  f.state.issues[0].state = "closed";
  assert.equal((await f.service.refresh(task.id)).task.issue.state, "closed");
  f.state.issueError = new GitHubError("GitHub CLI 인증이 필요합니다.", "gh-auth", 401);
  const failed = await f.service.refresh(task.id);
  assert.equal(failed.task.state, "review", "an unreadable issue never fails the task refresh");
  assert.equal(failed.task.issue.errorReason, "gh-auth"); assert.equal(failed.task.issue.state, "closed");
  assert.equal((await f.service.unlinkIssue(task.id)).task.issue, undefined);
});

test("tasks: 단계 표시용 상태는 변경·커밋·게시를 차례로 반영하고 작업 기록을 바꾸지 않는다", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create();
  let status = await f.service.status(task.id);
  assert.deepEqual({ dirty: status.dirty, commits: status.commits, pushed: status.pushed, sessions: status.sessions, running: status.running, folder: status.folder },
    { dirty: 0, commits: 0, pushed: false, sessions: 1, running: 0, folder: true });
  f.change(task.cwd, "a.txt"); f.change(task.cwd, "b.txt");
  f.state.running.add(session.id);
  status = await f.service.status(task.id);
  assert.equal(status.dirty, 2); assert.equal(status.running, 1);
  f.state.running.clear();
  f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "work");
  status = await f.service.status(task.id);
  assert.equal(status.dirty, 0); assert.equal(status.commits, 1); assert.equal(status.pushed, false);
  assert.equal(status.shortHead, status.head.slice(0, 7));
  const before = JSON.stringify(f.service.get(task.id));
  const review = await f.service.review(task.id);
  await f.service.finish(task.id, { expectedHead: review.head, reviewToken: review.token, message: "" });
  status = await f.service.status(task.id);
  assert.equal(status.state, "review"); assert.equal(status.pushed, true); assert.equal(status.commits, 1);
  assert.notEqual(before, JSON.stringify(f.service.get(task.id)));
  const stable = JSON.stringify(f.service.get(task.id));
  await f.service.status(task.id);
  assert.equal(JSON.stringify(f.service.get(task.id)), stable);
});

test("tasks: 유형별 분기 기준과 PR 대상이 GitFlow 설정과 같다", async (t) => {
  const f = fixture(t);
  const feature = (await f.create("feature")).task;
  const hotfix = (await f.create("hotfix", { title: "긴급" })).task;
  const release = (await f.create("release", { title: "배포", version: "1.2.0" })).task;
  assert.deepEqual([feature.baseBranch, feature.targetBranch, feature.branch.startsWith("feature/")], ["develop", "develop", true]);
  assert.deepEqual([hotfix.baseBranch, hotfix.targetBranch, hotfix.branch.startsWith("hotfix/")], ["main", "main", true]);
  assert.deepEqual([release.baseBranch, release.targetBranch, release.branch], ["develop", "main", "release/1.2.0"]);
});

test("tasks: 기준 반영 충돌은 원문 대신 한국어 설명과 해결 방법을 남긴다", async (t) => {
  const f = fixture(t);
  const { task } = await f.create();
  f.git(f.repo, "switch", "-q", "develop"); f.change(f.repo, "same.txt", "develop\n"); f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "develop");
  f.git(f.repo, "push", "-q", "origin", "develop");
  f.change(task.cwd, "same.txt", "task\n"); f.git(task.cwd, "add", "."); f.git(task.cwd, "commit", "-qm", "task");
  await assert.rejects(f.service.sync(task.id), (error) => {
    assert.equal(error.reason, "task-conflict");
    assert.doesNotMatch(error.message, /CONFLICT|Automatic merge/);
    assert.match(error.hint, /충돌/);
    assert.match(error.raw, /CONFLICT/);
    return true;
  });
  const stored = f.service.get(task.id);
  assert.equal(stored.errorReason, "task-conflict"); assert.match(stored.errorHint, /충돌/);
});

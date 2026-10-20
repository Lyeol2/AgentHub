import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../test-support/git-client-fixture.mjs";
import { run } from "../test-support/git-fixture.mjs";
import { createGitService } from "../server/application/git.mjs";
import { createTaskService } from "../server/application/tasks.mjs";
import { githubPulls, GitHubError } from "../server/github.mjs";

const pull = { number: 17, state: "MERGED", headRefOid: "a".repeat(40) };
const mergeBody = { number: pull.number, remote: "origin", repo: "acme/widget", method: "squash", sha: pull.headRefOid };

function serviceFor(f, sessions = [], tasks) {
  const notifications = [];
  const service = createGitService({
    sessions: { list: () => sessions, getSession: id => sessions.find(session => session.id === id) },
    projects: { projectSessions: () => sessions },
    runner: { isRunning: () => false, isBusy: id => ["running", "background"].includes(sessions.find(session => session.id === id)?.state) },
    tasks: () => tasks,
    notify: (...args) => notifications.push(args),
  });
  return { notifications, execute: (action, body = {}) => service.execute(action, { projectPath: f.repo, ...body }) };
}

function editFiles(f) {
  fs.writeFileSync(path.join(f.repo, "base.txt"), "staged change\n");
  run(f.repo, "add", "base.txt");
  fs.appendFileSync(path.join(f.repo, "base.txt"), "unstaged change\n");
  fs.writeFileSync(path.join(f.repo, "untracked.txt"), "untracked work\n");
}

function snapshot(f) {
  const names = [...new Set(run(f.repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean))].sort();
  return {
    head: f.head(), branch: run(f.repo, "branch", "--show-current"),
    status: run(f.repo, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    files: names.map(name => [name, fs.readFileSync(path.join(f.repo, name))]),
    metadata: ["index", "index.lock", "MERGE_HEAD", "ORIG_HEAD"].map(name => {
      const file = path.join(f.repo, ".git", name);
      return [name, fs.existsSync(file) ? fs.readFileSync(file) : null];
    }),
  };
}

async function mergeWithoutLocalChanges(t, f, service) {
  const before = snapshot(f);
  const merge = t.mock.method(githubPulls, "merge", async (cwd, number, body) => {
    assert.equal(cwd, fs.realpathSync.native(f.repo));
    assert.equal(number, pull.number);
    const { number: _number, ...expected } = mergeBody;
    assert.deepEqual(body, expected, "the reviewed remote PR SHA, repo and method are forwarded unchanged");
    return { ok: true, pull };
  });
  assert.deepEqual(await service.execute("mergePull", mergeBody), { ok: true, pull });
  assert.equal(merge.mock.callCount(), 1);
  assert.deepEqual(snapshot(f), before, "remote PR merge preserves local HEAD, index, files and operation markers");
  assert.equal(service.notifications.length, 1);
  assert.equal(service.notifications[0][0], "git");
}

test("Git PR merge ignores completed tasks and stale session branches while local writes stay guarded", async t => {
  for (const completed of [true, false]) await t.test(completed ? "completed task" : "stale session branch", async t => {
    const f = fixture();
    editFiles(f);
    const session = { id: "session", title: "local work", projectPath: f.repo, cwd: f.repo, state: "idle",
      worktree: { dir: f.repo, branch: completed ? "main" : "feature/previous" } };
    const dataDir = path.join(f.repo, ".git", "task-data");
    if (completed) {
      session.taskId = "finished-task";
      fs.mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "tasks", "finished-task.json"), JSON.stringify({
        id: session.taskId, title: "finished task", projectPath: f.repo, cwd: f.repo,
        gitCommonDir: path.join(f.repo, ".git"), branch: "main", state: "merged", sessionIds: [session.id],
      }));
    }
    const tasks = createTaskService({ dataDir, store: { list: () => [session], get: () => session }, runner: { isRunning: () => false } });
    const service = serviceFor(f, [session], tasks);
    const before = snapshot(f);
    const reason = completed ? "task-completed" : "workbranch-changed";
    await assert.rejects(service.execute("stage", { files: ["untracked.txt"] }), error => error.reason === reason);
    await assert.rejects(service.execute("checkout", { branch: "main" }), error => error.reason === reason);
    await assert.rejects(service.execute("commit", { message: "must stay blocked", staged: true }), error => error.reason === reason);
    assert.deepEqual(snapshot(f), before);
    await mergeWithoutLocalChanges(t, f, service);
  });
});

test("Git PR merge ignores running sessions and local Git operations without weakening local guards", async t => {
  for (const state of ["running", "background", "index.lock", "MERGE_HEAD", "dirty"]) await t.test(state, async t => {
    const f = fixture();
    run(f.repo, "branch", "source");
    editFiles(f);
    const sessions = ["running", "background"].includes(state)
      ? [{ id: "active-session", title: "local work", projectPath: f.repo, cwd: f.repo, state }] : [];
    if (["index.lock", "MERGE_HEAD"].includes(state)) fs.writeFileSync(path.join(f.repo, ".git", state), state === "MERGE_HEAD" ? f.root + "\n" : "active index writer\n");
    const service = serviceFor(f, sessions);
    const before = snapshot(f);
    if (state === "dirty") {
      const preview = await service.execute("preview", { action: "merge", branch: "source" });
      await assert.rejects(service.execute("execute", { previewId: preview.previewId }), error => error.reason === "git-dirty");
    } else {
      const reason = state === "MERGE_HEAD" ? "git-operation" : state === "index.lock" ? "git-locked" : "running";
      await assert.rejects(service.execute("stage", { files: ["untracked.txt"] }), error => error.reason === reason);
    }
    assert.deepEqual(snapshot(f), before);
    await mergeWithoutLocalChanges(t, f, service);
  });
});

test("Git PR merge preserves remote SHA, repository and protection failures", async t => {
  const f = fixture();
  editFiles(f);
  const service = serviceFor(f);
  const before = snapshot(f);
  for (const [reason, message] of [
    ["stale-head", "PR에 새 커밋이 있습니다. 내용을 다시 확인하세요."],
    ["stale-head", "원격 저장소가 바뀌었습니다. 목록을 새로고침하세요."],
    ["pull-blocked", "필수 검사 통과나 승인 리뷰 같은 보호 규칙을 아직 충족하지 않았습니다."],
  ]) {
    const merge = t.mock.method(githubPulls, "merge", async (_cwd, _number, body) => {
      assert.equal(body.sha, mergeBody.sha);
      assert.equal(body.repo, mergeBody.repo);
      throw new GitHubError(message, reason, 409);
    });
    await assert.rejects(service.execute("mergePull", mergeBody), error => error.status === 409 && error.reason === reason && error.message === message);
    assert.equal(merge.mock.callCount(), 1);
    merge.mock.restore();
  }
  assert.equal(service.notifications.length, 0);
  assert.deepEqual(snapshot(f), before);
});

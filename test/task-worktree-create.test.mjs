import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskService } from "../server/application/tasks.mjs";

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete gitEnv[key];

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, env: gitEnv, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-task-worktree-"));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("agenthub-task-worktree-"));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const repo = path.join(root, "repo"), remote = path.join(root, "origin.git");
  fs.mkdirSync(repo);
  git(root, "init", "--bare", "-q", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Task Worktree Test");
  git(repo, "config", "user.email", "task-worktree@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "Task worktree fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "Initial fixture");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "branch", "develop");
  git(repo, "push", "-q", "origin", "develop");
  return { root, repo, remote, worktrees: path.join(root, "repo.agenthub") };
}

function harness(t) {
  const f = repository(t);
  const stored = new Map(); let serial = 0;
  const store = { list: () => [...stored.values()], get: id => stored.get(id) };
  const sessions = { checkSessionOptions() {}, async createSession(body, internal) {
    const session = { id: `session-${++serial}`, title: body.title, projectPath: body.project.path, cwd: internal.worktree.dir,
      taskId: internal.taskId, worktree: internal.worktree, state: "idle", events: [] };
    stored.set(session.id, session);
    return session;
  } };
  const options = { dataDir: path.join(f.root, "data"), store, config: {}, runner: { isRunning: () => false }, sessions,
    projects: { ensureProject: projectPath => ({ name: "repo", path: projectPath }) } };
  let service = createTaskService(options);
  const create = (extra = {}) => service.create({ projectPath: f.repo, title: "새 작업", agent: "codex", session: false, ...extra });
  // git worktree list에 등록된 폴더와 브랜치
  const registered = () => git(f.repo, "worktree", "list", "--porcelain").split(/\r?\n\r?\n/).map(block => ({
    dir: path.resolve(block.match(/^worktree (.+)$/m)?.[1] ?? ""), branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
  }));
  const branches = () => git(f.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split(/\r?\n/).filter(Boolean);
  return { ...f, create, registered, branches, get service() { return service; }, restart() { service = createTaskService(options); return service; } };
}

function assertRegistered(f, task) {
  assert.equal(path.dirname(path.resolve(task.cwd)), path.resolve(f.worktrees));
  assert.ok(fs.existsSync(path.join(task.cwd, "README.md")));
  assert.ok(f.registered().some(item => item.dir.toLowerCase() === path.resolve(task.cwd).toLowerCase() && item.branch === task.branch),
    JSON.stringify(f.registered()));
  assert.equal(task.provisioning, undefined);
}

test("task worktree: default names create a registered worktree under <project>.agenthub", async t => {
  const f = harness(t);
  const { task } = await f.create();
  assertRegistered(f, task);
  assert.match(path.basename(task.cwd), /^task-/);
  // 기본 브랜치 이름은 작업 ID 없이 제목만 쓴다.
  assert.equal(task.branch, "feature/새-작업");
});

test("task worktree: chosen Korean folder and branch names create the same registered worktree", async t => {
  const f = harness(t);
  const { task } = await f.create({ worktreeName: "한글-폴더", branchName: "한글-브랜치" });
  assert.equal(path.basename(task.cwd), "한글-폴더");
  assert.equal(task.branch, "feature/한글-브랜치");
  assertRegistered(f, task);
  const { session } = await f.service.addSession(task.id, { agent: "codex" });
  assert.equal(path.resolve(session.cwd), path.resolve(task.cwd));
});

test("task worktree: a deleted but unpruned worktree at the same path no longer blocks creation", async t => {
  const f = harness(t);
  const stale = path.join(f.worktrees, "stale");
  git(f.repo, "worktree", "add", "-q", "-b", "leftover", stale);
  fs.rmSync(stale, { recursive: true, force: true });
  const { task } = await f.create({ worktreeName: "stale", branchName: "stale-retry" });
  assertRegistered(f, task);
});

test("task worktree: an empty folder left by an earlier attempt is reused, a used folder is not", async t => {
  const f = harness(t);
  fs.mkdirSync(path.join(f.worktrees, "empty"), { recursive: true });
  const { task } = await f.create({ worktreeName: "empty" });
  assertRegistered(f, task);
  fs.mkdirSync(path.join(f.worktrees, "used"));
  fs.writeFileSync(path.join(f.worktrees, "used", "keep.txt"), "keep\n");
  await assert.rejects(f.create({ worktreeName: "used" }), error => error.reason === "task-worktree-exists");
  assert.equal(fs.readFileSync(path.join(f.worktrees, "used", "keep.txt"), "utf8"), "keep\n");
});

test("task worktree: a failed checkout leaves no task, branch or folder and can be retried",
  { skip: process.platform !== "win32" && "Windows에서만 체크아웃할 수 없는 파일 이름을 쓴다" }, async t => {
    const f = harness(t);
    // git은 새 브랜치를 먼저 만든 뒤 체크아웃에서 실패한다.
    const blob = git(f.repo, "hash-object", "-w", "README.md");
    git(f.repo, "-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},bad:name.txt`);
    git(f.repo, "-c", "core.protectNTFS=false", "commit", "-qm", "Windows invalid name");
    git(f.repo, "push", "-q", "-f", "origin", "HEAD:develop");
    const before = f.branches();
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.create({ worktreeName: "retry", branchName: "retry" }), error => {
        assert.equal(error.reason, "task-worktree-create");
        assert.match(error.message, /파일 이름/);
        assert.match(error.message, /bad:name\.txt/);
        return true;
      });
      assert.deepEqual(f.service.list(f.repo).tasks, []);
      assert.deepEqual(f.branches(), before);
      assert.equal(fs.existsSync(f.worktrees), false);
      assert.equal(f.registered().length, 1);
    }
  });

test("task worktree: a provisioning task whose folder was lost recovers when a session attaches", async t => {
  const f = harness(t);
  const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(f.create({ worktreeName: "hooked" }));
  fs.unlinkSync(hook);
  const [task] = f.service.list(f.repo).tasks;
  assert.equal(task.provisioning, true);
  // 폴더가 지워져 등록만 남고, 그 자리에 빈 폴더가 다시 생긴 상태
  fs.rmSync(task.cwd, { recursive: true, force: true });
  fs.mkdirSync(task.cwd);
  f.restart();
  const recovered = await f.service.addSession(task.id, { agent: "codex" });
  assertRegistered(f, recovered.task);
});

test("task worktree: original folder use is reported so the creator can choose a worktree", async t => {
  const f = harness(t);
  assert.deepEqual(await f.service.inPlaceStatus(f.repo), { available: true });
  fs.writeFileSync(path.join(f.repo, "dirty.txt"), "dirty\n");
  assert.equal((await f.service.inPlaceStatus(f.repo)).reason, "task-dirty");
  fs.unlinkSync(path.join(f.repo, "dirty.txt"));
  const { task } = await f.create({ worktree: false, title: "원본 작업" });
  assert.equal(task.inPlace, true);
  assert.equal(git(f.repo, "branch", "--show-current"), task.branch);
  const busy = await f.service.inPlaceStatus(f.repo);
  assert.equal(busy.available, false);
  assert.equal(busy.reason, "task-in-place");
  assert.match(busy.message, /원본 작업/);
  // 워크트리를 고르면 원본 폴더를 쓰는 작업이 있어도 만든다.
  const { task: isolated } = await f.create();
  assertRegistered(f, isolated);
});

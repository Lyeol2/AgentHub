// 워크트리 폴더 삭제 공통 함수: 잠김 재시도, 기록만 남은 폴더, 기록 없이 남은 폴더, 커밋하지 않은 변경을 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { removeWorktreeDir, taskGit } from "../server/tasks.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-worktree-remove-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const add = (name) => {
    const dir = path.join(root, "repo.agenthub", name);
    git(repo, "worktree", "add", "-q", "-b", `feature/${name}`, dir);
    return dir;
  };
  const registered = (dir) => git(repo, "worktree", "list", "--porcelain").split(/\r?\n/)
    .some((line) => line.startsWith("worktree ") && path.resolve(line.slice(9)).toLowerCase() === path.resolve(dir).toLowerCase());
  return { root, repo, git, add, registered };
}
const noWait = { delay: 0, wait: async () => {} };

test("worktree remove: 깨끗한 폴더는 무시하는 파일(node_modules)이 있어도 지우고 기록도 남기지 않는다", async (t) => {
  const f = fixture(t);
  const dir = f.add("clean");
  fs.writeFileSync(path.join(f.repo, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  f.git(dir, "add", ".gitignore"); f.git(dir, "commit", "-qm", "ignore");
  fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "x");
  const result = await removeWorktreeDir(f.repo, dir, noWait);
  assert.deepEqual([result.removed, result.registered], [true, false]);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(f.registered(dir), false);
});

test("worktree remove: 커밋하지 않은 변경이 있으면 재시도하지 않고 바로 멈추며 폴더를 지키고, force면 지운다", async (t) => {
  const f = fixture(t);
  const dir = f.add("dirty");
  fs.writeFileSync(path.join(dir, "work.txt"), "unsaved\n");
  let removes = 0;
  const git = (cwd, args, options) => { if (args[1] === "remove") removes++; return taskGit(cwd, args, options); };
  await assert.rejects(removeWorktreeDir(f.repo, dir, { ...noWait, git }), (error) => error.reason === "task-dirty");
  assert.equal(removes, 1);
  assert.ok(fs.existsSync(path.join(dir, "work.txt")));
  assert.equal((await removeWorktreeDir(f.repo, dir, { ...noWait, force: true })).removed, true);
});

test("worktree remove: 파일을 잠깐 잡고 있어 실패해도 다시 시도해 지운다", async (t) => {
  const f = fixture(t);
  const dir = f.add("locked");
  let failures = 2;
  const git = (cwd, args, options) => {
    if (args[1] === "remove" && failures-- > 0) return Promise.reject(Object.assign(Error("error: failed to delete: Permission denied"), { reason: "git-error" }));
    return taskGit(cwd, args, options);
  };
  const result = await removeWorktreeDir(f.repo, dir, { ...noWait, git });
  assert.equal(result.removed, true);
  assert.equal(f.registered(dir), false);
});

test("worktree remove: 끝내 지우지 못하면 남은 상태와 마지막 오류를 돌려준다", async (t) => {
  const f = fixture(t);
  const dir = f.add("stuck");
  const git = (cwd, args, options) => args[1] === "remove"
    ? Promise.reject(Object.assign(Error("error: failed to delete: Permission denied"), { reason: "git-error" }))
    : taskGit(cwd, args, options);
  const result = await removeWorktreeDir(f.repo, dir, { ...noWait, attempts: 3, git });
  assert.deepEqual([result.removed, result.registered], [false, true]);
  assert.match(result.error.message, /Permission denied/);
});

test("worktree remove: 폴더만 사라졌으면 기록을 prune하고, 기록 없이 남은 폴더는 마저 지운다", async (t) => {
  const f = fixture(t);
  const gone = f.add("gone");
  fs.rmSync(gone, { recursive: true, force: true });
  assert.equal(f.registered(gone), true);
  assert.equal((await removeWorktreeDir(f.repo, gone, noWait)).removed, true);
  assert.equal(f.registered(gone), false);

  const leftover = path.join(f.root, "repo.agenthub", "leftover");
  fs.mkdirSync(path.join(leftover, "deep"), { recursive: true });
  fs.writeFileSync(path.join(leftover, "deep", "file.txt"), "left\n");
  const result = await removeWorktreeDir(f.repo, leftover, noWait);
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(leftover), false);
});

// 임시 Git 저장소에서 이름 검증과 실제 작업 폴더 생성을 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, removeWorktree, validateWorktreeName } from "../server/git.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-worktree-test-"));
const repo = path.join(tmp, "repo");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
fs.mkdirSync(repo);
git("init", "-q");
git("config", "core.autocrlf", "false");
fs.writeFileSync(path.join(repo, "file.txt"), "committed contents\n");
git("add", ".");
git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "initial");

test.after(() => {
  const resolved = path.resolve(tmp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("agenthub-worktree-test-"));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
});

test("worktree: 이름은 직접 입력해야 하며 경로와 브랜치에 안전한 단일 이름만 받는다", () => {
  for (const value of [undefined, null, "", "  ", 123, false, {}]) {
    assert.throws(() => validateWorktreeName(value), /이름을 입력하세요/);
  }
  for (const value of [".", "..", "../outside", "a/b", "a\\b", "C:\\outside", "/outside", "a b", ".hidden", "-branch", "_branch", "a.", "a.lock", "a..b", "a@{b", "a:b", "a?b", "a*b", "a[b", "a~b", "a^b", "a\nb", "x".repeat(65)]) {
    assert.throws(() => validateWorktreeName(value), /1~64자/, value);
  }
  for (const value of ["CON", "prn", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9"]) {
    assert.throws(() => validateWorktreeName(value), /Windows 예약어/, value);
  }
  for (const value of ["s1", "s2", "s3", "s4", "한글-기능_2", "ㄱ-구현", "9", "COM10", "context", "x".repeat(64)]) {
    assert.equal(validateWorktreeName(value), value);
  }
  assert.equal(validateWorktreeName("  작업_이름-1  "), "작업_이름-1");
});

test("worktree: 잘못된 이름은 Git이나 폴더를 바꾸기 전에 거부한다", async () => {
  const before = git("worktree", "list", "--porcelain");
  for (const name of [undefined, " ", "../outside", "C:\\outside", "NUL"]) {
    await assert.rejects(createWorktree(repo, name));
  }
  assert.equal(fs.existsSync(repo + ".agenthub"), false);
  assert.equal(fs.existsSync(path.join(tmp, "outside")), false);
  assert.equal(git("worktree", "list", "--porcelain"), before);
});

test("worktree: 입력한 이름으로 HEAD에서 분리하고 원본의 미커밋 변경은 보존한다", async () => {
  fs.writeFileSync(path.join(repo, "file.txt"), "uncommitted contents\n");
  fs.writeFileSync(path.join(repo, "pending.txt"), "untracked contents\n");
  const made = await createWorktree(repo, "  기능_구현-1  ");
  assert.equal(made.dir, path.join(repo + ".agenthub", "기능_구현-1"));
  assert.equal(made.branch, "agenthub/기능_구현-1");
  assert.equal(fs.readFileSync(path.join(made.dir, "file.txt"), "utf8"), "committed contents\n");
  assert.equal(fs.existsSync(path.join(made.dir, "pending.txt")), false);
  assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf8"), "uncommitted contents\n");
  assert.equal(fs.readFileSync(path.join(repo, "pending.txt"), "utf8"), "untracked contents\n");
  await assert.rejects(createWorktree(repo, "기능_구현-1"), /이미 있습니다/);
  await removeWorktree(repo, made.dir);
  assert.equal(fs.existsSync(made.dir), false);
  await assert.rejects(createWorktree(repo, "기능_구현-1"), /브랜치.*이미 있습니다/);
});

// 전체 테스트 통과 기록: 깨끗한 작업 트리에서만 남기고, 코드가 같으면(문서만 다르면) 릴리스가 재사용한다.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordPass, readStamps, testedMatch } from "../scripts/test-stamp.mjs";

test("test stamp: 깨끗할 때만 기록하고, 문서만 바뀐 커밋은 같은 코드로 본다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-stamp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commit = (message) => { git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message); return git("rev-parse", "HEAD"); };
  git("init", "-q");
  fs.writeFileSync(path.join(root, "app.mjs"), "export const a = 1;\n");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.txt"), "가이드\n");
  const first = commit("first");
  assert.equal(testedMatch(root), null, "기록이 없으면 테스트를 돌린다");
  // 커밋하지 않은 변경(새 파일 포함)이 있으면 기록하지 않는다.
  fs.writeFileSync(path.join(root, "new.mjs"), "x\n");
  assert.equal(recordPass(root), null);
  fs.rmSync(path.join(root, "new.mjs"));
  assert.equal(recordPass(root), first);
  assert.equal(readStamps(root)[0].commit, first);
  // 문서만 바뀐 커밋: 같은 코드
  fs.writeFileSync(path.join(root, "README.md"), "# 설명\n");
  fs.writeFileSync(path.join(root, "docs", "guide.txt"), "고친 가이드\n");
  commit("docs");
  assert.equal(testedMatch(root)?.commit, first);
  // 코드가 바뀌면 다시 테스트한다.
  fs.writeFileSync(path.join(root, "app.mjs"), "export const a = 2;\n");
  commit("code");
  assert.equal(testedMatch(root), null);
  // 같은 커밋을 다시 통과하면 맨 앞으로 옮기고 겹치지 않는다.
  const third = recordPass(root);
  recordPass(root);
  assert.deepEqual(readStamps(root).map((item) => item.commit), [third, first]);
});

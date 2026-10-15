import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitFixtures, run } from "../test-support/git-fixture.mjs";
import { gitOverview, fileDiff, stage, unstage, commit } from "../server/gitpanel.mjs";

const graphRepo = gitFixtures(test, "agenthub-git-staging-");

test("gitpanel: 두 영역의 diff를 나누고 index 내용만 커밋한다", async () => {
  const dir = graphRepo("staging");
  fs.writeFileSync(path.join(dir, "partial.txt"), "base\n");
  await commit(dir, "기준");
  fs.writeFileSync(path.join(dir, "partial.txt"), "base\nstaged\n");
  await stage(dir, ["partial.txt"]);
  fs.writeFileSync(path.join(dir, "partial.txt"), "base\nstaged\nworktree\n");
  fs.writeFileSync(path.join(dir, "other.txt"), "other\n");
  const overview = await gitOverview(dir);
  assert.deepEqual([overview.stagedCount, overview.unstagedCount], [1, 2]);
  const partial = overview.files.find((f) => f.path === "partial.txt");
  assert.deepEqual([partial.x, partial.y, partial.staged, partial.unstaged, partial.stageLabel, partial.workLabel], ["M", "M", true, true, "수정", "수정"]);
  assert.deepEqual(overview.files.find((f) => f.path === "other.txt").stageLabel, null);
  const stagedDiff = await fileDiff(dir, "partial.txt", "staged");
  assert.match(stagedDiff, /\+staged/);
  assert.doesNotMatch(stagedDiff, /worktree/);
  const workDiff = await fileDiff(dir, "partial.txt", "unstaged");
  assert.match(workDiff, /\+worktree/);
  assert.doesNotMatch(workDiff, /\+staged/);
  await assert.rejects(fileDiff(dir, "other.txt", "staged"), /변경된 파일/);
  await assert.rejects(fileDiff(dir, "partial.txt", "bogus"), /영역/);
  await commit(dir, "index만", null, { staged: true });
  assert.equal(run(dir, "show", "HEAD:partial.txt").replace(/\r\n/g, "\n"), "base\nstaged\n");
  assert.equal(fs.readFileSync(path.join(dir, "partial.txt"), "utf8"), "base\nstaged\nworktree\n");
  assert.equal(run(dir, "ls-tree", "--name-only", "HEAD").trim(), "partial.txt");
  assert.deepEqual([(await gitOverview(dir)).stagedCount, (await gitOverview(dir)).unstagedCount], [0, 2]);
  await assert.rejects(commit(dir, "빈 index", null, { staged: true }), /스테이징된 변경/);
});

test("gitpanel: 스테이징 취소는 작업 내용과 다른 index 파일을 보존한다", async () => {
  const dir = graphRepo("unstaging");
  fs.writeFileSync(path.join(dir, "a.txt"), "base a\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "base b\n");
  await commit(dir, "기준");
  fs.writeFileSync(path.join(dir, "a.txt"), "index a\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "index b\n");
  await stage(dir, ["a.txt", "b.txt"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "working a\n");
  await unstage(dir, ["a.txt"]);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "working a\n");
  assert.equal(run(dir, "show", ":a.txt").trim(), "base a");
  assert.equal(run(dir, "show", ":b.txt").trim(), "index b");
  assert.deepEqual((await gitOverview(dir)).files.map((f) => [f.path, f.staged, f.unstaged]), [["a.txt", false, true], ["b.txt", true, false]]);
  await assert.rejects(stage(dir, []), /고르세요/);
  await assert.rejects(stage(dir, "a.txt"), /고르세요/);
  await assert.rejects(stage(dir, ["a.txt", "missing.txt"]), /상태가 바뀌었습니다/);
  assert.equal(run(dir, "show", ":a.txt").trim(), "base a"); // 목록 전체 검증 뒤에만 변경한다.
  await assert.rejects(unstage(dir, ["a.txt"]), /상태가 바뀌었습니다/);
  await stage(dir, ["a.txt"]); // 거절된 요청 뒤에도 queue가 계속 동작한다.
});

test("gitpanel: staged rename의 수정과 취소는 양쪽 이름 및 내용을 올바르게 처리한다", async () => {
  const dir = graphRepo("stage-rename");
  fs.writeFileSync(path.join(dir, "old.txt"), "base\n");
  await commit(dir, "기준");
  run(dir, "mv", "old.txt", "new.txt");
  fs.appendFileSync(path.join(dir, "new.txt"), "work\n");
  let overview = await gitOverview(dir);
  const renamed = overview.files.find((f) => f.path === "new.txt");
  assert.deepEqual([renamed.orig, renamed.staged, renamed.unstaged, renamed.stageLabel, renamed.workLabel], ["old.txt", true, true, "이름 바꿈", "수정"]);
  assert.match(await fileDiff(dir, "new.txt", "staged"), /rename from old.txt/);
  assert.doesNotMatch(await fileDiff(dir, "new.txt", "staged"), /\+work/);
  assert.match(await fileDiff(dir, "new.txt", "unstaged"), /\+work/);
  await stage(dir, ["new.txt"]);
  assert.match(run(dir, "show", ":new.txt"), /work/);
  await unstage(dir, ["new.txt"]);
  assert.equal(fs.existsSync(path.join(dir, "old.txt")), false);
  assert.equal(fs.readFileSync(path.join(dir, "new.txt"), "utf8"), "base\nwork\n");
  assert.equal(run(dir, "show", ":old.txt").trim(), "base");
  overview = await gitOverview(dir);
  assert.equal(overview.stagedCount, 0);
  assert.deepEqual(overview.files.map((f) => f.path), ["old.txt", "new.txt"]);
  await stage(dir, ["old.txt", "new.txt"]);
  await commit(dir, "새 이름", null, { staged: true });
  assert.equal(run(dir, "ls-tree", "--name-only", "HEAD").trim(), "new.txt");
  fs.rmSync(path.join(dir, "new.txt"));
  await stage(dir, ["new.txt"]);
  assert.equal((await gitOverview(dir)).files[0].stageLabel, "삭제");
  await unstage(dir, ["new.txt"]);
  assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
  assert.equal((await gitOverview(dir)).files[0].workLabel, "삭제");
});

test("gitpanel: 첫 커밋 전의 스테이징 취소도 수정된 작업 파일을 보존한다", async () => {
  const dir = graphRepo("stage-unborn");
  fs.writeFileSync(path.join(dir, "new.txt"), "index\n");
  await stage(dir, ["new.txt"]);
  assert.match(await fileDiff(dir, "new.txt", "staged"), /\+index/);
  fs.writeFileSync(path.join(dir, "new.txt"), "work\n");
  await unstage(dir, ["new.txt"]);
  assert.equal(fs.readFileSync(path.join(dir, "new.txt"), "utf8"), "work\n");
  assert.equal(run(dir, "ls-files").trim(), "");
  await stage(dir, ["new.txt"]);
  await commit(dir, "첫 커밋", null, { staged: true });
  assert.equal(run(dir, "show", "HEAD:new.txt").trim(), "work");
});

test("gitpanel: 경로의 대괄호는 패턴으로 해석하지 않고 하위 폴더에서도 루트 기준으로 처리한다", async () => {
  const dir = graphRepo("stage-literal");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "match[1].txt"), "literal base\n");
  fs.writeFileSync(path.join(dir, "match1.txt"), "pattern base\n");
  await commit(dir, "기준");
  fs.writeFileSync(path.join(dir, "match[1].txt"), "literal changed\n");
  fs.writeFileSync(path.join(dir, "match1.txt"), "pattern changed\n");
  const sub = path.join(dir, "sub");
  assert.match(await fileDiff(sub, "match[1].txt", "unstaged"), /literal changed/);
  assert.doesNotMatch(await fileDiff(sub, "match[1].txt", "unstaged"), /pattern changed/);
  await stage(sub, ["match[1].txt"]);
  assert.equal(run(dir, "show", ":match1.txt").trim(), "pattern base");
  await stage(dir, ["match1.txt"]);
  await unstage(sub, ["match[1].txt"]);
  assert.equal(run(dir, "show", ":match[1].txt").trim(), "literal base");
  assert.equal(run(dir, "show", ":match1.txt").trim(), "pattern changed");
});

test("gitpanel: 연속된 index 변경과 커밋은 겹치지 않고 요청 순서대로 실행한다", async () => {
  const dir = graphRepo("stage-queue");
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(dir, "file.txt"), String(i));
    const results = await Promise.allSettled([stage(dir, ["file.txt"]), commit(dir, "순서 " + i, null, { staged: true })]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
    assert.equal(run(dir, "show", "HEAD:file.txt"), String(i));
  }
});

test("gitpanel: 영역 개수는 표시 제한 밖의 파일까지 센다", async () => {
  const dir = graphRepo("stage-count");
  const names = Array.from({ length: 502 }, (_, i) => "file-" + String(i).padStart(3, "0") + ".txt");
  for (const name of names) fs.writeFileSync(path.join(dir, name), "index\n");
  await stage(dir, names);
  for (const name of names) fs.appendFileSync(path.join(dir, name), "work\n");
  const overview = await gitOverview(dir);
  assert.deepEqual([overview.files.length, overview.moreFiles, overview.stagedCount, overview.unstagedCount], [500, 2, 502, 502]);
});

test("gitpanel: 충돌 항목은 작업 영역에 두고 index 전용 커밋을 막는다", async () => {
  const dir = graphRepo("stage-conflict");
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  await commit(dir, "기준");
  run(dir, "checkout", "-qb", "feature");
  fs.writeFileSync(path.join(dir, "a.txt"), "feature\n");
  await commit(dir, "feature");
  run(dir, "checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "main\n");
  await commit(dir, "main");
  assert.throws(() => run(dir, "merge", "--no-edit", "feature"));
  const overview = await gitOverview(dir);
  assert.deepEqual([overview.files[0].staged, overview.files[0].unstaged, overview.files[0].workLabel], [false, true, "충돌"]);
  await assert.rejects(commit(dir, "해결 안 함", null, { staged: true }), /충돌/);
  fs.writeFileSync(path.join(dir, "a.txt"), "resolved\n");
  await stage(dir, ["a.txt"]);
  await commit(dir, "충돌 해결", null, { staged: true });
  assert.equal((await gitOverview(dir)).files.length, 0);
});


test("gitpanel: copy의 diff와 취소는 원본 파일에 스테이징한 수정을 건드리지 않는다", async () => {
  const dir = graphRepo("stage-copy");
  fs.writeFileSync(path.join(dir, "source.txt"), "one\ntwo\nthree\nfour\nfive\n");
  await commit(dir, "기준");
  run(dir, "config", "status.renames", "copies");
  run(dir, "config", "diff.renames", "copies");
  fs.copyFileSync(path.join(dir, "source.txt"), path.join(dir, "copy.txt"));
  fs.appendFileSync(path.join(dir, "source.txt"), "staged source\n");
  await stage(dir, ["source.txt", "copy.txt"]);
  const copy = (await gitOverview(dir)).files.find((f) => f.path === "copy.txt");
  assert.deepEqual([copy.x, copy.orig, copy.staged], ["C", "source.txt", true]);
  const diff = await fileDiff(dir, "copy.txt", "staged");
  assert.match(diff, /copy.txt/);
  assert.doesNotMatch(diff, /staged source/);
  await unstage(dir, ["copy.txt"]);
  assert.match(run(dir, "show", ":source.txt"), /staged source/);
  const after = await gitOverview(dir);
  assert.deepEqual(after.files.map((f) => [f.path, f.staged, f.unstaged]), [["source.txt", true, false], ["copy.txt", false, true]]);
});

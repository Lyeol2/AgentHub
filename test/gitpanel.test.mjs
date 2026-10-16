// Git 패널: 임시 git 저장소에서 상태·diff·커밋·병합을 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitFixtures, run } from "../test-support/git-fixture.mjs";
import { parseStatus, statusLabel, gitOverview, fileDiff, showCommit, branchDiff, commit, merge, checkout } from "../server/gitpanel.mjs";
import { createWorktree } from "../server/git.mjs";

// These tests intentionally share repository history and run in their original order.
const repo = gitFixtures(test, "agenthub-git-")("repo");
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
run(repo, "add", ".");
run(repo, "commit", "-qm", "init");

test("gitpanel: porcelain -z 상태를 읽는다", () => {
  const files = parseStatus(" M a.txt\0?? new.txt\0R  b.txt\0old.txt\0UU c.txt\0");
  assert.deepEqual(files.map((f) => [f.path, f.orig ?? null, statusLabel(f)]),
    [["a.txt", null, "수정"], ["new.txt", null, "새 파일"], ["b.txt", "old.txt", "이름 바꿈"], ["c.txt", null, "충돌"]]);
});

test("gitpanel: 변경 파일 diff를 보고 고른 파일만 커밋한다", async () => {
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "새 파일\n");
  const overview = await gitOverview(repo);
  assert.equal(overview.branch, "main");
  assert.deepEqual(overview.files.map((f) => [f.path, f.label]), [["a.txt", "수정"], ["b.txt", "새 파일"]]);
  assert.match(await fileDiff(repo, "a.txt"), /\+two/);
  assert.match(await fileDiff(repo, "b.txt"), /\+새 파일/);
  await assert.rejects(fileDiff(repo, "없는.txt"), /변경된 파일이 아닙니다/);

  await assert.rejects(commit(repo, " "), /메시지/);
  await assert.rejects(commit(repo, "x", ["없는.txt"]), /고르세요/);
  assert.match(await commit(repo, "a만 커밋", ["a.txt"]), /a만 커밋/);
  assert.deepEqual((await gitOverview(repo)).files.map((f) => f.path), ["b.txt"]); // 고르지 않은 파일은 남는다.
  await commit(repo, "나머지");
  assert.equal((await gitOverview(repo)).files.length, 0);
  await assert.rejects(commit(repo, "빈 커밋"), /변경이 없습니다/);

  const [last] = (await gitOverview(repo)).commits;
  assert.equal(last.subject, "나머지");
  assert.match(await showCommit(repo, last.hash), /b\.txt/);
  await assert.rejects(showCommit(repo, "--help"), /해시/);
});

test("gitpanel: 세션 브랜치의 커밋 안 한 변경을 세고, 커밋한 뒤 병합한다", async () => {
  const wt = await createWorktree(repo, "s1");
  const session = { id: "s1", title: "구현", state: "idle", worktree: wt };
  fs.writeFileSync(path.join(wt.dir, "feature.txt"), "기능\n");
  let overview = await gitOverview(repo, [session]);
  const branch = overview.branches.find((b) => b.name === wt.branch);
  assert.deepEqual([branch.sessionTitle, branch.sessionState, branch.dirty, branch.ahead], ["구현", "idle", 1, 0]);
  assert.equal(branch.tip, run(wt.dir, "rev-parse", "HEAD").trim());
  assert.equal(overview.branches[0].current, true); // 현재 브랜치를 맨 위에

  await commit(wt.dir, "기능 추가");
  overview = await gitOverview(repo, [session]);
  assert.deepEqual(overview.branches.find((b) => b.name === wt.branch).ahead, 1);
  assert.match(await branchDiff(repo, wt.branch), /feature\.txt/);
  await assert.rejects(branchDiff(repo, "-x"), /없는 브랜치/);
  await assert.rejects(merge(repo, "main"), /같은 브랜치/);

  assert.match(await merge(repo, wt.branch), /Merge branch/);
  assert.ok(fs.existsSync(path.join(repo, "feature.txt")));
});

test("gitpanel: 충돌하면 병합을 되돌리고 충돌한 파일을 알린다", async () => {
  const wt = await createWorktree(repo, "s2");
  fs.writeFileSync(path.join(wt.dir, "a.txt"), "세션 쪽\n");
  await commit(wt.dir, "세션이 a 수정");
  fs.writeFileSync(path.join(repo, "a.txt"), "원본 쪽\n");
  await commit(repo, "원본이 a 수정");
  await assert.rejects(merge(repo, wt.branch), (err) => err.conflict && /a\.txt/.test(err.message));
  assert.equal((await gitOverview(repo)).files.length, 0); // 병합 중인 상태로 남지 않는다.
  // 되돌리면 git이 파일을 다시 쓰므로 autocrlf 설정에 따라 줄 끝이 바뀔 수 있다.
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "원본 쪽\n");
});

test("gitpanel: 이름을 바꾼 파일은 새 이름만 골라도 원래 이름의 삭제까지 커밋한다", async () => {
  fs.writeFileSync(path.join(repo, "old-name.txt"), "내용\n");
  await commit(repo, "이름 바꿀 파일");
  run(repo, "mv", "old-name.txt", "new-name.txt");
  fs.writeFileSync(path.join(repo, "other.txt"), "같이 커밋하지 않을 파일\n");
  const renamed = (await gitOverview(repo)).files.find((f) => f.path === "new-name.txt");
  assert.deepEqual([renamed.orig, renamed.label], ["old-name.txt", "이름 바꿈"]);
  await commit(repo, "이름 바꿈", ["new-name.txt"]);
  assert.deepEqual((await gitOverview(repo)).files.map((f) => f.path), ["other.txt"]); // 옛 이름 삭제가 남지 않는다.
  assert.ok(!run(repo, "ls-files").includes("old-name.txt"));
  await commit(repo, "나머지 정리");
});

test("gitpanel: 사용자가 하던 병합이 있으면 병합하지 않고 그 병합을 건드리지 않는다", async () => {
  const a = await createWorktree(repo, "s3");
  const b = await createWorktree(repo, "s4");
  fs.writeFileSync(path.join(a.dir, "x.txt"), "a\n");
  await commit(a.dir, "a 쪽");
  fs.writeFileSync(path.join(repo, "x.txt"), "원본\n");
  await commit(repo, "원본 쪽");
  fs.writeFileSync(path.join(b.dir, "y.txt"), "b\n");
  await commit(b.dir, "b 쪽");
  // 사용자가 직접 병합하다 충돌이 나서 해결하는 중인 상태
  assert.throws(() => run(repo, "merge", "--no-edit", a.branch));
  await assert.rejects(merge(repo, b.branch), /진행 중인 병합/);
  assert.ok(run(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").trim()); // 사용자의 병합은 그대로 남아 있다.
  run(repo, "merge", "--abort");
});

test("git: 변경 보기는 아직 추적하지 않는 새 파일의 내용도 보여 준다", async () => {
  const { diffSince } = await import("../server/git.mjs");
  const base = run(repo, "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(repo, "brand-new.txt"), "첫 줄\n둘째 줄\n");
  fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(repo, "huge.txt"), "x".repeat(150_000));
  const { status, diff } = await diffSince(repo, base);
  assert.match(status, /\?\? brand-new\.txt/);
  assert.match(diff, /\+\+\+ b\/brand-new\.txt\n@@ -0,0 \+1,2 @@\n\+첫 줄\n\+둘째 줄/);
  assert.match(diff, /b\/blob\.bin\n@@ 바이너리 파일 @@/);
  assert.match(diff, /b\/huge\.txt\n@@ 내용 생략: 150,000 바이트/);
  for (const f of ["brand-new.txt", "blob.bin", "huge.txt"]) fs.rmSync(path.join(repo, f));
});

test("git: 한글 파일 이름도 변경 보기·바뀐 파일 목록에 그대로 나온다", async () => {
  const { diffSince, changedFiles } = await import("../server/git.mjs");
  run(repo, "config", "core.quotePath", "true"); // git 기본값: 한글 이름을 따옴표·8진수로 감싼다.
  fs.writeFileSync(path.join(repo, "기존 파일.txt"), "처음\n");
  await commit(repo, "한글 이름 파일");
  const base = run(repo, "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(repo, "기존 파일.txt"), "처음\n고침\n"); // 추적하는 한글 파일 수정
  fs.writeFileSync(path.join(repo, "새 파일.txt"), "내용\n"); // 추적하지 않는 한글 파일
  const { diff } = await diffSince(repo, base);
  assert.match(diff, /\+\+\+ b\/새 파일\.txt\n@@ -0,0 \+1,1 @@\n\+내용/);
  const files = await changedFiles(repo, base);
  assert.match(files, /M\t기존 파일\.txt/);
  assert.match(files, /A\t새 파일\.txt/);
  assert.ok(!files.includes("\\"), files); // 8진수 이스케이프가 없다.
  await commit(repo, "정리");
});

test("gitpanel: 다른 브랜치로 체크아웃하고, 다른 작업 폴더의 브랜치나 겹치는 변경은 거절한다", async () => {
  run(repo, "branch", "side");
  const wt = await createWorktree(repo, "s5");
  const overview = await gitOverview(repo, []);
  assert.equal(overview.branches.find((b) => b.name === "side").checkedOutAt, null);
  assert.ok(overview.branches.find((b) => b.name === wt.branch).checkedOutAt);
  await assert.rejects(checkout(repo, "main"), /이미 현재 브랜치/);
  await assert.rejects(checkout(repo, "-q"), /없는 브랜치/);
  await assert.rejects(checkout(repo, wt.branch), /다른 작업 폴더/);

  fs.writeFileSync(path.join(repo, "carry.txt"), "가져갈 변경\n");
  assert.equal(await checkout(repo, "side"), "side");
  assert.equal((await gitOverview(repo)).branch, "side");
  assert.ok(fs.existsSync(path.join(repo, "carry.txt"))); // 커밋하지 않은 새 파일은 따라온다.
  fs.rmSync(path.join(repo, "carry.txt"));

  fs.writeFileSync(path.join(repo, "a.txt"), "side 쪽\n");
  await commit(repo, "side가 a 수정");
  fs.writeFileSync(path.join(repo, "a.txt"), "덮어쓰면 안 되는 변경\n");
  await assert.rejects(checkout(repo, "main"), /겹쳐 체크아웃하지 않았습니다/);
  assert.equal((await gitOverview(repo)).branch, "side");
  run(repo, "checkout", "--", "a.txt");
  assert.equal(await checkout(repo, "main"), "main");
});

// Git 패널: 임시 git 저장소에서 상태·diff·커밋·병합을 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseStatus, statusLabel, gitOverview, fileDiff, showCommit, branchDiff, stage, unstage, commit, merge } from "../server/gitpanel.mjs";
import { createWorktree } from "../server/git.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-git-"));
const repo = path.join(tmp, "repo");
const run = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
fs.mkdirSync(repo);
run(repo, "init", "-q", "-b", "main");
// 이 테스트의 커밋이 사용자 git 설정(서명 등)에 기대지 않게 저장소에 이름을 둔다.
run(repo, "config", "user.name", "t");
run(repo, "config", "user.email", "t@t");
run(repo, "config", "commit.gpgsign", "false");
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
run(repo, "add", ".");
run(repo, "commit", "-qm", "init");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

// 그래프는 별도 저장소로 만들어 기존 커밋·병합 테스트의 기록에 기대지 않는다.
function graphRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.name", "t");
  run(dir, "config", "user.email", "t@t");
  run(dir, "config", "commit.gpgsign", "false");
  return dir;
}

test("gitpanel: 그래프는 다른 로컬 브랜치의 분기·병합과 브랜치 끝을 보여 준다", async () => {
  const dir = graphRepo("graph");
  run(dir, "commit", "--allow-empty", "-qm", "시작");
  const base = run(dir, "rev-parse", "HEAD").trim();
  run(dir, "checkout", "-qb", "feature");
  run(dir, "commit", "--allow-empty", "-qm", "기능 작업");
  const feature = run(dir, "rev-parse", "HEAD").trim();
  run(dir, "branch", "shared", feature);
  run(dir, "tag", "graph-tag", feature);
  run(dir, "update-ref", "refs/remotes/origin/feature", feature);
  run(dir, "checkout", "-q", "main");
  run(dir, "commit", "--allow-empty", "-qm", "메인 작업");
  const main = run(dir, "rev-parse", "HEAD").trim();

  let overview = await gitOverview(dir);
  assert.equal(overview.graph.truncated, false);
  assert.ok(!overview.commits.some((c) => c.hash === feature)); // 기존 기록은 현재 HEAD만 보여 준다.
  const featureNode = overview.graph.commits.find((c) => c.hash === feature);
  assert.deepEqual(featureNode.parents, [base]);
  assert.deepEqual(featureNode.refs, ["feature", "shared"]); // 태그와 원격 브랜치는 노선 이름에 섞이지 않는다.
  assert.equal(featureNode.subject, "기능 작업");
  assert.equal(featureNode.author, "t");
  assert.match(featureNode.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(feature.startsWith(featureNode.short));
  assert.equal(overview.branches.find((b) => b.name === "feature").tip, feature);
  assert.equal(overview.branches.find((b) => b.current).tip, main);

  run(dir, "merge", "--no-ff", "-qm", "작업 합치기", "feature");
  overview = await gitOverview(dir);
  const merged = overview.graph.commits[0];
  assert.equal(merged.subject, "작업 합치기");
  assert.deepEqual(merged.parents, [main, feature]);
  assert.deepEqual(merged.refs, ["main"]);
  assert.deepEqual(overview.graph.commits.find((c) => c.hash === base).parents, []);
  const positions = new Map(overview.graph.commits.map((c, i) => [c.hash, i]));
  for (const [index, node] of overview.graph.commits.entries()) {
    for (const parent of node.parents) assert.ok(positions.get(parent) > index);
  }

  // 분리된 HEAD의 작업도 로컬 브랜치들과 함께 남는다.
  run(dir, "checkout", "-q", "--detach", base);
  run(dir, "commit", "--allow-empty", "-qm", "분리된 작업");
  const detached = run(dir, "rev-parse", "HEAD").trim();
  overview = await gitOverview(dir);
  assert.equal(overview.branch, "HEAD");
  assert.ok(overview.graph.commits.some((c) => c.hash === detached));
  assert.ok(overview.graph.commits.some((c) => c.hash === merged.hash));
});

test("gitpanel: 커밋 없는 저장소는 빈 그래프와 변경 파일을 보여 준다", async () => {
  const dir = graphRepo("empty-graph");
  fs.writeFileSync(path.join(dir, "새 파일.txt"), "첫 작업\n");
  const overview = await gitOverview(dir);
  assert.deepEqual(overview.graph, { commits: [], truncated: false });
  assert.deepEqual(overview.commits, []);
  assert.deepEqual(overview.branches, []);
  assert.deepEqual(overview.files.map((f) => f.path), ["새 파일.txt"]);
});

test("gitpanel: 그래프는 최근 100개로 제한하고 더 오래된 부모 해시는 보존한다", async () => {
  const dir = graphRepo("long-graph");
  const stream = [];
  for (let i = 1; i <= 100; i++) {
    const subject = "commit " + i;
    stream.push("commit refs/heads/main", "mark :" + i, "committer t <t@t> " + (1700000000 + i) + " +0000",
      "data " + Buffer.byteLength(subject), subject);
    if (i > 1) stream.push("from :" + (i - 1));
    stream.push("");
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input: stream.join("\n"), encoding: "utf8" });
  let overview = await gitOverview(dir);
  assert.equal(overview.graph.commits.length, 100);
  assert.equal(overview.graph.truncated, false);
  const firstHash = overview.graph.commits.at(-1).hash;
  run(dir, "commit", "--allow-empty", "-qm", "commit 101");
  overview = await gitOverview(dir);
  assert.equal(overview.commits.length, 40);
  assert.equal(overview.graph.commits.length, 100);
  assert.equal(overview.graph.truncated, true);
  assert.equal(overview.graph.commits[0].subject, "commit 101");
  assert.deepEqual(overview.graph.commits.at(-1).parents, [firstHash]);
  assert.ok(!overview.graph.commits.some((c) => c.hash === firstHash));
});


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

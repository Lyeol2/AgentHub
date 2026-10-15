// Git 패널: 임시 git 저장소에서 상태·diff·커밋·병합을 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseStatus, statusLabel, gitOverview, fileDiff, showCommit, branchDiff, commit, merge } from "../server/gitpanel.mjs";
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

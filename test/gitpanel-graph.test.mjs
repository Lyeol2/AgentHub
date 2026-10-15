import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitFixtures, run } from "../test-support/git-fixture.mjs";
import { execFileSync } from "node:child_process";
import { gitOverview } from "../server/gitpanel.mjs";

const graphRepo = gitFixtures(test, "agenthub-git-graph-");

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

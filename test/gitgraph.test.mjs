import test from "node:test";
import assert from "node:assert/strict";
import { layoutGitGraph, gitWorkRows } from "../public/gitgraph.js";

const c = (hash, ...parents) => ({ hash, parents });
const segment = (fromLane, toLane, from, to, color) => ({ fromLane, toLane, from, to, color });
const outgoing = (row) => row.segments.filter((line) => line.from === "node");

function checkConnections(graph) {
  for (const [index, row] of graph.rows.entries()) {
    assert.ok(row.lane >= 0 && row.lane < graph.lanes);
    assert.ok(row.color >= 0 && row.color < 6);
    for (const line of row.segments) {
      assert.ok(line.fromLane >= 0 && line.fromLane < graph.lanes);
      assert.ok(line.toLane >= 0 && line.toLane < graph.lanes);
      if (line.from === "node") assert.equal(line.fromLane, row.lane);
      if (line.to === "node") assert.equal(line.toLane, row.lane);
    }
    if (!index) assert.ok(row.segments.every((line) => line.from !== "top"));
    if (index) {
      const bottom = new Set(graph.rows[index - 1].segments.filter((line) => line.to === "bottom").map((line) => line.toLane));
      const top = new Set(row.segments.filter((line) => line.from === "top").map((line) => line.fromLane));
      assert.deepEqual(top, bottom, "행 경계에서 노선이 끊기지 않는다");
    }
  }
}

test("gitgraph: 기록이 없으면 빈 그래프를 반환한다", () => {
  assert.deepEqual(layoutGitGraph([]), { rows: [], lanes: 0 });
  assert.deepEqual(layoutGitGraph(), { rows: [], lanes: 0 });
});

test("gitgraph: 일자 기록의 첫 부모와 색을 한 노선으로 이어 준다", () => {
  const commits = [c("tip", "middle"), c("middle", "root"), c("root")];
  const graph = layoutGitGraph(commits);
  assert.equal(graph.lanes, 1);
  assert.deepEqual(graph.rows.map((row) => [row.lane, row.color, row.continuation]), [[0, 0, true], [0, 0, true], [0, 0, false]]);
  assert.deepEqual(graph.rows.map((row) => row.segments), [
    [segment(0, 0, "node", "bottom", 0)],
    [segment(0, 0, "top", "node", 0), segment(0, 0, "node", "bottom", 0)],
    [segment(0, 0, "top", "node", 0)],
  ]);
  assert.strictEqual(graph.rows[0].commit, commits[0]);
  checkConnections(graph);
});

test("gitgraph: 병합 커밋의 두 부모를 갈라 그리고 공통 조상에 합친다", () => {
  const graph = layoutGitGraph([c("merge", "main", "feature"), c("main", "base"), c("feature", "base"), c("base")]);
  assert.equal(graph.lanes, 2);
  assert.deepEqual(outgoing(graph.rows[0]), [segment(0, 0, "node", "bottom", 0), segment(0, 1, "node", "bottom", 1)]);
  assert.deepEqual(graph.rows.map((row) => [row.lane, row.color]), [[0, 0], [0, 0], [1, 1], [0, 0]]);
  assert.deepEqual(outgoing(graph.rows[2]), [segment(1, 0, "node", "bottom", 1)]);
  assert.equal(graph.rows[3].continuation, false);
  checkConnections(graph);
});

test("gitgraph: 서로 다른 브랜치의 tip은 새 노선에서 시작한다", () => {
  const graph = layoutGitGraph([c("main", "main-parent"), c("feature", "feature-parent"), c("main-parent", "base"), c("feature-parent", "base"), c("base")]);
  assert.deepEqual(graph.rows.map((row) => [row.lane, row.color]), [[0, 0], [1, 1], [0, 0], [1, 1], [0, 0]]);
  assert.deepEqual(graph.rows[1].segments, [segment(0, 0, "top", "bottom", 0), segment(1, 1, "node", "bottom", 1)]);
  checkConnections(graph);
});

test("gitgraph: 노선이 닫히면 통과 노선을 옮기고 색은 유지한다", () => {
  const graph = layoutGitGraph([c("merge", "a", "b", "c"), c("a"), c("b"), c("c")]);
  assert.equal(graph.lanes, 3);
  assert.deepEqual(graph.rows[1].segments, [
    segment(0, 0, "top", "node", 0),
    segment(1, 0, "top", "bottom", 1),
    segment(2, 1, "top", "bottom", 2),
  ]);
  assert.deepEqual(graph.rows.map((row) => [row.lane, row.color]), [[0, 0], [0, 0], [0, 1], [0, 2]]);
  checkConnections(graph);
});

test("gitgraph: 부모가 셋 이상인 octopus 병합도 모두 연결한다", () => {
  const graph = layoutGitGraph([c("merge", "a", "b", "c", "d"), c("a", "base"), c("b", "base"), c("c", "base"), c("d", "base"), c("base")]);
  assert.equal(graph.lanes, 4);
  assert.deepEqual(outgoing(graph.rows[0]).map((line) => [line.toLane, line.color]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(graph.rows.map((row) => [row.lane, row.color]), [[0, 0], [0, 0], [1, 1], [1, 2], [1, 3], [0, 0]]);
  checkConnections(graph);
});

test("gitgraph: 같은 부모의 여러 작업 노드도 부모 노선을 중복하지 않는다", () => {
  const graph = layoutGitGraph([c("work:one", "head"), c("work:two", "head"), c("work:three", "head"), c("head", "base"), c("base")]);
  assert.equal(graph.lanes, 2);
  assert.deepEqual(graph.rows.map((row) => [row.lane, row.color]), [[0, 0], [1, 1], [1, 2], [0, 0], [0, 0]]);
  assert.deepEqual(outgoing(graph.rows[1]), [segment(1, 0, "node", "bottom", 1)]);
  assert.deepEqual(outgoing(graph.rows[2]), [segment(1, 0, "node", "bottom", 2)]);
  checkConnections(graph);
});

test("gitgraph: 페이지 밖 부모로 향하는 마지막 행의 선도 남긴다", () => {
  const graph = layoutGitGraph([c("merge", "outside-main", "outside-feature")]);
  assert.equal(graph.lanes, 2);
  assert.equal(graph.rows[0].continuation, true);
  assert.deepEqual(outgoing(graph.rows[0]), [segment(0, 0, "node", "bottom", 0), segment(0, 1, "node", "bottom", 1)]);
  checkConnections(graph);
});

test("gitgraph: 색상을 순환하고 중복 부모와 원본 배열을 안전하게 다룬다", () => {
  const roots = Array.from({ length: 8 }, (_, index) => c("root-" + index));
  assert.deepEqual(layoutGitGraph(roots).rows.map((row) => row.color), [0, 1, 2, 3, 4, 5, 0, 1]);
  const commits = [c("tip", "parent", "parent"), c("parent")];
  const before = JSON.stringify(commits);
  const graph = layoutGitGraph(commits);
  assert.equal(graph.lanes, 1);
  assert.equal(outgoing(graph.rows[0]).length, 1);
  assert.equal(JSON.stringify(commits), before);
  assert.deepEqual(layoutGitGraph(commits), graph);
  checkConnections(graph);
});


test("gitgraph: 작업 노드에서 시작한 점선은 기다리는 행을 지나 실제 커밋까지만 이어진다", () => {
  const graph = layoutGitGraph([
    { ...c("work:a", "tip-a"), work: true },
    { ...c("work:b", "tip-b"), work: true },
    c("tip-a", "base"),
    c("tip-b", "base"),
    c("base"),
  ]);
  assert.equal(outgoing(graph.rows[0])[0].dashed, true);
  assert.equal(graph.rows[1].segments.find((line) => line.from === "top").dashed, true);
  assert.ok(outgoing(graph.rows[1]).every((line) => line.dashed));
  assert.equal(graph.rows[2].segments.find((line) => line.to === "node").dashed, true);
  assert.equal(graph.rows[2].segments.find((line) => line.to === "bottom" && line.from === "top").dashed, true);
  assert.equal(graph.rows[3].segments.find((line) => line.to === "node").dashed, true);
  assert.ok(outgoing(graph.rows[2]).every((line) => !line.dashed));
  assert.ok(outgoing(graph.rows[3]).every((line) => !line.dashed));
  assert.equal(graph.rows[3].segments.find((line) => line.from === "top" && line.to === "bottom").dashed, undefined);
  checkConnections(graph);
});


test("gitgraph: 분리된 HEAD의 변경은 다른 브랜치가 아닌 현재 HEAD 커밋에 잇는다", () => {
  const data = { branch: "HEAD", branches: [{ name: "main", current: false, tip: "new-main" }],
    files: [{ path: "작업.txt" }], moreFiles: 0,
    commits: [c("detached", "base")], graph: { commits: [c("new-main", "base"), c("detached", "base"), c("base")] } };
  const work = gitWorkRows(data);
  assert.equal(work.length, 1);
  assert.deepEqual(work[0].parents, ["detached"]);
  assert.equal(work[0].subject, "커밋 전 변경");
  assert.equal(work[0].dirty, 1);
  assert.equal(work[0].branch.current, true);
  const graph = layoutGitGraph([...work, ...data.graph.commits]);
  checkConnections(graph);
  assert.ok(graph.rows.find((r) => r.commit.hash === "detached").segments.some((s) => s.to === "node" && s.dashed));
});

test("gitgraph: 첫 커밋 전 변경만 부모 없는 작업 노드로 표시한다", () => {
  const [work] = gitWorkRows({ branch: "HEAD", branches: [], files: [{ path: "새 파일.txt" }], moreFiles: 0, commits: [] });
  assert.deepEqual(work.parents, []);
  assert.equal(work.subject, "첫 커밋 전");
  assert.equal(work.work, true);
  assert.deepEqual(gitWorkRows({ branch: "HEAD", branches: [], files: [], moreFiles: 0, commits: [] }), []);
});

test("gitgraph: 현재 작업 폴더 변경과 실행 중인 세션은 각자의 tip에 연결한다", () => {
  const work = gitWorkRows({ branch: "main", files: [{ path: "a" }], moreFiles: 2, commits: [c("main-tip")],
    branches: [{ name: "main", current: true, tip: "main-tip" },
      { name: "agenthub/running", tip: "session-tip", sessionState: "running", dirty: 0 },
      { name: "clean", tip: "clean-tip", dirty: 0 }] });
  assert.equal(work.length, 2);
  assert.deepEqual(work.map((r) => r.parents), [["main-tip"], ["session-tip"]]);
  assert.deepEqual(work.map((r) => r.dirty), [3, 0]);
  assert.equal(work[1].subject, "작업 중");
});

test("branch short name: 브랜치 목록은 접두어와 AgentHub 작업 ID를 빼고 보여 준다", async () => {
  const { branchShortName } = await import("../public/features/git/view.js");
  assert.equal(branchShortName("feature/mvchhmuv-5343251e-기능-추가-및-개선-수정"), "기능-추가-및-개선-수정");
  assert.equal(branchShortName("Feature/login-button"), "login-button");
  assert.equal(branchShortName("main"), "main");
  assert.equal(branchShortName("feature/mvchhmuv-5343251e"), "mvchhmuv-5343251e", "작업 ID만 있으면 그대로 둔다");
  assert.equal(branchShortName("feature/"), "feature/", "남는 글자가 없으면 전체 이름을 쓴다");
});

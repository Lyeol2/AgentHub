import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskPipeline } from "../public/shared/task-stage.js";

const base = { id: "t1", type: "feature", state: "working", branch: "feature/login-ui", baseBranch: "develop", targetBranch: "develop",
  cwd: "E:/Git/AgentHub.agenthub/login-ui", freshness: { state: "current" }, pull: null, finishMode: "pr" };
const task = (extra = {}) => ({ ...base, ...extra });
const status = (extra = {}) => ({ dirty: 0, commits: 0, shortHead: "a41c9e2", pushed: false, sessions: 1, running: 0, folder: true, ...extra });
const states = (pipeline) => Object.fromEntries(pipeline.nodes.map((item) => [item.key, item.state]));
const action = (pipeline, id, label) => pipeline.actions.find((item) => item.id === id && (!label || item.label === label));

test("단계 판정: 갓 만든 작업은 작업 단계이고 마무리는 이유와 함께 꺼진다", () => {
  const p = buildTaskPipeline(task(), status(), { sessionId: "s1", sessions: 2, running: 0 });
  assert.equal(p.current, "work");
  assert.deepEqual(states(p), { base: "done", branch: "done", folder: "done", work: "current", commit: "todo", pr: "todo", target: "todo" });
  assert.equal(p.nodes.find((n) => n.key === "folder").sub, ".agenthub/login-ui");
  assert.equal(p.nodes.find((n) => n.key === "commit").sub, "아직 없음");
  assert.equal(p.nodes.find((n) => n.key === "pr").sub, "→ develop");
  const finish = action(p, "finish", "마무리");
  assert.equal(finish.primary, true); assert.equal(finish.disabled, true); assert.match(finish.reason, /변경이 없습니다/);
  assert.equal(action(p, "open-session").label, "세션 열기");
  assert.equal(p.stateLabel, "진행 중");
});

test("단계 판정: 세션 실행 중이면 작업 단계에 머물고 마무리를 막는다", () => {
  const p = buildTaskPipeline(task(), status({ dirty: 3 }), { sessions: 2, running: 1 });
  assert.equal(p.current, "work");
  assert.equal(p.nodes.find((n) => n.key === "work").sub, "세션 2개 · 실행 중");
  assert.match(action(p, "finish", "마무리").reason, /세션이 작업 중/);
});

test("단계 판정: 커밋하지 않은 변경은 커밋 단계, 커밋을 마치면 PR 단계로 넘어간다", () => {
  let p = buildTaskPipeline(task(), status({ dirty: 3 }), { running: 0 });
  assert.equal(p.current, "commit");
  assert.equal(p.nodes.find((n) => n.key === "commit").sub, "변경 3개 · 커밋 전");
  assert.equal(action(p, "finish", "마무리").disabled, false);
  p = buildTaskPipeline(task(), status({ commits: 3 }), {});
  assert.equal(p.current, "pr");
  assert.equal(states(p).commit, "done");
  assert.equal(p.nodes.find((n) => n.key === "commit").sub, "3개 · a41c9e2");
  p = buildTaskPipeline(task(), status({ commits: 3, pushed: true }), {});
  assert.equal(p.nodes.find((n) => n.key === "pr").sub, "푸시됨 · PR 전");
});

test("단계 판정: PR이 열리면 검토 대기, 병합되면 대상 브랜치에 도달한다", () => {
  const pull = { number: 13, state: "OPEN", url: "https://github.com/o/r/pull/13" };
  let p = buildTaskPipeline(task({ state: "review", pull }), status({ commits: 3 }), { sessionId: "s1" });
  assert.equal(p.current, "pr"); assert.equal(p.stateLabel, "검토 대기");
  assert.equal(p.nodes.find((n) => n.key === "pr").sub, "#13 검토 대기");
  assert.deepEqual(p.actions.map((a) => a.label), ["세션 열기", "PR 열기", "병합 검토"]);
  p = buildTaskPipeline(task({ state: "merged", pull: { ...pull, state: "MERGED" } }), status({ commits: 12, shortHead: "9d75b8f" }), { sessionId: "s1" });
  assert.equal(p.current, "target"); assert.equal(p.stateLabel, "완료");
  assert.deepEqual(states(p), { base: "done", branch: "done", folder: "done", work: "done", commit: "done", pr: "done", target: "done" });
  assert.equal(p.nodes.find((n) => n.key === "pr").sub, "#13 병합됨");
  assert.deepEqual(p.actions.map((a) => a.label), ["대화 기록", "PR 보기", "작업 폴더 정리"]);
  assert.equal(action(p, "cleanup").disabled, false);
});

test("단계 판정: 기준 브랜치가 앞서면 기준 노드에 경고하고 기준 반영을 먼저 권한다", () => {
  let p = buildTaskPipeline(task({ freshness: { state: "needs-update" } }), status({ commits: 1 }), {});
  assert.equal(p.nodes[0].state, "warn");
  assert.equal(action(p, "sync").primary, true); assert.equal(action(p, "finish", "마무리"), undefined);
  p = buildTaskPipeline(task({ freshness: { state: "needs-update" } }), status({ dirty: 2 }), {});
  assert.match(action(p, "sync").reason, /커밋하지 않은 변경/);
  p = buildTaskPipeline(task({ state: "review", pull: { number: 2, state: "OPEN" }, freshness: { state: "needs-update" } }), status({ commits: 1 }), {});
  assert.match(action(p, "merge").reason, /develop의 새 변경/);
});

test("단계 판정: 결과를 모르는 요청이 있으면 쓰기 동작을 모두 막는다", () => {
  const p = buildTaskPipeline(task({ pendingAction: { action: "push" } }), status({ commits: 1 }), {});
  assert.match(action(p, "finish", "마무리").reason, /최신 상태 확인/);
  assert.match(action(p, "finish", "변경 보기").reason, /최신 상태 확인/);
});

test("단계 판정: hotfix·release는 main으로 병합한 뒤 develop 역반영 단계를 보여 준다", () => {
  const hotfix = { type: "hotfix", branch: "hotfix/x", baseBranch: "main", targetBranch: "main" };
  let p = buildTaskPipeline(task(hotfix), status(), {});
  assert.deepEqual(p.nodes.map((n) => n.label).filter((_, i, all) => i === 0 || i >= all.length - 2), ["main", "main", "develop"]);
  p = buildTaskPipeline(task({ ...hotfix, state: "merged", pull: { number: 3, state: "MERGED" }, developPending: true }), status(), {});
  assert.equal(p.nodes.at(-1).state, "warn");
  assert.equal(action(p, "develop").primary, true);
  assert.match(action(p, "cleanup").reason, /develop에도 반영/);
  p = buildTaskPipeline(task({ type: "release", branch: "release/1.0.0", baseBranch: "develop", targetBranch: "main", state: "merged", developPending: false }), status(), {});
  assert.equal(p.base, "develop"); assert.equal(p.target, "main");
  assert.equal(p.nodes.at(-1).state, "done"); assert.equal(action(p, "cleanup").disabled, false);
});

test("단계 판정: 로컬 반영 방식과 원본 폴더 작업을 구분해 표시한다", () => {
  let p = buildTaskPipeline(task({ finishMode: "local", inPlace: true }), status({ commits: 1 }), {});
  assert.equal(p.nodes.find((n) => n.key === "pr").label, "대상 반영");
  assert.equal(p.nodes.find((n) => n.key === "folder").sub, "원본 폴더");
  p = buildTaskPipeline(task({ finishMode: "local", state: "merged", completion: { kind: "local", publishState: "pending" } }), status(), {});
  assert.equal(p.nodes.find((n) => n.key === "target").state, "warn");
  assert.equal(p.nodes.find((n) => n.key === "target").sub, "푸시 전");
});

test("단계 판정: 작업 폴더가 사라지면 경고하고 작업을 진행하지 않는다", () => {
  const p = buildTaskPipeline(task(), status({ folder: false, dirty: null, commits: null }), {});
  assert.equal(p.nodes.find((n) => n.key === "folder").state, "warn");
  assert.match(action(p, "finish", "마무리").reason, /작업 폴더가 없습니다/);
});

test("단계 판정: main 변경이 develop에 없으면 기준 반영 대신 해야 할 일을 안내한다", () => {
  let p = buildTaskPipeline(task({ freshness: { state: "needs-update", mainMissing: true } }), status({ commits: 1 }), {});
  assert.equal(p.mainMissing, true);
  assert.equal(action(p, "sync"), undefined);
  assert.equal(action(p, "refresh").primary, true);
  assert.match(action(p, "finish", "마무리").reason, /main의 변경을 develop에 먼저/);
  assert.match(p.notice, /Git 탭에서 main을 develop에 병합/);
  assert.equal(p.nodes[0].sub, "main 미반영");
  // 상태 조회가 지금 다시 따진 결과가 저장된 결과보다 우선한다.
  p = buildTaskPipeline(task({ freshness: { state: "needs-update", mainMissing: true } }), status({ commits: 1, freshness: { state: "current", mainMissing: false } }), {});
  assert.equal(p.mainMissing, false); assert.equal(p.behind, false); assert.equal(p.notice, "");
  assert.equal(action(p, "finish", "마무리").primary, true);
  // 긴급 수정은 main에서 출발하므로 안내하지 않는다.
  p = buildTaskPipeline(task({ type: "hotfix", branch: "hotfix/x", baseBranch: "main", targetBranch: "main", freshness: { state: "current", mainMissing: true } }), status({ commits: 1 }), {});
  assert.equal(p.mainMissing, false);
});

test("단계 판정: 원격 작업 브랜치가 앞서면 원격 변경 합치기를 먼저 권한다", () => {
  let p = buildTaskPipeline(task(), status({ commits: 1, remoteAhead: true }), {});
  assert.equal(action(p, "sync", "원격 변경 합치기").primary, true);
  assert.equal(action(p, "finish", "마무리"), undefined);
  p = buildTaskPipeline(task({ state: "review", pull: { number: 2, state: "OPEN" } }), status({ commits: 1, remoteAhead: true }), {});
  assert.match(action(p, "merge").reason, /원격 작업 브랜치의 새 커밋/);
});

test("단계 판정: 푸시 안 된 커밋은 배지와 원격에 백업으로 알린다", () => {
  let p = buildTaskPipeline(task(), status({ commits: 2, unpushed: 2 }), {});
  assert.deepEqual(p.badges.map((b) => b.label), ["푸시 안 됨 2개"]);
  assert.equal(action(p, "backup").disabled, false);
  p = buildTaskPipeline(task(), status({ commits: 2, unpushed: 0 }), {});
  assert.equal(p.badges.length, 0); assert.equal(action(p, "backup"), undefined);
});

test("단계 판정: 원본 폴더가 작업 브랜치를 벗어나면 경고하고 정리 경로를 안내한다", () => {
  let p = buildTaskPipeline(task({ inPlace: true }), status({ offBranch: true, currentBranch: "develop", unpushed: 3 }), {});
  assert.equal(p.nodes.find((n) => n.key === "folder").state, "warn");
  assert.equal(p.nodes.find((n) => n.key === "folder").sub, "다른 브랜치");
  assert.match(p.notice, /Git 작업은 막지 않습니다/);
  assert.deepEqual(p.badges.map((b) => b.id), ["off-branch"]);
  assert.match(action(p, "finish", "마무리").reason, /작업 브랜치에 있지 않습니다/);
  p = buildTaskPipeline(task({ inPlace: true }), status({ offBranch: true, branchMissing: true, currentBranch: "develop" }), {});
  assert.equal(action(p, "delete", "기록만 정리").primary, true);
  assert.match(p.notice, /기록만 정리/);
  assert.equal(p.nodes.find((n) => n.key === "branch").state, "warn");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mergeSubtasks, countSubtasks, subtaskSummary, subtaskKind, subtaskElapsed, subtaskStall, orderSubtasks, visibleSubtasks } from "../public/shared/subtasks.js";

const now = Date.parse("2026-10-18T10:00:00Z");
const iso = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();

test("하위 작업 화면 계산: SSE 병합은 id로 덮어쓰고 removed를 지우며 순서를 지킨다", () => {
  const list = [{ id: "a", status: "running" }, { id: "b", status: "running" }];
  const merged = mergeSubtasks(list, [{ id: "b", status: "completed" }, { id: "c", status: "running" }], ["a"]);
  assert.deepEqual(merged.map((task) => `${task.id}:${task.status}`), ["b:completed", "c:running"]);
  assert.deepEqual(list.map((task) => task.status), ["running", "running"], "원래 배열은 바꾸지 않는다");
  assert.deepEqual(mergeSubtasks(undefined, [{ id: "x" }]).map((task) => task.id), ["x"]);
  assert.deepEqual(mergeSubtasks(list, [{ id: "a", status: "failed" }], ["a"]).map((task) => task.id), ["b"], "같은 알림에서 지운 작업은 다시 넣지 않는다");
});

test("하위 작업 화면 계산: 개수·요약은 정리 작업(ambient)을 실행 중에서 빼고 서버 subtaskCount와 같다", () => {
  const tasks = [{ id: "a", status: "running" }, { id: "b", status: "failed" }, { id: "c", status: "completed" }, { id: "d", status: "running", ambient: true }];
  assert.deepEqual(countSubtasks(tasks), { running: 1, total: 4 });
  assert.equal(countSubtasks([]), null);
  assert.equal(visibleSubtasks(tasks).length, 3);
  assert.equal(subtaskSummary(tasks), "하위 작업 3개 · 실행 중 1개 · 실패 1개");
  assert.equal(subtaskSummary([{ status: "completed" }, { status: "completed" }]), "하위 작업 2개 · 모두 완료");
});

test("하위 작업 화면 계산: 종류·경과 시간·진행 없음 경고", () => {
  assert.equal(subtaskKind({ taskType: "local_agent", type: "Explore", background: true }), "서브에이전트 · Explore · 백그라운드");
  assert.equal(subtaskKind({ taskType: "local_bash", type: "local_bash", background: false }), "백그라운드 명령");
  assert.equal(subtaskElapsed({ status: "running", startedAt: iso(75) }, now), "1분 15초");
  assert.equal(subtaskElapsed({ status: "completed", startedAt: iso(30), endedAt: iso(20) }, now), "10초");
  assert.equal(subtaskElapsed({ status: "completed", usage: { durationMs: 4200 } }, now), "4초");
  assert.equal(subtaskElapsed({ status: "completed" }, now), null);
  assert.equal(subtaskStall({ status: "running", startedAt: iso(300), lastProgressAt: iso(30) }, now), null, "최근 진행이 있으면 경고하지 않는다");
  assert.equal(subtaskStall({ status: "running", startedAt: iso(90) }, now), "1분 30초째 진행 없음", "진행이 없으면 시작 시각부터 센다");
  assert.equal(subtaskStall({ status: "completed", startedAt: iso(900) }, now), null);
});

test("하위 작업 화면 계산: 상위 작업 아래로 줄 세우고, 상위가 없으면 깊이로 들여 쓴다", () => {
  const tasks = [{ id: "c", parentId: "a" }, { id: "a" }, { id: "x", parentId: "gone", depth: 3 }, { id: "b", parentId: "a" }, { id: "d", parentId: "c" }, { id: "e", ambient: true }];
  assert.deepEqual(orderSubtasks(tasks).map(({ task, level }) => `${task.id}${level}`), ["a0", "c1", "d2", "b1", "x2"]);
  // 서로를 가리키는 잘못된 기록도 빠뜨리지 않는다.
  assert.deepEqual(orderSubtasks([{ id: "p", parentId: "q" }, { id: "q", parentId: "p" }]).map(({ task }) => task.id).sort(), ["p", "q"]);
});

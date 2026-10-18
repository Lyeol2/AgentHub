import test from "node:test";
import assert from "node:assert/strict";
import { applySubtask, addSubtaskActivity, settleSubtasks, activeSubtasks, SUBTASK_LIMIT, SUBTASK_ACTIVITY_LIMIT } from "../server/subtasks.mjs";

const start = (session, id, extra = {}) => applySubtask(session, { kind: "subtask", phase: "started", taskId: id, toolUseId: `tu-${id}`, description: id, background: true, ...extra });

test("subtasks: 작업 수와 최근 활동 수를 제한하고, 실행 중인 작업은 지우지 않는다", () => {
  const session = {};
  start(session, "live");
  for (let i = 0; i < SUBTASK_LIMIT + 5; i++) {
    start(session, `t${i}`);
    applySubtask(session, { kind: "subtask", phase: "notification", taskId: `t${i}`, status: "completed" });
  }
  assert.equal(session.subtasks.length, SUBTASK_LIMIT);
  assert.ok(session.subtasks.some((task) => task.id === "live"));
  assert.equal(session.subtasks.some((task) => task.id === "t0"), false, "끝난 작업부터 오래된 순으로 지운다");
  for (let i = 0; i < SUBTASK_ACTIVITY_LIMIT + 3; i++) addSubtaskActivity(session, "tu-live", [{ kind: "tool", name: "Bash", label: "명령 실행", text: `cmd ${i}` }]);
  const live = session.subtasks.find((task) => task.id === "live");
  assert.equal(live.activity.length, SUBTASK_ACTIVITY_LIMIT);
  assert.equal(live.activity.at(-1).text, `cmd ${SUBTASK_ACTIVITY_LIMIT + 2}`);
  assert.equal(live.lastTool, "명령 실행");
});

test("subtasks: 상태 변환과 정리 작업(ambient) 제외, 끝날 때 남은 작업 표시", () => {
  const session = {};
  start(session, "a");
  start(session, "quiet", { ambient: true });
  assert.deepEqual(activeSubtasks(session).map((task) => task.id), ["a"]);
  applySubtask(session, { kind: "subtask", phase: "updated", taskId: "a", patch: { status: "failed", error: "실패", end_time: Date.parse("2026-10-18T00:00:00Z") } });
  assert.equal(session.subtasks[0].status, "failed");
  assert.equal(session.subtasks[0].endedAt, "2026-10-18T00:00:00.000Z");
  // 시작을 놓친 작업도 완료 알림으로 만든다.
  applySubtask(session, { kind: "subtask", phase: "notification", taskId: "late", status: "stopped" });
  assert.equal(session.subtasks.find((task) => task.id === "late").status, "stopped");
  start(session, "b");
  assert.deepEqual(settleSubtasks(session, "interrupted").map((task) => task.id), ["quiet", "b"]);
  assert.equal(activeSubtasks(session).length, 0);
});

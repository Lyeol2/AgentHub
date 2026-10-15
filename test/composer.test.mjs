import test from "node:test";
import assert from "node:assert/strict";
import { composerAction } from "../public/composer.js";

test("요청 버튼은 빈 입력의 실행·일시중지 상태에서 제어 동작을 고른다", () => {
  assert.equal(composerAction({ state: "running" }, " \n").action, "pause");
  assert.equal(composerAction({ state: "paused" }).action, "resume");
  assert.equal(composerAction({ state: "idle" }).disabled, true);
  assert.equal(composerAction(null).disabled, true);
});

test("입력한 요청은 실행 중에는 대기열로, 일시중지 중에는 재개하며 보낸다", () => {
  for (const state of ["idle", "paused", "error", "interrupted"]) {
    const action = composerAction({ state }, "새 요청");
    assert.equal(action.action, "send");
    assert.equal(action.disabled, false);
  }
  assert.equal(composerAction({ state: "running" }, "새 요청").action, "queue");
  assert.equal(composerAction(null, "새 채팅").action, "send");
});

test("일시중지 종료 대기 중 빈 버튼은 잠기고 새 요청은 대기열에 넣을 수 있다", () => {
  const stopping = { state: "running", paused: true };
  assert.equal(composerAction(stopping).action, "pausing");
  assert.equal(composerAction(stopping).disabled, true);
  assert.equal(composerAction(stopping, "추가 요청").action, "queue");
  assert.equal(composerAction(stopping, "추가 요청").disabled, false);
});

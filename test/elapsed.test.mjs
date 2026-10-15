import test from "node:test";
import assert from "node:assert/strict";
import { runningElapsed } from "../public/elapsed.js";

const start = "2026-10-15T10:00:00.000Z";
const at = (seconds) => Date.parse(start) + seconds * 1000;

test("elapsed: 현재 실행 구간의 초·분·시간 경계를 표시한다", () => {
  const session = { state: "running", runningStartedAt: start };
  for (const [seconds, label] of [[0,"0초"],[59,"59초"],[60,"1분 0초"],[61,"1분 1초"],[3599,"59분 59초"],[3600,"1시간 0분"],[3661,"1시간 1분"],[90000,"25시간 0분"]]) {
    assert.equal(runningElapsed(session, at(seconds)), label);
  }
});

test("elapsed: 로그 갱신과 무관하며 명령의 live 시작시각도 지원한다", () => {
  const session = { state: "running", runningStartedAt: start, updatedAt: new Date(at(149)).toISOString() };
  assert.equal(runningElapsed(session, at(150)), "2분 30초");
  assert.equal(runningElapsed({ state: "running", live: { startedAt: start } }, at(150)), "2분 30초");
  assert.equal(runningElapsed({ ...session, runningStartedAt: new Date(at(150)).toISOString() }, at(151)), "1초");
});

test("elapsed: 실행하지 않을 때·잘못된 시각은 숨기고 클라이언트 시계차는 0으로 제한한다", () => {
  for (const state of ["idle","paused","interrupted","error","success"]) {
    assert.equal(runningElapsed({ state, runningStartedAt: start }, at(100)), null);
  }
  for (const runningStartedAt of [null,undefined,"bad date",0]) {
    assert.equal(runningElapsed({ state: "running", runningStartedAt }, at(100)), null);
  }
  assert.equal(runningElapsed(null), null);
  assert.equal(runningElapsed({ state: "running", updatedAt: start }, at(100)), null);
  assert.equal(runningElapsed({ state: "running", runningStartedAt: start }, at(-30)), "0초");
  assert.equal(runningElapsed({ state: "running", runningStartedAt: start }, NaN), null);
});

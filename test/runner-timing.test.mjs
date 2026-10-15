import test from "node:test";
import assert from "node:assert/strict";
import { Runner } from "../server/runner.mjs";
import { summary } from "../server/store.mjs";

function fixture(extra = {}) {
  const session = { id: "timing", agent: "claude", state: "idle", updatedAt: "2026-01-01T00:00:00.000Z", events: [], ...extra };
  const runner = new Runner({
    touch(s) { s.updatedAt = new Date().toISOString(); },
    get(id) { return id === session.id ? session : undefined; },
  });
  return { session, runner };
}

test("실행 시작 시각은 첫 실행과 목록 요약·실시간 상태 알림에 동일하게 제공된다", () => {
  const { session, runner } = fixture();
  const notifications = [];
  runner.on("state", (...args) => notifications.push(args));
  const before = Date.now();
  runner.setState(session, "running");
  const after = Date.now();
  const started = Date.parse(session.runningStartedAt);
  assert.ok(started >= before && started <= after);
  assert.equal(summary(session).runningStartedAt, session.runningStartedAt);
  assert.deepEqual(notifications, [[session.id, "running", session.runningStartedAt]]);
});

test("출력·추가 요청·중복 상태 알림은 작업 시작 시각을 초기화하지 않는다", () => {
  const original = "2026-01-01T01:00:00.000Z";
  const { session, runner } = fixture({ state: "running", runningStartedAt: original });
  const input = [];
  runner.running.set(session.id, { stdin: { write(line) { input.push(line); } } });
  runner.append(session, { kind: "text", text: "계속 작업 중" });
  runner.inject(session, "진행하던 작업에 이 조건을 반영한다.");
  runner.setState(session, "running"); // CLI 대화 복구 재시도도 같은 작업이다.
  assert.equal(session.runningStartedAt, original);
  assert.notEqual(session.updatedAt, original);
  assert.equal(input.length, 1);
  assert.equal(session.events.at(-1).injected, true);
});

test("작업 종료·오류·일시중지·중단 후 다음 실행은 새 시작 시각을 사용한다", () => {
  for (const state of ["idle", "error", "paused", "interrupted"]) {
    const original = "2026-01-01T01:00:00.000Z";
    const { session, runner } = fixture({ state: "running", runningStartedAt: original });
    const notifications = [];
    runner.on("state", (...args) => notifications.push(args));
    runner.setState(session, state);
    assert.equal(session.runningStartedAt, null, state);
    assert.deepEqual(notifications.at(-1), [session.id, state, null]);
    runner.setState(session, "running");
    assert.ok(Number.isFinite(Date.parse(session.runningStartedAt)));
    assert.notEqual(session.runningStartedAt, original, state);
  }
});

test("이전 시작 시각이 없거나 손상된 실행 상태도 유효한 시작 시각을 한 번 복구한다", () => {
  for (const runningStartedAt of [undefined, null, "invalid"]) {
    const { session, runner } = fixture({ state: "running", runningStartedAt });
    runner.setState(session, "running");
    const recovered = session.runningStartedAt;
    assert.ok(Number.isFinite(Date.parse(recovered)));
    runner.setState(session, "running");
    assert.equal(session.runningStartedAt, recovered);
  }
});

test("세션 다시 시작은 이전 작업 타이머를 종료한다", () => {
  const { session, runner } = fixture({ state: "paused", runningStartedAt: "2026-01-01T01:00:00.000Z" });
  runner.restart(session);
  assert.equal(session.state, "idle");
  assert.equal(session.runningStartedAt, null);
});

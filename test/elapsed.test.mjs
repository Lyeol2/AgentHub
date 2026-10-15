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


// Import the actual DOM updater: arithmetic-only tests cannot catch renamed store references.
test("elapsed: 열린 세션과 목록·명령 타이머를 한 번의 갱신에서 모두 업데이트한다", async (t) => {
  const { refreshElapsedTimes } = await import("../public/shared/elapsed.js");
  const nodes = [];
  const makeTimer = (kind, id, fallback = false) => {
    const classes = new Set();
    const node = {
      dataset: { elapsedKind: kind, elapsedId: id, ...(fallback ? { elapsedFallback: "updated" } : {}) },
      textContent: "이전 표시", hidden: false,
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
      removeAttribute(name) { delete this[name === "datetime" ? "dateTime" : name]; },
    };
    nodes.push(node);
    return node;
  };
  const current = makeTimer("session", "current");
  const listed = makeTimer("session", "other");
  const command = makeTimer("command", "cmd");
  const missing = makeTimer("session", "deleted");
  const fallback = makeTimer("session", "idle", true);
  const commandDetail = { textContent: "이전 결과", classList: { contains: (name) => name === "gcmd-result-text" } };
  command.nextElementSibling = commandDetail;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => nodes } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else delete globalThis.document; });
  let now = at(65);
  t.mock.method(Date, "now", () => now);
  const data = {
    current: { id: "current", state: "running", runningStartedAt: start },
    sessions: [
      { id: "current", state: "idle" }, // Detail is newer than the list snapshot.
      { id: "other", state: "running", runningStartedAt: new Date(at(55)).toISOString() },
      { id: "idle", state: "idle", updatedAt: new Date(at(64)).toISOString() },
    ],
    commands: [{ id: "cmd", state: "running", live: { startedAt: new Date(at(50)).toISOString() }, title: "명령 결과" }],
  };
  const refresh = () => refreshElapsedTimes(data, (item) => item.title);
  assert.doesNotThrow(refresh);
  assert.equal(current.textContent, "⏱ 1분 5초");
  assert.equal(current.dateTime, start);
  assert.equal(current.hidden, false);
  assert.equal(listed.textContent, "⏱ 10초");
  assert.equal(command.textContent, "⏱ 15초");
  assert.equal(commandDetail.textContent, "명령 결과");
  assert.equal(missing.hidden, true);
  assert.equal(fallback.hidden, false);
  assert.equal(fallback.textContent, "방금");
  now = at(66);
  refresh();
  assert.equal(current.textContent, "⏱ 1분 6초");
  assert.equal(listed.textContent, "⏱ 11초");
  assert.equal(command.textContent, "⏱ 16초");
  assert.equal(command.nextElementSibling, commandDetail);
  data.current = { ...data.current, state: "paused" };
  refresh();
  assert.equal(current.hidden, true);
  assert.equal(current.textContent, "");
  assert.equal(current.classList.contains("is-running"), false);
  assert.equal(current.dateTime, undefined);
});

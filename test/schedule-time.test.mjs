import test from "node:test";
import assert from "node:assert/strict";
import { nextScheduleAt, MAX_SCHEDULE_TIMEOUT_MS } from "../server/schedule.mjs";

test("schedule time: one-shot accepts an absolute future time and rejects expired dates", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  assert.equal(nextScheduleAt({ runAt: "2026-10-16T10:00:00+09:00" }, now), "2026-10-16T01:00:00.000Z");
  for (const runAt of ["2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z"]) assert.throws(() => nextScheduleAt({ runAt }, now), { code: "SCHEDULE_EXPIRED" });
  for (const runAt of [undefined, "bad", ""]) assert.throws(() => nextScheduleAt({ runAt }, now), /날짜와 시간/);
  assert.equal(MAX_SCHEDULE_TIMEOUT_MS, 2 ** 31 - 1);
});

test("schedule time: daily follows server local wall time and moves exact boundaries to tomorrow", () => {
  const morning = new Date(2026, 9, 16, 8, 0, 0, 0);
  const today = new Date(2026, 9, 16, 9, 30, 0, 0);
  const tomorrow = new Date(2026, 9, 17, 9, 30, 0, 0);
  const node = { scheduleMode: "daily", timeOfDay: "09:30" };
  assert.equal(nextScheduleAt(node, morning.getTime()), today.toISOString());
  assert.equal(nextScheduleAt(node, today.getTime()), tomorrow.toISOString());
  assert.equal(nextScheduleAt({ scheduleMode: "daily", timeOfDay: "00:00" }, new Date(2026, 11, 31, 23, 59).getTime()), new Date(2027, 0, 1).toISOString());
});

test("schedule time: intervals preserve cadence while skipping missed occurrences", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  const node = { scheduleMode: "interval", intervalMinutes: 5 };
  assert.equal(nextScheduleAt(node, now), "2026-10-16T00:05:00.000Z");
  assert.equal(nextScheduleAt(node, now + 17 * 60_000, "2026-10-16T00:05:00.000Z"), "2026-10-16T00:20:00.000Z");
  assert.equal(nextScheduleAt(node, now, "2026-10-16T00:05:00.000Z"), "2026-10-16T00:05:00.000Z");
  assert.equal(nextScheduleAt(node, now + 5 * 60_000, "2026-10-16T00:05:00.000Z"), "2026-10-16T00:10:00.000Z");
  assert.equal(nextScheduleAt({ scheduleMode: "interval" }, now), "2026-10-16T01:00:00.000Z");
});

test("schedule time: corrupt persisted schedules are rejected without timers", () => {
  for (const timeOfDay of [undefined, "9:30", "24:00", "09:60", "12:00:00"]) assert.throws(() => nextScheduleAt({ scheduleMode: "daily", timeOfDay }), /HH:mm/);
  for (const intervalMinutes of [0, 10081, 1.5, "60", NaN]) assert.throws(() => nextScheduleAt({ scheduleMode: "interval", intervalMinutes }), /1~10080/);
  assert.throws(() => nextScheduleAt({ scheduleMode: "unknown" }), /예약 방식/);
});

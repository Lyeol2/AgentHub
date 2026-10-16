// Calendar calculation has no dependency on node validation or workflow state.
export const MAX_SCHEDULE_TIMEOUT_MS = 2_147_483_647;

export function nextScheduleAt(node, now = Date.now(), previous = null) {
  const current = Number(now);
  if (!Number.isFinite(current)) throw new Error("현재 시간을 확인할 수 없습니다.");
  const mode = node.scheduleMode ?? "once";
  if (mode === "once") {
    const at = typeof node.runAt === "string" ? Date.parse(node.runAt) : NaN;
    if (!Number.isFinite(at)) throw new Error("예약할 날짜와 시간을 입력하세요.");
    if (at <= current) throw Object.assign(new Error("예약 시간이 이미 지났습니다. 미래 시간을 정한 뒤 예약을 다시 시작하세요."), { code: "SCHEDULE_EXPIRED" });
    return new Date(at).toISOString();
  }
  if (mode === "daily") {
    if (typeof node.timeOfDay !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(node.timeOfDay)) throw new Error("매일 실행할 시간을 HH:mm 형식으로 입력하세요.");
    const [hours, minutes] = node.timeOfDay.split(":").map(Number);
    const next = new Date(current);
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= current) {
      next.setDate(next.getDate() + 1);
      next.setHours(hours, minutes, 0, 0);
    }
    return next.toISOString();
  }
  if (mode === "interval") {
    const minutes = node.intervalMinutes ?? 60;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error("예약 간격은 1~10080분 사이 정수로 입력하세요.");
    const interval = minutes * 60_000;
    const anchor = typeof previous === "string" ? Date.parse(previous) : NaN;
    const next = Number.isFinite(anchor) ? anchor > current ? anchor : anchor + (Math.floor((current - anchor) / interval) + 1) * interval : current + interval;
    return new Date(next).toISOString();
  }
  throw new Error("예약 방식은 한 번·매일·일정 간격 중 하나입니다.");
}

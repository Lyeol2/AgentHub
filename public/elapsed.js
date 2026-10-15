// 현재 실행 구간의 경과 시간. 로그 갱신 시각(updatedAt)은 시작 시각으로 쓰지 않는다.
export function runningElapsed(item, now = Date.now()) {
  if (item?.state !== "running") return null;
  const start = item.runningStartedAt ?? item.live?.startedAt;
  if (typeof start !== "string") return null;
  const timestamp = Date.parse(start);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return null;
  const total = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (total < 60) return total + "초";
  if (total < 3600) return Math.floor(total / 60) + "분 " + total % 60 + "초";
  return Math.floor(total / 3600) + "시간 " + Math.floor(total % 3600 / 60) + "분";
}

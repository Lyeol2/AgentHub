// 구독 한도 이벤트와 CLI 기록을 화면에 쓸 값으로 바꾸는 순수 규칙.
export const CLAUDE_LABEL = {
  five_hour: "5시간",
  seven_day: "주간",
  seven_day_opus: "주간 (Opus)",
  seven_day_sonnet: "주간 (Sonnet)",
  overage: "추가 사용량",
};

export function percent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return value <= 1 ? Math.round(value * 1000) / 10 : Math.round(value * 10) / 10;
}

export const toIso = (seconds) => typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;

// CLI 이벤트와 사용량 API의 초기화 시각은 정밀도가 달라 10분 이내 차이는 같은 기간이다.
export const sameWindow = (left, right) => !!left && !!right && Math.abs(Date.parse(left) - Date.parse(right)) < 10 * 60_000;

export function claudeEvent(info, previous, observedAt) {
  const resetsAt = toIso(info.resetsAt);
  let usedPercent = percent(info.utilization ?? info.usedPercent);
  if (usedPercent === null && sameWindow(previous?.resetsAt, resetsAt)) usedPercent = previous.usedPercent ?? null;
  return { status: info.status ?? null, usedPercent, resetsAt, isUsingOverage: !!info.isUsingOverage, observedAt };
}

export function mergeClaudeUsage(saved, usage, oauth, observedAt) {
  const claude = { ...saved.claude };
  for (const type of Object.keys(CLAUDE_LABEL)) {
    const window = usage[type];
    if (typeof window?.utilization !== "number") continue;
    const usedPercent = Math.round(window.utilization * 10) / 10; // OAuth API는 항상 퍼센트를 준다.
    claude[type] = {
      ...claude[type],
      status: usedPercent >= 100 ? "rejected" : claude[type]?.status ?? "allowed",
      usedPercent,
      resetsAt: window.resets_at ? new Date(window.resets_at).toISOString() : null,
      observedAt,
    };
  }
  return { ...saved, claude, claudePlan: oauth.subscriptionType ?? saved.claudePlan ?? null };
}

export function claudeSnapshot(saved, error) {
  const order = Object.keys(CLAUDE_LABEL);
  const rank = (type) => order.includes(type) ? order.indexOf(type) : order.length;
  const windows = Object.entries(saved.claude ?? {})
    .sort(([left], [right]) => rank(left) - rank(right))
    .map(([type, window]) => ({ id: type, label: CLAUDE_LABEL[type] ?? type, ...window }));
  const observedAt = windows.map((window) => window.observedAt).sort().at(-1) ?? null;
  return { windows, observedAt, plan: saved.claudePlan ?? null, error };
}

export function windowLabel(minutes) {
  if (minutes === 300) return "5시간";
  if (minutes === 10080) return "주간";
  if (minutes % 1440 === 0) return minutes / 1440 + "일";
  if (minutes % 60 === 0) return minutes / 60 + "시간";
  return minutes + "분";
}

function codexWindow(id, window) {
  if (!window) return null;
  return {
    id,
    label: windowLabel(window.window_minutes),
    usedPercent: typeof window.used_percent === "number" ? Math.round(window.used_percent * 10) / 10 : null,
    resetsAt: toIso(window.resets_at),
  };
}

export function parseCodexLimits(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let message;
    try { message = JSON.parse(lines[i]); }
    catch { continue; } // 파일 뒷부분만 읽으면 첫 줄은 잘릴 수 있다.
    const limits = message.payload?.rate_limits;
    if (!limits || (!limits.primary && !limits.secondary)) continue;
    return {
      windows: [codexWindow("primary", limits.primary), codexWindow("secondary", limits.secondary)].filter(Boolean),
      plan: limits.plan_type ?? null,
      limitReached: limits.rate_limit_reached_type ?? null,
      observedAt: message.timestamp ?? null,
    };
  }
  return null;
}

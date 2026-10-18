import { $, el } from "./dom.js";

// 실행 중 진행 표시. 시작 단계(AI 시작 중), 출력이 끊긴 시간(N초째 응답 없음), 오래 끊기면 멈춘 것 같다는 경고.
// 권한·질문 답을 기다리는 동안은 출력이 없어도 멈춘 것이 아니므로 따로 보여 준다.
export const QUIET_AFTER_S = 10;
export const STALL_AFTER_S = 60;

// 초를 "N초"·"N분 N초"·"N시간 N분"으로 쓴다(하위 작업 경과·진행 없음 표시도 같이 쓴다).
export const seconds = (total) => total < 60 ? `${total}초` : total < 3600 ? `${Math.floor(total / 60)}분 ${total % 60}초` : `${Math.floor(total / 3600)}시간 ${Math.floor(total % 3600 / 60)}분`;

// { tone: "start" | "quiet" | "stall" | "wait", text } 또는 표시할 것이 없으면 null
export function runActivity(session, now = Date.now()) {
  if (session?.state !== "running") return null;
  if (session.waiting) return { tone: "wait", text: "답을 기다리는 중 · 위의 권한 요청이나 질문에 답하면 이어서 진행합니다." };
  const since = (value) => {
    const at = Date.parse(value ?? "");
    return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : null;
  };
  if (session.runPhase === "starting") {
    const total = since(session.runningStartedAt) ?? 0;
    if (total >= STALL_AFTER_S) return { tone: "stall", text: `AI가 ${seconds(total)}째 시작하지 못하고 있습니다. 멈춘 것 같으면 중지하거나 다시 시도하세요.` };
    return { tone: "start", text: `AI 시작 중…${total >= 3 ? ` ${seconds(total)}` : ""}` };
  }
  const quiet = since(session.lastOutputAt);
  if (quiet === null || quiet < QUIET_AFTER_S) return null;
  if (quiet >= STALL_AFTER_S) return { tone: "stall", text: `${seconds(quiet)}째 응답 없음 · 멈춘 것 같으면 중지하거나 다시 시도하세요. 긴 명령을 실행 중일 수도 있습니다.` };
  return { tone: "quiet", text: `${seconds(quiet)}째 응답 없음` };
}

// prefix(s·c)의 진행 표시 줄을 그린다. 멈춘 것 같을 때만 중지·다시 시도 버튼을 보인다.
export function renderActivity(prefix, session, { onStop, onRetry, now = Date.now() } = {}) {
  const node = $(`${prefix}-activity`);
  if (!node) return;
  const activity = runActivity(session, now);
  node.hidden = !activity;
  if (!activity) { delete node.dataset.tone; return; }
  if (node.dataset.tone !== activity.tone) {
    node.dataset.tone = activity.tone;
    for (const tone of ["start", "quiet", "stall", "wait"]) node.classList.toggle(tone, tone === activity.tone);
    node.replaceChildren(el("span", { class: "run-activity-text" }),
      ...(activity.tone === "stall" ? [
        el("button", { type: "button", class: "ghost sm", title: "지금 작업을 멈춥니다", onclick: () => onStop?.() }, "중지"),
        el("button", { type: "button", class: "ghost sm", title: "지금 작업을 멈추고 멈춘 곳부터 다시 진행합니다", onclick: () => onRetry?.() }, "다시 시도"),
      ] : []));
  }
  const text = node.querySelector(".run-activity-text");
  if (text.textContent !== activity.text) text.textContent = activity.text;
}

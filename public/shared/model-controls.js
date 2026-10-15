import { $, el } from "./dom.js";

export function createModelControls(getStatus) {
// ── 모델·추론 강도 ──────────────────────────────────────────────
function fillModels(listId, agent) {
  const info = getStatus().agents[agent];
  $(listId).replaceChildren(...info.models.map((m) => el("option", { value: m.id }, m.label)));
  // 비워 두면 쓸 모델을 알려 준다. Codex 설정의 기본 모델을 쓸 수 없으면 대신 쓸 모델을 보인다(서버의 codex.defaultModel).
  const input = document.querySelector(`input[list="${listId}"]`);
  const d = info.defaultModel;
  if (input) {
    input.placeholder = d?.unavailable ? `CLI 기본값: ${d.model} (설정의 ${d.configured}은 쓸 수 없음)`
      : d?.configured ? `CLI 기본값: ${d.configured}` : "CLI 기본값";
  }
}

// 고른 모델이 지원하는 추론 강도만 보여 준다. 모르는 모델이면 에이전트 전체 목록을 쓴다.
function fillEfforts(selectId, agent, model, current = $(selectId).value) {
  const info = getStatus().agents[agent];
  const known = info.models.find((m) => m.id === model);
  const efforts = known?.efforts.length ? known.efforts : info.efforts;
  const fallback = known?.defaultEffort ? ` (${known.defaultEffort})` : "";
  $(selectId).replaceChildren(
    el("option", { value: "" }, `CLI 기본값${fallback}`),
    ...efforts.map((e) => el("option", { value: e }, e)));
  $(selectId).value = efforts.includes(current) ? current : "";
}

return { fillModels, fillEfforts };
}

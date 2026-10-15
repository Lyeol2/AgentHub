import { runningElapsed } from "../elapsed.js";
import { $, el, timeAgo } from "./dom.js";

// 타이머는 텍스트만 갱신한다. 노드 선택·끌기·입력창 포커스는 그대로 유지한다.
export function updateElapsedElement(node, item, now = Date.now()) {
  const elapsed = runningElapsed(item, now);
  const fallback = node.dataset.elapsedFallback === "updated" && item;
  node.hidden = elapsed === null && !fallback;
  node.classList.toggle("is-running", elapsed !== null);
  const text = elapsed !== null ? "⏱ " + elapsed : fallback ? timeAgo(item.updatedAt) : "";
  if (node.textContent !== text) node.textContent = text;
  const startedAt = elapsed !== null ? item.runningStartedAt ?? item.live?.startedAt : null;
  if (startedAt) {
    node.dateTime = startedAt;
    node.title = "현재 작업 경과 시간 · 시작 " + new Date(startedAt).toLocaleString();
  } else {
    node.removeAttribute("datetime");
    node.removeAttribute("title");
  }
}

export function elapsedElement(kind, item, fallback = false) {
  const node = el("time", {
    class: "run-elapsed", role: "timer", "aria-live": "off",
    "data-elapsed-kind": kind, "data-elapsed-id": item.id,
    ...(fallback ? { "data-elapsed-fallback": "updated" } : {}),
  });
  updateElapsedElement(node, item);
  return node;
}

export function renderSessionElapsed(prefix, session) {
  const node = $(prefix + "-elapsed");
  node.dataset.elapsedKind = "session";
  node.dataset.elapsedId = session?.id ?? "";
  updateElapsedElement(node, session);
}

export function refreshElapsedTimes(data, commandNodeFoot) {
  const now = Date.now();
  for (const node of document.querySelectorAll("[data-elapsed-kind]")) {
    const item = node.dataset.elapsedKind === "command" ? data.commands.find((item) => item.id === node.dataset.elapsedId)
      : data.current?.id === node.dataset.elapsedId ? state.current : data.sessions.find((item) => item.id === node.dataset.elapsedId);
    updateElapsedElement(node, item, now);
    if (node.dataset.elapsedKind === "command" && item) {
      const detail = node.nextElementSibling;
      if (detail?.classList.contains("gcmd-result-text")) {
        const text = commandNodeFoot(item);
        if (detail.textContent !== text) detail.textContent = text;
      }
    }
  }
}

// 세션 수명: 컨텍스트 압축 횟수(1회 노랑, 2회 주황, 3회 이상 빨강)와 지금 컨텍스트가 창을 얼마나 채웠는지

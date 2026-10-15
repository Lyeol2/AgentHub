import { el } from "./dom.js";

// A separate button keeps lock toggles accessible without opening the chat.
export function sessionLockButton(session, toggleSessionLock) {
  const label = session.locked ? "세션 잠금 해제" : "세션 잠금";
  const button = el("button", {
    type: "button",
    class: "session-lock",
    "aria-label": `${session.title} · ${label}`,
    "aria-pressed": String(!!session.locked),
    title: `${label} · 잠그면 채팅을 열 수 없습니다. 연결된 실행은 계속됩니다.`,
    onclick: (event) => {
      event.stopPropagation();
      toggleSessionLock(session);
    },
    ondblclick: (event) => event.stopPropagation(),
    onauxclick: (event) => { event.preventDefault(); event.stopPropagation(); },
  });
  button.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="${session.locked ? "M8 10V6a4 4 0 0 1 8 0v4" : "M8 10V6a4 4 0 0 1 8 0"}"/><path d="M12 14v3"/></svg>`;
  return button;
}

const STORAGE_KEY = "agenthub.gitWorkWidth";
const MIN_WIDTH = 320;
const PREVIEW_MIN_WIDTH = 280;
const SEPARATOR_WIDTH = 6;

export function initGitResizer() {
  const panel = document.getElementById("g-changes");
  const work = document.getElementById("g-work");
  const separator = document.getElementById("g-changes-resizer");
  const narrowScreen = window.matchMedia("(max-width: 900px)");
  let preferredWidth;
  let drag = null;

  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) preferredWidth = stored;
  } catch { /* 저장할 수 없어도 현재 창에서 조절할 수 있다. */ }

  const enabled = () => !narrowScreen.matches && panel.clientWidth >= MIN_WIDTH + PREVIEW_MIN_WIDTH + SEPARATOR_WIDTH;
  const maxWidth = () => panel.clientWidth - PREVIEW_MIN_WIDTH - SEPARATOR_WIDTH;

  function applyWidth(width = preferredWidth ?? (panel.clientWidth - SEPARATOR_WIDTH) * .425) {
    if (!enabled()) return;
    const value = Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth(), width)));
    panel.style.setProperty("--git-work-width", value + "px");
    separator.setAttribute("aria-valuemin", MIN_WIDTH);
    separator.setAttribute("aria-valuemax", maxWidth());
    separator.setAttribute("aria-valuenow", value);
    separator.setAttribute("aria-valuetext", value + "픽셀");
    return value;
  }

  function saveWidth() {
    try {
      if (preferredWidth === undefined) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, preferredWidth);
    } catch { /* 저장 실패가 드래그를 막지 않게 한다. */ }
  }

  function endDrag(save = true) {
    if (!drag) return;
    const { pointerId, initialPreference } = drag;
    drag = null;
    document.body.classList.remove("resizing-git");
    if (!save) {
      preferredWidth = initialPreference;
      applyWidth();
    }
    if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId);
    if (save) saveWidth();
  }

  separator.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag || !enabled()) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, startX: event.clientX, initialWidth: work.getBoundingClientRect().width, initialPreference: preferredWidth };
    separator.focus({ preventScroll: true });
    separator.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-git");
  });
  separator.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    preferredWidth = applyWidth(drag.initialWidth + event.clientX - drag.startX);
  });
  separator.addEventListener("pointerup", (event) => {
    if (event.pointerId === drag?.pointerId) endDrag();
  });
  separator.addEventListener("pointercancel", (event) => {
    if (event.pointerId === drag?.pointerId) endDrag(false);
  });
  separator.addEventListener("lostpointercapture", () => endDrag());
  window.addEventListener("blur", () => endDrag());

  separator.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      endDrag(false);
      return;
    }
    if (!enabled() || drag) return;
    const current = work.getBoundingClientRect().width;
    const step = event.shiftKey ? 50 : 10;
    const next = { ArrowLeft: current - step, ArrowRight: current + step, Home: MIN_WIDTH, End: maxWidth() }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    preferredWidth = applyWidth(next);
    saveWidth();
  });
  separator.addEventListener("dblclick", () => {
    if (!enabled()) return;
    endDrag(false);
    preferredWidth = undefined;
    saveWidth();
    applyWidth();
  });

  function syncLayout() {
    endDrag();
    panel.classList.toggle("git-changes-stacked", !enabled());
    separator.tabIndex = enabled() ? 0 : -1;
    applyWidth();
  }
  // 탭을 열거나 앱 사이드바를 조절할 때도 실제 남은 공간에 맞춘다.
  let observedWidth;
  new ResizeObserver(() => {
    if (observedWidth === panel.clientWidth) return;
    observedWidth = panel.clientWidth;
    syncLayout();
  }).observe(panel);
  narrowScreen.addEventListener("change", syncLayout);
  syncLayout();
}

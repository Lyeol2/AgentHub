const separator = document.getElementById("sidebar-resizer");
const sidebar = document.getElementById("sidebar");
const body = document.body;
const narrowScreen = window.matchMedia("(max-width: 640px)");
const query = new URLSearchParams(location.search);
const popup = query.get("session") ?? query.get("chat");
const STORAGE_KEY = "agenthub.sidebarWidth";
const MIN_WIDTH = 180;
const MAX_WIDTH = 520;
const MAIN_MIN_WIDTH = 360;
const SEPARATOR_WIDTH = 6;
let preferredWidth;
let drag = null;

try {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(stored) && stored > 0) preferredWidth = stored;
} catch { /* 설정을 저장할 수 없어도 너비 조절은 동작한다. */ }

const defaultWidth = () => window.innerWidth <= 900 ? 220 : 260;
const enabled = () => !narrowScreen.matches && !popup && !body.classList.contains("popup");
const limits = () => ({ min: MIN_WIDTH, max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(body.clientWidth / 2), body.clientWidth - MAIN_MIN_WIDTH - SEPARATOR_WIDTH)) });
const clamp = (width) => {
  const { min, max } = limits();
  return Math.round(Math.max(min, Math.min(max, width)));
};

function applyWidth(width = preferredWidth ?? defaultWidth()) {
  const value = clamp(width);
  const { min, max } = limits();
  body.style.setProperty("--sidebar-width", value + "px");
  separator.setAttribute("aria-valuemin", min);
  separator.setAttribute("aria-valuemax", max);
  separator.setAttribute("aria-valuenow", value);
  separator.setAttribute("aria-valuetext", value + "픽셀");
  separator.tabIndex = enabled() ? 0 : -1;
  return value;
}

function saveWidth() {
  if (!Number.isFinite(preferredWidth)) return;
  try {
    localStorage.setItem(STORAGE_KEY, preferredWidth);
  } catch { /* 브라우저가 설정 저장을 막은 경우 현재 창에만 적용한다. */ }
}

function endDrag(save = true) {
  if (!drag) return;
  const { pointerId, initialWidth } = drag;
  drag = null;
  body.classList.remove("resizing-sidebar");
  if (!save) applyWidth(preferredWidth = initialWidth);
  if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId);
  if (save) saveWidth();
}

separator.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || drag || !enabled()) return;
  event.preventDefault();
  drag = { pointerId: event.pointerId, initialWidth: sidebar.getBoundingClientRect().width, startX: event.clientX };
  separator.focus({ preventScroll: true });
  separator.setPointerCapture(event.pointerId);
  body.classList.add("resizing-sidebar");
});

separator.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  preferredWidth = applyWidth(drag.initialWidth + event.clientX - drag.startX);
});
separator.addEventListener("pointerup", (event) => {
  if (event.pointerId === drag?.pointerId) endDrag();
});
separator.addEventListener("pointercancel", () => endDrag(false));
separator.addEventListener("lostpointercapture", () => endDrag());
window.addEventListener("blur", () => endDrag());

separator.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drag) {
    event.preventDefault();
    endDrag(false);
    return;
  }
  if (!enabled()) return;
  const { min, max } = limits();
  const current = sidebar.getBoundingClientRect().width;
  const step = event.shiftKey ? 50 : 10;
  const next = { ArrowLeft: current - step, ArrowRight: current + step, Home: min, End: max }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  preferredWidth = applyWidth(next);
  saveWidth();
});

separator.addEventListener("dblclick", () => {
  if (!enabled()) return;
  preferredWidth = undefined;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  applyWidth();
});

function syncLayout() {
  endDrag();
  applyWidth();
}
window.addEventListener("resize", syncLayout);
narrowScreen.addEventListener("change", syncLayout);
applyWidth();

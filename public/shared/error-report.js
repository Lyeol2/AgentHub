// 오류를 화면 안에 보여 주는 공용 표시. 무엇이 실패했는지(동작) · 원인(message) · 해결 방법(hint) · 원문(raw, 접기)을
// 함께 보여 주고 복사할 수 있게 한다. 세션이나 작업에 연결된 오류면 그 세션에 해결을 요청하는 버튼을 단다.
//   showError(err, { action, sessionId }): 화면 위쪽 알림으로 띄운다(닫을 때까지 남는다).
//   errorPanel(err, { action, title, sessionId, rawLabel, onClose }): 카드·패널 안에 넣을 요소를 만든다.
// err는 api()가 던진 오류({ message, hint, raw, reason, outcomeUnknown, recoveryId })나 문자열이다.
const RAW_LIMIT = 1500;
const TRAY_LIMIT = 4;
let askSession = null;

// 앱이 시작할 때 세션에 메시지를 보내는 방법을 정한다. 정하지 않으면 해결 요청 버튼을 숨긴다.
export function configureErrorReports({ ask } = {}) { askSession = typeof ask === "function" ? ask : null; }

export function errorDetails(err) {
  if (typeof err === "string") return { message: err };
  const text = (value) => typeof value === "string" ? value.trim() : "";
  return {
    message: text(err?.message) || "요청을 처리하지 못했습니다.",
    hint: text(err?.hint), raw: text(err?.raw), reason: text(err?.reason),
    outcomeUnknown: err?.outcomeUnknown === true, recoveryId: text(err?.recoveryId),
  };
}

const clip = (value, limit = RAW_LIMIT) => value.length > limit ? value.slice(0, limit) + "\n…(이하 생략)" : value;
const extra = (detail) => [
  detail.outcomeUnknown ? "완료 여부가 확실하지 않습니다. 현재 상태를 확인하기 전에는 다시 실행하지 마세요." : "",
  detail.recoveryId ? `복구 기록: ${detail.recoveryId}` : "",
].filter(Boolean);

// 복사해서 문의할 때 쓰는 글. 원문은 줄이지 않고 그대로 넣는다.
export function errorReportText(err, { action = "" } = {}) {
  const d = errorDetails(err);
  return [action && `동작: ${action}`, `오류: ${d.message}`, d.hint && `해결 방법: ${d.hint}`, ...extra(d), d.reason && `사유 코드: ${d.reason}`,
    d.raw && d.raw !== d.message && `원문:\n${d.raw}`].filter(Boolean).join("\n");
}

// 세션에 보내는 해결 요청. 일반 메시지로 보내며, 원문은 앞부분만 넣는다.
export function errorRequestPrompt(err, { action = "" } = {}) {
  const d = errorDetails(err);
  return ["다음 오류가 났습니다.", action && `- 동작: ${action}`, `- 오류: ${d.message}`, d.hint && `- 안내된 해결 방법: ${d.hint}`, ...extra(d).map((line) => `- ${line}`),
    d.raw && d.raw !== d.message && `- 원문 일부:\n\`\`\`\n${clip(d.raw)}\n\`\`\``,
    "원인을 확인하고 해결해 주세요. 해결할 수 없으면 이유와 제가 할 일을 알려 주세요."].filter(Boolean).join("\n");
}

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function button(label, className, onClick) {
  const item = node("button", className, label);
  item.type = "button";
  item.addEventListener("click", onClick);
  return item;
}

export function errorPanel(err, { action = "", title = "", sessionId = null, rawLabel = "원문 보기", onClose = null, extraActions = [] } = {}) {
  const d = errorDetails(err);
  const box = node("div", "error-report");
  box.setAttribute("role", "alert");
  box.dataset.errorReason = d.reason;
  const head = node("div", "error-report-head");
  head.append(node("strong", "error-report-action", action ? `${action} 실패` : title || "오류"));
  if (onClose) {
    const close = button("×", "ghost sm error-report-close", onClose);
    close.setAttribute("aria-label", "오류 닫기");
    head.append(close);
  }
  box.append(head, node("p", "error-report-message", d.message));
  if (d.hint) {
    const hint = node("p", "error-report-hint");
    hint.append(node("span", "error-report-label", "해결 방법"), document.createTextNode(d.hint));
    box.append(hint);
  }
  for (const line of extra(d)) box.append(node("p", "error-report-note", line));
  if (d.raw && d.raw !== d.message) {
    const details = node("details", "error-report-raw");
    details.append(node("summary", "", rawLabel), node("pre", "", d.raw));
    box.append(details);
  }
  const actions = node("div", "error-report-actions");
  const status = node("span", "error-report-status");
  status.setAttribute("role", "status");
  const copy = button("오류 내용 복사", "ghost sm error-report-copy", async () => {
    try { await navigator.clipboard.writeText(errorReportText(d, { action })); status.textContent = "복사했습니다."; }
    catch { status.textContent = "복사하지 못했습니다. 내용을 직접 선택해 복사하세요."; }
  });
  actions.append(copy);
  if (sessionId && askSession) {
    const ask = button("AI에게 해결 요청", "ghost sm error-report-ask", async () => {
      ask.disabled = true;
      status.textContent = "보내는 중…";
      try {
        const result = await askSession(sessionId, errorRequestPrompt(d, { action }));
        status.textContent = result?.queued ? "세션이 실행 중이라 대기열에 넣었습니다." : "세션에 해결을 요청했습니다.";
      } catch (error) {
        ask.disabled = false;
        status.textContent = `요청을 보내지 못했습니다: ${error?.message || "알 수 없는 오류"}`;
      }
    });
    ask.dataset.sessionId = sessionId;
    ask.title = "이 오류 내용을 연결된 세션에 보내 원인 확인과 해결을 요청합니다.";
    actions.append(ask);
  }
  for (const item of extraActions) if (item) actions.append(item);
  actions.append(status);
  box.append(actions);
  return box;
}

// 열린 모달 창이 있으면 그 안에 띄운다. 모달 밖의 요소는 가려지고 누를 수 없기 때문이다.
function trayHost() {
  const modal = [...document.querySelectorAll("dialog[open]")].reverse().find((dialog) => { try { return dialog.matches(":modal"); } catch { return false; } });
  return modal || document.body;
}

export function showError(err, options = {}) {
  if (typeof document === "undefined" || !document.body?.append) {
    globalThis.alert?.(errorReportText(err, options));
    return null;
  }
  const host = trayHost();
  let tray = [...host.children].find((child) => child.classList?.contains("error-toast-tray"));
  if (!tray) {
    tray = node("section", "error-toast-tray");
    tray.setAttribute("aria-label", "오류 알림");
    host.append(tray);
  }
  const toast = errorPanel(err, { ...options, onClose: () => toast.remove() });
  toast.classList.add("error-toast");
  tray.prepend(toast);
  while (tray.children.length > TRAY_LIMIT) tray.lastElementChild.remove();
  return toast;
}

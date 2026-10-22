import { $, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";

const STATUS = { running: "실행 중", pending: "대기", queued: "대기열", waiting: "응답 대기", stopping: "중지 중", success: "성공", completed: "완료", idle: "완료", failed: "실패", error: "실패", interrupted: "중단됨", stopped: "중지됨", cancelled: "취소됨", skipped: "건너뜀" };
const active = (status) => ["running", "pending", "queued", "waiting", "stopping"].includes(status);
const retryable = (status) => ["failed", "error", "interrupted", "stopped", "cancelled"].includes(status);
const plain = (value) => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
const date = (value) => value ? new Date(value).toLocaleString() : "";
const duration = (item) => {
  const ms = item.durationMs ?? (item.startedAt ? Math.max(0, Date.parse(item.endedAt ?? new Date().toISOString()) - Date.parse(item.startedAt)) : null);
  return Number.isFinite(ms) ? ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "초" : "";
};

export function createExecutionControls({ api, navigation, refreshGraph = async () => {} }) {
  let history = null, templates = null, settingsDialog = null, saveDialog = null, historyRevision = 0, templateRevision = 0;
  let audio = null;
  const seenNotifications = new Set();
  let preferences;
  try { preferences = JSON.parse(localStorage.getItem("agenthub.flowNotifications") ?? "{}"); } catch { preferences = {}; }
  if (!preferences || typeof preferences !== "object") preferences = {};
  const savePreferences = () => { try { localStorage.setItem("agenthub.flowNotifications", JSON.stringify(preferences)); } catch {} };

  function dialog(id, title, className = "") {
    document.getElementById(id)?.remove();
    const heading = el("h2", { id: id + "-title" }, title);
    const close = el("button", { type: "button", class: "ghost sm", "aria-label": title + " 닫기", onclick: () => node.close() }, "닫기");
    const error = el("p", { class: "error", role: "alert" });
    const body = el("div", { class: "execution-dialog-body" });
    const node = el("dialog", { id, class: "execution-dialog " + className, "aria-labelledby": id + "-title" }, el("header", { class: "execution-dialog-header" }, heading, close), error, body);
    node.addEventListener("close", () => node.remove());
    document.body.append(node);
    node.showModal();
    return { node, body, error, heading };
  }

  function stillHistory(state) { return history === state && state.node.open && samePath(state.projectPath, navigation.project); }
  async function openHistory(runId = null) {
    const projectPath = navigation.project;
    if (!projectPath) return;
    history?.node.close();
    const state = history = { ...dialog("execution-history-dialog", "실행 기록", "execution-history-dialog"), projectPath, selectedRunId: runId, selectedStepId: null, busy: false };
    state.list = el("nav", { class: "execution-run-list", "aria-label": "실행 목록" });
    state.detail = el("section", { class: "execution-run-detail", "aria-label": "실행 상세" });
    state.body.append(el("p", { class: "hint" }, "실행을 고르면 각 노드에 전달된 내용과 결과를 확인할 수 있습니다."), el("div", { class: "execution-history-layout" }, state.list, state.detail));
    state.node.addEventListener("close", () => { if (history === state) { history = null; historyRevision++; } });
    await refreshRuns();
  }

  async function refreshRuns() {
    const state = history;
    if (!state || !stillHistory(state)) return;
    if (state.refreshing) { state.refreshAgain = true; return state.refreshing; }
    state.refreshing = (async () => {
      do {
        state.refreshAgain = false;
        await loadRuns(state);
      } while (state.refreshAgain && stillHistory(state));
    })().finally(() => { state.refreshing = null; });
    return state.refreshing;
  }

  async function loadRuns(state) {
    const revision = ++historyRevision;
    try {
      const result = await api("GET", "/api/runs?path=" + encodeURIComponent(state.projectPath));
      if (!stillHistory(state) || revision !== historyRevision) return;
      const previous = state.runs?.find(run => run.id === state.selectedRunId);
      state.runs = result.runs ?? [];
      state.nextCursor = result.nextCursor ?? null;
      if (previous && !state.runs.some(run => run.id === previous.id)) state.runs.unshift(previous);
      const selected = state.selectedRunId ?? state.runs[0]?.id;
      state.selectedRunId = selected ?? null;
      renderRuns(state);
      if (selected) await selectRun(state, selected, revision);
      else state.detail.replaceChildren(el("p", { class: "muted" }, "아직 실행 기록이 없습니다. 노드를 실행하면 여기에 표시됩니다."));
      state.error.textContent = "";
    } catch (error) { if (stillHistory(state) && revision === historyRevision) state.error.textContent = error.message; }
  }

  function renderRuns(state) {
    state.list.replaceChildren(...state.runs.map((run) => el("button", { type: "button", class: "execution-run-row" + (run.id === state.selectedRunId ? " selected" : ""), "data-run-id": run.id, "aria-pressed": String(run.id === state.selectedRunId), onclick: () => { state.selectedStepId = null; state.selectedRunId = run.id; renderRuns(state); void selectRun(state, run.id, ++historyRevision); } },
      el("strong", {}, run.sourceTitle ?? run.title ?? "흐름 실행"), el("span", { class: "execution-run-status " + run.status }, STATUS[run.status] ?? run.status), el("small", { class: "muted" }, [date(run.startedAt), duration(run)].filter(Boolean).join(" · ")))));
    if (state.nextCursor) state.list.append(el("button", { type: "button", class: "ghost sm", ...(state.moreBusy ? { disabled: "" } : {}),
      onclick: () => loadMoreRuns(state) }, state.moreBusy ? "불러오는 중…" : "이전 실행 더 보기"));
  }

  async function loadMoreRuns(state) {
    if (state.moreBusy || !state.nextCursor || !stillHistory(state)) return;
    const revision = historyRevision;
    state.moreBusy = true;
    renderRuns(state);
    try {
      const result = await api("GET", "/api/runs?path=" + encodeURIComponent(state.projectPath) + "&cursor=" + encodeURIComponent(state.nextCursor));
      if (!stillHistory(state) || revision !== historyRevision) return;
      state.runs = [...new Map([...state.runs, ...(result.runs ?? [])].map(run => [run.id, run])).values()];
      state.nextCursor = result.nextCursor ?? null;
    } catch (error) { if (stillHistory(state)) state.error.textContent = error.message; }
    finally { state.moreBusy = false; if (stillHistory(state)) renderRuns(state); }
  }

  async function selectRun(state, id, revision) {
    state.detail.replaceChildren(el("p", { class: "muted" }, "실행 내용을 불러오는 중…"));
    try {
      const response = await api("GET", "/api/runs/" + encodeURIComponent(id));
      if (!stillHistory(state) || revision !== historyRevision || id !== state.selectedRunId) return;
      state.run = response.run ?? response;
      renderRun(state);
    } catch (error) { if (stillHistory(state) && revision === historyRevision) state.error.textContent = error.message; }
  }

  function renderRun(state) {
    const run = state.run;
    const steps = Array.isArray(run.steps) ? run.steps : Object.values(run.steps ?? {});
    if (!steps.some((step) => step.id === state.selectedStepId)) state.selectedStepId = steps.find((step) => retryable(step.status))?.id ?? steps.at(-1)?.id ?? null;
    const selected = steps.find((step) => step.id === state.selectedStepId);
    const stop = el("button", { type: "button", class: "ghost danger", id: "execution-run-stop", onclick: () => mutateRun(state, "stop") }, run.status === "stopping" ? "중지 중…" : "이 흐름 전체 중지");
    stop.hidden = !active(run.status); stop.disabled = state.busy || run.status === "stopping";
    const resume = el("button", { type: "button", class: "primary", id: "execution-run-resume", onclick: () => mutateRun(state, "resume", selected?.id) }, "선택한 단계부터 재개");
    resume.hidden = !retryable(run.status); resume.disabled = state.busy || !selected || !retryable(selected.status);
    const stepList = el("nav", { class: "execution-step-list", "aria-label": "실행 단계" }, ...steps.map((step, index) => el("button", { type: "button", class: "execution-step-row" + (step.id === state.selectedStepId ? " selected" : ""), "data-step-id": step.id, "aria-pressed": String(step.id === state.selectedStepId), onclick: () => { state.selectedStepId = step.id; renderRun(state); } }, el("span", {}, (index + 1) + ". " + (step.nodeTitle ?? step.title ?? step.nodeId ?? "노드"), step.options?.reused ? el("small", { class: "execution-step-reused" }, "기존 결과 사용") : null), el("span", { class: "execution-run-status " + step.status }, STATUS[step.status] ?? step.status), el("small", { class: "muted" }, duration(step)))));
    const stepDetail = el("section", { id: "execution-step-detail" });
    if (selected) {
      stepDetail.append(el("h3", {}, selected.nodeTitle ?? selected.title ?? "선택한 단계"), el("p", { class: "hint" }, [selected.options?.reused ? "기존 결과 사용" : null, date(selected.startedAt), duration(selected)].filter(Boolean).join(" · ")));
      for (const [label, value] of [["입력", selected.input], ["출력", selected.output], ["오류", selected.error]]) {
        const text = plain(value);
        stepDetail.append(el("details", { ...(label === "오류" && text ? { open: "" } : {}) }, el("summary", {}, label), el("pre", { class: "execution-value", "data-value": label }, text || "없음")));
      }
    }
    state.detail.replaceChildren(...[el("div", { class: "execution-detail-head" }, el("div", {}, el("h3", {}, run.sourceTitle ?? run.title ?? "흐름 실행"), el("p", { class: "hint" }, [STATUS[run.status] ?? run.status, date(run.startedAt), duration(run)].filter(Boolean).join(" · "))), el("div", { class: "actions" }, stop, resume)), run.resumedFrom ? el("p", { class: "hint" }, "이전 실행에서 이어서 시작한 기록입니다.") : null, retryable(run.status) ? el("p", { class: "hint" }, "재개할 실패·중단 단계를 고르세요. 앞서 성공한 단계의 결과를 이어서 사용합니다.") : null, stepList, stepDetail].filter(Boolean));
  }

  async function mutateRun(state, action, stepId) {
    if (state.busy || !stillHistory(state)) return;
    state.busy = true; state.error.textContent = ""; renderRun(state);
    try {
      const result = await api("POST", "/api/runs/" + encodeURIComponent(state.selectedRunId) + "/" + action, action === "resume" ? { stepId } : {});
      if (!stillHistory(state)) return;
      if (action === "resume") { state.selectedRunId = result.run?.id ?? result.runId ?? result.id ?? state.selectedRunId; state.selectedStepId = null; }
      await refreshGraph(state.projectPath);
      await refreshRuns();
    } catch (error) { if (stillHistory(state)) state.error.textContent = error.message; }
    finally { state.busy = false; if (stillHistory(state) && state.run) renderRun(state); }
  }

  async function openTemplates(pos = null) {
    const projectPath = navigation.project;
    if (!projectPath) return;
    templates?.node.close();
    const state = templates = { ...dialog("group-templates-dialog", "그룹 템플릿"), projectPath, tabId: navigation.graphTabId, pos, busy: false };
    state.list = el("div", { class: "execution-template-list" });
    state.body.append(el("p", { class: "hint" }, "저장한 그룹의 노드·연결·입출력 설정을 새 그룹으로 추가합니다."), state.list);
    state.node.addEventListener("close", () => { if (templates === state) { templates = null; templateRevision++; } });
    await loadTemplates(state);
  }
  const stillTemplates = (state) => templates === state && state.node.open && samePath(state.projectPath, navigation.project) && state.tabId === navigation.graphTabId;
  async function loadTemplates(state) {
    const revision = ++templateRevision;
    try {
      const result = await api("GET", "/api/group-templates?path=" + encodeURIComponent(state.projectPath));
      if (!stillTemplates(state) || revision !== templateRevision) return;
      const list = result.templates ?? [];
      state.list.replaceChildren(...(list.length ? list.map((item) => el("article", { class: "execution-template-row", "data-template-id": item.id }, el("div", {}, el("strong", {}, item.title), el("p", { class: "hint" }, [Number.isFinite(item.nodeCount) ? item.nodeCount + "개 노드" : null, date(item.updatedAt ?? item.createdAt)].filter(Boolean).join(" · "))), el("div", { class: "actions" }, el("button", { type: "button", class: "primary sm", onclick: () => applyTemplate(state, item) }, "추가"), el("button", { type: "button", class: "ghost danger sm", "aria-label": item.title + " 템플릿 삭제", onclick: () => deleteTemplate(state, item) }, "삭제")))) : [el("p", { class: "muted" }, "저장한 템플릿이 없습니다. 그래프에서 그룹을 우클릭해 템플릿으로 저장하세요.")]));
    } catch (error) { if (stillTemplates(state) && revision === templateRevision) state.error.textContent = error.message; }
  }
  async function applyTemplate(state, item) {
    if (state.busy || !stillTemplates(state)) return;
    state.busy = true; for (const button of state.list.querySelectorAll("button")) button.disabled = true;
    try {
      await api("POST", "/api/group-templates/" + encodeURIComponent(item.id) + "/instantiate", { projectPath: state.projectPath, ...(state.tabId ? { tabId: state.tabId } : {}), ...(state.pos ? { pos: state.pos } : {}) });
      await refreshGraph(state.projectPath);
      if (stillTemplates(state)) state.node.close();
    } catch (error) { if (stillTemplates(state)) state.error.textContent = error.message; }
    finally { state.busy = false; for (const button of state.list.querySelectorAll("button")) button.disabled = false; }
  }
  async function deleteTemplate(state, item) {
    if (state.busy || !stillTemplates(state)) return;
    state.busy = true;
    try { await api("DELETE", "/api/group-templates/" + encodeURIComponent(item.id)); if (stillTemplates(state)) await loadTemplates(state); }
    catch (error) { if (stillTemplates(state)) state.error.textContent = error.message; }
    finally { state.busy = false; }
  }
  function saveTemplate(group) {
    saveDialog?.node.close();
    const state = saveDialog = { ...dialog("group-template-save-dialog", "그룹을 템플릿으로 저장"), projectPath: group.projectPath };
    const name = el("input", { id: "group-template-title", value: group.title, maxlength: "120", required: "" });
    const submit = el("button", { type: "submit", class: "primary" }, "템플릿 저장");
    const form = el("form", { class: "dialog-form" }, el("label", {}, "템플릿 이름", name), el("p", { class: "hint" }, "그룹 안의 노드·연결·입출력 설정을 저장해 다시 사용합니다."), el("div", { class: "dialog-actions" }, submit));
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); if (!name.value.trim()) return;
      submit.disabled = true;
      try { await api("POST", "/api/group-templates", { groupId: group.id, title: name.value.trim() }); state.node.close(); }
      catch (error) { if (state.node.open) state.error.textContent = error.message; }
      finally { submit.disabled = false; }
    });
    state.body.append(form); name.select();
  }

  async function playSound() {
    try {
      const Audio = window.AudioContext ?? window.webkitAudioContext;
      if (!Audio) return;
      audio ??= new Audio();
      await audio.resume();
      const oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.type = "sine"; oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0.08, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.2);
    } catch {}
  }
  function openNotificationSettings() {
    settingsDialog?.node.close();
    const state = settingsDialog = dialog("flow-notifications-dialog", "흐름 알림 설정");
    const desktop = el("input", { id: "flow-notifications-desktop", type: "checkbox" }); desktop.checked = preferences.desktop === true;
    const sound = el("input", { id: "flow-notifications-sound", type: "checkbox" }); sound.checked = preferences.sound === true;
    const status = el("p", { class: "hint", role: "status", id: "flow-notifications-status" });
    const updateStatus = () => { status.textContent = !window.Notification ? "이 브라우저는 데스크톱 알림을 지원하지 않습니다." : Notification.permission === "denied" ? "브라우저에서 알림이 차단되어 있습니다. 사이트 설정에서 허용할 수 있습니다." : Notification.permission === "granted" ? "데스크톱 알림을 사용할 수 있습니다." : "데스크톱 알림을 켜면 브라우저에서 권한을 요청합니다."; };
    desktop.disabled = !window.Notification;
    desktop.addEventListener("change", async () => {
      desktop.disabled = true;
      try {
        if (desktop.checked && Notification.permission === "default") await Notification.requestPermission();
        preferences.desktop = desktop.checked && Notification.permission === "granted";
        desktop.checked = preferences.desktop; savePreferences(); updateStatus();
      } catch (error) { preferences.desktop = false; desktop.checked = false; savePreferences(); status.textContent = error.message; }
      finally { desktop.disabled = !window.Notification; }
    });
    sound.addEventListener("change", () => { preferences.sound = sound.checked; savePreferences(); if (sound.checked) void playSound(); });
    state.body.append(el("p", { class: "hint" }, "앱 안에서는 항상 알림을 보여 줍니다. 아래 설정은 이 브라우저에 적용됩니다."), el("label", { class: "check" }, desktop, " 데스크톱 알림"), status, el("label", { class: "check" }, sound, " 소리 허용"), el("p", { class: "hint" }, "알림 노드에서도 소리를 켠 경우에만 재생합니다."));
    updateStatus();
  }
  function notify(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.id && seenNotifications.has(payload.id)) return;
    if (payload.id) { seenNotifications.add(payload.id); if (seenNotifications.size > 200) seenNotifications.delete(seenNotifications.values().next().value); }
    let tray = $("flow-notification-tray");
    if (!tray) { tray = el("aside", { id: "flow-notification-tray", "aria-label": "흐름 알림", "aria-live": "polite" }); document.body.append(tray); }
    const toast = el("article", { class: "flow-notification " + (["success", "error"].includes(payload.level) ? payload.level : "info"), "data-notification-id": payload.id ?? "", role: payload.level === "error" ? "alert" : "status" }, el("div", {}, el("strong", {}, payload.title || "AgentHub"), el("p", {}, plain(payload.message))), el("button", { type: "button", class: "ghost sm", "aria-label": "알림 닫기", onclick: () => toast.remove() }, "×"));
    tray.prepend(toast); while (tray.children.length > 5) tray.lastElementChild.remove();
    setTimeout(() => toast.remove(), 15000);
    if (preferences.desktop && window.Notification?.permission === "granted") {
      try { const notice = new Notification(payload.title || "AgentHub", { body: plain(payload.message), tag: payload.id, silent: true }); notice.onclick = () => { window.focus(); notice.close(); }; } catch {}
    }
    if (payload.sound && preferences.sound) void playSound();
  }
  function clear() {
    for (const state of [history, templates, settingsDialog, saveDialog]) state?.node.close();
    history = null; templates = null; historyRevision++; templateRevision++;
  }
  $("p-execution-history")?.addEventListener("click", () => void openHistory());
  $("p-group-templates")?.addEventListener("click", () => void openTemplates());
  $("p-flow-notifications")?.addEventListener("click", openNotificationSettings);
  return { openHistory, refreshRuns, openTemplates, saveTemplate, openNotificationSettings, notify, clear };
}

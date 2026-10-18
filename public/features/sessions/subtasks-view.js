import { $, el, fmtDate } from "../../shared/dom.js";
import { showError } from "../../shared/error-report.js";
import { SUBTASK_STATUS, visibleSubtasks, subtaskSummary, subtaskKind, subtaskElapsed, subtaskStall, orderSubtasks } from "../../shared/subtasks.js";

/** 세션 화면의 "하위 작업" 패널. 실행 중 작업이 있으면 펼치고, 모두 끝나면 요약 한 줄로 접는다. */
export function createSubtasksView({ api, getSession }) {
  const opened = new Set(); // 자세히를 펼친 작업
  const promptOpened = new Set(); // 요청 글을 펼친 작업
  const notices = new Map(); // 작업 → 중지 안내 글
  const stopping = new Set();
  const panelChoice = new Map(); // 세션 → 사용자가 고른 패널 펼침(실행 중 작업이 새로 생기면 지운다)
  const lastRunning = new Map();
  let renderedSession = null;

  const statusBadge = (task, attrs = {}) => el("span", { class: `pill subtask-status ${task.status}`, ...attrs }, SUBTASK_STATUS[task.status] ?? task.status);

  async function stop(session, task) {
    if (stopping.has(task.id) || !confirm(`하위 작업 "${task.description || task.id}"을(를) 멈출까요?\n세션과 다른 하위 작업은 그대로 둡니다.`)) return;
    stopping.add(task.id);
    notices.delete(task.id);
    render();
    try {
      const result = await api("POST", `/api/sessions/${session.id}/subtasks/${encodeURIComponent(task.id)}/stop`);
      if (result?.confirmed === false) notices.set(task.id, "중지를 요청했지만 CLI가 아직 응답하지 않았습니다. 잠시 뒤에도 실행 중이면 세션을 중지하세요.");
    } catch (err) {
      showError(err, { action: "하위 작업 중지", sessionId: session.id });
    } finally {
      stopping.delete(task.id);
      if (getSession()?.id === session.id) render();
    }
  }

  function card(session, task, level, now) {
    const running = task.status === "running";
    const usage = task.usage ?? {};
    const facts = [usage.toolUses != null ? `도구 ${usage.toolUses}회` : null, usage.totalTokens != null ? `토큰 ${usage.totalTokens.toLocaleString()}` : null].filter(Boolean).join(" · ");
    const stall = subtaskStall(task, now);
    const more = el("details", { class: "subtask-more", ontoggle: (e) => e.currentTarget.open ? opened.add(task.id) : opened.delete(task.id) },
      el("summary", {}, `자세히${task.activity?.length ? ` · 활동 ${task.activity.length}개` : ""}`),
      task.activity?.length
        ? el("ol", { class: "subtask-activity" }, ...task.activity.map((item) => el("li", { class: `subtask-act ${item.kind}` },
          el("time", { datetime: item.ts ?? "" }, item.ts ? fmtDate(item.ts) : ""), item.label ? el("span", { class: "subtask-act-label" }, item.label) : null, el("span", { class: "subtask-act-text" }, item.text ?? ""))))
        : el("div", { class: "muted" }, "기록된 활동이 없습니다."),
      task.prompt ? el("details", { class: "subtask-prompt", ontoggle: (e) => e.currentTarget.open ? promptOpened.add(task.id) : promptOpened.delete(task.id) },
        el("summary", {}, "요청"), el("pre", {}, task.prompt)) : null,
      task.outputFile ? el("div", { class: "subtask-output" }, el("span", { class: "muted" }, "출력 파일 "), el("code", {}, task.outputFile)) : null,
      task.reason ? el("div", { class: "muted" }, `끝난 이유 · ${task.reason}`) : null);
    more.open = opened.has(task.id);
    const prompt = more.querySelector(".subtask-prompt");
    if (prompt) prompt.open = promptOpened.has(task.id);
    return el("li", { class: `subtask-card ${task.status}`, "data-subtask-id": task.id, style: `--level:${Math.min(level, 6)}` },
      el("div", { class: "subtask-head" },
        statusBadge(task),
        el("span", { class: "subtask-desc", title: task.description || "" }, task.description || "(설명 없음)"),
        el("span", { class: "subtask-kind" }, subtaskKind(task)),
        el("time", { class: `subtask-elapsed${running ? " is-running" : ""}`, title: task.startedAt ? `시작 ${new Date(task.startedAt).toLocaleString()}` : "" }, subtaskElapsed(task, now) ?? ""),
        facts ? el("span", { class: "subtask-facts" }, facts) : null,
        running ? el("button", { type: "button", class: "ghost sm danger subtask-stop", title: "이 하위 작업만 멈춥니다", onclick: () => stop(session, task), ...(stopping.has(task.id) ? { disabled: "" } : {}) }, stopping.has(task.id) ? "멈추는 중…" : "중지") : null),
      running && task.lastTool ? el("div", { class: "subtask-now" }, `지금 · ${task.lastTool}`) : null,
      el("div", { class: "subtask-stall", ...(stall ? {} : { hidden: "" }) }, stall ?? ""),
      task.summary ? el("div", { class: "subtask-summary" }, task.summary) : null,
      task.error ? el("div", { class: "subtask-error" }, task.error) : null,
      notices.has(task.id) && running ? el("div", { class: "subtask-notice", role: "status" }, notices.get(task.id)) : null,
      more);
  }

  // 패널만 다시 그린다(대화 기록은 건드리지 않는다).
  function render(now = Date.now()) {
    const root = $("s-subtasks");
    if (!root) return;
    const s = getSession();
    const tasks = visibleSubtasks(s?.chat ? [] : s?.subtasks);
    if (!s || !tasks.length) {
      root.hidden = true;
      root.replaceChildren();
      renderedSession = s?.id ?? null;
      return;
    }
    const running = tasks.filter((task) => task.status === "running").length;
    // 실행 중 작업이 새로 생기면 사용자가 접어 둔 것도 다시 펼친다.
    if (running > (lastRunning.get(s.id) ?? 0)) panelChoice.delete(s.id);
    lastRunning.set(s.id, running);
    const open = panelChoice.get(s.id) ?? running > 0;
    const scroll = renderedSession === s.id ? root.querySelector(".subtask-list")?.scrollTop ?? 0 : 0;
    renderedSession = s.id;
    const list = el("ol", { class: "subtask-list" }, ...orderSubtasks(tasks).map(({ task, level }) => card(s, task, level, now)));
    // 코드로 연 것(dataset.auto)과 다를 때만 사용자의 선택으로 기억한다. toggle 이벤트는 코드로 바꿔도 온다.
    const details = el("details", { class: "subtasks-panel", "data-auto": String(open), ontoggle: (e) => {
      const node = e.currentTarget;
      if (String(node.open) === node.dataset.auto) return;
      node.dataset.auto = String(node.open);
      panelChoice.set(s.id, node.open);
    } },
      el("summary", {}, el("span", { class: `dot ${running ? "running" : "idle"}` }), el("span", { class: "subtask-total" }, subtaskSummary(tasks))), list);
    details.open = open;
    root.hidden = false;
    root.replaceChildren(details);
    list.scrollTop = scroll;
  }

  // 1초마다 실행 중 작업의 경과 시간과 진행 없음 경고만 고친다.
  function tick(now = Date.now()) {
    const s = getSession();
    const root = $("s-subtasks");
    if (!s || !root || root.hidden) return;
    for (const node of root.querySelectorAll(".subtask-card.running")) {
      const task = s.subtasks?.find((item) => item.id === node.dataset.subtaskId);
      if (!task) continue;
      const elapsed = node.querySelector(".subtask-elapsed"), stall = node.querySelector(".subtask-stall");
      const text = subtaskElapsed(task, now) ?? "", warning = subtaskStall(task, now);
      if (elapsed.textContent !== text) elapsed.textContent = text;
      stall.hidden = !warning;
      if (stall.textContent !== (warning ?? "")) stall.textContent = warning ?? "";
    }
  }

  // 대화의 도구 호출 줄에서 누르면 그 작업 카드를 펼쳐 보이고 잠깐 강조한다.
  function focus(taskId) {
    const s = getSession();
    if (!s) return;
    panelChoice.set(s.id, true);
    render();
    const node = [...($("s-subtasks")?.querySelectorAll(".subtask-card") ?? [])].find((item) => item.dataset.subtaskId === taskId);
    if (!node) return;
    node.scrollIntoView({ block: "nearest" });
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1600);
  }

  return { render, tick, focus, statusBadge };
}

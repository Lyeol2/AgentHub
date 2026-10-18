import { $, el, badge } from "../../shared/dom.js";
import { firstLine } from "../../shared/store.js";
import { linkLabel } from "../../shared/flow.js";
import { renderMarkdown } from "../../markdown.js";
import { renderAttachmentLinks } from "./image-composer.js";
import { createReportView } from "./report-view.js";
import { showError } from "../../shared/error-report.js";

/** Render conversation history; user decisions are commands supplied by the controller. */
export function createConversationView({ api, getSession, sessionById, selectSession, onTaskReference, onPlanDecision, onPlanError, onQuestionAnswer, onPermissionDecision }) {
  const reports = createReportView({ api, getSession, sessionById, selectSession, onTaskReference });
  const PLAN_STATUS = { pending: "승인 대기", applied: "실행함", rejected: "거절함", invalid: "형식 오류" };

  // 오케스트레이터가 쓴 계획. 승인하면 세션·연결·요청을 만든다.
  function renderPlan(ev) {
    const s = getSession();
    const plan = ev.plan;
    const name = (ref) => {
      if (ref === s.id) return "오케스트레이터";
      return plan?.sessions.find((x) => x.key === ref)?.title ?? sessionById(ref)?.title ?? ref;
    };
    const section = (title, items) => items.length
      ? el("div", { class: "plan-section" }, el("div", { class: "plan-label" }, title), el("ul", {}, ...items))
      : null;
    const node = el("li", { class: `ev plan ${ev.status}` },
      el("div", { class: "plan-head" }, el("b", {}, "계획"), el("span", { class: `pill plan-${ev.status}` }, PLAN_STATUS[ev.status] ?? ev.status)),
      ev.error ? el("div", { class: "plan-error" }, ev.error) : null);
    if (plan) {
      node.append(
        section("세션", plan.sessions.map((x) => x.id
          ? el("li", {}, el("span", { class: "muted" }, "기존 "), x.title)
          : el("li", { title: x.roleText }, badge(x.agent), ` ${x.title} `,
            el("span", { class: "muted" }, [x.roleName && `역할 ${x.roleName}`, x.permission, x.isolate ? `워크트리 ${x.worktreeName}` : "원본 폴더"].filter(Boolean).join(" · "))))),
        section("연결", plan.links.map((l) => el("li", {}, `${name(l.from)} → ${name(l.to)}`, el("span", { class: "muted" }, ` · ${linkLabel(l)}`)))),
        section("요청", plan.send.map((m) => el("li", { title: m.prompt }, el("b", {}, name(m.to)), ` ${firstLine(m.prompt)}`))));
    }
    const decide = async (action, reason) => {
      try {
        await onPlanDecision(s.id, ev.planId, { action, reason });
      } catch (err) {
        showError(err, { action: action === "approve" ? "계획 승인" : "계획 거절", sessionId: action === "approve" ? s.id : null });
      }
    };
    if (ev.status === "pending") {
      node.append(el("div", { class: "plan-actions" },
        el("button", { class: "primary sm", onclick: () => decide("approve") }, "승인하고 실행"),
        el("button", { class: "ghost sm", onclick: () => {
          const reason = prompt("거절 이유 (적으면 오케스트레이터가 계획을 고칩니다)");
          if (reason !== null) decide("reject", reason);
        } }, "거절")));
    } else if (ev.status === "invalid") {
      node.append(el("div", { class: "plan-actions" },
        el("button", { class: "ghost sm", onclick: () => onPlanError(s.id, ev.error).catch((err) => showError(err, { action: "오케스트레이터에게 오류 알리기" })) }, "오케스트레이터에게 오류 알리기")));
    } else if (ev.result) {
      node.append(el("div", { class: "plan-result" }, ev.result));
    }
    return node;
  }

  // ── 에이전트의 질문 ─────────────────────────────────────────────
  const QUESTION_FENCE = "agenthub-question";
  const QUESTION_BLOCK = new RegExp("```" + QUESTION_FENCE + "\\s*\\n[\\s\\S]*?```", "g");
  // 메시지 블록은 보낸 메시지 줄로 따로 보여 주므로 답변 본문에서 뺀다(서버의 messages.mjs와 같다).
  const MESSAGE_FENCE = "agenthub-message";
  const MESSAGE_BLOCK = new RegExp("```" + MESSAGE_FENCE + "\\s*\\n[\\s\\S]*?```", "g");
  const MESSAGE_VIA = { answer: "답을 기다리던 상대에게 전달", live: "작업 중에 전달", queue: "대기열로 전달" };
  const QUESTION_STATUS = { pending: "답을 기다림", answered: "답함", skipped: "지나감", invalid: "형식 오류" };

  // 선택지를 고르거나 직접 적어 답한다. 답은 다음 요청으로 에이전트에게 간다.
  function renderQuestion(ev) {
    const s = getSession();
    const pending = ev.status === "pending";
    const node = el("li", { class: `ev question ${ev.status}` },
      el("div", { class: "plan-head" }, el("b", {}, "질문"), el("span", { class: `pill q-${ev.status}` }, QUESTION_STATUS[ev.status] ?? ev.status)),
      ev.error ? el("div", { class: "plan-error" }, ev.error) : null);
    if (!ev.questions) return node;
    // 답했거나 지나간 질문은 버튼 없이 질문과 고른 답만 글로 남긴다.
    if (!pending) {
      ev.questions.forEach((q, i) => {
        const a = ev.answers?.[i];
        const answer = [...(a?.selected ?? []), a?.text].filter(Boolean).join(", ");
        node.append(el("div", { class: "q-item done" },
          el("div", { class: "q-question" }, q.header ? el("span", { class: "q-header" }, q.header) : null, q.question),
          el("div", { class: "q-answer" }, answer ? `→ ${answer}` : el("span", { class: "muted" }, "답하지 않음"))));
      });
      return node;
    }

    const picks = ev.questions.map((_, i) => new Set(ev.answers?.[i]?.selected ?? []));
    const texts = [];
    const submit = async (button) => {
      const answers = ev.questions.map((_, i) => ({ selected: [...picks[i]], text: texts[i].value.trim() }));
      if (!answers.some((a) => a.selected.length || a.text)) return showError("답을 고르거나 적으세요.", { action: "질문에 답하기" });
      button.disabled = true;
      try {
        await onQuestionAnswer(s.id, ev.questionId, answers);
      } catch (err) {
        showError(err, { action: "질문에 답하기" });
        button.disabled = false;
      }
    };

    ev.questions.forEach((q, i) => {
      const group = el("div", { class: "q-options" });
      for (const o of q.options) {
        const attrs = { type: "button", class: `q-option${picks[i].has(o.label) ? " picked" : ""}`, "data-label": o.label };
        if (!pending) attrs.disabled = "";
        group.append(el("button", {
          ...attrs,
          onclick: () => {
            const on = !picks[i].has(o.label);
            if (!q.multiSelect) picks[i].clear();
            if (on) picks[i].add(o.label);
            else picks[i].delete(o.label);
            for (const b of group.children) b.classList.toggle("picked", picks[i].has(b.dataset.label));
          },
        }, el("b", {}, o.label), o.description ? el("span", { class: "muted" }, o.description) : null));
      }
      const textAttrs = { class: "q-text", placeholder: pending ? "직접 답 적기 · Enter로 답하기" : "" };
      if (!pending) textAttrs.disabled = "";
      const text = el("input", textAttrs);
      text.value = ev.answers?.[i]?.text ?? "";
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) node.querySelector(".q-submit")?.click();
      });
      texts.push(text);
      node.append(el("div", { class: "q-item" },
        el("div", { class: "q-question" }, q.header ? el("span", { class: "q-header" }, q.header) : null, q.question,
          q.multiSelect ? el("span", { class: "muted" }, " (여러 개 고를 수 있음)") : null),
        q.options.length ? group : null,
        text));
    });
    if (pending) {
      node.append(el("div", { class: "plan-actions" },
        el("button", { class: "primary sm q-submit", onclick: (e) => submit(e.currentTarget) }, "답하기")));
    }
    return node;
  }

  // 실행 중에 CLI가 묻는 권한 요청. 답할 때까지 CLI가 기다린다.
  const PERMISSION_STATUS = { pending: "허용을 기다림", allowed: "허용함", denied: "거절함", skipped: "지나감" };
  const PLAN_APPROVAL_STATUS = { pending: "승인을 기다림", allowed: "승인함", denied: "수정 요청함", skipped: "지나감" };

  function renderPermission(ev) {
    const s = getSession();
    const decide = async (decision, button) => {
      let message;
      if (decision === "deny") {
        message = prompt(ev.planApproval ? "계획에서 고칠 점 (비워 두어도 됩니다)" : "거절 이유나 대신 할 일 (비워 두어도 됩니다)");
        if (message === null) return;
      }
      for (const b of button.parentElement.children) b.disabled = true;
      try {
        await onPermissionDecision(s.id, ev.requestId, { decision, message });
      } catch (err) {
        showError(err, { action: ev.planApproval ? "계획 승인 응답" : "권한 요청 응답" });
        for (const b of button.parentElement.children) b.disabled = false;
      }
    };
    if (ev.planApproval) return renderPlanApproval(ev, decide);
    const label = ev.status === "allowed" && ev.decision === "always" ? (ev.rememberLabel ? ev.rememberLabel + "함" : "항상 허용함") : PERMISSION_STATUS[ev.status] ?? ev.status;
    const node = el("li", { class: `ev permission ${ev.status}` },
      el("div", { class: "plan-head" }, el("b", {}, "권한 요청"), el("span", { class: `pill p-${ev.status}` }, label)),
      el("div", { class: "perm-tool mono" }, ev.text),
      ev.reason ? el("div", { class: "muted" }, ev.reason) : null,
      ev.detail ? el("details", {}, el("summary", {}, "자세히"), el("pre", { class: "perm-detail" }, ev.detail)) : null);
    if (ev.status === "pending") {
      node.append(el("div", { class: "plan-actions" },
        el("button", { class: "primary sm", title: "이 요청만 허용합니다. 같은 요청이 다시 오면 또 묻습니다.", onclick: (e) => decide("allow", e.currentTarget) }, "이번만 허용"),
        ev.canRemember ? el("button", { class: "ghost sm", title: ev.rememberDescription ?? "이 세션에서는 같은 요청을 다시 묻지 않습니다. 세션 설정에서 지울 수 있습니다.", onclick: (e) => decide("always", e.currentTarget) }, ev.rememberLabel ?? "이 세션에서 계속 허용") : null,
        el("button", { class: "ghost sm danger", onclick: (e) => decide("deny", e.currentTarget) }, "거절")));
    }
    return node;
  }

  // 계획 모드(/plan)에서 세운 계획. 승인하면 그대로 진행하고, 수정 요청은 계획 모드에서 다시 세우게 한다.
  function renderPlanApproval(ev, decide) {
    const node = el("li", { class: `ev permission plan-approval ${ev.status}` },
      el("div", { class: "plan-head" }, el("b", {}, "계획 승인"), el("span", { class: `pill p-${ev.status}` }, PLAN_APPROVAL_STATUS[ev.status] ?? ev.status)));
    const body = el("div", { class: "md plan-approval-body" });
    body.innerHTML = renderMarkdown(ev.detail ?? "", { sessionId: getSession()?.id });
    node.append(body);
    if (ev.status === "pending") {
      node.append(el("div", { class: "plan-actions" },
        el("button", { class: "primary sm", onclick: (e) => decide("allow", e.currentTarget) }, "승인하고 진행"),
        el("button", { class: "ghost sm", onclick: (e) => decide("deny", e.currentTarget) }, "수정 요청")));
    }
    return node;
  }

  // 다른 창을 보고 있거나 다른 세션을 열어 둔 사이에 온 질문·권한 요청은 알림으로 알린다.

  // ── 도구 호출 ───────────────────────────────────────────────────
  // 도구 호출(명령 실행, 파일 읽기 등)은 한 줄로 접어 두고, 누르면 입력과 출력을 펼친다.
  // 결과(tool_result)는 아직 결과가 없는 가장 앞의 도구 호출에 붙인다(CLI가 호출한 순서대로 결과를 보낸다).
  const EXPAND_TOOLS_KEY = "agenthub-expand-tools";
  const expandTools = () => localStorage.getItem(EXPAND_TOOLS_KEY) === "1";

  function renderTool(ev, cls) {
    const body = el("div", { class: "tool-body" });
    if (ev.detail) body.append(el("div", { class: "tool-label" }, "입력"), el("pre", { class: "tool-input" }, ev.detail));
    const details = el("details", {},
      el("summary", {}, el("span", { class: "tool-name" }, ev.text ?? ""), el("span", { class: "tool-state" })),
      body);
    details.open = expandTools();
    return el("li", { class: `${cls} pending`, title: ev.text ?? "" }, details);
  }

  // 같은 실행에서 아직 결과를 받지 않은 도구에만 출력을 붙인다.
  function attachToolResult(pendingTools, ev) {
    const tool = pendingTools.shift();
    if (!tool) return false;
    tool.classList.remove("pending");
    tool.classList.add(ev.isError ? "failed" : "done");
    const text = ev.text ?? "";
    const lines = text ? text.split("\n").length : 0;
    tool.querySelector(".tool-state").textContent = ev.isError ? "오류" : lines ? `${lines}줄` : "";
    tool.querySelector(".tool-body").append(el("div", { class: "tool-label" }, "출력"),
      el("pre", { class: `tool-output${ev.isError ? " is-error" : ""}` }, text || "(출력 없음)"));
    return true;
  }

  const histories = new WeakMap();
  const answerText = (ev) => (ev.text ?? "").replace(QUESTION_BLOCK, "").replace(MESSAGE_BLOCK, "").trim();
  const isSettled = () => !["running", "paused"].includes(getSession()?.state);

  function appendRendered(list, ev, pendingTools) {
    if (ev.kind === "tool_result" && attachToolResult(pendingTools, ev)) return;
    const node = renderEvent(ev);
    if (ev.kind === "tool") pendingTools.push(node);
    list.append(node);
    return node;
  }

  // 가져온 기록에는 완료 이벤트가 없을 수 있어 다음 독립 요청도 경계로 쓴다.
  // 실행 중에 붙인 요청은 같은 작업이며, 완료 뒤의 로그·질문은 그 결과에 속한다.
  function turns(events, settled) {
    const result = [];
    let current = { events: [], complete: false };
    for (const ev of events) {
      const nextRequest = ev.kind === "user" && !ev.injected;
      const nextOutput = current.complete && ["user", "text", "thinking", "tool"].includes(ev.kind);
      if (current.events.length && (nextRequest || nextOutput)) {
        result.push({ ...current, complete: true });
        current = { events: [], complete: false };
      }
      current.events.push(ev);
      if (ev.kind === "result") current.complete = true;
    }
    if (current.events.length) result.push({ ...current, complete: current.complete || settled });
    return result;
  }

  function renderTurn(list, turn, pendingTools) {
    if (!turn.complete) {
      for (const ev of turn.events) appendRendered(list, ev, pendingTools);
      return;
    }
    const failed = turn.events.some((ev) => ev.kind === "error") && !turn.events.some((ev) => ev.kind === "result");
    const answer = failed ? null : turn.events.findLast((ev) => ev.kind === "text" && answerText(ev));
    let work = null;
    for (const ev of turn.events) {
      if (ev.kind === "tool_result" && attachToolResult(pendingTools, ev)) continue;
      // 사용자 결정과 오류는 접힌 작업 과정 안에 감추지 않는다.
      const visible = ev === answer || ["user", "error", "question", "permission", "plan"].includes(ev.kind) || (ev.kind === "result" && !answer);
      if (visible) {
        appendRendered(list, ev, pendingTools);
        if (ev !== answer) work = null;
        continue;
      }
      // 중간 출력 없이 답변만 한 경우 완료 통계만 따로 접는 묶음은 만들지 않는다.
      if (ev.kind === "result" && !work) continue;
      if (ev.kind === "text" && !answerText(ev)) continue;
      if (!work) {
        const body = el("ol", { class: "work-events" });
        const summary = el("summary", {}, "작업 과정");
        list.append(el("li", { class: "ev work" }, el("details", {}, summary, body)));
        work = { body, summary, count: 0 };
      }
      const node = appendRendered(work.body, ev, pendingTools);
      if (node) {
        for (const details of node.querySelectorAll("details")) details.open = false;
        work.summary.textContent = `작업 과정 · ${++work.count}개`;
      }
    }
  }

  function appendEvent(list, ev) {
    const history = histories.get(list);
    if (!history) return renderEvents(list, [ev]);
    history.events.push(ev);
    if (ev.kind === "result" || (ev.kind === "user" && !ev.injected) || history.complete) {
      renderEvents(list, history.events);
      return;
    }
    history.settled = false;
    appendRendered(list, ev, history.pendingTools);
  }

  function renderEvents(list, events) {
    const history = { events: [...events], pendingTools: [], settled: isSettled(), sessionId: getSession()?.id };
    const groups = turns(history.events, history.settled);
    history.complete = groups.at(-1)?.complete ?? false;
    histories.set(list, history);
    list.replaceChildren();
    for (const turn of groups) {
      history.pendingTools = [];
      renderTurn(list, turn, history.pendingTools);
    }
  }

  // 실패·중단은 result가 없으므로 실제 실행 상태가 끝났을 때 마지막 과정도 접는다.
  function settleEvents(list) {
    const history = histories.get(list);
    if (history && history.sessionId === getSession()?.id && !history.settled && isSettled()) renderEvents(list, history.events);
  }

  $("s-expand-tools").checked = expandTools();
  $("s-expand-tools").addEventListener("change", (e) => {
    localStorage.setItem(EXPAND_TOOLS_KEY, e.target.checked ? "1" : "0");
    for (const d of document.querySelectorAll(".events li.ev.tool > details")) d.open = e.target.checked;
  });

  function renderEvent(ev) {
    const cls = `ev ${ev.kind}${ev.isError ? " is-error" : ""}${ev.injected ? " injected" : ""}`;
    if (ev.kind === "tool") return renderTool(ev, cls);
    if (ev.kind === "plan") return renderPlan(ev);
    if (ev.kind === "question") return renderQuestion(ev);
    if (ev.kind === "permission") return renderPermission(ev);
    // 질문 블록은 아래 질문 카드로 보여 주므로 답변 본문에서는 뺀다.
    if (ev.kind === "text") {
      // 에이전트 답변은 마크다운으로 보여 준다(renderMarkdown이 원문을 이스케이프한다).
      const text = answerText(ev);
      if (!text) return el("li", { class: "ev hidden-empty", hidden: true });
      const node = el("li", { class: `${cls} md` });
      node.innerHTML = renderMarkdown(text, { sessionId: getSession()?.id });
      reports.enhance(node, text, { references: ev.references });
      if (ev.attachments?.length) node.append(renderAttachmentLinks(ev.attachments));
      return node;
    }
    if (ev.kind === "message") {
      // 이 세션이 다른 세션에 보낸 메시지
      return el("li", { class: `${cls} handoff` },
        el("details", {},
          el("summary", {}, "✉ ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); if (sessionById(ev.to)) selectSession(ev.to); } }, ev.toTitle),
            `에게 보낸 메시지 · ${MESSAGE_VIA[ev.via] ?? ""}`),
          el("div", { class: "handoff-body" }, ev.text)));
    }
    if (ev.kind === "user" && ev.from) {
      // 연결된 세션에서 넘어온 요청은 접어서 보여 준다.
      const open = (e) => {
        e.preventDefault();
        if (sessionById(ev.from)) selectSession(ev.from);
      };
      return el("li", { class: `${cls} handoff` },
        el("details", {},
          el("summary", {}, el("a", { href: "#", onclick: open }, `${ev.message || ev.reply ? "✉" : "↳"} ${ev.fromTitle}`),
            ev.reply ? "에게서 온 답" : ev.message ? "에게서 온 메시지" : "에서 넘어온 작업"),
          el("div", { class: "handoff-body" }, ev.text)));
    }
    const node = el("li", { class: cls });
    if (ev.kind === "user") reports.renderUser(node, ev.text ?? "", ev.references);
    else node.append(ev.text ?? "");
    if (ev.attachments?.length) node.append(renderAttachmentLinks(ev.attachments));
    if (ev.detail) node.title = ev.detail;
    return node;
  }

  return { renderEvents, appendEvent, settleEvents };
}

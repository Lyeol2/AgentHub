import { el, badge, pill, lifePill, subtaskPill, unreadPill } from "../../shared/dom.js";
import { elapsedElement } from "../../shared/elapsed.js";
import { firstLine } from "../../shared/store.js";
import { sessionLockButton } from "../../shared/session-lock.js";
import { SVG_NS } from "./model.js";

export function createGraphView({ skillChips, restartSession, clearSessionError, commandNode, toggleSessionLock, guideWarning = () => 0, openGuide = null }) {
    function createCanvas(sessions, commands) {
    const canvas = el("div", { class: "graph-canvas" });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("graph-edges");
    svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>`;
    canvas.append(svg);

    const cards = new Map();
    for (const s of sessions) {
      // 카드에는 지침 글을 싣지 않는다. 지침 이름·요약은 마우스를 올리면 보이고, 문제가 있을 때만 ⚠를 띄운다.
      const role = s.guideFile ? [s.guideName, s.guideSummary].filter(Boolean).join(" · ") || s.guideFile.split("/").pop() : [s.roleName, firstLine(s.role)].filter(Boolean).join(" · ");
      const warn = s.guideFile ? (s.guideMissing ? "세션 지침 파일이 없습니다" : guideWarning(s) ? "연결 키워드가 세션 지침의 판정에 없습니다" : "") : "";
      const orchestrator = s.kind === "orchestrator";
      const tip = role ? `${s.title} — ${s.guideFile ? "지침" : "역할"} ${role}` : s.title;
      const warnMark = warn ? el("button", { type: "button", class: "gcard-guide-warn", title: `${warn}${openGuide ? " · 누르면 지침을 엽니다" : ""}`, "aria-label": `${s.title}: ${warn}`,
        onclick: (e) => { e.stopPropagation(); openGuide?.(s); } }, "⚠") : null;
      const card = el("div", { class: `gcard ${s.state}${orchestrator ? " orchestrator" : ""}${s.locked ? " locked" : ""}`, "data-id": s.id, title: tip },
        el("div", { class: "gcard-top" }, badge(s.agent), orchestrator ? el("span", { class: "pill orch" }, "지휘") : null,
          s.waiting ? el("span", { class: "pill q-pending", title: "답을 기다리는 질문이나 권한 요청이 있습니다" }, "답 대기") : pill(s.state),
          subtaskPill(s), warnMark,
          sessionLockButton(s, toggleSessionLock)),
        el("div", { class: "gcard-heading" }, el("div", { class: "gcard-title" }, s.title), unreadPill(s)),
        skillChips(s),
        el("div", { class: "gcard-foot" }, elapsedElement("session", s, true),
          el("span", { class: "gcard-life" }, lifePill(s),
            s.state === "error" ? el("button", {
              type: "button",
              class: "gcard-clear-error",
              title: "오류 해제: 오류 표시만 지웁니다. 대화와 연결은 그대로 둡니다.",
              "aria-label": `${s.title} 오류 해제`,
              onclick: () => clearSessionError(s),
            }, "✕") : null,
            el("button", {
              type: "button",
              class: "gcard-restart",
              title: "다시 시작: CLI 대화를 새로 시작해 컨텍스트를 비웁니다. 기록·역할·연결은 그대로 둡니다.",
              onclick: () => restartSession(s),
              ...(s.state === "running" || s.state === "background" ? { disabled: "" } : {}),
            }, "↻"))),
        el("span", { class: "gcard-handle", title: "끌어서 다른 세션에 연결" }));
      cards.set(s.id, card);
      canvas.append(card);
    }
    for (const c of commands) {
      const node = commandNode(c);
      cards.set(c.id, node);
      canvas.append(node);
    }

    return { canvas, svg, cards };
  }
  return { createCanvas };
}

import { el, badge, pill, lifePill } from "../../shared/dom.js";
import { elapsedElement } from "../../shared/elapsed.js";
import { firstLine } from "../../shared/store.js";
import { sessionLockButton } from "../../shared/session-lock.js";
import { SVG_NS } from "./model.js";

export function createGraphView({ skillChips, restartSession, commandNode, toggleSessionLock }) {
    function createCanvas(sessions, commands) {
    const canvas = el("div", { class: "graph-canvas" });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("graph-edges");
    svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>`;
    canvas.append(svg);

    const cards = new Map();
    for (const s of sessions) {
      const role = [s.roleName, firstLine(s.role)].filter(Boolean).join(" · ");
      const orchestrator = s.kind === "orchestrator";
      const card = el("div", { class: `gcard ${s.state}${orchestrator ? " orchestrator" : ""}${s.locked ? " locked" : ""}`, "data-id": s.id, title: s.role || s.title },
        el("div", { class: "gcard-top" }, badge(s.agent), orchestrator ? el("span", { class: "pill orch" }, "지휘") : null,
          s.waiting ? el("span", { class: "pill q-pending", title: "답을 기다리는 질문이나 권한 요청이 있습니다" }, "답 대기") : pill(s.state),
          sessionLockButton(s, toggleSessionLock)),
        el("div", { class: "gcard-title" }, s.title),
        el("div", { class: `gcard-role${role ? "" : " empty"}` }, role || "역할 없음"),
        skillChips(s),
        el("div", { class: "gcard-foot" }, elapsedElement("session", s, true),
          el("span", { class: "gcard-life" }, lifePill(s),
            el("button", {
              type: "button",
              class: "gcard-restart",
              title: "다시 시작: CLI 대화를 새로 시작해 컨텍스트를 비웁니다. 기록·역할·연결은 그대로 둡니다.",
              onclick: () => restartSession(s),
              ...(s.state === "running" ? { disabled: "" } : {}),
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

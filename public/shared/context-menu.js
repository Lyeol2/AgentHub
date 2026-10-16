import { el } from "./dom.js";

export function closeContextMenu() {
  document.querySelector(".context-menu")?.remove();
}

// entries: [이름, 동작, 옵션] 항목, null(구분선), 문자열(묶음 제목)
export function openContextMenu(e, title, entries) {
  e.preventDefault();
  closeContextMenu();
  const menu = el("div", { class: "context-menu", role: "menu" }, el("div", { class: "menu-title" }, title),
    ...entries.map((entry) => {
      if (!entry) return el("hr");
      if (typeof entry === "string") return el("div", { class: "menu-section", role: "presentation" }, entry);
      const [label, action, { danger = false, disabled = false, title: tip = "" } = {}] = entry;
      return el("button", {
        type: "button",
        class: `menu-item${danger ? " danger" : ""}`,
        title: tip,
        ...(disabled ? { disabled: "" } : {}),
        onclick: () => {
          closeContextMenu();
          action();
        },
      }, label);
    }));
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - height - 8)}px`;
}

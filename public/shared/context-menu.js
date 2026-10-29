import { el } from "./dom.js";

export function closeContextMenu() {
  document.querySelector(".context-menu")?.remove();
}

const CLOSE_DELAY_MS = 250; // 하위 메뉴로 마우스를 옮기는 동안 닫히지 않게 기다리는 시간

// entries: [이름, 동작, 옵션] 항목, null(구분선), 문자열(묶음 제목), { submenu: 이름, items: entries } 하위 메뉴
// 하위 메뉴는 마우스를 올리거나 누르면(→·Enter 키도) 옆에 펼쳐진다. 접힌 항목도 메뉴 안에 숨겨 두어 검색·이동에 쓴다.
export function openContextMenu(e, title, entries) {
  e.preventDefault();
  closeContextMenu();
  const menu = el("div", { class: "context-menu", role: "menu" }, el("div", { class: "menu-title" }, title), ...render(entries));
  menu.addEventListener("keydown", (event) => keyboard(event, menu));
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - height - 8))}px`;
}

function render(entries) {
  return entries.map((entry) => {
    if (!entry) return el("hr");
    if (typeof entry === "string") return el("div", { class: "menu-section", role: "presentation" }, entry);
    if (!Array.isArray(entry) && entry.submenu) return submenu(entry);
    const [label, action, { danger = false, disabled = false, title: tip = "" } = {}] = entry;
    return el("button", {
      type: "button",
      class: `menu-item${danger ? " danger" : ""}`,
      role: "menuitem",
      title: tip,
      ...(disabled ? { disabled: "" } : {}),
      onclick: () => {
        closeContextMenu();
        action();
      },
    }, label);
  });
}

// 하위 메뉴 하나: 펼치는 단추와 옆에 뜨는 패널
function submenu({ submenu: label, items }) {
  const count = items.filter((item) => Array.isArray(item)).length + items.filter((item) => item?.submenu).reduce((sum, item) => sum + item.items.length, 0);
  const trigger = el("button", { type: "button", class: "menu-item menu-sub-trigger", role: "menuitem", "aria-haspopup": "menu", "aria-expanded": "false" },
    el("span", { class: "menu-sub-label" }, label), el("span", { class: "menu-sub-count" }, String(count)), el("span", { class: "menu-sub-arrow", "aria-hidden": "true" }, "▸"));
  const panel = el("div", { class: "menu-panel", role: "menu", "aria-label": label, hidden: "" }, ...render(items));
  const wrap = el("div", { class: "menu-sub" }, trigger, panel);
  let timer = null;
  wrap.open = () => {
    clearTimeout(timer);
    if (!panel.hidden) return;
    // 같은 단계의 다른 하위 메뉴는 닫는다.
    for (const other of wrap.parentElement?.querySelectorAll(":scope > .menu-sub") ?? []) if (other !== wrap) other.close();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("open");
    place(trigger, panel);
  };
  wrap.close = () => {
    clearTimeout(timer);
    for (const inner of panel.querySelectorAll(".menu-sub")) inner.close();
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("open");
  };
  trigger.addEventListener("click", () => (panel.hidden ? wrap.open() : wrap.close()));
  wrap.addEventListener("mouseenter", () => wrap.open());
  wrap.addEventListener("mouseleave", () => { clearTimeout(timer); timer = setTimeout(() => wrap.close(), CLOSE_DELAY_MS); });
  return wrap;
}

// 단추 오른쪽에 펼친다. 화면 오른쪽이 모자라면 왼쪽에, 아래가 모자라면 위로 올린다.
function place(trigger, panel) {
  const box = trigger.getBoundingClientRect();
  const parent = (trigger.closest(".menu-panel") ?? trigger.closest(".context-menu")).getBoundingClientRect();
  const { width, height } = panel.getBoundingClientRect();
  const right = parent.right + 2;
  panel.style.left = `${right + width + 8 > innerWidth ? Math.max(8, parent.left - width - 2) : right}px`;
  panel.style.top = `${Math.max(8, Math.min(box.top - 4, innerHeight - height - 8))}px`;
}

// ↑↓ 같은 패널 안에서 이동, → 하위 메뉴 펼치기, ← 접고 단추로 돌아가기, Esc 닫기
function keyboard(event, menu) {
  const current = document.activeElement?.closest?.(".menu-item");
  if (event.key === "Escape") { event.preventDefault(); closeContextMenu(); return; }
  if (!current || !menu.contains(current)) {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); visible(menu)[0]?.focus(); }
    return;
  }
  const level = current.closest(".menu-panel") ?? menu;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const items = visible(level);
    const index = items.indexOf(current);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  } else if (event.key === "ArrowRight" && current.classList.contains("menu-sub-trigger")) {
    event.preventDefault();
    const wrap = current.closest(".menu-sub");
    wrap.open();
    visible(wrap.querySelector(".menu-panel"))[0]?.focus();
  } else if (event.key === "ArrowLeft" && level !== menu) {
    event.preventDefault();
    const wrap = level.closest(".menu-sub");
    wrap.close();
    wrap.querySelector(".menu-sub-trigger").focus();
  }
}

// 이 단계(메뉴나 패널)에 바로 보이는 항목: 하위 패널 안의 항목은 빼고 펼치는 단추는 넣는다.
const visible = (level) => [...level.querySelectorAll(".menu-item")].filter((item) => (item.closest(".menu-panel") ?? item.closest(".context-menu")) === level && !item.disabled);

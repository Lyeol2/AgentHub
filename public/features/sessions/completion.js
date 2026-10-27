import { el } from "../../shared/dom.js";
import { completionTrigger, applyCompletion, filterCommands, refToken, refMatches, expandRefs, NBSP, BUILTIN_COMMANDS } from "../../composer.js";

const SKILL_TTL = 10_000;
const REFS_MIME = "application/x-agenthub-refs";
let clipboardRefs = null; // 마지막으로 복사한 { text, map } — 작성창끼리 같이 쓴다.
const SCOPE_LABEL = { project: "프로젝트 스킬", claude: "Claude 스킬", personal: "개인 스킬" };
// "a/b/c.txt" → "c.txt", 폴더 "a/b/" → "b/"
const fileName = (value) => (value.endsWith("/") ? `${value.slice(0, -1).split("/").pop()}/` : value.split("/").pop());

// 세션 작성창의 "@" 파일 참조와 "/" 명령 자동 완성.
// ↑↓로 고르고 Enter·Tab으로 넣는다. Esc는 목록만 닫는다(작업 일시중지로 넘어가지 않는다).
// 반드시 작성창의 다른 keydown 처리보다 먼저 만든다. 목록이 열려 있으면 Enter가 보내기로 넘어가지 않게 막는다.
// 고른 파일은 "@파일이름"으로 줄여 파란 글씨로 보이고, 보낼 때 expand()로 전체 경로를 되살린다.
export function createCompletion({ textarea, api, getSession, onBuiltin, getReferences = () => [] }) {
  const menu = el("ul", { class: "complete-menu", role: "listbox", id: `${textarea.id}-complete`, hidden: "" });
  const parent = textarea.parentElement;
  // 작성창 뒤에 같은 글자를 그리는 판을 두고, 참조가 있으면 작성창 글자를 숨겨 판의 색을 보인다.
  const mirror = el("div", { class: "ref-mirror", "aria-hidden": "true" });
  const field = el("div", { class: "ref-field" });
  textarea.before(field);
  field.append(mirror, textarea);
  parent?.append(menu);
  textarea.setAttribute("aria-autocomplete", "list");
  const state = { trigger: null, items: [], index: 0, seq: 0, timer: null, dismissed: null, empty: null };
  const skillCache = new Map(); // projectPath → { at, skills }
  const refsBySession = new Map(); // sessionId → Map(작성창 이름 → 전체 경로)
  const sessionRefs = () => refsBySession.get(getSession()?.id);

  const MIRROR_STYLE = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize", "paddingTop", "paddingLeft", "paddingBottom",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderRadius", "boxSizing"];
  function paint() {
    const text = textarea.value;
    const refs = sessionRefs();
    if (refs && !text) refs.clear();
    const matches = refs ? refMatches(text, refs) : [];
    field.classList.toggle("has-refs", matches.length > 0);
    if (!matches.length) return mirror.replaceChildren();
    const style = getComputedStyle(textarea);
    for (const key of MIRROR_STYLE) mirror.style[key] = style[key];
    // 작성창 스크롤 막대가 차지하는 폭만큼 오른쪽을 비워 줄바꿈 위치를 맞춘다.
    const bar = textarea.offsetWidth - textarea.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    mirror.style.paddingRight = `${parseFloat(style.paddingRight) + Math.max(0, bar)}px`;
    const nodes = [];
    let last = 0;
    for (const m of matches) {
      nodes.push(text.slice(last, m.start), el("span", { class: "ref-chip" }, text.slice(m.start, m.end)));
      last = m.end;
    }
    // 끝 줄바꿈이 있어도 판의 높이가 작성창과 같게 한 줄을 더 둔다.
    nodes.push(`${text.slice(last)}\n`);
    mirror.replaceChildren(...nodes);
    mirror.scrollTop = textarea.scrollTop;
  }

  async function skills(projectPath) {
    const hit = skillCache.get(projectPath);
    if (hit && Date.now() - hit.at < SKILL_TTL) return hit.skills;
    const list = await api("GET", `/api/skills?path=${encodeURIComponent(projectPath)}`).catch(() => []);
    skillCache.set(projectPath, { at: Date.now(), skills: list });
    return list;
  }

  function close() {
    paint();
    state.seq++;
    state.trigger = null;
    state.items = [];
    clearTimeout(state.timer);
    menu.hidden = true;
    menu.replaceChildren();
    textarea.removeAttribute("aria-activedescendant");
  }

  function render() {
    if (!state.items.length) {
      menu.hidden = true;
      return;
    }
    menu.hidden = false;
    menu.replaceChildren(...state.items.map((item, i) => {
      const active = i === state.index;
      const parts = item.type === "file"
        // 파일 이름은 잘리지 않게 앞에 두고, 전체 경로는 뒤에 흐린 글씨로 보인다.
        ? [el("span", { class: "complete-icon", "aria-hidden": "true" }, item.value.endsWith("/") ? "📁" : "📄"),
          el("span", { class: "complete-name complete-file mono" }, fileName(item.value)),
          el("span", { class: "complete-desc complete-path mono", title: item.value }, item.value)]
        : item.type === "session" || item.type === "task"
        ? [el("span", { class: "complete-icon", "aria-hidden": "true" }, item.type === "session" ? "◉" : "☑"),
          el("span", { class: "complete-name" }, item.value),
          el("span", { class: "complete-desc" }, item.description ?? ""),
          el("span", { class: "complete-tag" }, item.type === "session" ? "세션" : "작업")]
        : [el("span", { class: "complete-name mono" }, `/${item.value}`),
          el("span", { class: "complete-desc" }, item.description ?? ""),
          el("span", { class: "complete-tag" }, item.builtin ? "기본" : SCOPE_LABEL[item.scope] ?? "스킬")];
      const node = el("li", { class: `complete-item${active ? " active" : ""}`, role: "option", id: `${menu.id}-${i}`, "aria-selected": String(active) }, ...parts);
      // 누르는 순간 작성창이 초점을 잃지 않게 한다.
      node.addEventListener("pointerdown", (e) => e.preventDefault());
      node.addEventListener("click", () => choose(i));
      return node;
    }));
    textarea.setAttribute("aria-activedescendant", `${menu.id}-${state.index}`);
    menu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  async function update() {
    const session = getSession();
    let trigger = session && !session.chat ? completionTrigger(textarea.value, textarea.selectionStart) : null;
    // 이미 골라 넣은 참조 뒤에 이어 쓰는 글은 검색어로 보지 않는다.
    if (trigger?.type === "file" && refMatches(textarea.value, sessionRefs() ?? new Map()).some((ref) => ref.start === trigger.start && ref.end < trigger.end)) trigger = null;
    // 띄어쓰기를 넣어 이어 쓰다 결과가 없어진 검색어는 더 길게 써도 다시 찾지 않는다.
    if (trigger && state.empty && state.empty.start === trigger.start && trigger.query.startsWith(state.empty.query)) trigger = null;
    // Esc로 닫은 자리에서는 다시 열지 않는다(같은 낱말을 고치면 다시 연다).
    if (!trigger || (state.dismissed && state.dismissed.start === trigger.start && state.dismissed.type === trigger.type && textarea.value.slice(trigger.start, trigger.end) === state.dismissed.word)) {
      if (!trigger) { state.dismissed = null; if (state.empty && !completionTrigger(textarea.value, textarea.selectionStart)) state.empty = null; }
      return close();
    }
    state.dismissed = null;
    const seq = ++state.seq;
    const sameWord = state.trigger && state.trigger.type === trigger.type && state.trigger.start === trigger.start;
    state.trigger = trigger;
    if (trigger.type === "command") {
      const commands = [...BUILTIN_COMMANDS, ...(await skills(session.projectPath)).filter((s) => !BUILTIN_COMMANDS.some((b) => b.name === s.name))];
      if (seq !== state.seq) return;
      state.items = filterCommands(commands, trigger.query).slice(0, 30).map((c) => ({ type: "command", value: c.name, description: c.description, builtin: !!c.builtin && !c.prompt, scope: c.scope }));
      state.index = sameWord ? Math.min(state.index, Math.max(0, state.items.length - 1)) : 0;
      return render();
    }
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      const [fileResult, referenceResult] = await Promise.allSettled([
        api("GET", `/api/sessions/${session.id}/files?q=${encodeURIComponent(trigger.query)}`),
        Promise.resolve().then(() => getReferences(session)),
      ]);
      if (seq !== state.seq) return;
      const files = fileResult.status === "fulfilled" && Array.isArray(fileResult.value?.files) ? fileResult.value.files : [];
      const references = referenceResult.status === "fulfilled" && Array.isArray(referenceResult.value) ? referenceResult.value : [];
      // 띄어쓰기로 나눈 낱말이 모두 들어 있는 세션·작업을 찾는다.
      const terms = trigger.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = references.filter((item) => ["session", "task"].includes(item.type)
        && typeof item.path === "string" && typeof item.value === "string"
        && terms.every((term) => (`${item.type === "session" ? "세션" : "작업"}/${item.value} ${item.description ?? ""}`).toLocaleLowerCase().includes(term)));
      state.items = [...matches.slice(0, 10), ...files.map((value) => ({ type: "file", value }))].slice(0, 40);
      if (!state.items.length && /\s/.test(trigger.query)) state.empty = { start: trigger.start, query: trigger.query };
      state.index = sameWord ? Math.min(state.index, Math.max(0, state.items.length - 1)) : 0;
      render();
    }, 80);
  }

  function choose(index) {
    const item = state.items[index];
    const trigger = state.trigger;
    if (!item || !trigger) return;
    if (item.type === "command" && item.builtin) {
      close();
      textarea.value = "";
      textarea.dispatchEvent(new Event("input"));
      onBuiltin(item.value);
      return;
    }
    let value = item.value;
    if (item.type === "file" && !value.endsWith("/")) {
      const id = getSession()?.id;
      if (!refsBySession.has(id)) refsBySession.set(id, new Map());
      const refs = refsBySession.get(id);
      value = refToken(value, refs);
      refs.set(value, item.value);
    } else if (item.type === "session" || item.type === "task") {
      const id = getSession()?.id;
      if (!refsBySession.has(id)) refsBySession.set(id, new Map());
      const refs = refsBySession.get(id);
      const name = value.replace(/["\r\n]/g, " ").trim() || item.path.split("/").at(-1);
      const base = `${item.type === "session" ? "세션" : "작업"}/${name}`;
      value = base;
      let suffix = 1;
      while (refs.has(value) && refs.get(value) !== item.path) value = `${base} (${++suffix})`;
      refs.set(value, item.path);
    }
    const next = applyCompletion(textarea.value, trigger, value);
    textarea.value = next.text;
    textarea.setSelectionRange(next.caret, next.caret);
    textarea.focus();
    close();
    // 폴더를 고르면 그 안을 이어서 보여 준다. 입력 이벤트로 보내기 버튼 상태도 맞춘다.
    textarea.dispatchEvent(new Event("input"));
  }

  textarea.addEventListener("keydown", (e) => {
    if (menu.hidden || !state.items.length || e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      state.index = (state.index + step + state.items.length) % state.items.length;
      render();
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      choose(state.index);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const trigger = state.trigger;
      state.dismissed = trigger && { type: trigger.type, start: trigger.start, word: textarea.value.slice(trigger.start, trigger.end) };
      close();
    }
  });
  textarea.addEventListener("input", paint);
  textarea.addEventListener("input", update);
  textarea.addEventListener("scroll", () => { mirror.scrollTop = textarea.scrollTop; });
  new ResizeObserver(paint).observe(textarea);
  textarea.addEventListener("click", update);
  textarea.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) update();
  });
  textarea.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== textarea) close(); }, 100));

  const expand = (text) => {
    const refs = sessionRefs();
    return refs ? expandRefs(text, refs) : text;
  };
  const references = (text) => {
    const refs = sessionRefs();
    const found = refs ? refMatches(text, refs) : [];
    const seen = new Set();
    return found.filter((match) => {
      if (seen.has(match.file)) return false;
      seen.add(match.file);
      return true;
    }).map((match) => ({ label: match.token.replaceAll(NBSP, " "), path: match.file }));
  };

  // 복사·잘라내기에 고른 참조를 함께 담아, 붙여넣으면 (다른 세션 작성창이라도) 다시 파란 참조가 된다.
  // 다른 앱에는 줄바꿈 없는 공백을 보통 공백으로 바꾼 글이 간다. 앱 안에서는 전용 형식으로 원래 글과 참조를 넘긴다.
  // 전용 형식을 못 쓰는 환경이면 마지막으로 복사한 글과 같은 글을 붙여넣을 때 되살린다.
  const carry = (e) => {
    const refs = sessionRefs();
    const { selectionStart: from, selectionEnd: to, value } = textarea;
    if (!refs || from === to || !e.clipboardData) return;
    const picked = refMatches(value, refs).filter((m) => m.start >= from && m.end <= to);
    if (!picked.length) return;
    const text = value.slice(from, to);
    const plain = text.replaceAll(NBSP, " ");
    const map = Object.fromEntries(picked.map((m) => [m.token, m.file]));
    clipboardRefs = { text, plain, map };
    e.preventDefault();
    e.clipboardData.setData("text/plain", plain);
    try { e.clipboardData.setData(REFS_MIME, JSON.stringify({ text, map })); } catch { /* 전용 형식을 못 쓰면 글만 복사한다 */ }
    if (e.type === "cut") {
      textarea.setRangeText("", from, to, "start");
      textarea.dispatchEvent(new Event("input"));
    }
  };
  textarea.addEventListener("copy", carry);
  textarea.addEventListener("cut", carry);
  textarea.addEventListener("paste", (e) => {
    const id = getSession()?.id;
    if (!id || !e.clipboardData) return;
    let payload = null;
    try { payload = JSON.parse(e.clipboardData.getData(REFS_MIME) || "null"); } catch { payload = null; }
    if (!payload && clipboardRefs && e.clipboardData.getData("text/plain") === clipboardRefs.plain) payload = clipboardRefs;
    if (!payload || typeof payload.text !== "string" || !payload.map || typeof payload.map !== "object") return;
    if (!refsBySession.has(id)) refsBySession.set(id, new Map());
    const refs = refsBySession.get(id);
    // 같은 이름이 이미 다른 파일을 가리키면 덮어쓰지 않는다.
    for (const [token, file] of Object.entries(payload.map)) {
      if (token && typeof file === "string" && file && !refs.has(token)) refs.set(token, file);
    }
    e.preventDefault();
    textarea.setRangeText(payload.text, textarea.selectionStart, textarea.selectionEnd, "end");
    textarea.dispatchEvent(new Event("input"));
  });
  // 참조 바로 뒤에서 Backspace, 바로 앞에서 Delete를 누르면 참조를 통째로 지운다.
  textarea.addEventListener("keydown", (e) => {
    if ((e.key !== "Backspace" && e.key !== "Delete") || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    const { selectionStart: from, selectionEnd: to, value } = textarea;
    const refs = sessionRefs();
    if (from !== to || !refs) return;
    const hit = refMatches(value, refs).find((m) => (e.key === "Backspace" ? m.end === from : m.start === from));
    if (!hit) return;
    e.preventDefault();
    textarea.setRangeText("", hit.start, hit.end, "start");
    textarea.dispatchEvent(new Event("input"));
  });
  return { close, isOpen: () => !menu.hidden, expand, references, sync: paint };
}

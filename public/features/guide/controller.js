import { $, el } from "../../shared/dom.js";
import { openDiffDialog } from "./diff.js";
import { renderMap, KIND_LABEL } from "./map.js";
import { renderFlow } from "./flow.js";
import { createSkillsView } from "./skills.js";

// 프로젝트 지침 탭: 편집(AGENTS.md 작성·검사·AI 초안) / 지침 지도 / 작업 순서도
const VIEW_KEY = "agenthub-guide-view";
const HIDE_KEY = "agenthub-guide-hide-dim";
const elapsed = (start) => { const s = Math.floor((Date.now() - start) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const time = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const LEVEL_ORDER = { conflict: 0, error: 1, info: 2 };
// 빈 값(null·false)은 "null" 글자로 들어가지 않게 뺀다.
const fill = (box, ...items) => box.replaceChildren(...items.filter((item) => item !== null && item !== undefined && item !== false));

export function createGuideController({ api, navigation, selectSession, showGraph }) {
  const state = {
    project: null, file: "AGENTS.md", view: ["edit", "map", "flow", "skills"].includes(localStorage.getItem(VIEW_KEY)) ? localStorage.getItem(VIEW_KEY) : "edit",
    guide: null, text: "", warnings: [], sections: [], panel: false, ignored: new Set(), fixed: [], dismissedClaude: new Set(),
    saveError: null, busy: null, checkTimer: null, loadId: 0,
    map: null, mapError: null, mapLoading: false, mapSelected: null, hideDim: localStorage.getItem(HIDE_KEY) !== "0", zoom: 1,
    flow: null, flowError: null, flowBusy: null, flowSelected: null, session: "",
  };
  let root = null;
  const skills = createSkillsView({ api, toast: (text, error) => toast(text, error), selectSession, showGraph: (ids) => showGraph?.(ids),
    onCount: (n) => { const count = $("g-skills-count"); if (count) { count.textContent = n ? String(n) : ""; count.classList.toggle("warn", n > 0); } } });
  const dirty = () => state.guide && state.text !== (state.guide.exists ? state.guide.text : "");
  const q = (extra = {}) => new URLSearchParams({ path: state.project, file: state.file, ...extra }).toString();
  const problems = () => state.warnings.filter((w) => w.level !== "info" && !state.ignored.has(w.id));

  // ── 골격 ────────────────────────────────────────────────────
  function mount() {
    if (root) return;
    root = $("guide-root");
    root.replaceChildren(
      el("div", { class: "guide-bar" },
        el("div", { class: "guide-seg", role: "tablist", "aria-label": "지침 보기" },
          ...[["edit", "편집"], ["map", "지침 지도"], ["flow", "작업 순서도"], ["skills", "스킬"]].map(([view, label]) => el("button", { type: "button", role: "tab", "data-view": view, onclick: () => show(view) }, label, view === "skills" ? el("span", { class: "tab-count", id: "g-skills-count" }) : null))),
        el("div", { class: "guide-actions", "data-for": "edit" },
          el("button", { type: "button", class: "ghost", id: "g-rewrite", onclick: openRewrite }, "섹션만 다시 쓰기"),
          el("button", { type: "button", id: "g-draft", onclick: () => state.busy ? stopBusy() : draft() }, "AI 초안 만들기"),
          el("button", { type: "button", class: "primary", id: "g-save", onclick: () => save() }, "저장")),
        el("div", { class: "guide-actions", "data-for": "map" },
          el("button", { type: "button", id: "g-map-reload", onclick: () => loadMap() }, "↻ 다시 읽기"),
          el("label", { class: "guide-check" }, el("input", { type: "checkbox", id: "g-hide-dim", onchange: (e) => { state.hideDim = e.target.checked; localStorage.setItem(HIDE_KEY, state.hideDim ? "1" : "0"); paintMap(); } }), " 흐린 문서 숨기기"),
          el("div", { class: "guide-zoom" },
            el("button", { type: "button", "aria-label": "축소", onclick: () => zoomBy(-0.1) }, "−"), el("span", { id: "g-zoom" }, "100%"), el("button", { type: "button", "aria-label": "확대", onclick: () => zoomBy(0.1) }, "+"))),
        el("div", { class: "guide-actions", "data-for": "flow" },
          el("select", { id: "g-session", "aria-label": "세션 선택", onchange: (e) => { state.session = e.target.value; state.flowSelected = null; loadFlow(); } }),
          el("span", { class: "muted guide-meta", id: "g-flow-meta" }),
          el("button", { type: "button", id: "g-flow-draw", onclick: () => state.flowBusy ? stopFlow() : drawFlow() }, "↻ 다시 그리기"))),
      el("div", { id: "g-banner" }),
      el("section", { class: "guide-view", "data-view-panel": "edit" },
        el("div", { class: "guide-filebar" },
          el("select", { id: "g-file", class: "mono", "aria-label": "지침 파일", onchange: (e) => switchFile(e.target.value) }),
          el("span", { class: "muted guide-meta", id: "g-saved" })),
        el("div", { class: "guide-edit" },
          el("aside", { class: "guide-sections" }, el("header", {}, el("strong", {}, "섹션"), el("span", { class: "muted", id: "g-section-count" })), el("ol", { id: "g-section-list" }), el("footer", { class: "muted" }, "섹션 순서는 권장 순서입니다")),
          el("div", { class: "guide-editor" },
            el("div", { id: "g-progress", hidden: "" }),
            el("div", { id: "g-save-error", hidden: "" }),
            el("div", { class: "guide-editor-body", id: "g-editor-body" },
              el("pre", { class: "guide-gutter mono", id: "g-gutter", "aria-hidden": "true" }),
              el("textarea", { id: "g-text", class: "mono", spellcheck: "false", "aria-label": "지침 내용", oninput: onInput, onscroll: syncGutter, onkeydown: onKeydown })),
            el("div", { class: "guide-empty", id: "g-empty", hidden: "" },
              el("div", { class: "guide-empty-icon", "aria-hidden": "true" }, "📘"), el("strong", {}, "아직 AGENTS.md가 없습니다"),
              el("p", { class: "muted" }, "AI가 저장소를 살펴 초안을 만들거나, 빈 틀에서 직접 시작할 수 있습니다."),
              el("div", {}, el("button", { type: "button", class: "primary", onclick: () => draft() }, "AI 초안 만들기"), el("button", { type: "button", onclick: startBlank }, "빈 틀로 시작"))),
            el("footer", { class: "guide-editor-foot" }, el("button", { type: "button", class: "link", id: "g-status", onclick: () => togglePanel() }), el("span", { class: "muted", id: "g-info" }))),
          el("aside", { class: "guide-warnings", id: "g-warnings", hidden: "" },
            el("header", {}, el("strong", {}, "저장 전 검사"), el("span", { class: "guide-count", id: "g-warning-count" })),
            el("div", { class: "guide-warning-list", id: "g-warning-list" }),
            el("footer", {}, el("button", { type: "button", id: "g-save-anyway", onclick: () => save({ ignoreWarnings: true }) }, "경고 무시하고 저장"), el("button", { type: "button", class: "ghost", onclick: () => togglePanel(false) }, "닫기"))))),
      el("section", { class: "guide-view", "data-view-panel": "map", hidden: "" },
        el("div", { class: "guide-canvas", id: "g-map" }),
        el("aside", { class: "guide-side" }, el("div", { class: "guide-info", id: "g-map-info" }), legend())),
      el("section", { class: "guide-view", "data-view-panel": "flow", hidden: "" },
        el("div", { class: "guide-flow-main" }, el("div", { id: "g-flow-notice" }), el("div", { class: "guide-canvas", id: "g-flow" })),
        el("aside", { class: "guide-side" }, el("div", { class: "guide-info", id: "g-flow-info" }))),
      el("section", { class: "guide-view", "data-view-panel": "skills", hidden: "", id: "g-skills" }),
      el("div", { class: "guide-toast", id: "g-toast", role: "status", hidden: "" }));
    root.querySelector(".guide-bar").append(el("div", { class: "guide-actions", "data-for": "skills", id: "g-skills-actions" }));
    skills.mount($("g-skills"), $("g-skills-actions"));
    $("g-hide-dim").checked = state.hideDim;
    enablePan($("g-map"));
    enablePan($("g-flow"));
  }

  function legend() {
    const box = (cls, label) => el("li", {}, el("span", { class: `guide-legend-box ${cls}` }), label);
    const line = (cls, label) => el("li", {}, el("span", { class: `guide-legend-line ${cls}` }), label);
    return el("div", { class: "guide-legend" }, el("strong", {}, "범례"),
      el("ul", {}, box("root", "루트 AGENTS.md"), box("claude", "CLAUDE.md"), box("nested", "하위 AGENTS.md"), box("doc", "링크된 문서"), box("skill", "스킬"), box("role", "세션 역할"), box("inject", "주입 안내")),
      el("ul", {}, line("import", "@가져오기"), line("link", "문서 링크"), line("conditional", "조건부 참조"), line("broken", "깨진 링크"), line("inject", "자동 주입")),
      el("ul", {}, box("orphan", "흐림 · 참조 없음"), box("broken", "깨짐 · 파일 없음")));
  }

  // 끌어서 화면 옮기기(빈 곳을 누르고 끈다)
  function enablePan(box) {
    let drag = null;
    box.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".gm-node, .gf-node, button")) return;
      drag = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
      box.setPointerCapture(event.pointerId);
      box.classList.add("panning");
    });
    box.addEventListener("pointermove", (event) => { if (drag) { box.scrollLeft = drag.left - (event.clientX - drag.x); box.scrollTop = drag.top - (event.clientY - drag.y); } });
    const end = () => { drag = null; box.classList.remove("panning"); };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
  }

  function show(view) {
    state.view = view;
    localStorage.setItem(VIEW_KEY, view);
    for (const button of root.querySelectorAll("[data-view]")) { button.classList.toggle("active", button.dataset.view === view); button.setAttribute("aria-selected", String(button.dataset.view === view)); }
    for (const panel of root.querySelectorAll("[data-view-panel]")) panel.hidden = panel.dataset.viewPanel !== view;
    for (const bar of root.querySelectorAll("[data-for]")) bar.hidden = bar.dataset.for !== view;
    renderBanner();
    if (view === "map" && !state.map && !state.mapLoading) loadMap();
    if (view === "flow" && !state.flow && !state.flowBusy) loadFlow();
    if (view === "skills" && state.project) skills.activate(state.project);
  }

  // ── 불러오기 ─────────────────────────────────────────────────
  async function activate(projectPath) {
    mount();
    if (state.project !== projectPath) {
      Object.assign(state, { project: projectPath, file: "AGENTS.md", guide: null, text: "", map: null, flow: null, mapSelected: null, flowSelected: null, session: "", panel: false, ignored: new Set(), fixed: [], saveError: null });
      stopBusy(); stopFlow();
    }
    show(state.view);
    await load();
  }

  async function load({ keepText = false } = {}) {
    const id = ++state.loadId;
    try {
      const guide = await api("GET", `/api/guide?${q()}`);
      if (id !== state.loadId) return;
      state.guide = guide;
      if (!keepText || !dirty()) state.text = guide.exists ? guide.text : "";
      state.warnings = guide.warnings;
      state.sections = guide.sections;
      if (keepText) await check();
      renderEdit();
    } catch (error) { if (id === state.loadId) toast(error.message, true); }
  }

  async function switchFile(file) {
    if (dirty() && !confirm("저장하지 않은 변경이 있습니다. 버리고 다른 파일을 열까요?")) { $("g-file").value = state.file; return; }
    state.file = file;
    state.ignored = new Set(); state.fixed = []; state.saveError = null;
    state.flow = null;
    await load();
    if (state.view === "flow") loadFlow();
  }

  // ── 편집 보기 ────────────────────────────────────────────────
  function renderEdit() {
    const guide = state.guide;
    if (!guide) return;
    $("g-file").replaceChildren(...guide.files.map((file) => el("option", { value: file, ...(file === state.file ? { selected: "" } : {}) }, file)));
    if (!guide.files.includes(state.file)) $("g-file").append(el("option", { value: state.file, selected: "" }, state.file));
    $("g-saved").textContent = guide.exists ? `마지막 저장 ${time(guide.savedAt)} · ${guide.lines}줄` : "아직 파일이 없습니다";
    const textarea = $("g-text");
    if (textarea.value !== state.text) textarea.value = state.text;
    const empty = !guide.exists && !state.text;
    $("g-empty").hidden = !empty;
    $("g-editor-body").hidden = empty;
    $("g-rewrite").disabled = empty || !!state.busy || !state.sections.length;
    $("g-save").disabled = !dirty() || !!state.busy;
    $("g-draft").textContent = state.busy?.kind === "draft" ? "■ 초안 중지" : "AI 초안 만들기";
    $("g-draft").classList.toggle("danger-outline", state.busy?.kind === "draft");
    syncGutter();
    renderSections();
    renderWarnings();
    renderSaveError();
    renderBanner();
    renderTabCount();
  }

  function syncGutter() {
    const textarea = $("g-text");
    const count = textarea.value.split("\n").length;
    const gutter = $("g-gutter");
    if (gutter.dataset.count !== String(count)) { gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n"); gutter.dataset.count = String(count); }
    gutter.scrollTop = textarea.scrollTop;
  }

  function onInput() {
    state.text = $("g-text").value;
    state.saveError = state.saveError?.kind === "changed" ? state.saveError : null;
    syncGutter();
    $("g-save").disabled = !dirty() || !!state.busy;
    clearTimeout(state.checkTimer);
    state.checkTimer = setTimeout(() => check().then(() => { renderSections(); renderWarnings(); renderTabCount(); }), 400);
  }
  function onKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); }
  }

  async function check() {
    try {
      const result = await api("POST", `/api/guide/check?${q()}`, { text: state.text });
      state.warnings = result.warnings;
      state.sections = result.sections;
    } catch { /* 검사 실패는 저장을 막지 않는다 */ }
  }

  function renderSections() {
    const list = $("g-section-list");
    const catalog = state.guide?.catalog ?? [];
    const present = new Set(state.sections.map((s) => s.key).filter(Boolean));
    const warned = (section) => problems().some((w) => w.line >= section.line && w.line <= (section.end ?? section.line));
    const current = currentSection();
    const items = state.sections.map((section) => el("li", { class: `guide-section${section === current ? " current" : ""}` },
      el("button", { type: "button", onclick: () => goLine(section.line) },
        el("span", { class: "guide-hash" }, "#"), el("span", { class: "guide-section-title" }, section.title),
        warned(section) ? el("span", { class: "guide-dot", title: "경고 있음" }) : null,
        el("span", { class: "muted guide-lines" }, `${section.lines}줄`))));
    const missing = catalog.filter((c) => !present.has(c.key)).map((c) => el("li", { class: "guide-section missing" },
      el("span", { class: "guide-hash" }, "#"), el("span", { class: "guide-section-title", title: c.hint }, c.title),
      el("button", { type: "button", class: "link", onclick: () => addSection(c.key) }, "+ 추가")));
    list.replaceChildren(...items, ...missing);
    $("g-section-count").textContent = state.sections.length ? `${state.sections.length}개` : `0 / ${catalog.length}`;
  }

  function currentSection() {
    const textarea = $("g-text");
    const line = textarea.value.slice(0, textarea.selectionStart).split("\n").length;
    return [...state.sections].reverse().find((s) => s.line <= line) ?? null;
  }

  function goLine(line, { select = false } = {}) {
    const textarea = $("g-text");
    const lines = textarea.value.split("\n");
    const start = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0);
    const end = start + (lines[line - 1]?.length ?? 0);
    textarea.focus();
    textarea.setSelectionRange(start, select ? end : start);
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
    textarea.scrollTop = Math.max(0, (line - 4) * lineHeight);
    syncGutter();
    renderSections();
  }

  // 권장 순서에 맞춰 앞 섹션 뒤에 빈 섹션을 넣는다.
  function addSection(key) {
    const catalog = state.guide.catalog;
    const index = catalog.findIndex((c) => c.key === key);
    const section = catalog[index];
    const lines = state.text.split("\n");
    const before = [...catalog.slice(0, index)].reverse().map((c) => state.sections.find((s) => s.key === c.key)).find(Boolean);
    const after = catalog.slice(index + 1).map((c) => state.sections.find((s) => s.key === c.key)).find(Boolean);
    const at = before ? before.end : after ? after.line - 1 : lines.length;
    const block = ["", `## ${section.title}`, `<!-- ${section.hint} -->`, ""];
    lines.splice(at, 0, ...block);
    setText(lines.join("\n").replace(/^\n+/, ""));
    check().then(() => { renderEdit(); const added = state.sections.find((s) => s.key === key); if (added) goLine(added.line + 1); });
  }

  function startBlank() {
    setText(state.guide.blank);
    check().then(() => renderEdit());
  }

  function setText(text) {
    state.text = text;
    $("g-text").value = text;
    renderEdit();
  }

  // ── 저장 전 검사 패널 ─────────────────────────────────────────
  function togglePanel(open = !state.panel) {
    state.panel = open;
    renderWarnings();
  }

  function renderWarnings() {
    const list = problems();
    const all = state.warnings.filter((w) => !state.ignored.has(w.id)).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.line - b.line);
    $("g-status").textContent = list.length ? `⚠ 경고 ${list.length} · ${state.panel ? "닫기" : "보기"}` : all.length ? `ⓘ 제안 ${all.length} · ${state.panel ? "닫기" : "보기"}` : "✓ 검사 통과";
    $("g-status").className = `link guide-status ${list.length ? "warn" : all.length ? "info" : "ok"}`;
    $("g-info").textContent = `Markdown · UTF-8 · ${state.text.split("\n").length}줄`;
    const panel = $("g-warnings");
    panel.hidden = !state.panel;
    root.querySelector(".guide-edit").classList.toggle("with-panel", state.panel);
    if (!state.panel) return;
    $("g-warning-count").textContent = String(all.length);
    $("g-save-anyway").hidden = !list.length;
    $("g-warning-list").replaceChildren(
      ...all.map((warning) => el("article", { class: `guide-warning ${warning.level}` },
        el("strong", {}, warning.title),
        warning.quote ? el("div", { class: "guide-quote" }, warning.quote) : null,
        el("p", { class: "muted" }, warning.detail),
        warning.fix?.to ? el("p", { class: "guide-suggest" }, `제안: ${warning.fix.to.trim()}`) : null,
        el("div", { class: "guide-warning-actions" },
          warning.fix ? el("button", { type: "button", class: "primary sm", onclick: () => applyFix(warning) }, warning.fix.to ? "제안 적용" : "링크 지우기") : null,
          el("button", { type: "button", class: "ghost sm", onclick: () => goLine(warning.line, { select: true }) }, "줄로 이동"),
          el("button", { type: "button", class: "ghost sm", onclick: () => { state.ignored.add(warning.id); renderWarnings(); renderSections(); renderTabCount(); } }, "무시")))),
      ...state.fixed.map((text) => el("article", { class: "guide-warning fixed" }, el("strong", {}, "고쳤습니다"), el("p", { class: "muted" }, text))),
      all.length || state.fixed.length ? "" : el("p", { class: "muted pad" }, "경고가 없습니다."));
  }

  function applyFix(warning) {
    const lines = state.text.split("\n");
    if (lines[warning.fix.line - 1] !== warning.fix.from) { toast("그 줄이 바뀌었습니다. 다시 검사합니다.", true); check().then(renderEdit); return; }
    lines[warning.fix.line - 1] = warning.fix.to ?? warning.fix.from.replace(/!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label, target) => label || target);
    state.fixed.push(`${warning.title} · ${warning.line}행`);
    setText(lines.join("\n"));
    check().then(() => renderEdit());
  }

  // ── 저장 ────────────────────────────────────────────────────
  async function save({ ignoreWarnings = false, force = false } = {}) {
    if (!dirty() && !force) return;
    await check();
    if (problems().length && !ignoreWarnings && !force) { state.panel = true; renderEdit(); toast(`경고 ${problems().length}개가 있습니다. 고치거나 무시하고 저장하세요.`, true); return; }
    try {
      const guide = await api("PUT", `/api/guide?${q()}`, { text: state.text, baseHash: state.guide.hash, force });
      state.guide = guide;
      state.text = guide.text;
      state.warnings = guide.warnings;
      state.sections = guide.sections;
      state.saveError = null;
      state.fixed = [];
      if (!problems().length) state.panel = false;
      state.map = null;
      renderEdit();
      toast(`${state.file}를 저장했습니다`);
    } catch (error) {
      state.saveError = { kind: error.reason === "guide-changed" ? "changed" : "write", message: error.message };
      renderEdit();
    }
  }

  function renderSaveError() {
    const box = $("g-save-error");
    const error = state.saveError;
    box.hidden = !error;
    if (!error) return;
    box.className = "guide-save-error";
    fill(box, el("span", {}, `⚠ 저장하지 못했습니다 · ${error.kind === "changed" ? "파일이 다른 곳에서 바뀌었습니다" : error.message}`), el("span", { class: "spacer" }),
      ...(error.kind === "changed" ? [
        el("button", { type: "button", class: "ghost sm", onclick: compareDisk }, "다시 불러와 비교"),
        el("button", { type: "button", class: "ghost sm danger-outline", onclick: () => save({ force: true }) }, "덮어쓰기")] : [
        el("button", { type: "button", class: "ghost sm", onclick: () => save({ ignoreWarnings: true }) }, "다시 시도")]));
  }

  // 디스크의 새 내용과 편집 중인 글을 비교해 디스크 쪽 변경을 골라 받는다.
  async function compareDisk() {
    const fresh = await api("GET", `/api/guide?${q()}`);
    const result = await openDiffDialog({ title: "다른 곳에서 바뀐 내용", oldText: state.text, newText: fresh.text, applyLabel: "고른 변경 받기", note: "고른 변경만 편집 중인 글에 받습니다. 그다음 저장하세요." });
    state.guide = { ...state.guide, hash: fresh.hash, savedAt: fresh.savedAt, lines: fresh.lines };
    state.saveError = null;
    if (result) setText(result.text);
    await check();
    renderEdit();
  }

  // ── CLAUDE.md 배너·합치기 ─────────────────────────────────────
  function renderBanner() {
    const box = $("g-banner");
    const claude = state.guide?.claude;
    fill(box, );
    if (!claude || state.view !== "edit" || state.file !== "AGENTS.md") return;
    if (!claude.claude || !claude.imports) {
      box.append(el("div", { class: "guide-banner warn" },
        el("span", { "aria-hidden": "true" }, "⚠"),
        el("strong", {}, "Claude 세션이 이 지침을 읽지 못합니다"),
        el("span", { class: "muted" }, claude.claude ? "CLAUDE.md가 AGENTS.md를 가져오지 않습니다. 맨 위에 @AGENTS.md를 넣습니다." : "CLAUDE.md가 없습니다. @AGENTS.md 한 줄짜리 CLAUDE.md를 만듭니다."),
        el("span", { class: "spacer" }),
        el("button", { type: "button", class: "ghost sm", ...(claude.agents ? {} : { disabled: "", title: "먼저 AGENTS.md를 저장하세요" }), onclick: linkClaude }, "@AGENTS.md 연결 만들기")));
    } else if (claude.extraLines > 0 && !state.dismissedClaude.has(state.project)) {
      box.append(el("div", { class: "guide-banner info" },
        el("span", { "aria-hidden": "true" }, "ⓘ"),
        el("strong", {}, `CLAUDE.md에 AGENTS.md에 없는 내용이 ${claude.extraLines}줄 있습니다`),
        el("span", { class: "muted" }, "Claude 세션만 이 내용을 읽습니다."),
        el("span", { class: "spacer" }),
        el("button", { type: "button", class: "ghost sm", onclick: openMerge }, "AGENTS.md로 합치기"),
        el("button", { type: "button", class: "ghost sm", "aria-label": "닫기", onclick: () => { state.dismissedClaude.add(state.project); renderBanner(); } }, "×")));
    }
  }

  async function linkClaude() {
    try { const guide = await api("POST", `/api/guide/claude/link?${q()}`); state.guide = { ...state.guide, claude: guide.claude, files: guide.files }; renderEdit(); toast("CLAUDE.md에 @AGENTS.md를 연결했습니다"); state.map = null; }
    catch (error) { toast(error.message, true); }
  }

  function openMerge() {
    if (dirty()) { toast("저장하지 않은 변경이 있습니다. 먼저 저장한 뒤 합치세요.", true); return; }
    const sections = state.guide.claude.sections;
    const picked = new Set(sections.map((s) => s.index));
    const dialog = el("dialog", { class: "guide-merge-dialog", "aria-label": "CLAUDE.md를 AGENTS.md로 합치기" });
    const preview = el("pre", { class: "guide-merge-preview mono" });
    const paint = () => { preview.textContent = ["@AGENTS.md", ...sections.filter((s) => !picked.has(s.index)).map((s) => `## ${s.title}`)].join("\n"); };
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.append(el("h3", {}, "CLAUDE.md를 AGENTS.md로 합치기"),
      el("p", { class: "muted" }, "옮길 내용"),
      el("ul", { class: "guide-merge-list" }, ...sections.map((s) => el("li", {}, el("label", {},
        el("input", { type: "checkbox", checked: "", onchange: (e) => { if (e.target.checked) picked.add(s.index); else picked.delete(s.index); paint(); } }),
        el("span", {}, s.title), el("span", { class: "muted" }, `${s.lines}줄`))))),
      el("p", { class: "muted" }, "합친 뒤 CLAUDE.md"), preview,
      el("p", { class: "hint" }, "Claude 전용 내용은 CLAUDE.md에 남길 수 있습니다. 체크를 해제한 항목은 CLAUDE.md에 그대로 남습니다."),
      el("footer", {}, el("button", { type: "button", class: "ghost", onclick: close }, "취소"),
        el("button", { type: "button", class: "primary", onclick: async () => {
          try {
            const guide = await api("POST", `/api/guide/claude/merge?${q()}`, { sections: [...picked], baseHash: state.guide.hash });
            close(); state.guide = guide; state.text = guide.text; state.warnings = guide.warnings; state.sections = guide.sections; state.map = null; renderEdit(); toast("CLAUDE.md 내용을 AGENTS.md로 옮겼습니다");
          } catch (error) { toast(error.message, true); }
        } }, "합치기")));
    document.body.append(dialog);
    paint();
    dialog.showModal();
  }

  // ── AI 초안·섹션 다시 쓰기 ────────────────────────────────────
  const DRAFT_STEPS = ["저장소 구조 읽기", "기존 문서·스킬 찾기", "섹션 초안 쓰기", "AgentHub 흐름 검사"];
  function startBusy(kind, label) {
    stopBusy();
    const controller = new AbortController();
    state.busy = { kind, label, controller, start: Date.now(), step: 0 };
    state.busy.timer = setInterval(() => { if (state.busy) { state.busy.step = Math.min(2, Math.floor((Date.now() - state.busy.start) / 2500)); renderProgress(); } }, 500);
    renderProgress();
    renderEdit();
    return controller.signal;
  }
  function stopBusy() {
    if (!state.busy) return;
    clearInterval(state.busy.timer);
    state.busy.controller.abort();
    state.busy = null;
    renderProgress();
    if (root) renderEdit();
  }
  function renderProgress() {
    const box = $("g-progress");
    if (!box) return;
    const busy = state.busy;
    box.hidden = !busy;
    if (!busy) { fill(box, ); return; }
    box.className = "guide-progress";
    const steps = busy.kind === "draft" ? DRAFT_STEPS : ["섹션 읽기", "다시 쓰기", "AgentHub 흐름 검사"];
    fill(box, 
      el("header", {}, el("strong", {}, `${busy.label} · ${elapsed(busy.start)}`), el("span", { class: "spacer" }), el("span", { class: "muted" }, "중지하면 지금까지 쓴 초안은 버립니다"),
        busy.kind === "rewrite" ? el("button", { type: "button", class: "ghost sm", onclick: stopBusy }, "중지") : null),
      el("ul", {}, ...steps.map((label, index) => el("li", { class: index < busy.step ? "done" : index === busy.step ? "now" : "" }, el("span", { class: "guide-step-mark", "aria-hidden": "true" }, index < busy.step ? "✓" : index === busy.step ? "●" : "○"), label))),
      el("div", { class: "guide-bar-track" }, el("div", { class: "guide-bar-fill", style: `width:${Math.min(92, 8 + (Date.now() - busy.start) / 900)}%` })));
  }

  async function draft() {
    if (state.busy) return;
    const signal = startBusy("draft", "AI 초안 만드는 중");
    try {
      const result = await api("POST", `/api/guide/draft?${q()}`, { text: state.text }, { signal });
      state.busy.step = 3; renderProgress();
      const checked = await api("POST", `/api/guide/check?${q()}`, { text: result.text }).catch(() => ({ warnings: [] }));
      stopBusy();
      if (!state.text.trim()) { setText(result.text); await check(); renderEdit(); toast("AI 초안을 넣었습니다. 읽어 보고 저장하세요."); return; }
      const picked = await openDiffDialog({ oldText: state.text, newText: result.text, warnings: checked.warnings });
      if (picked?.unchanged) toast("바꿀 곳이 없습니다.");
      else if (picked) { setText(picked.text); await check(); renderEdit(); }
    } catch (error) { if (state.busy) { stopBusy(); toast(error.message, true); } }
  }

  function openRewrite() {
    document.querySelector(".guide-popover")?.remove();
    const current = currentSection() ?? state.sections[0];
    const select = el("select", { "aria-label": "다시 쓸 섹션" }, ...state.sections.map((s) => el("option", { value: String(s.line), ...(s === current ? { selected: "" } : {}) }, s.title)));
    const input = el("textarea", { rows: "2", placeholder: "예: 더 짧게, 승인 단계 빼기", "aria-label": "어떻게 다시 쓸지" });
    const pop = el("div", { class: "guide-popover", role: "dialog", "aria-label": "섹션만 다시 쓰기" },
      el("label", { class: "muted" }, "다시 쓸 섹션", select), input,
      el("footer", {}, el("button", { type: "button", class: "ghost", onclick: () => pop.remove() }, "취소"),
        el("button", { type: "button", class: "primary", onclick: () => { pop.remove(); rewrite(Number(select.value), input.value); } }, "다시 쓰기")));
    root.querySelector(".guide-bar").append(pop);
    input.focus();
    const away = (event) => { if (!pop.contains(event.target) && event.target.id !== "g-rewrite") { pop.remove(); document.removeEventListener("pointerdown", away, true); } };
    document.addEventListener("pointerdown", away, true);
  }

  async function rewrite(line, request) {
    const signal = startBusy("rewrite", "섹션 다시 쓰는 중");
    try {
      const result = await api("POST", `/api/guide/rewrite?${q()}`, { text: state.text, line, request }, { signal });
      const checked = await api("POST", `/api/guide/check?${q()}`, { text: result.text }).catch(() => ({ warnings: [] }));
      stopBusy();
      const picked = await openDiffDialog({ title: `섹션 다시 쓰기 · ${result.section.title}`, oldText: state.text, newText: result.text, warnings: checked.warnings, defaultAccept: true });
      if (picked?.unchanged) toast("바꿀 곳이 없습니다.");
      else if (picked) { setText(picked.text); await check(); renderEdit(); }
    } catch (error) { if (state.busy) { stopBusy(); toast(error.message, true); } }
  }

  // ── 지침 지도 ────────────────────────────────────────────────
  async function loadMap() {
    state.mapLoading = true; state.mapError = null;
    paintMap();
    try { state.map = await api("GET", `/api/guide/map?${q()}`); }
    catch (error) { state.mapError = error.message; state.map = null; }
    state.mapLoading = false;
    if (state.map && !state.map.nodes.some((n) => n.id === state.mapSelected)) state.mapSelected = state.map.nodes.find((n) => n.kind === "root")?.id ?? state.map.nodes[0]?.id ?? null;
    paintMap();
  }

  function zoomBy(step) {
    state.zoom = Math.min(2, Math.max(0.4, Math.round((state.zoom + step) * 10) / 10));
    paintMap();
  }

  function paintMap() {
    if (!root) return;
    const box = $("g-map");
    $("g-zoom").textContent = `${Math.round(state.zoom * 100)}%`;
    $("g-map-reload").disabled = state.mapLoading;
    if (state.mapLoading) { fill(box, stateCard("loading", "지침 파일을 읽는 중…")); $("g-map-info").replaceChildren(); return; }
    if (state.mapError) { fill(box, stateCard("error", "지침 파일을 읽지 못했습니다", state.mapError, el("button", { type: "button", onclick: () => loadMap() }, "↻ 다시 읽기"))); return; }
    const data = state.map;
    if (!data) return;
    if (!data.nodes.some((n) => n.kind === "root" || n.kind === "claude")) {
      fill(box, stateCard("empty", "아직 지침 파일이 없습니다", "AGENTS.md를 만들면 이어진 문서와 스킬이 여기에 그려집니다.", el("button", { type: "button", class: "primary", onclick: () => show("edit") }, "편집 보기에서 만들기")));
      $("g-map-info").replaceChildren();
      return;
    }
    fill(box, renderMap(data, { hideDim: state.hideDim, zoom: state.zoom, selected: state.mapSelected, onSelect: (id) => { state.mapSelected = id; paintMap(); } }));
    renderMapInfo();
  }

  function renderMapInfo() {
    const data = state.map;
    const node = data.nodes.find((n) => n.id === state.mapSelected);
    const box = $("g-map-info");
    if (!node) { fill(box, el("p", { class: "muted" }, "노드를 누르면 자세히 보입니다.")); return; }
    const name = (id) => data.nodes.find((n) => n.id === id);
    const incoming = data.edges.filter((e) => e.to === node.id);
    const outgoing = data.edges.filter((e) => e.from === node.id);
    const row = (label, value) => el("div", { class: "guide-row" }, el("span", { class: "muted" }, label), el("span", {}, value));
    const ref = (edge, id) => {
      const other = name(id);
      return el("li", { class: edge.broken ? "broken" : "" }, el("button", { type: "button", class: "link", onclick: () => { state.mapSelected = id; paintMap(); } }, other?.kind === "doc" || other?.kind === "nested" || other?.kind === "root" ? other.id : other?.title ?? id),
        edge.label ? el("span", { class: "muted" }, ` · ${edge.label}`) : null, edge.broken ? el("span", { class: "guide-broken" }, "파일 없음") : null);
    };
    const editable = node.file && /\.md$/i.test(node.file) && !node.broken && ["root", "claude", "nested", "doc"].includes(node.kind);
    fill(box, 
      el("p", { class: "muted guide-label" }, "선택한 노드"),
      el("h4", {}, node.title),
      node.file ? el("p", { class: "mono muted guide-path" }, node.kind === "skill" ? node.file : `${state.project.replace(/[\\/]$/, "")}\\${node.id.replaceAll("/", "\\")}`) : null,
      el("div", { class: "guide-rows" }, row("종류", KIND_LABEL[node.kind] ?? node.kind), row("읽는 도구", node.readers ?? ""), node.lines ? row("줄 수", `${node.lines}줄`) : null),
      node.description ? el("p", { class: "muted guide-desc" }, node.description) : null,
      node.role ? el("p", { class: "guide-desc" }, node.role.slice(0, 400)) : null,
      el("p", { class: "guide-label" }, `들어오는 선 ${incoming.length}`), el("ul", { class: "guide-refs" }, ...incoming.map((e) => ref(e, e.from))),
      el("p", { class: "guide-label" }, `나가는 선 ${outgoing.length}`), el("ul", { class: "guide-refs" }, ...outgoing.map((e) => ref(e, e.to))),
      editable ? el("button", { type: "button", class: "primary guide-wide", onclick: async () => { show("edit"); if (state.file !== node.id) await switchFile(node.id); } }, "편집 보기로 열기") : null,
      node.sessionId ? el("button", { type: "button", class: "primary guide-wide", onclick: () => selectSession?.(node.sessionId) }, "세션 열기") : null,
      node.kind === "skill" ? el("button", { type: "button", class: "primary guide-wide", onclick: () => { show("skills"); skills.activate(state.project, { select: node.title }); } }, "스킬 보기로 열기") : null);
  }

  // ── 작업 순서도 ──────────────────────────────────────────────
  async function loadFlow() {
    if (!state.project) return;
    state.flowError = null;
    try { state.flow = await api("GET", `/api/guide/flow?${q(state.session ? { session: state.session } : {})}`); }
    catch (error) { state.flowError = error.message; }
    paintFlow();
  }

  async function drawFlow() {
    stopFlow();
    const controller = new AbortController();
    state.flowBusy = { controller, start: Date.now(), timer: setInterval(paintFlow, 1000) };
    state.flowError = null;
    paintFlow();
    try { state.flow = await api("POST", `/api/guide/flow?${q()}`, { session: state.session || undefined }, { signal: controller.signal }); state.flowSelected = null; }
    catch (error) { if (state.flowBusy) state.flowError = error.message; }
    if (state.flowBusy) { clearInterval(state.flowBusy.timer); state.flowBusy = null; }
    paintFlow();
  }
  function stopFlow() {
    if (!state.flowBusy) return;
    clearInterval(state.flowBusy.timer);
    state.flowBusy.controller.abort();
    state.flowBusy = null;
    paintFlow();
  }

  function paintFlow() {
    if (!root) return;
    const flow = state.flow;
    const select = $("g-session");
    const sessions = flow?.sessions ?? [];
    select.replaceChildren(el("option", { value: "" }, "세션: 선택 안 함"), ...sessions.map((s) => el("option", { value: s.id, ...(s.id === state.session ? { selected: "" } : {}) }, `${s.title}${s.receives ? " · 연결로 받은 작업" : ""}`)));
    $("g-flow-draw").textContent = state.flowBusy ? "■ 중지" : flow?.empty === false || flow?.nodes ? "↻ 다시 그리기" : "순서도 그리기";
    $("g-flow-meta").textContent = state.flowBusy ? "다시 그리는 중…" : flow?.drawnAt ? `${time(flow.drawnAt)}에 그림 · ${flow.file} ${flow.lines}줄 기준` : "";
    const box = $("g-flow");
    const notice = $("g-flow-notice");
    notice.replaceChildren();
    if (state.flowBusy) {
      fill(box, stateCard("loading", `AI가 지침을 해석하는 중 · ${elapsed(state.flowBusy.start)}`, "작업 절차와 분기를 읽고 있습니다.", el("button", { type: "button", class: "ghost sm danger-outline", onclick: stopFlow }, "중지")));
      return;
    }
    if (state.flowError) { fill(box, stateCard("error", "순서도를 그리지 못했습니다", state.flowError, el("button", { type: "button", onclick: drawFlow }, "↻ 다시 그리기"))); $("g-flow-info").replaceChildren(); return; }
    if (!flow) return;
    if (flow.empty) {
      fill(box, stateCard("empty", "아직 순서도가 없습니다", flow.exists ? `AI가 ${flow.file}를 읽고 작업 순서를 그립니다.` : "먼저 편집 보기에서 지침을 저장하세요.",
        flow.exists ? el("button", { type: "button", class: "primary", onclick: drawFlow }, "순서도 그리기") : el("button", { type: "button", class: "primary", onclick: () => show("edit") }, "편집 보기로")));
      $("g-flow-info").replaceChildren();
      return;
    }
    const h = flow.highlights;
    if (flow.stale) notice.append(el("div", { class: "guide-banner warn" }, el("span", {}, "⚠ 지침이 바뀌었습니다 ·"), el("button", { type: "button", class: "link", onclick: drawFlow }, "다시 그리기")));
    if (flow.session && !flow.session.receives) notice.append(el("div", { class: "guide-banner info" }, el("span", {}, `ⓘ ${flow.session.title}은(는) 연결로 작업을 받지 않습니다. 사용자가 직접 보낸 요청만 이 순서를 따릅니다.`)));
    if (h && (h.stop || h.conflicts.length)) {
      const stopNode = h.stop && flow.nodes.find((n) => n.id === h.stop.id);
      notice.append(el("div", { class: "guide-banner flow-hit" }, el("span", {}, "이 세션이 연결로 받은 작업은 "),
        stopNode ? el("strong", { class: "danger-text" }, stopNode.title) : null, stopNode ? el("span", {}, "에서 멈춥니다") : el("span", {}, "멈추지 않습니다"),
        h.conflicts.length ? el("span", {}, ` · 판정 줄과 부딪히는 칸 `) : null, h.conflicts.length ? el("strong", { class: "warn-text" }, `${h.conflicts.length}개`) : null));
    } else if (h) notice.append(el("div", { class: "guide-banner ok" }, el("span", {}, "✓ 이 세션이 연결로 받은 작업은 멈추지 않고 다음 세션으로 넘어갑니다.")));
    fill(box, renderFlow(flow, { selected: state.flowSelected, highlights: h, onSelect: (id) => { state.flowSelected = id; paintFlow(); } }));
    renderFlowInfo();
  }

  function sourceLines(range) {
    const lines = (state.guide?.file === state.flow?.file ? state.guide.text : "").split(/\r?\n/);
    return range?.length ? lines.slice(range[0] - 1, range[1]).join("\n") : "";
  }
  const lineLink = (range) => el("button", { type: "button", class: "link guide-line-link", onclick: async () => {
    show("edit");
    if (state.file !== state.flow.file) await switchFile(state.flow.file);
    goLine(range[0], { select: true });
  } }, `↗ ${state.flow.file} ${range[0]}${range[1] !== range[0] ? `–${range[1]}` : ""}행`);

  function renderFlowInfo() {
    const flow = state.flow;
    const box = $("g-flow-info");
    const h = flow.highlights;
    const node = flow.nodes.find((n) => n.id === state.flowSelected);
    if (!node && h && (h.stop || h.conflicts.length)) {
      const sessionTitle = flow.session?.title ?? "";
      const stopNode = h.stop && flow.nodes.find((n) => n.id === h.stop.id);
      fill(box, 
        el("p", { class: "muted guide-label" }, `근거 · ${sessionTitle}`),
        ...(stopNode ? [el("h4", { class: "danger-text" }, `⏸ ${stopNode.title}에서 멈춤`), el("p", { class: "muted" }, "연결로 받은 작업은 사용자가 승인할 때까지 다음 세션으로 넘어가지 않습니다."),
          el("div", { class: "guide-quote" }, h.stop.warning.quote), lineLink([h.stop.warning.line, h.stop.warning.line])] : []),
        ...h.conflicts.flatMap((c) => [el("hr"), el("h4", { class: "warn-text" }, `⚠ ${flow.nodes.find((n) => n.id === c.id)?.title}와 판정 줄 충돌`), el("p", { class: "muted" }, c.warning.detail), el("div", { class: "guide-quote" }, c.warning.quote), lineLink([c.warning.line, c.warning.line])]),
        el("span", { class: "spacer" }),
        el("button", { type: "button", class: "primary guide-wide", onclick: async () => { show("edit"); if (state.file !== flow.file) await switchFile(flow.file); state.panel = true; renderEdit(); } }, "편집 보기에서 고치기"));
      return;
    }
    if (!node) { fill(box, el("p", { class: "muted guide-label" }, "근거"), el("p", { class: "muted" }, "칸을 누르면 근거가 보입니다.")); return; }
    const index = flow.nodes.indexOf(node) + 1;
    const others = flow.nodes.filter((n) => n.guess && n !== node).map((n) => n.title);
    fill(box, 
      el("p", { class: "muted guide-label" }, "근거"),
      el("h4", {}, node.title, node.guess ? el("span", { class: "guide-guess" }, "추정") : null),
      el("p", { class: "muted" }, `${{ start: "시작", end: "끝", decision: "분기", step: "단계" }[node.type]} · ${index}번째 칸`),
      el("p", { class: "guide-label" }, "원문"),
      node.lines.length ? el("pre", { class: "guide-quote mono" }, sourceLines(node.lines) || "(지침이 바뀌어 원문을 찾지 못했습니다. 다시 그리세요.)") : el("p", { class: "warn-text" }, "근거 줄이 없습니다. AI가 앞뒤를 이으려고 추정한 칸입니다."),
      node.lines.length ? lineLink(node.lines) : null,
      node.detail ? el("p", { class: "guide-label" }, "AI 해석") : null, node.detail ? el("p", {}, node.detail) : null,
      others.length ? el("p", { class: "guide-label" }, "다른 추정 칸") : null, others.length ? el("p", { class: "warn-text" }, others.join(" · ")) : null);
  }

  // ── 공통 ────────────────────────────────────────────────────
  function stateCard(kind, title, detail = "", action = null) {
    return el("div", { class: `guide-state ${kind}` },
      el("div", { class: "guide-state-icon", "aria-hidden": "true" }, kind === "loading" ? "" : kind === "error" ? "⚠" : "🧭"),
      el("strong", {}, title), detail ? el(kind === "error" ? "pre" : "p", { class: kind === "error" ? "mono guide-error-detail" : "muted" }, detail) : null, action);
  }

  let toastTimer = null;
  function toast(text, error = false) {
    const box = $("g-toast");
    if (!box) return;
    box.textContent = text;
    box.className = `guide-toast${error ? " error" : ""}`;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 3000);
  }

  function renderTabCount() {
    const count = $("p-tab-guide");
    if (count) { const n = problems().length; count.textContent = n ? String(n) : ""; count.classList.toggle("warn", n > 0); }
  }

  // 다른 곳(세션·명령)에서 프로젝트가 바뀌면 지도를 다시 읽는다.
  function changed() { state.map = null; if (state.view === "map" && navigation.project === state.project) loadMap(); }

  // 상단바 "스킬" 버튼·그래프의 "스킬 관리"·지도의 스킬 노드에서 스킬 보기로 바로 온다.
  async function showSkills(projectPath, name) {
    await activate(projectPath);
    show("skills");
    if (name) await skills.activate(projectPath, { select: name });
  }

  return { activate, changed, showSkills, isDirty: () => !!dirty() || skills.isDirty() };
}

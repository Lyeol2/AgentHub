import { el } from "../../shared/dom.js";
import { openDiffDialog } from "./diff.js";

// 프로젝트 지침 탭의 "스킬" 보기: 목록(검색·범위 필터·문제 배지) / 편집(앞머리 칸·본문·참고 파일 탭·검사) / 정보(읽는 쪽·경로·참고 파일·세션·다른 프로젝트·범위 옮기기)
export const READER = {
  agenthub: { chip: "AgentHub", title: "AgentHub가 이은 세션만", detail: "세션 카드에 장착한 세션만 씁니다. 다른 도구에서는 보이지 않습니다.", icon: "⧉" },
  claude: { chip: "Claude", title: "Claude가 저절로 읽음", detail: "이 프로젝트의 Claude 세션은 장착하지 않아도 씁니다.", icon: "◆" },
  codex: { chip: "Codex", title: "Codex가 저절로 읽음", detail: "이 프로젝트의 Codex 세션은 장착하지 않아도 씁니다.", icon: "◇" },
  shared: { chip: "공용", title: "Claude·Codex 모두", detail: "모든 프로젝트의 Claude·Codex 세션이 씁니다.", icon: "◎" },
  skipped: { chip: "건너뜀", title: "아무도 읽지 않음", detail: "규칙에 맞지 않아 빠졌습니다.", icon: "⊘" },
};
const FILTERS = [["all", "전체"], ["agenthub", "AgentHub만"], ["claude", "Claude 자동"], ["codex", "Codex 자동"], ["shared", "공용"]];
const MOVE_TARGETS = [["project", "AgentHub만", "세션 카드에 장착한 세션만 씁니다."], ["claude", "이 프로젝트 Claude", ".claude/skills · Claude가 저절로 읽습니다."], ["codex", "이 프로젝트 Codex", ".agents/skills · Codex가 저절로 읽습니다."], ["personal", "공용(Claude·Codex 모두)", "~/.claude/skills와 ~/.agents/skills에 둡니다."]];
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fill = (box, ...items) => box.replaceChildren(...items.flat().filter((item) => item !== null && item !== undefined && item !== false));
const kb = (bytes) => bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
const elapsed = (start) => { const s = Math.floor((Date.now() - start) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const readerOf = (row) => row?.skipped ? "skipped" : row?.reader ?? "agenthub";
const formatSkill = ({ name, description, body }) => `---\nname: ${name}\ndescription: ${JSON.stringify(String(description ?? "").replace(/\s+/g, " ").trim())}\n---\n\n${String(body ?? "").trim()}\n`;
function parseSkill(text) {
  const match = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { description: "", body: String(text).trim() };
  const description = match[1].match(/^description:\s*(.*)$/m)?.[1].replace(/^(["'])([\s\S]*)\1$/, "$2").trim() ?? "";
  return { description: description.replace(/\\"/g, '"'), body: match[2].trim() };
}

export function createSkillsView({ api, toast, selectSession, showGraph, onCount }) {
  const state = {
    project: null, catalog: null, loading: false, error: null, filter: "all", query: "", problemsOnly: false,
    selected: null, detail: null, draft: null, tabs: [], tab: "SKILL.md", files: new Map(), warnings: [], panel: false, ignored: new Set(),
    saveError: null, busy: null, checkTimer: null, newSkill: null, chooseSeq: 0,
  };
  let box = null, bar = null;
  const $q = (sel) => box.querySelector(sel);
  const dirty = () => {
    if (state.newSkill) return true;
    if (!state.detail || !state.draft) return false;
    if (state.draft.description !== state.detail.description || state.draft.body !== state.detail.body) return true;
    return [...state.files.values()].some((f) => f.text !== f.saved);
  };

  // ── 골격 ────────────────────────────────────────────────────
  function mount(container, actions) {
    box = container; bar = actions;
    fill(bar,
      el("button", { type: "button", class: "ghost", id: "gs-trigger", onclick: openTrigger }, "발동 시험"),
      el("button", { type: "button", id: "gs-new", onclick: openNew }, "새 스킬"),
      el("button", { type: "button", id: "gs-suggest", onclick: suggest }, "AI 고칠 점 제안"),
      el("button", { type: "button", class: "primary", id: "gs-save", onclick: () => save() }, "저장"));
    fill(box,
      el("div", { id: "gs-banner" }),
      el("div", { class: "gs-grid" },
        el("aside", { class: "gs-list" },
          el("div", { class: "gs-search" }, el("input", { type: "search", id: "gs-query", placeholder: "스킬 이름·설명 검색", "aria-label": "스킬 검색", oninput: (e) => { state.query = e.target.value; renderList(); } })),
          el("div", { class: "gs-filters", id: "gs-filters", role: "group", "aria-label": "범위 필터" }),
          el("label", { class: "guide-check gs-problems" }, el("input", { type: "checkbox", id: "gs-problems-only", onchange: (e) => { state.problemsOnly = e.target.checked; renderList(); } }), " 문제 있는 스킬만"),
          el("div", { class: "gs-rows", id: "gs-rows", role: "listbox", "aria-label": "스킬 목록" }),
          el("footer", {}, el("span", { class: "muted", id: "gs-count" }), el("button", { type: "button", class: "ghost sm", title: "다시 찾기", "aria-label": "다시 찾기", onclick: () => load() }, "↻"))),
        el("section", { class: "gs-editor guide-editor", id: "gs-editor" }),
        el("aside", { class: "gs-info", id: "gs-info" })));
    box.querySelector("#gs-query").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.target.value = ""; state.query = ""; renderList(); } });
  }

  async function activate(projectPath, { select } = {}) {
    if (state.project !== projectPath) Object.assign(state, { project: projectPath, catalog: null, selected: null, detail: null, draft: null, tabs: [], files: new Map(), newSkill: null, saveError: null, ignored: new Set() });
    await load();
    if (select) await choose({ name: select });
  }

  async function load() {
    state.loading = true; state.error = null;
    render();
    try { state.catalog = await api("GET", `/api/skills/catalog?path=${encodeURIComponent(state.project)}`); }
    catch (error) { state.error = error.message; }
    state.loading = false;
    onCount?.(problemCount());
    if (!state.selected && !state.newSkill) {
      const first = rows()[0];
      if (first) { await choose(first); return; }
    }
    render();
  }

  const problemCount = () => state.catalog ? state.catalog.skills.filter((s) => s.locked || s.warnings || s.diverged).length + state.catalog.skipped.length : 0;
  const allRows = () => state.catalog ? [...state.catalog.skills, ...state.catalog.skipped.map((s) => ({ ...s, skipped: true }))] : [];
  function rows() {
    const q = state.query.trim().toLowerCase();
    return allRows().filter((row) => {
      if (state.filter !== "all" && (row.skipped || row.reader !== state.filter)) return false;
      if (state.problemsOnly && !(row.skipped || row.locked || row.warnings || row.diverged)) return false;
      return !q || row.name.toLowerCase().includes(q) || String(row.description ?? "").toLowerCase().includes(q);
    });
  }

  function render() {
    if (!box) return;
    renderBar(); renderBanner(); renderList(); renderEditor(); renderInfo();
  }

  function renderBar() {
    const d = state.detail;
    const editable = d && !d.locked && !d.skipped;
    $q("#gs-banner");
    bar.querySelector("#gs-save").disabled = !dirty() || !!state.busy || (!!d && !editable && !state.newSkill);
    bar.querySelector("#gs-suggest").disabled = !editable || !!state.busy || !!state.newSkill;
  }

  // ── 목록 ────────────────────────────────────────────────────
  function renderList() {
    const all = allRows();
    const count = (key) => key === "all" ? all.length : all.filter((r) => !r.skipped && r.reader === key).length;
    fill($q("#gs-filters"), FILTERS.map(([key, label]) => el("button", { type: "button", class: `gs-filter${state.filter === key ? " active" : ""}`, "aria-pressed": String(state.filter === key), onclick: () => { state.filter = key; renderList(); } }, `${label} `, el("span", { class: "muted" }, String(count(key))))));
    const list = $q("#gs-rows");
    if (state.loading && !state.catalog) { fill(list, Array.from({ length: 6 }, () => el("div", { class: "gs-row skeleton" }))); $q("#gs-count").textContent = "스킬을 찾는 중…"; return; }
    if (state.error) { fill(list, el("div", { class: "gs-list-error" }, el("strong", { class: "danger-text" }, "스킬 목록을 읽지 못했습니다"), el("pre", { class: "mono" }, state.error), el("button", { type: "button", onclick: () => load() }, "다시 찾기"))); return; }
    const visible = rows();
    const groups = [["agenthub", "AgentHub만"], ["claude", "Claude 자동"], ["codex", "Codex 자동"], ["shared", "공용"], ["skipped", "건너뜀"]];
    const items = [];
    if (state.newSkill) items.push(rowEl({ ...state.newSkill, isNew: true }));
    for (const [key, label] of groups) {
      const group = visible.filter((r) => readerOf(r) === key);
      if (!group.length) continue;
      items.push(el("div", { class: "gs-group" }, label));
      items.push(...group.map(rowEl));
    }
    for (const error of state.catalog?.errors ?? []) items.push(el("div", { class: "gs-list-error small" }, el("span", { class: "danger-text" }, `${error.dir}를 읽지 못했습니다`), el("span", { class: "mono muted" }, error.code)));
    if (!items.length) items.push(el("div", { class: "gs-none muted" }, state.query ? `‘${state.query}’와 맞는 스킬이 없습니다` : allRows().length ? "조건에 맞는 스킬이 없습니다" : "아직 스킬이 없습니다",
      state.query && SKILL_NAME.test(state.query.trim()) ? el("button", { type: "button", class: "link", onclick: () => openNew(state.query.trim()) }, ` 새 스킬 ${state.query.trim()} 만들기`) : null));
    fill(list, items);
    const skipped = state.catalog?.skipped.length ?? 0;
    $q("#gs-count").textContent = `${state.catalog?.skills.length ?? 0}개${skipped ? ` · 건너뜀 ${skipped}` : ""}${state.catalog?.skills.some((s) => s.scope === "codex-home") ? " · ~/.codex 포함" : ""}`;
  }

  function rowEl(row) {
    const reader = row.isNew ? READER[row.reader ?? "agenthub"] : READER[readerOf(row)];
    const selected = row.isNew ? true : !state.newSkill && state.selected && state.selected.file === row.file;
    const badges = [
      row.isNew ? el("span", { class: "gs-badge new" }, "새 스킬") : null,
      row.locked ? el("span", { class: "gs-badge warn" }, "🔒 잠김") : null,
      row.skipped ? el("span", { class: "gs-badge faint" }, "⊘ 건너뜀") : null,
      row.warnings ? el("span", { class: "gs-badge warn" }, `경고 ${row.warnings}`) : null,
      row.diverged ? el("span", { class: "gs-badge orch" }, "⑂ 갈라짐") : null];
    const users = row.equipped || row.reading;
    return el("button", { type: "button", role: "option", "aria-selected": String(!!selected), class: `gs-row${selected ? " selected" : ""}${row.skipped ? " skipped" : ""}`, "data-name": row.name, onclick: () => !row.isNew && choose(row) },
      el("div", { class: "gs-row-top" }, el("span", { class: `gs-chip ${row.isNew ? row.reader ?? "agenthub" : readerOf(row)}` }, `${reader.icon} ${reader.chip}`),
        el("span", { class: "gs-row-name mono" }, row.name || "(이름 없음)", selected && dirty() ? el("span", { class: "gs-dirty", title: "저장하지 않은 변경" }, " ●") : null),
        el("span", { class: "gs-row-badges" }, ...badges.filter(Boolean)),
        users ? el("span", { class: "gs-row-users muted", title: `장착 ${row.equipped} · 저절로 읽는 세션 ${row.reading}` }, `👤 ${users}`) : null),
      el("div", { class: "gs-row-desc muted" }, row.skipped ? row.reasons?.[0]?.text ?? "" : row.description || "(설명 없음)"));
  }

  async function choose(row, { force = false } = {}) {
    if (!force && dirty() && !confirm("저장하지 않은 변경이 있습니다. 버리고 다른 스킬을 열까요?")) return;
    const seq = ++state.chooseSeq; // 나중에 고른 스킬이 이긴다(앞의 요청이 늦게 끝나도 덮지 않는다).
    state.newSkill = null;
    const match = row.file ? row : allRows().find((r) => r.name === row.name);
    if (!match) return;
    state.selected = { name: match.name, file: match.file, skipped: !!match.skipped };
    state.tabs = []; state.tab = "SKILL.md"; state.files = new Map(); state.saveError = null; state.panel = false; state.ignored = new Set();
    render();
    try {
      const detail = await api("GET", `/api/skills/${encodeURIComponent(match.name)}/detail?path=${encodeURIComponent(state.project)}&file=${encodeURIComponent(match.file)}`);
      if (seq !== state.chooseSeq) return;
      state.detail = detail;
      state.draft = { description: detail.description, body: detail.body };
      state.warnings = detail.warnings;
    } catch (error) { if (seq === state.chooseSeq) { toast(error.message, true); state.detail = null; } }
    if (seq === state.chooseSeq) render();
  }

  // ── 배너 ────────────────────────────────────────────────────
  function renderBanner() {
    const banner = $q("#gs-banner");
    const d = state.detail;
    fill(banner);
    if (!d || state.newSkill) return;
    if (d.locked) {
      banner.append(el("div", { class: "guide-banner warn" }, el("span", { "aria-hidden": "true" }, "🔒"),
        el("strong", {}, `두 위치의 내용이 다릅니다 · ${d.name}은 읽기만 할 수 있습니다`),
        el("span", { class: "muted" }, "~/.claude/skills와 ~/.agents/skills의 SKILL.md가 다릅니다."), el("span", { class: "spacer" }),
        el("button", { type: "button", class: "primary sm", onclick: mergePersonal }, "비교해서 합치기")));
    }
  }

  // ── 편집 ────────────────────────────────────────────────────
  function renderEditor() {
    const pane = $q("#gs-editor");
    if (state.loading && !state.catalog) { fill(pane, el("div", { class: "guide-state loading" }, el("div", { class: "guide-state-icon" }), el("strong", {}, "스킬을 찾는 중…"), el("p", { class: "muted" }, ".agenthub · .claude · .agents · ~/.claude · ~/.agents · ~/.codex"))); return; }
    if (!state.newSkill && !state.selected) {
      fill(pane, el("div", { class: "guide-state empty" }, el("div", { class: "guide-state-icon" }, "⚡"), el("strong", {}, allRows().length ? "스킬을 고르세요" : "스킬을 만들어 보세요"),
        el("p", { class: "muted" }, "자주 하는 일을 스킬로 만들면 세션에 붙이거나 저절로 읽히게 할 수 있습니다."),
        el("div", { class: "gs-empty-actions" }, el("button", { type: "button", class: "primary", onclick: () => openNew() }, "새 스킬"), el("button", { type: "button", onclick: () => openNew("", { ai: true }) }, "AI로 초안 만들기"))));
      return;
    }
    const d = state.newSkill ?? state.detail;
    if (!d) { fill(pane, el("div", { class: "guide-state loading" }, el("div", { class: "guide-state-icon" }), el("strong", {}, "불러오는 중…"))); return; }
    const readOnly = !state.newSkill && (d.locked || d.skipped);
    const reader = state.newSkill ? state.newSkill.reader : readerOf(d);
    const head = el("header", { class: "gs-head" },
      el("span", { class: `gs-chip ${reader}` }, `${READER[reader].icon} ${READER[reader].chip}`),
      el("h3", { class: "mono" }, d.name || "새 스킬"),
      el("span", { class: "spacer" }),
      el("span", { class: "muted mono" }, state.newSkill ? "저장 전" : `SKILL.md · ${kb(d.bytes)} · ${d.lines.toLocaleString()}줄`));
    const tabs = el("div", { class: "gs-tabs", role: "tablist" },
      el("button", { type: "button", role: "tab", class: state.tab === "SKILL.md" ? "active" : "", onclick: () => { state.tab = "SKILL.md"; renderEditor(); } }, "SKILL.md"),
      ...state.tabs.map((rel) => el("span", { class: `gs-tab${state.tab === rel ? " active" : ""}` },
        el("button", { type: "button", role: "tab", onclick: () => { state.tab = rel; renderEditor(); } }, rel, state.files.get(rel)?.text !== state.files.get(rel)?.saved ? " ●" : ""),
        el("button", { type: "button", class: "gs-tab-close", "aria-label": `${rel} 닫기`, onclick: () => closeTab(rel) }, "×"))));
    const progress = state.busy ? progressCard() : null;
    const saveError = state.saveError ? el("div", { class: "guide-save-error" }, el("span", {}, `⚠ 저장하지 못했습니다 · ${state.saveError.kind === "changed" ? "파일이 다른 곳에서 바뀌었습니다" : state.saveError.message}`), el("span", { class: "spacer" }),
      ...(state.saveError.kind === "changed" ? [el("button", { type: "button", class: "ghost sm", onclick: compareDisk }, "다시 불러와 비교"), el("button", { type: "button", class: "ghost sm danger-outline", onclick: () => save({ force: true }) }, "덮어쓰기")] : [])) : null;
    if (state.tab !== "SKILL.md") {
      const file = state.files.get(state.tab);
      const area = editorArea(file?.text ?? "불러오는 중…", (value) => { file.text = value; renderBar(); }, { readOnly: !file || readOnly });
      fill(pane, head, tabs, progress, saveError, area, el("footer", { class: "guide-editor-foot" }, el("span", { class: "muted" }, `${state.tab} · ${file ? kb(new Blob([file.text]).size) : ""}`)));
      return;
    }
    const draft = state.newSkill ?? state.draft;
    const skipCard = !state.newSkill && d.skipped ? el("div", { class: "gs-skip-card" },
      el("strong", {}, "이 스킬은 Claude·Codex가 읽지 않고 건너뜁니다"),
      el("ul", {}, ...d.reasons.map((r) => el("li", {}, `⊘ ${r.text}`))),
      el("div", {}, el("button", { type: "button", class: "primary sm", onclick: fixSkipped }, "고치기"))) : null;
    const nameOk = SKILL_NAME.test(d.name ?? "");
    const fields = el("div", { class: "gs-fields" },
      el("label", { class: "gs-field gs-name" }, el("span", { class: "muted" }, "이름"),
        el("input", { class: "mono", value: d.name ?? "", disabled: "", "aria-label": "이름" }),
        el("span", { class: nameOk ? "ok-text" : "danger-text" }, nameOk ? (state.newSkill ? "✓ 규칙에 맞음" : "✓ 폴더 이름과 같음") : "✗ 소문자·숫자·하이픈만")),
      el("label", { class: "gs-field gs-desc" }, el("span", { class: "muted", id: "gs-desc-count" }, `description · 1줄 · ${(draft.description ?? "").length}/1024자`),
        el("input", { id: "gs-description", value: draft.description ?? "", ...(readOnly ? { disabled: "" } : {}), "aria-label": "description", placeholder: "무엇을 하는지와 언제 쓰는지, 범위 밖 일을 한 줄로",
          oninput: (e) => { draft.description = e.target.value.replace(/\n/g, " "); $q("#gs-desc-count").textContent = `description · 1줄 · ${draft.description.length}/1024자`; changed(); } })));
    const area = editorArea(draft.body ?? "", (value) => { draft.body = value; changed(); }, { readOnly, label: "스킬 본문" });
    const problems = state.warnings.filter((w) => w.level !== "info" && !state.ignored.has(w.id));
    const infos = state.warnings.filter((w) => w.level === "info" && !state.ignored.has(w.id));
    const foot = el("footer", { class: "guide-editor-foot" },
      el("button", { type: "button", class: `link guide-status ${problems.length ? "warn" : infos.length ? "info" : "ok"}`, id: "gs-status", onclick: () => { state.panel = !state.panel; renderInfo(); renderEditor(); } },
        problems.length ? `⚠ 경고 ${problems.length} · ${problems[0].title} · ${state.panel ? "닫기" : "보기"}` : infos.length ? `ⓘ ${infos[0].title} · ${state.panel ? "닫기" : "보기"}` : "✓ 검사 통과"),
      el("span", { class: "muted" }, readOnly ? "읽기 전용" : "Ctrl+S 저장"));
    fill(pane, head, tabs, progress, saveError, skipCard, fields, area, foot);
  }

  function editorArea(text, onInput, { readOnly = false, label = "파일 내용" } = {}) {
    const gutter = el("pre", { class: "guide-gutter mono", "aria-hidden": "true" });
    const textarea = el("textarea", { class: "mono gs-text", spellcheck: "false", "aria-label": label, ...(readOnly ? { readonly: "" } : {}) });
    textarea.value = text;
    const sync = () => {
      const count = textarea.value.split("\n").length;
      if (gutter.dataset.count !== String(count)) { gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n"); gutter.dataset.count = String(count); }
      gutter.scrollTop = textarea.scrollTop;
    };
    textarea.addEventListener("input", () => { onInput(textarea.value); sync(); });
    textarea.addEventListener("scroll", sync);
    textarea.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } });
    sync();
    return el("div", { class: `guide-editor-body gs-body${readOnly ? " readonly" : ""}` }, gutter, textarea);
  }

  function goLine(line) {
    const textarea = $q(".gs-text");
    if (!textarea || !line) return;
    const lines = textarea.value.split("\n");
    const start = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0);
    textarea.focus();
    textarea.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    textarea.scrollTop = Math.max(0, (line - 4) * (parseFloat(getComputedStyle(textarea).lineHeight) || 21));
  }

  function changed() {
    renderBar();
    const row = $q(".gs-row.selected .gs-row-name");
    if (row && !row.querySelector(".gs-dirty")) row.append(el("span", { class: "gs-dirty" }, " ●"));
    clearTimeout(state.checkTimer);
    state.checkTimer = setTimeout(check, 400);
  }

  async function check() {
    const d = state.newSkill ?? state.detail;
    const draft = state.newSkill ?? state.draft;
    if (!d || !draft) return;
    try {
      const result = await api("POST", `/api/skills/check?path=${encodeURIComponent(state.project)}`, { name: d.name, folder: state.newSkill ? undefined : d.name, description: draft.description, body: draft.body });
      state.warnings = result.warnings;
      const status = $q("#gs-status");
      if (status) { renderEditor(); renderInfo(); }
    } catch { /* 검사 실패는 저장을 막지 않는다 */ }
  }

  async function openFile(rel) {
    if (!state.tabs.includes(rel)) state.tabs.push(rel);
    state.tab = rel;
    renderEditor();
    if (state.files.has(rel)) return;
    try {
      const file = await api("GET", `/api/skills/${encodeURIComponent(state.detail.name)}/file?path=${encodeURIComponent(state.project)}&rel=${encodeURIComponent(rel)}`);
      state.files.set(rel, { text: file.text, saved: file.text, hash: file.hash });
    } catch (error) { toast(error.message, true); state.tabs = state.tabs.filter((t) => t !== rel); state.tab = "SKILL.md"; }
    renderEditor();
  }
  function closeTab(rel) {
    const file = state.files.get(rel);
    if (file && file.text !== file.saved && !confirm(`${rel}의 저장하지 않은 변경을 버릴까요?`)) return;
    state.tabs = state.tabs.filter((t) => t !== rel);
    state.files.delete(rel);
    if (state.tab === rel) state.tab = "SKILL.md";
    renderEditor();
  }

  // ── 정보 / 검사 패널 ─────────────────────────────────────────
  function renderInfo() {
    const pane = $q("#gs-info");
    const d = state.newSkill ?? state.detail;
    if (!d) { fill(pane); return; }
    if (state.panel && !state.newSkill) return renderPanel(pane);
    const reader = state.newSkill ? state.newSkill.reader : readerOf(d);
    const r = READER[reader];
    const detail = reader === "codex" && d.scope === "codex-home" ? "모든 프로젝트의 Codex 세션이 씁니다." : r.detail;
    if (state.newSkill) { fill(pane, el("div", { class: `gs-reader ${reader}` }, el("span", { class: "gs-reader-icon" }, r.icon), el("div", {}, el("strong", {}, r.title), el("p", { class: "muted" }, detail)))); return; }
    const sessions = d.sessions ?? [];
    const native = !d.skipped && reader !== "agenthub";
    fill(pane,
      el("div", { class: `gs-reader ${reader}` }, el("span", { class: "gs-reader-icon" }, r.icon), el("div", {}, el("strong", {}, r.title), el("p", { class: "muted" }, detail))),
      el("p", { class: "guide-label" }, "파일"),
      el("p", { class: "mono muted guide-path" }, d.file),
      el("div", { class: "gs-path-actions" }, el("button", { type: "button", class: "ghost sm", onclick: async () => { try { await navigator.clipboard.writeText(d.file); toast("경로를 복사했습니다"); } catch { toast(d.file); } } }, "📋 경로 복사")),
      d.files?.length ? el("p", { class: "guide-label" }, `참고 파일 ${d.files.filter((f) => !f.dir).length}`) : null,
      d.files?.length ? el("ul", { class: "gs-tree" }, ...d.files.map((f) => el("li", { style: `padding-left:${f.depth * 14}px` },
        f.dir ? el("span", { class: "muted" }, `▾ ${f.path.split("/").pop()}/`) : f.text && !d.skipped
          ? el("button", { type: "button", class: "link", onclick: () => openFile(f.path) }, f.path.split("/").pop(), el("span", { class: "muted" }, ` ${kb(f.bytes)}`))
          : el("span", { class: "muted" }, `${f.path.split("/").pop()} ${kb(f.bytes)}`)))) : null,
      el("p", { class: "guide-label" }, native ? `읽는 세션 ${sessions.length}${sessions.some((s) => s.native) ? " · 저절로" : ""}` : `장착한 세션 ${sessions.filter((s) => s.equipped).length}`),
      sessions.length ? el("ul", { class: "gs-sessions" }, ...sessions.map((s) => el("li", {},
        el("button", { type: "button", class: "gs-session", title: "세션 흐름에서 이 카드를 강조합니다", onclick: () => showGraph?.([s.id]) },
          el("span", { class: `gs-engine ${s.agent}` }), s.title, el("span", { class: "muted" }, s.equipped ? " · 장착" : " · 저절로"))))) : el("p", { class: "muted" }, native ? "이 범위를 읽는 세션이 없습니다." : "장착한 세션이 없습니다. 세션 카드의 스킬 칩에서 장착합니다."),
      d.elsewhere?.length ? el("button", { type: "button", class: "link gs-elsewhere", onclick: openCrossProject }, `⑂ 다른 프로젝트 ${d.elsewhere.length}곳에 같은 이름${d.elsewhere.some((e) => !e.same) ? ` · ${d.elsewhere.filter((e) => !e.same).length}곳 다름` : " · 모두 같음"}`) : null,
      d.skipped ? null : el("p", { class: "guide-label" }, "범위 옮기기"),
      d.skipped ? null : el("select", { class: "gs-move", "aria-label": "범위 옮기기", ...(d.locked || d.scope === "codex-home" ? { disabled: "" } : {}), onchange: (e) => { const to = e.target.value; e.target.value = ""; if (to) moveScope(to); } },
        el("option", { value: "" }, "범위 옮기기 ▾"), ...MOVE_TARGETS.filter(([scope]) => scope !== d.scope).map(([scope, label, help]) => el("option", { value: scope, title: help }, `${label} — ${help}`))),
      el("span", { class: "spacer" }),
      d.skipped || d.scope === "codex-home" ? null : el("button", { type: "button", class: "ghost sm danger gs-delete", onclick: remove }, "삭제"));
  }

  function renderPanel(pane) {
    const list = state.warnings.filter((w) => !state.ignored.has(w.id));
    fill(pane,
      el("header", { class: "gs-panel-head" }, el("button", { type: "button", class: "link", onclick: () => { state.panel = false; renderInfo(); renderEditor(); } }, "← 정보"), el("span", { class: "spacer" }), el("strong", {}, "저장 전 검사"), el("span", { class: "guide-count" }, String(list.length))),
      el("div", { class: "guide-warning-list" }, ...list.map((w) => el("article", { class: `guide-warning ${w.level}` },
        el("strong", {}, w.title),
        w.quote ? el("div", { class: "guide-quote" }, w.quote) : null,
        w.other ? el("div", { class: "guide-quote" }, `${w.other.name}: ${w.other.description}`) : null,
        el("p", { class: "muted" }, w.detail),
        w.fix?.to ? el("p", { class: "guide-suggest" }, `제안: ${w.fix.to.trim()}`) : null,
        el("div", { class: "guide-warning-actions" },
          w.fix ? el("button", { type: "button", class: "primary sm", onclick: () => applyFix(w) }, w.fix.to ? "제안 적용" : "링크 지우기") : null,
          w.kind === "trigger" ? el("button", { type: "button", class: "ghost sm", onclick: () => openTrigger() }, "발동 시험") : null,
          w.line ? el("button", { type: "button", class: "ghost sm", onclick: () => { if (state.tab !== "SKILL.md") { state.tab = "SKILL.md"; renderEditor(); } goLine(w.line); } }, "줄로 이동") : null,
          w.field === "description" ? el("button", { type: "button", class: "ghost sm", onclick: () => $q("#gs-description")?.focus() }, "description으로") : null,
          el("button", { type: "button", class: "ghost sm", onclick: () => { state.ignored.add(w.id); renderInfo(); renderEditor(); } }, "무시")))),
        list.length ? null : el("p", { class: "muted pad" }, "경고가 없습니다.")),
      el("footer", { class: "gs-panel-foot" }, list.some((w) => w.level !== "info") ? el("button", { type: "button", onclick: () => save({ ignoreWarnings: true }) }, "경고 무시하고 저장") : null, el("button", { type: "button", class: "ghost", onclick: () => { state.panel = false; renderInfo(); renderEditor(); } }, "닫기")));
  }

  function applyFix(w) {
    const lines = state.draft.body.split("\n");
    if (lines[w.fix.line - 1] !== w.fix.from) { toast("그 줄이 바뀌었습니다. 다시 검사합니다.", true); check(); return; }
    lines[w.fix.line - 1] = w.fix.to ?? w.fix.from.replace(/!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label, target) => label || target);
    state.draft.body = lines.join("\n");
    renderEditor(); renderBar(); check();
  }

  // ── 저장 ────────────────────────────────────────────────────
  async function save({ ignoreWarnings = false, force = false } = {}) {
    if (!dirty() && !force) return;
    const q = `path=${encodeURIComponent(state.project)}`;
    try {
      if (state.newSkill) {
        const s = state.newSkill;
        await api("POST", "/api/skills", { projectPath: state.project, name: s.name, description: s.description, body: s.body, scope: s.scope });
        const name = s.name;
        state.newSkill = null;
        toast(`${name} 스킬을 만들었습니다`);
        await load();
        await choose({ name });
        return;
      }
      const d = state.detail;
      // 열어 둔 참고 파일부터 저장
      for (const [rel, file] of state.files) {
        if (file.text === file.saved) continue;
        const saved = await api("PUT", `/api/skills/${encodeURIComponent(d.name)}/file?${q}&rel=${encodeURIComponent(rel)}`, { text: file.text, baseHash: file.hash, force });
        Object.assign(file, { saved: file.text, hash: saved.hash });
      }
      if (state.draft.description !== d.description || state.draft.body !== d.body) {
        await check();
        const problems = state.warnings.filter((w) => w.level !== "info" && !state.ignored.has(w.id));
        if (problems.length && !ignoreWarnings && !force) { state.panel = true; render(); toast(`경고 ${problems.length}개가 있습니다. 고치거나 무시하고 저장하세요.`, true); return; }
        await api("PUT", `/api/skills/${encodeURIComponent(d.name)}?${q}`, { description: state.draft.description, body: state.draft.body, baseHash: d.hash, force });
      }
      state.saveError = null;
      // 다시 읽는 동안 사용자가 다른 스킬을 고르면 그쪽을 둔다.
      const seq = state.chooseSeq;
      const keepTabs = { tabs: state.tabs, tab: state.tab, files: state.files };
      await load();
      if (seq === state.chooseSeq) {
        await choose(state.selected, { force: true });
        if (state.selected?.file === d.file) Object.assign(state, keepTabs);
        render();
      }
      toast(`${d.name}을 저장했습니다`);
    } catch (error) {
      state.saveError = { kind: error.reason === "skill-changed" ? "changed" : "write", message: error.message };
      render();
    }
  }

  async function compareDisk() {
    const fresh = await api("GET", `/api/skills/${encodeURIComponent(state.detail.name)}/detail?path=${encodeURIComponent(state.project)}&file=${encodeURIComponent(state.detail.file)}`);
    const result = await openDiffDialog({ title: "다른 곳에서 바뀐 내용", oldText: formatSkill({ name: fresh.name, ...state.draft }), newText: fresh.text, applyLabel: "고른 변경 받기", note: "고른 변경만 편집 중인 글에 받습니다. 그다음 저장하세요." });
    state.detail = { ...state.detail, hash: fresh.hash };
    state.saveError = null;
    if (result && !result.unchanged) Object.assign(state.draft, parseSkill(result.text));
    render();
  }

  // ── 범위 옮기기·삭제·건너뜀 고치기 ─────────────────────────────
  async function moveScope(to) {
    const d = state.detail;
    const target = MOVE_TARGETS.find(([scope]) => scope === to);
    if (dirty()) { toast("저장하지 않은 변경이 있습니다. 먼저 저장하세요.", true); return; }
    if (!confirm(`${d.name}을(를) ${target[1]}(으)로 옮깁니다.\n${target[2]}`)) return;
    try {
      await api("POST", `/api/skills/${encodeURIComponent(d.name)}/move`, { projectPath: state.project, to });
      toast(`${d.name}을(를) ${target[1]}(으)로 옮겼습니다`);
      state.selected = null;
      await load();
      await choose({ name: d.name });
    } catch (error) { toast(error.message, true); }
  }
  async function remove() {
    const d = state.detail;
    if (!confirm(`${d.name} 스킬을 지웁니다. 참고 파일도 함께 지워지고 되돌릴 수 없습니다.`)) return;
    try {
      await api("DELETE", `/api/skills/${encodeURIComponent(d.name)}?path=${encodeURIComponent(state.project)}`);
      toast(`${d.name}을 지웠습니다`);
      Object.assign(state, { selected: null, detail: null, draft: null });
      await load();
    } catch (error) { toast(error.message, true); }
  }
  async function fixSkipped() {
    const d = state.detail;
    let description = d.description;
    if (!description) { description = prompt("언제 쓰는 스킬인지 description을 한 줄로 적어 주세요."); if (!description) return; }
    try {
      const fixed = await api("POST", `/api/skills/fix-skipped?path=${encodeURIComponent(state.project)}`, { file: d.file, description });
      toast(`${fixed.name}(으)로 고쳤습니다. 이제 Claude·Codex가 읽습니다.`);
      state.selected = null;
      await load();
      await choose({ name: fixed.name });
    } catch (error) { toast(error.message, true); }
  }

  // ── 잠긴 공용 스킬 합치기 · 다른 프로젝트 비교 ─────────────────
  async function mergePersonal() {
    const [left, right] = state.detail.locations;
    if (!left || !right) return;
    const result = await openDiffDialog({ title: `${state.detail.name} 두 위치 합치기`, oldText: left.text, newText: right.text, applyLabel: "합치고 잠김 풀기",
      note: `반영 = ${right.label} 내용 · 버리기 = ${left.label} 내용. 합치면 두 위치에 같은 내용을 저장합니다.` });
    if (!result) return;
    try {
      await api("POST", `/api/skills/${encodeURIComponent(state.detail.name)}/merge?path=${encodeURIComponent(state.project)}`, { text: result.text });
      toast(`${state.detail.name}을 합쳤습니다 · 이제 편집할 수 있습니다`);
      const name = state.detail.name;
      state.selected = null;
      await load();
      await choose({ name });
    } catch (error) { toast(error.message, true); }
  }

  function openCrossProject() {
    const d = state.detail;
    const dialog = el("dialog", { class: "gs-dialog", "aria-label": `${d.name} 프로젝트 비교` });
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.append(el("h3", {}, `${d.name} · 프로젝트 ${d.elsewhere.length + 1}곳 비교`),
      el("p", { class: "muted" }, "다른 프로젝트 파일은 고치지 않습니다. 고른 내용을 이 프로젝트 편집기로 가져옵니다. 공용으로 옮기면 한 곳에서 관리합니다."),
      el("ul", { class: "gs-projects" }, el("li", {}, el("strong", {}, "이 프로젝트"), el("span", { class: "muted" }, d.mtime ? ` · ${new Date(d.mtime).toLocaleDateString()}` : "")),
        ...d.elsewhere.map((e) => el("li", {}, el("strong", {}, e.projectName), el("span", { class: e.same ? "ok-text" : "warn-text" }, e.same ? " · 같음 ✓" : " · 다름"), el("span", { class: "muted" }, ` · ${new Date(e.mtime).toLocaleDateString()}`), el("span", { class: "spacer" }),
          e.same ? null : el("button", { type: "button", class: "ghost sm", onclick: async () => {
            close();
            const result = await openDiffDialog({ title: `${d.name} · ${e.projectName}에서 가져오기`, oldText: formatSkill({ name: d.name, ...state.draft }), newText: e.text, applyLabel: "편집기에 적용", note: "반영한 항목만 이 프로젝트 편집기에 넣습니다. 저장은 따로 누르세요." });
            if (result && !result.unchanged) { Object.assign(state.draft, parseSkill(result.text)); render(); check(); }
          } }, "비교하기")))),
      el("footer", {}, el("button", { type: "button", class: "ghost", onclick: close }, "닫기")));
    document.body.append(dialog);
    dialog.showModal();
  }

  // ── 새 스킬 · AI 초안 · AI 고칠 점 · 발동 시험 ─────────────────
  function openNew(name = "", { ai = false } = {}) {
    if (dirty() && !confirm("저장하지 않은 변경이 있습니다. 버리고 새 스킬을 만들까요?")) return;
    const taken = new Set(allRows().map((r) => r.name));
    const dialog = el("dialog", { class: "gs-dialog gs-new", "aria-label": "새 스킬" });
    const close = () => { dialog.close(); dialog.remove(); };
    const nameInput = el("input", { class: "mono", value: name, placeholder: "new-skill", "aria-label": "스킬 이름" });
    const hint = el("p", { class: "gs-hint" });
    const purpose = el("textarea", { rows: "3", placeholder: "예: PR을 올리기 전에 변경 사항을 검토할 때", "aria-label": "어떤 일을 할 때 쓰는지" });
    let scope = "project";
    const cards = el("div", { class: "gs-scope-cards", role: "radiogroup" });
    const paintCards = () => fill(cards, MOVE_TARGETS.map(([value, label, help]) => {
      const reader = { project: "agenthub", claude: "claude", codex: "codex", personal: "shared" }[value];
      return el("label", { class: `gs-scope-card ${reader}${scope === value ? " active" : ""}` }, el("input", { type: "radio", name: "gs-scope", value, ...(scope === value ? { checked: "" } : {}), onchange: () => { scope = value; paintCards(); } }),
        el("span", { class: "gs-reader-icon" }, READER[reader].icon), el("span", {}, el("strong", {}, label), el("small", { class: "muted" }, help)));
    }));
    const validate = () => {
      const value = nameInput.value.trim();
      const ok = SKILL_NAME.test(value) && !taken.has(value);
      hint.textContent = !value ? "영문 소문자·숫자·하이픈으로 씁니다" : !SKILL_NAME.test(value) ? "✗ 소문자·숫자·하이픈만 씁니다" : taken.has(value) ? "✗ 이미 있는 이름입니다" : "✓ 소문자·숫자·하이픈";
      hint.className = `gs-hint ${!value ? "muted" : ok ? "ok-text" : "danger-text"}`;
      return ok;
    };
    nameInput.addEventListener("input", validate);
    const start = (withAi) => {
      if (!validate()) { nameInput.focus(); return; }
      if (withAi && !purpose.value.trim()) { purpose.focus(); return; }
      const reader = { project: "agenthub", claude: "claude", codex: "codex", personal: "shared" }[scope];
      close();
      Object.assign(state, { newSkill: { name: nameInput.value.trim(), scope, reader, description: purpose.value.trim(), body: `# ${nameInput.value.trim()}\n\n1. \n`, isNew: true }, selected: null, detail: null, draft: null, tabs: [], tab: "SKILL.md", warnings: [], saveError: null, panel: false });
      render();
      if (withAi) draftNew(purpose.value.trim());
      else check();
    };
    dialog.append(el("h3", {}, "새 스킬"),
      el("label", { class: "gs-field" }, el("span", { class: "muted" }, "이름"), nameInput), hint,
      el("p", { class: "muted gs-label" }, "누가 읽는지"), cards,
      el("label", { class: "gs-field" }, el("span", { class: "muted" }, "어떤 일을 할 때 쓰는지"), purpose),
      el("footer", {}, el("button", { type: "button", class: "ghost", onclick: close }, "취소"),
        el("button", { type: "button", onclick: () => start(false) }, "빈 스킬로 만들기"),
        el("button", { type: "button", class: "primary", onclick: () => start(true) }, "AI 초안 만들기")));
    document.body.append(dialog);
    paintCards(); validate();
    dialog.showModal();
    (ai && name ? purpose : nameInput).focus();
  }

  function startBusy(label, steps) {
    stopBusy();
    const controller = new AbortController();
    state.busy = { label, steps, controller, start: Date.now(), step: 0, timer: setInterval(() => { if (state.busy) { state.busy.step = Math.min(steps.length - 2, Math.floor((Date.now() - state.busy.start) / 3000)); const card = $q(".guide-progress"); if (card) card.replaceWith(progressCard()); } }, 1000) };
    render();
    return controller.signal;
  }
  function stopBusy() {
    if (!state.busy) return;
    clearInterval(state.busy.timer);
    state.busy.controller.abort();
    state.busy = null;
    if (box) render();
  }
  function progressCard() {
    const b = state.busy;
    return el("div", { class: "guide-progress gs-progress" },
      el("header", {}, el("strong", {}, `${b.label} · ${elapsed(b.start)}`), el("span", { class: "spacer" }), el("button", { type: "button", class: "ghost sm danger-outline", onclick: stopBusy }, "■ 중지")),
      el("ul", {}, ...b.steps.map((label, i) => el("li", { class: i < b.step ? "done" : i === b.step ? "now" : "" }, el("span", { class: "guide-step-mark" }, i < b.step ? "✓" : i === b.step ? "●" : "○"), label))),
      el("div", { class: "guide-bar-track" }, el("div", { class: "guide-bar-fill", style: `width:${Math.min(92, 8 + (Date.now() - b.start) / 900)}%` })));
  }

  async function draftNew(purpose) {
    const signal = startBusy("AI 초안 만드는 중", ["비슷한 스킬 찾기", "앞머리·본문 쓰기", "검사"]);
    try {
      const result = await api("POST", `/api/skills/draft?path=${encodeURIComponent(state.project)}`, { name: state.newSkill.name, purpose }, { signal });
      if (!state.newSkill) return;
      Object.assign(state.newSkill, { description: result.description || purpose, body: result.body });
      stopBusy();
      await check();
      render();
      toast("AI 초안을 넣었습니다. 읽어 보고 저장하세요.");
    } catch (error) { if (state.busy) { stopBusy(); toast(error.message, true); } }
  }

  async function suggest() {
    const d = state.detail;
    if (!d || d.locked || d.skipped) return;
    const signal = startBusy("AI가 고칠 점을 찾는 중", ["스킬 읽기", "고칠 점 쓰기", "검사"]);
    try {
      const result = await api("POST", `/api/skills/${encodeURIComponent(d.name)}/suggest?path=${encodeURIComponent(state.project)}`, { description: state.draft.description, body: state.draft.body }, { signal });
      stopBusy();
      const before = formatSkill({ name: d.name, ...state.draft });
      const after = formatSkill({ name: d.name, description: result.description || state.draft.description, body: result.body });
      const checked = await api("POST", `/api/skills/check?path=${encodeURIComponent(state.project)}`, { name: d.name, folder: d.name, ...parseSkill(after) }).catch(() => ({ warnings: [] }));
      const picked = await openDiffDialog({ title: `${d.name} 고칠 점 제안`, oldText: before, newText: after, warnings: checked.warnings });
      if (picked?.unchanged) toast("고칠 곳이 없습니다.");
      else if (picked) { Object.assign(state.draft, parseSkill(picked.text)); render(); check(); }
    } catch (error) { if (state.busy) { stopBusy(); toast(error.message, true); } }
  }

  function openTrigger() {
    document.querySelector(".gs-trigger-pop")?.remove();
    const input = el("textarea", { rows: "2", placeholder: "예: 릴리스 노트 정리하고 태그 달아줘", "aria-label": "요청 예시" });
    let engine = "claude";
    const seg = el("div", { class: "guide-seg sm" });
    const paintSeg = () => fill(seg, [["claude", "Claude"], ["codex", "Codex"]].map(([value, label]) => el("button", { type: "button", class: engine === value ? "active" : "", onclick: () => { engine = value; paintSeg(); } }, label)));
    const results = el("div", { class: "gs-trigger-results" });
    const pop = el("div", { class: "guide-popover gs-trigger-pop", role: "dialog", "aria-label": "발동 시험" },
      el("label", { class: "muted" }, "요청 예시", input),
      el("div", { class: "gs-trigger-row" }, seg, el("span", { class: "spacer" }), el("button", { type: "button", class: "primary", onclick: run }, "시험")),
      results,
      el("p", { class: "muted gs-small" }, "AI가 description만 보고 추정한 순위입니다. 실제 발동과 다를 수 있습니다."));
    async function run() {
      if (!input.value.trim()) { input.focus(); return; }
      fill(results, Array.from({ length: 3 }, () => el("div", { class: "gs-row skeleton" })));
      try {
        const out = await api("POST", `/api/skills/trigger?path=${encodeURIComponent(state.project)}`, { request: input.value, agent: engine });
        fill(results, out.results.length ? out.results.map((r, i) => {
          const tone = i === 0 && r.score >= 60 ? "accent" : r.score >= 35 ? "warn" : "faint";
          const row = allRows().find((x) => x.name === r.name);
          return el("button", { type: "button", class: "gs-rank", onclick: () => { pop.remove(); choose({ name: r.name }); } },
            el("div", { class: "gs-rank-top" }, el("strong", { class: "mono" }, r.name), row ? el("span", { class: `gs-chip ${readerOf(row)}` }, READER[readerOf(row)].chip) : null, el("span", { class: "spacer" }), el("span", { class: "muted" }, `${r.score}%`)),
            el("div", { class: "gs-rank-bar" }, el("div", { class: tone, style: `width:${r.score}%` })),
            el("p", { class: "muted" }, r.reason));
        }) : el("p", { class: "muted" }, `발동할 스킬이 없습니다 (후보 ${out.candidates}개).`));
      } catch (error) { fill(results, el("p", { class: "danger-text" }, error.message)); }
    }
    bar.closest(".guide-bar").append(pop);
    paintSeg();
    input.focus();
    const away = (event) => { if (!pop.contains(event.target) && event.target.id !== "gs-trigger") { pop.remove(); document.removeEventListener("pointerdown", away, true); } };
    document.addEventListener("pointerdown", away, true);
  }

  return { mount, activate, isDirty: () => dirty(), problemCount, select: (name) => choose({ name }) };
}

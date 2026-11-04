import { el } from "../../shared/dom.js";

// 지침 갈래 창: 새 지침(하위 폴더 AGENTS.md·CLAUDE.md) · 문서 추가(연결 문서 + 링크 줄) · 삭제 확인(영향·백업) · 되살리기 · 갈래 경고 목록
// ctx: { api, project(), file(), text(), sections(), setText(text), openFile(file), reload(), toast(text, error, action) }
const fill = (box, ...items) => box.replaceChildren(...items.flat().filter((item) => item !== null && item !== undefined && item !== false));
const q = (path, extra = {}) => new URLSearchParams({ path, ...extra }).toString();

function dialog(title, body, actions, { className = "" } = {}) {
  const box = el("dialog", { class: `guide-branch-dialog ${className}`, "aria-label": title });
  const close = () => { box.close(); box.remove(); };
  const error = el("p", { class: "error", role: "alert" });
  box.append(el("h3", {}, title), ...body.flat().filter((item) => item !== null && item !== undefined && item !== false), error, el("footer", {}, el("button", { type: "button", class: "ghost", onclick: close }, "취소"), ...actions({ close, error })));
  box.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  document.body.append(box);
  box.showModal();
  return { box, close, error };
}
const busyButton = (label, run, cls = "primary") => el("button", { type: "button", class: cls, onclick: async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try { await run(); } finally { if (button.isConnected) button.disabled = false; }
} }, label);
const radios = (name, options, value) => el("div", { class: "guide-radios", role: "radiogroup" }, ...options.map(([v, label, help]) =>
  el("label", { class: "guide-radio" }, el("input", { type: "radio", name, value: v, ...(v === value ? { checked: "" } : {}) }), el("span", {}, el("strong", {}, label), help ? el("small", { class: "muted" }, help) : null))));
const picked = (box, name) => box.querySelector(`input[name="${name}"]:checked`)?.value;

// 폴더 입력: 입력하면 프로젝트 안 폴더를 자동 완성한다(생성 폴더 제외).
function folderInput(ctx, value = "", placeholder = "예: server  (비우면 프로젝트 루트)") {
  const id = `guide-folders-${Math.random().toString(36).slice(2, 8)}`;
  const input = el("input", { class: "mono", value, placeholder, list: id, "aria-label": "폴더", autocomplete: "off" });
  const list = el("datalist", { id });
  let timer = null;
  const load = async () => {
    try {
      const out = await ctx.api("GET", `/api/guide/folders?${q(ctx.project(), { q: input.value })}`);
      fill(list, out.folders.map((f) => el("option", { value: f }, f || "(프로젝트 루트)")));
    } catch { /* 제안은 없어도 된다 */ }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  load();
  return { input, list };
}

export function openNewGuide(ctx, { dir = "", kind = "both" } = {}) {
  const folder = folderInput(ctx, dir);
  const kinds = radios("guide-kind", [["both", "둘 다 (추천)", "AGENTS.md와 @AGENTS.md 한 줄짜리 CLAUDE.md. Claude·Codex가 모두 읽습니다."], ["agents", "AGENTS.md만", "Codex만 읽습니다."], ["claude", "CLAUDE.md만", "Claude만 읽습니다."]], kind);
  const rootSections = ctx.file() === "AGENTS.md" ? ctx.sections().filter((s) => s.lines > 0) : [];
  const starts = radios("guide-start", [["blank", "빈 틀", "이 폴더에만 해당하는 규칙을 씁니다."], ...(rootSections.length ? [["move", "루트 지침에서 섹션 옮기기", "고른 섹션을 하위 지침으로 옮기고, 루트에는 참고 링크만 남깁니다(복사하지 않습니다)."]] : [])], "blank");
  const sectionList = el("div", { class: "guide-move-sections", hidden: "" }, ...rootSections.map((s) => el("label", { class: "check" }, el("input", { type: "checkbox", value: String(s.line) }), ` ${s.title} `, el("span", { class: "muted" }, `${s.lines}줄`))));
  starts.addEventListener("change", () => { sectionList.hidden = picked(starts, "guide-start") !== "move"; });
  dialog("새 지침", [
    el("label", { class: "guide-field" }, el("span", { class: "muted" }, "위치(폴더)"), folder.input, folder.list),
    el("p", { class: "muted guide-small" }, "하위 폴더 지침은 그 폴더를 다룰 때 읽힙니다. 꼭 지킬 규칙은 루트 지침에 두세요."),
    el("p", { class: "muted guide-small" }, "종류"), kinds,
    el("p", { class: "muted guide-small" }, "시작 내용"), starts, sectionList,
  ], ({ close, error }) => [busyButton("만들기", async () => {
    const start = picked(starts, "guide-start");
    const sections = [...sectionList.querySelectorAll("input:checked")].map((b) => Number(b.value));
    if (start === "move" && !sections.length) { error.textContent = "옮길 섹션을 고르세요."; return; }
    try {
      const result = await ctx.api("POST", `/api/guide/files?${q(ctx.project())}`, { dir: folder.input.value, kind: picked(kinds, "guide-kind"), start, sections, parentText: ctx.text() });
      close();
      // 루트에서 섹션을 옮겼으면 루트 편집기에 남은 글을 넣는다(저장은 사용자가).
      if (result.remaining != null) ctx.setText(result.remaining);
      ctx.toast(`${result.created.join(", ")}를 만들었습니다${result.remaining != null ? " · 루트 지침의 옮긴 섹션을 저장하세요" : ""}`);
      if (result.remaining == null) await ctx.openFile(result.open); else await ctx.reload();
    } catch (e) {
      if (e.reason === "guide-exists" && confirm(`${e.message}\n그 파일을 열까요?`)) { close(); await ctx.openFile(e.message.split(": ")[1].split(", ")[0]); return; }
      error.textContent = e.message;
    }
  })]);
}

export function openAddDoc(ctx, { docDir = "docs" } = {}) {
  const title = el("input", { placeholder: "예: 배포 절차", "aria-label": "문서 제목" });
  const folder = folderInput(ctx, docDir, "문서 폴더");
  const condition = el("input", { placeholder: "예: 배포하기 전에 · .cs 파일을 고치기 전에", "aria-label": "언제 읽나" });
  const modes = radios("guide-doc-mode", [["link", "링크로 걸기 (추천)", "AI가 조건에 맞을 때 엽니다. 문맥을 늘 차지하지 않습니다."], ["import", "CLAUDE.md에서 가져오기", "Claude 세션이 항상 읽습니다. 짧은 문서에만 쓰세요. Codex는 읽지 않습니다."]], "link");
  dialog("문서 추가", [
    el("label", { class: "guide-field" }, el("span", { class: "muted" }, "제목"), title),
    el("label", { class: "guide-field" }, el("span", { class: "muted" }, "위치(폴더)"), folder.input, folder.list),
    el("label", { class: "guide-field" }, el("span", { class: "muted" }, "언제 읽나 (필수)"), condition),
    el("p", { class: "muted guide-small" }, "\"Unity 관련\"보다 \"`.cs` 파일을 고치기 전에\"처럼 행동으로 쓰면 AI가 제때 엽니다. 연결 문서에는 참고용 세부만 두고, 꼭 지킬 규칙은 루트 지침에 두세요."),
    modes,
  ], ({ close, error }) => [busyButton("만들기", async () => {
    if (!title.value.trim()) { error.textContent = "제목을 적어 주세요."; title.focus(); return; }
    if (!condition.value.trim()) { error.textContent = "언제 읽을지 적어 주세요."; condition.focus(); return; }
    try {
      const result = await ctx.api("POST", `/api/guide/docs?${q(ctx.project(), { file: ctx.file() })}`, { title: title.value, dir: folder.input.value, condition: condition.value, mode: picked(modes, "guide-doc-mode"), text: ctx.text() });
      close();
      if (result.imported) { ctx.toast(`${result.doc}를 만들고 ${result.imported}에서 가져오게 했습니다`); await ctx.reload(); return; }
      ctx.setText(result.text);
      ctx.toast(`${result.doc}를 만들고 필독 문서에 링크를 넣었습니다 · 지침을 저장하세요`);
    } catch (e) { error.textContent = e.message; }
  })]);
  title.focus();
}

export async function openDelete(ctx, file) {
  let info;
  try { info = await ctx.api("GET", `/api/guide/impact?${q(ctx.project(), { file })}`); } catch (e) { ctx.toast(e.message, true); return; }
  if (!info.exists) { ctx.toast("파일이 없습니다.", true); return; }
  const dropRefs = el("input", { type: "checkbox", checked: "" });
  const effects = [
    info.readers ? `읽는 도구: ${info.readers}. 지우면 더 읽지 않습니다.` : null,
    info.assurance === "항상" || info.assurance === "항상(Claude)" ? "세션마다 읽히던 파일입니다." : null,
    info.running ? `실행 중인 세션 ${info.running}개는 다음 새 대화부터 반영됩니다.` : null,
  ].filter(Boolean);
  dialog(`${info.file} 삭제`, [
    el("p", { class: "mono muted" }, `${info.file} · ${info.lines}줄 · 마지막 저장 ${new Date(info.savedAt).toLocaleString()}`),
    el("p", { class: "guide-small" }, "이 파일을 가리키는 곳"),
    info.refs.length ? el("ul", { class: "guide-ref-list" }, ...info.refs.map((r) => el("li", { class: "mono" }, `${r.from}${r.kind === "import" ? " · @가져오기" : r.label ? ` · ${r.label}` : ""}`))) : el("p", { class: "muted guide-small" }, "없음"),
    ...effects.map((t) => el("p", { class: "guide-small" }, `· ${t}`)),
    el("p", { class: info.tracked ? "guide-small ok-text" : "guide-small warn-text" }, info.tracked ? "git에 올라간 파일이라 git에서도 되살릴 수 있습니다." : info.tracked === false ? "git에 올리지 않은 파일입니다. 앱 백업(최근 20개)에서만 되살릴 수 있습니다." : "git 저장소가 아닙니다. 앱 백업(최근 20개)에서만 되살릴 수 있습니다."),
    info.refs.length ? el("label", { class: "check" }, dropRefs, " 이 파일을 가리키는 링크·@ 줄도 지우기") : null,
  ], ({ close, error }) => [busyButton("삭제", async () => {
    try {
      const result = await ctx.api("DELETE", `/api/guide?${q(ctx.project(), { file: info.file, baseHash: info.hash, ...(info.refs.length && dropRefs.checked ? { dropRefs: "1" } : {}) })}`);
      close();
      await ctx.afterDelete(result);
      ctx.toast(`${info.file}를 지웠습니다${result.cleaned.length ? ` · 링크 ${result.cleaned.reduce((n, c) => n + c.removed, 0)}줄 정리` : ""}`, false, { label: "되돌리기", run: () => restore(ctx, result.backup) });
    } catch (e) { error.textContent = e.reason === "guide-changed" ? `${e.message}` : e.message; }
  }, "danger")], { className: "danger" });
}

export async function restore(ctx, id) {
  try {
    const result = await ctx.api("POST", `/api/guide/restore?${q(ctx.project())}`, { id });
    ctx.toast(`${result.restored}를 되살렸습니다`);
    await ctx.openFile(result.restored);
  } catch (e) { ctx.toast(e.message, true); }
}

export async function openTrash(ctx) {
  let items = [];
  try { items = (await ctx.api("GET", `/api/guide/trash?${q(ctx.project())}`)).items; } catch (e) { ctx.toast(e.message, true); return; }
  const d = dialog("지운 지침 되살리기", [
    items.length ? el("ul", { class: "guide-trash-list" }, ...items.map((item) => el("li", {},
      el("span", { class: "mono" }, item.file), el("span", { class: "muted" }, ` · ${new Date(item.deletedAt).toLocaleString()}${item.tracked ? " · git에 있음" : ""}`), el("span", { class: "spacer" }),
      el("button", { type: "button", class: "ghost sm", onclick: async () => { d.close(); await restore(ctx, item.id); } }, "되살리기")))) : el("p", { class: "muted" }, "지운 지침이 없습니다."),
    el("p", { class: "muted guide-small" }, "앱 데이터 폴더에 프로젝트마다 최근 20개를 남깁니다."),
  ], () => []);
}

// 갈래 경고: 다른 파일(하위 지침·연결 문서)의 경고. 누르면 그 파일을 연다.
export async function openBranchWarnings(ctx) {
  let files = [];
  try { files = (await ctx.api("GET", `/api/guide/check-all?${q(ctx.project())}`)).files; } catch (e) { ctx.toast(e.message, true); return; }
  const d = dialog("갈래 경고", [
    el("p", { class: "muted guide-small" }, "루트 = 꼭 지킬 것, 갈래 = 필요할 때 볼 것. 하위 지침과 연결 문서를 한꺼번에 검사합니다."),
    files.length ? el("div", { class: "guide-branch-list" }, ...files.map((f) => el("section", {},
      el("header", {}, el("strong", { class: "mono" }, f.file), el("span", { class: "spacer" }), el("button", { type: "button", class: "ghost sm", onclick: async () => { d.close(); await ctx.openFile(f.file); } }, "열기")),
      ...f.warnings.map((w) => el("article", { class: `guide-warning ${w.level}` }, el("strong", {}, w.title), w.quote ? el("div", { class: "guide-quote" }, w.quote) : null, el("p", { class: "muted" }, w.detail),
        w.pair ? el("button", { type: "button", class: "ghost sm", onclick: async () => { d.close(); await createPair(ctx, w.pair); } }, "짝 만들기") : null))))) : el("p", { class: "ok-text" }, "✓ 갈래 경고가 없습니다."),
  ], () => [], { className: "wide" });
}

// 짝 없는 하위 지침의 짝(CLAUDE.md면 @AGENTS.md 한 줄, AGENTS.md면 빈 틀)
export async function createPair(ctx, pairFile) {
  const dir = pairFile.split("/").slice(0, -1).join("/");
  const kind = pairFile.endsWith("CLAUDE.md") ? "claude" : "agents";
  try {
    const result = await ctx.api("POST", `/api/guide/files?${q(ctx.project())}`, { dir, kind, start: "blank" });
    if (kind === "claude") await ctx.api("PUT", `/api/guide?${q(ctx.project(), { file: pairFile })}`, { text: "@AGENTS.md\n", baseHash: result.hash, force: true });
    ctx.toast(`${pairFile}를 만들었습니다`);
    await ctx.openFile(pairFile);
  } catch (e) { ctx.toast(e.message, true); }
}

export async function createMissing(ctx, docPath) {
  try {
    const result = await ctx.api("POST", `/api/guide/docs?${q(ctx.project(), { file: ctx.file() })}`, { docPath });
    ctx.toast(result.created ? `${result.doc}를 만들었습니다` : `${result.doc}가 이미 있습니다`);
    await ctx.recheck();
  } catch (e) { ctx.toast(e.message, true); }
}

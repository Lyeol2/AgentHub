import { $, el } from "../../shared/dom.js";
import { permissionLabel } from "../../shared/permissions.js";

// 세션 화면의 상태 칩 줄(#s-meta) · 오른쪽 정보 패널(#s-info) · ⋯ 메뉴(#s-menu) · 세션 지침 창
// 세션 지침(.agenthub/sessions/*.md)은 예전 "역할"을 대신한다. 지침이 없으면 역할을 그대로 쓴다(호환 모드).
const INFO_KEY = "agenthub.sessionInfo";
const fill = (box, ...items) => box.replaceChildren(...items.flat().filter((item) => item !== null && item !== undefined && item !== false));
const time = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const keywordList = (k) => String(k ?? "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);

// 판정어와 나가는 키워드 연결이 어긋나는 것: { missing: 지침에 없는 연결 키워드, unlinked: 연결이 없는 판정어 }
export function guideMismatch(s, links = []) {
  if (!s?.guideFile || !Array.isArray(s.guideVerdicts)) return { missing: [], unlinked: [] };
  const keywords = [...new Set(links.filter((l) => l.from === s.id && l.enabled !== false && l.when === "keyword").flatMap((l) => keywordList(l.keyword)))];
  const near = (a, b) => a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());
  return {
    missing: keywords.filter((k) => !s.guideVerdicts.some((v) => near(v, k))),
    unlinked: keywords.length ? s.guideVerdicts.filter((v) => !keywords.some((k) => near(v, k))) : [],
  };
}

export const GUIDE_STATE = {
  sent: "새 대화 첫 요청에 전달됨", "resent-change": "지침이 바뀌어 다시 전달됨", "resent-compact": "대화 요약 뒤 다시 전달됨",
  pending: "다음 요청에 전달", missing: "지침 파일이 없습니다",
};

export function createSessionPanel({ api, data, openEquipDialog, openSessionGuide, onRestart, POPUP = false }) {
  // ── ⋯ 메뉴 ─────────────────────────────────────────────────
  const menu = $("s-menu"), more = $("s-more");
  const closeMenu = () => { menu.hidden = true; more.setAttribute("aria-expanded", "false"); };
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    more.setAttribute("aria-expanded", String(!menu.hidden));
  });
  // 메뉴 단추의 동작(내보내기 메뉴 위치 계산 등)이 먼저 돌도록 한 박자 뒤에 닫는다. 체크 칸은 열어 둔다.
  menu.addEventListener("click", (e) => { if (e.target.closest("button")) setTimeout(closeMenu, 0); });
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== more) closeMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { closeMenu(); more.focus(); } });

  // ── 정보 패널 접기(기억). 처음에는 넓은 화면에서만 펼친다. ──────
  const info = $("s-info"), toggle = $("s-info-toggle");
  const stored = () => { try { return localStorage.getItem(INFO_KEY); } catch { return null; } };
  const applyInfo = () => {
    const value = stored();
    const open = value ? value === "open" : window.innerWidth >= 1280;
    info.hidden = !open;
    toggle.setAttribute("aria-pressed", String(open));
    toggle.classList.toggle("active", open);
  };
  toggle.addEventListener("click", () => {
    try { localStorage.setItem(INFO_KEY, info.hidden ? "open" : "closed"); } catch { /* 기억하지 못해도 바꾼다 */ }
    applyInfo();
  });
  applyInfo();

  // ── 상태 칩 줄 ─────────────────────────────────────────────
  function chip(label, value, { title = "", onclick = null, cls = "" } = {}) {
    return el(onclick ? "button" : "span", { class: `session-chip ${cls}`, ...(onclick ? { type: "button", onclick } : {}), ...(title ? { title } : {}) },
      el("span", { class: "session-chip-label" }, label), value);
  }
  function renderChips(s) {
    const box = $("s-meta");
    box.title = s.agentSessionId ? `CLI 세션 ${s.agentSessionId}` : "";
    const folder = s.chat ? "도구 없이 대화만" : s.worktree ? `워크트리 · ${s.worktree.branch}` : `원본 폴더${s.branch ? ` · ${s.branch}` : ""}`;
    const copy = async () => { try { await navigator.clipboard.writeText(s.cwd); } catch { /* 복사하지 못해도 경로는 풍선 글에 있다 */ } };
    const mismatch = guideMismatch(s, data.links);
    fill(box,
      chip("📁", folder, { title: `${s.cwd}\n누르면 경로를 복사합니다`, onclick: s.chat ? null : copy }),
      s.chat ? null : chip("🔒", permissionLabel(s.permission), { title: `권한 ${s.permission} · 누르면 세션 설정`, onclick: () => $("s-config").click() }),
      chip("⚙", `${s.model || "기본 모델"} · ${s.effort || "기본 추론"}`, { title: "누르면 세션 설정", onclick: () => $("s-config").click() }),
      s.chat ? null : guideChip(s, mismatch));
  }
  function guideChip(s, mismatch) {
    if (!s.guideFile) return chip("🧭", s.role ? "역할 (옮기기 전)" : "지침 없음", { cls: s.role ? "warn" : "muted", title: s.role ? "예전 역할을 쓰고 있습니다. 누르면 세션 지침으로 옮깁니다." : "누르면 세션 지침을 만듭니다", onclick: () => openGuide(s) });
    const bad = s.guideMissing || mismatch.missing.length;
    const state = s.guideMissing ? "파일 없음" : mismatch.missing.length ? `판정·연결 어긋남 ${mismatch.missing.length}` : s.guideState === "pending" || !s.guideSentAt ? "다음 요청에 전달" : "전달됨";
    return chip("🧭", `${s.guideName || s.guideFile.split("/").pop()} · ${bad ? "⚠ " : s.guideSentAt ? "✓ " : "⟳ "}${state}`, { cls: bad ? "warn" : "", title: `${s.guideFile}\n누르면 지침을 엽니다`, onclick: () => openGuide(s) });
  }

  // ── 정보 패널 ──────────────────────────────────────────────
  function renderInfo(s) {
    const guideBox = $("s-info-guide"), skillsBox = $("s-info-skills"), lifeBox = $("s-info-life");
    if (s.chat) { fill(guideBox); fill(skillsBox); fill(lifeBox, el("h4", {}, "수명"), lifeLine(s)); return; }
    const mismatch = guideMismatch(s, data.links);
    fill(guideBox, el("h4", {}, "세션 지침"),
      s.guideFile ? [
        el("p", { class: "session-info-title" }, el("strong", {}, s.guideName || s.guideFile.split("/").pop()), s.guideMissing ? el("span", { class: "warn-text" }, " · 파일 없음") : null),
        s.guideSummary ? el("p", { class: "muted" }, s.guideSummary) : null,
        s.guideVerdicts?.length ? el("p", { class: "session-verdicts" }, el("span", { class: "muted" }, "판정 "), ...s.guideVerdicts.map((v) => el("span", { class: `session-verdict${mismatch.unlinked.includes(v) ? " unlinked" : ""}`, title: mismatch.unlinked.includes(v) ? "이 판정으로 가는 연결이 없습니다" : "" }, v))) : el("p", { class: "muted" }, "판정어가 없습니다."),
        mismatch.missing.length ? el("p", { class: "warn-text" }, `⚠ 연결 키워드 ${mismatch.missing.map((k) => `'${k}'`).join(", ")}가 지침에 없습니다`) : null,
        el("p", { class: "muted session-small" }, s.guideMissing ? GUIDE_STATE.missing : `${GUIDE_STATE[s.guideState] ?? "다음 요청에 전달"}${s.guideSentAt ? ` · ${time(s.guideSentAt)}` : ""}`),
        el("p", { class: "mono muted session-small", title: s.guideFile }, s.guideFile),
        el("div", { class: "session-info-actions" }, el("button", { type: "button", class: "ghost sm", onclick: () => openGuide(s) }, POPUP ? "바꾸기" : "열기")),
      ] : [
        el("p", { class: "muted" }, s.role ? "예전 역할을 쓰고 있습니다. 세션 지침으로 옮기면 지침 탭에서 AGENTS.md처럼 고치고 검사할 수 있습니다." : "이 세션에만 더할 지침이 없습니다."),
        s.role ? el("p", { class: "session-role-preview" }, s.role.split(/\r?\n/).slice(0, 3).join("\n")) : null,
        el("div", { class: "session-info-actions" }, el("button", { type: "button", class: "primary sm", onclick: () => openGuide(s) }, s.role ? "세션 지침으로 옮기기" : "세션 지침 만들기")),
      ]);
    const skills = s.skills ?? [];
    fill(skillsBox, el("h4", {}, "스킬"),
      skills.length ? el("div", { class: "session-skill-list" }, ...skills.map((name) => el("span", { class: "skill-chip" }, name))) : el("p", { class: "muted" }, "이은 스킬이 없습니다."),
      el("div", { class: "session-info-actions" }, el("button", { type: "button", class: "ghost sm", onclick: () => openEquipDialog?.(s) }, "스킬 장착…")));
    fill(lifeBox, el("h4", {}, "수명"), lifeLine(s));
  }
  function lifeLine(s) {
    const used = s.context?.used ?? s.context?.tokens, total = s.context?.total ?? s.context?.window;
    const pct = used && total ? Math.min(100, Math.round((used / total) * 100)) : null;
    return [
      el("p", { class: "muted" }, `대화 요약 ${s.compactions ?? 0}회${pct !== null ? ` · 컨텍스트 ${pct}%` : ""}`),
      pct !== null ? el("div", { class: "session-meter" }, el("div", { style: `width:${pct}%` })) : null,
      el("div", { class: "session-info-actions" }, el("button", { type: "button", class: "ghost sm", disabled: $("s-restart").disabled ? "" : null, onclick: () => onRestart?.() }, "다시 시작")),
    ].map((node) => { if (node?.getAttribute?.("disabled") === "null") node.removeAttribute("disabled"); return node; });
  }

  // ── 세션 지침 창 ──────────────────────────────────────────
  async function openGuide(s) {
    if (s.guideFile && !POPUP && openSessionGuide) { openSessionGuide(s.projectPath, s.guideFile); return; }
    let shared = [];
    try { shared = (await api("GET", `/api/guide?path=${encodeURIComponent(s.projectPath)}`)).sessionGuides ?? []; } catch { /* 같이 쓸 지침 목록 없이 연다 */ }
    const box = el("dialog", { class: "guide-branch-dialog", "aria-label": "세션 지침" });
    const close = () => { box.close(); box.remove(); };
    const error = el("p", { class: "error", role: "alert" });
    const options = [
      s.role ? ["role", "예전 역할을 세션 지침으로 옮기기 (추천)", "역할 글을 .agenthub/sessions/에 파일로 옮기고, 판정은 따로 섹션으로 나눕니다."] : null,
      ["blank", "빈 틀로 새로 만들기", "맡는 일 · 고쳐도 되는 범위 · 하지 않는 것 · 완료 기준 · 판정"],
      shared.length ? ["share", "다른 세션 지침 같이 쓰기", "여러 세션이 한 파일을 씁니다. 한쪽에서 고치면 모두 바뀝니다."] : null,
      s.guideFile ? ["unlink", "세션 지침 끊기", "파일은 지우지 않습니다."] : null,
    ].filter(Boolean);
    const radios = el("div", { class: "guide-radios" }, ...options.map(([value, label, help], i) => el("label", { class: "guide-radio" },
      el("input", { type: "radio", name: "s-guide-mode", value, ...(i === 0 ? { checked: "" } : {}) }), el("span", {}, el("strong", {}, label), el("small", { class: "muted" }, help)))));
    const select = el("select", { class: "mono", "aria-label": "같이 쓸 세션 지침", hidden: "" }, ...shared.filter((g) => g.file !== s.guideFile).map((g) => el("option", { value: g.file }, `${g.file} · ${g.users}개 세션`)));
    radios.addEventListener("change", () => { select.hidden = box.querySelector("input[name=s-guide-mode]:checked")?.value !== "share"; });
    box.append(el("h3", {}, `${s.title} · 세션 지침`),
      el("p", { class: "muted guide-small" }, "세션 지침은 이 세션에만 더하는 AGENTS.md입니다. 새 대화 첫 요청, 지침이 바뀐 뒤, 대화가 요약된 뒤에 요청에 붙습니다."),
      radios, select, error,
      el("footer", {}, el("button", { type: "button", class: "ghost", onclick: close }, "취소"),
        el("button", { type: "button", class: "primary", onclick: async () => {
          const mode = box.querySelector("input[name=s-guide-mode]:checked")?.value;
          try {
            if (mode === "share") await api("PUT", `/api/sessions/${s.id}`, { guideFile: select.value });
            else if (mode === "unlink") await api("PUT", `/api/sessions/${s.id}`, { guideFile: "" });
            else {
              const result = await api("POST", `/api/sessions/${s.id}/guide`, { from: mode });
              close();
              if (!POPUP && openSessionGuide) openSessionGuide(s.projectPath, result.file);
              return;
            }
            close();
          } catch (e) { error.textContent = e.message; }
        } }, "확인")));
    box.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    document.body.append(box);
    box.showModal();
  }

  function render(s) {
    if (!s) return;
    renderChips(s);
    renderInfo(s);
    // 예전 역할 단추는 세션 지침으로 옮기기 전에만 보인다.
    $("s-role").hidden = !!s.chat || !!s.guideFile || !s.role;
    $("s-guide").hidden = !!s.chat;
    $("s-guide").classList.toggle("warn", !!s.guideMissing || guideMismatch(s, data.links).missing.length > 0);
  }

  return { render, renderInfo, openGuide, closeMenu };
}

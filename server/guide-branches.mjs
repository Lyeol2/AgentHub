// 지침 갈래(하위 폴더 지침·연결 문서)의 순수 규칙: 위치 제안, 링크 줄 넣기, 섹션 옮기기, 참조 줄 정리, 갈래 검사.
// 원칙: 루트 = 꼭 지킬 것, 갈래 = 필요할 때 볼 것. 쓰기는 application/guide.mjs가 한다.
import fs from "node:fs";
import path from "node:path";
import { SKIP_DIRS, DOC_DIRS, guideLinks, parseSections, checkGuide, findNestedGuides } from "./guide.mjs";

export const GUIDE_NAMES = ["AGENTS.md", "CLAUDE.md"];
export const IMPORT_MAX = 2000;
const RULE = /(반드시|금지|절대|[가-힣]지\s*(않는다|않습니다|말 것|마라|마세요)|must\b|never\b|do not\b)/i;
const rel = (root, file) => path.relative(root, file).replaceAll("\\", "/");
const inside = (root, file) => { const r = path.relative(root, file); return !r.startsWith("..") && !path.isAbsolute(r); };

// 만들 위치 제안: 프로젝트 안 폴더(생성 폴더 제외). "" 은 프로젝트 루트
export function folderSuggestions(root, query = "", { depth = 4, limit = 50 } = {}) {
  const q = String(query ?? "").trim().replaceAll("\\", "/").toLowerCase();
  const out = [];
  const walk = (dir, level) => {
    if (level > depth || out.length >= limit * 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".ai")) continue;
      const full = path.join(dir, entry.name);
      out.push(rel(root, full));
      walk(full, level + 1);
    }
  };
  walk(root, 1);
  const hit = out.filter((d) => !q || d.toLowerCase().includes(q)).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return [...(!q || "(프로젝트 루트)".includes(q) ? [""] : []), ...hit].slice(0, limit);
}

// 프로젝트 안 폴더인지와 생성 폴더가 아닌지 확인한다. 상대 경로("" = 루트)를 돌려준다.
export function checkFolder(root, dir) {
  const value = String(dir ?? "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const full = path.resolve(root, value);
  if (!inside(root, full)) throw new Error("프로젝트 안의 폴더만 고를 수 있습니다.");
  const parts = rel(root, full).split("/").filter(Boolean);
  if (parts.some((p) => SKIP_DIRS.has(p) || (p.startsWith(".") && p !== ".ai"))) throw new Error("생성 폴더나 도구 설정 폴더에는 지침을 만들지 않습니다.");
  return { rel: parts.join("/"), full };
}

// 연결 문서를 둘 기본 폴더: 프로젝트에 있는 문서 폴더(docs → Docs → .ai), 없으면 docs
export function defaultDocDir(root) {
  for (const name of DOC_DIRS) if (fs.existsSync(path.join(root, name))) return name;
  return "docs";
}

export const docFileName = (title) => `${String(title ?? "").trim().replace(/[\\/:*?"<>|#%]+/g, " ").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "문서"}.md`;
export const blankDoc = (title, condition) => `# ${String(title).trim()}\n\n<!-- 언제 읽나: ${condition}. 참고용 세부만 쓴다. 꼭 지킬 규칙은 루트 지침에 둔다. -->\n\n`;
export function blankNested(dirRel) {
  return `# ${dirRel || "루트"} 폴더 지침\n\n<!-- 이 폴더에만 해당하는 규칙을 쓴다. 루트 지침을 반복하지 않는다. -->\n\n## 이 폴더의 구조\n\n## 이 폴더에서 지킬 것\n\n`;
}

// 필독 문서 섹션 끝에 링크 줄을 넣는다. 섹션이 없으면 끝에 만든다. 이미 같은 대상 링크가 있으면 그대로 둔다.
export function insertDocLink(text, line, target) {
  const value = String(text ?? "");
  if (target && guideLinks(value).some((l) => !l.import && path.posix.normalize(l.target) === path.posix.normalize(target))) return value;
  const lines = value.split(/\r?\n/);
  const section = parseSections(value).find((s) => s.key === "docs");
  if (!section) return `${value.replace(/\s+$/, "")}${value.trim() ? "\n\n" : ""}## 필독 문서\n${line}\n`;
  let at = section.end; // 섹션 마지막 글 줄 다음
  lines.splice(at, 0, line);
  return lines.join("\n");
}

// 고른 섹션(제목 줄 번호)을 떼어 낸다. 남은 글에는 그 자리마다 "→ <rel> 참고" 한 줄을 남긴다.
export function moveSections(text, sectionLines, targetRel) {
  const value = String(text ?? "");
  const lines = value.split(/\r?\n/);
  const sections = parseSections(value).filter((s) => sectionLines.map(Number).includes(s.line)).sort((a, b) => b.line - a.line);
  const moved = [];
  for (const section of sections) {
    moved.unshift(lines.slice(section.line - 1, section.end).join("\n"));
    lines.splice(section.line - 1, section.end - section.line + 1, `## ${section.title}`, `- → [${targetRel}](${targetRel}) 참고`);
  }
  return { moved: moved.join("\n\n"), remaining: lines.join("\n") };
}

// 지운 파일을 가리키는 링크 줄과 @가져오기 줄을 걷어 낸다. 고친 글과 지운 줄 수
export function dropReferences(text, sourceDir, targetFull) {
  const value = String(text ?? "");
  const hits = new Set(guideLinks(value).filter((l) => path.resolve(sourceDir, l.target).toLowerCase() === targetFull.toLowerCase()).map((l) => l.line));
  if (!hits.size) return { text: value, removed: 0 };
  return { text: value.split(/\r?\n/).filter((_, i) => !hits.has(i + 1)).join("\n"), removed: hits.size };
}

// 지침 원본 파일들(루트·하위 AGENTS.md·CLAUDE.md)
export function guideSources(root) {
  return [...GUIDE_NAMES.map((n) => path.join(root, n)).filter((f) => fs.existsSync(f)), ...findNestedGuides(root)];
}

// 갈래 검사: 파일마다 경고. 편집 중인 파일의 일반 검사(연결 충돌 등)는 편집기가 따로 한다.
// kinds: rule-in-doc · no-condition · link-depth · conflict(갈래) · unpaired · big-import
export function branchChecks(root) {
  const out = new Map();
  const push = (full, warning) => { const key = rel(root, full); if (!out.has(key)) out.set(key, []); out.get(key).push(warning); };
  const sources = guideSources(root);
  const docs = new Map(); // 연결 문서 → 어떻게 이어졌나
  for (const source of sources) {
    const text = fs.readFileSync(source, "utf8");
    for (const link of guideLinks(text)) {
      const target = path.resolve(path.dirname(source), link.target);
      if (!/\.md$/i.test(target) || !inside(root, target) || GUIDE_NAMES.includes(path.basename(target))) continue;
      const how = docs.get(target) ?? { import: false, conditional: false, plain: false };
      if (link.import) how.import = true; else if (link.condition) how.conditional = true; else how.plain = true;
      docs.set(target, how);
      if (!link.import && !link.condition) push(source, { id: `no-condition:${link.line}`, kind: "no-condition", level: "error", title: "언제 읽을지 적지 않은 링크", detail: `${link.target} 앞에 "\`.cs\` 파일을 고치기 전에"처럼 행동으로 조건을 쓰면 AI가 제때 엽니다.`, line: link.line, quote: link.text });
      if (link.import && fs.existsSync(target) && fs.statSync(target).size > IMPORT_MAX) push(source, { id: `big-import:${link.line}`, kind: "big-import", level: "info", title: "큰 문서를 늘 가져옵니다", detail: `${link.target}(${(fs.statSync(target).size / 1024).toFixed(1)}KB)를 Claude 세션마다 읽어 문맥을 차지합니다. 링크로 걸기를 권합니다.`, line: link.line, quote: link.text });
    }
    // 하위 지침의 연결 충돌(루트는 편집기가 검사한다)
    if (path.dirname(source).toLowerCase() !== root.toLowerCase()) {
      for (const w of checkGuide(text, {})) if (["approval", "commit-every"].includes(w.kind)) push(source, { ...w, id: `branch-${w.id}`, detail: `하위 지침에 있어도 그 폴더를 다루는 연결 세션이 멈추거나 매 턴 커밋·보고서를 만듭니다. ${w.detail}` });
    }
  }
  for (const [doc, how] of docs) {
    if (!fs.existsSync(doc)) continue;
    const text = fs.readFileSync(doc, "utf8");
    // 링크로만 이어진 문서(가져오기 아님)에 꼭 지킬 규칙이 있으면 루트로 올리라고 한다.
    if (!how.import) {
      let fence = false;
      text.split(/\r?\n/).forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        if (fence || /^\s*#/.test(line) || /^\s*<!--/.test(line) || !RULE.test(line)) return;
        push(doc, { id: `rule-in-doc:${index + 1}`, kind: "rule-in-doc", level: "error", title: "꼭 지킬 규칙이 링크 문서에만 있습니다", detail: "AI가 이 문서를 열지 않으면 어깁니다. 루트 지침으로 올리세요.", line: index + 1, quote: line.trim().slice(0, 160) });
      });
    }
    const deeper = guideLinks(text).filter((l) => !l.import && /\.md$/i.test(l.target));
    if (deeper.length) push(doc, { id: "link-depth", kind: "link-depth", level: "info", title: "링크가 두 단계로 이어집니다", detail: `이 문서가 다시 ${deeper.map((l) => l.target).slice(0, 3).join(", ")}로 이어집니다. 두 번째 문서는 거의 읽히지 않으니 한 단계로 줄이세요.`, line: deeper[0].line, quote: deeper[0].text });
    for (const w of checkGuide(text, {})) if (["approval", "commit-every"].includes(w.kind)) push(doc, { ...w, id: `doc-${w.id}` });
  }
  // 짝 없는 하위 지침: 한 도구만 읽는다.
  const dirs = new Map();
  for (const file of findNestedGuides(root)) { const d = path.dirname(file); if (!dirs.has(d)) dirs.set(d, new Set()); dirs.get(d).add(path.basename(file)); }
  for (const [dir, names] of dirs) {
    if (names.size === 2) continue;
    const only = [...names][0];
    push(path.join(dir, only), { id: "unpaired", kind: "unpaired", level: "info", title: only === "AGENTS.md" ? "Codex만 읽는 하위 지침" : "Claude만 읽는 하위 지침", detail: only === "AGENTS.md" ? "같은 폴더에 @AGENTS.md 한 줄짜리 CLAUDE.md를 두면 Claude도 읽습니다." : "같은 폴더에 AGENTS.md를 두면 Codex도 읽습니다.", line: 0, quote: "", pair: rel(root, path.join(dir, only === "AGENTS.md" ? "CLAUDE.md" : "AGENTS.md")) });
  }
  return [...out].map(([file, warnings]) => ({ file, warnings }));
}

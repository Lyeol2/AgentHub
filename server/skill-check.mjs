// 스킬 검사: 앞머리, 발동 충돌(다른 스킬과 description 겹침), 깨진 링크, 다른 프로젝트 경로, AgentHub 연결 충돌, 긴 본문.
// 줄 번호는 본문 기준(앞머리 제외)이다. 지침 탭 검사(guide.mjs)와 같은 경고 형식을 쓴다.
import fs from "node:fs";
import path from "node:path";
import { SKILL_NAME, DESCRIPTION_MAX, suggestName } from "./skills.mjs";
import { checkGuide, guideLinks } from "./guide.mjs";

const LONG_BYTES = 40_000;
const LONG_LINES = 500;
const OVERLAP = 0.3;
const STOP = new Set(["the", "and", "for", "when", "use", "with", "this", "that", "from", "into", "you", "are", "not", "can", "또는", "그리고", "때", "쓴다", "한다", "있는", "하는", "같은", "이런", "요청에", "요청", "작업", "때만", "쓰지", "않는다", "사용자가", "사용자", "경우"]);

// description의 핵심 낱말(한글 2자 이상·영문 3자 이상, 조사·흔한 말 빼기)
export function triggerWords(text) {
  const words = String(text ?? "").toLowerCase().replace(/['"`'“”‘’]/g, " ").match(/[a-z][a-z0-9-]{2,}|[가-힣]{2,}/g) ?? [];
  return new Set(words.map((w) => w.replace(/(을|를|이|가|은|는|에|의|로|으로|과|와|도|만|에서|하고|할|한)$/u, "")).filter((w) => w.length >= 2 && !STOP.has(w)));
}
export function overlap(a, b) {
  const x = triggerWords(a), y = triggerWords(b);
  if (!x.size || !y.size) return 0;
  let same = 0;
  for (const w of x) if (y.has(w)) same++;
  return same / Math.min(x.size, y.size);
}

const ABS_PATH = /(?:^|[\s(`'"<])([A-Za-z]:[\\/][^\s)`'"<>|*?]+)/g;
const within = (root, file) => { const rel = path.relative(root, file); return !rel.startsWith("..") && !path.isAbsolute(rel); };

// skill: { name, folder?, description, body, multiline?, file? } / others: 다른 스킬 [{ name, description }] / roots: 다른 프로젝트 경로
export function checkSkillText(skill, { projectPath, others = [], roots = [] } = {}) {
  const warnings = [];
  const body = String(skill.body ?? "");
  const lines = body.split(/\r?\n/);
  const name = String(skill.name ?? "").trim();
  const description = String(skill.description ?? "");
  // 앞머리
  if (!SKILL_NAME.test(name)) warnings.push({ id: "fm:name", kind: "frontmatter", level: "conflict", title: "이름이 규칙에 맞지 않습니다", detail: `소문자·숫자·하이픈만 64자까지 씁니다. 예: ${suggestName(name)}`, line: 0, quote: name, field: "name" });
  if (skill.folder && name !== skill.folder) warnings.push({ id: "fm:folder", kind: "frontmatter", level: "error", title: "폴더 이름과 name이 다릅니다", detail: `폴더는 ${skill.folder}입니다. 저장하면 name을 폴더 이름으로 씁니다.`, line: 0, quote: name, field: "name" });
  if (!description.trim()) warnings.push({ id: "fm:empty", kind: "frontmatter", level: "conflict", title: "description이 비어 있습니다", detail: "언제 쓰는 스킬인지 적지 않으면 Claude·Codex가 이 스킬을 고르지 못합니다.", line: 0, quote: "", field: "description" });
  else if (description.length > DESCRIPTION_MAX) warnings.push({ id: "fm:long", kind: "frontmatter", level: "conflict", title: `description이 ${description.length}자입니다`, detail: `${DESCRIPTION_MAX}자 이하로 줄이세요.`, line: 0, quote: description.slice(0, 80), field: "description" });
  if (skill.multiline || /\n/.test(description)) warnings.push({ id: "fm:multiline", kind: "frontmatter", level: "info", title: "description이 여러 줄입니다", detail: "도구에 따라 첫 줄만 읽습니다. 저장하면 한 줄로 합칩니다.", line: 0, quote: description.split("\n")[0].slice(0, 80), field: "description" });
  // 발동 충돌
  for (const other of others) {
    if (!other?.description || other.name === name) continue;
    const score = overlap(description, other.description);
    if (score >= OVERLAP) warnings.push({ id: `trigger:${other.name}`, kind: "trigger", level: "error", title: `${other.name}와 발동 조건이 겹칩니다`, detail: `겹침 ${Math.round(score * 100)}% · 같은 요청에 두 스킬이 함께 발동할 수 있습니다. 범위 밖 일을 description에 적어 나누세요.`,
      line: 0, quote: description.slice(0, 120), other: { name: other.name, description: other.description.slice(0, 160) }, score: Math.round(score * 100), field: "description" });
  }
  // 깨진 링크(스킬 폴더 기준)
  const dir = skill.file ? path.dirname(skill.file) : null;
  if (dir) {
    for (const link of guideLinks(body)) {
      if (link.import || fs.existsSync(path.resolve(dir, link.target))) continue;
      warnings.push({ id: `broken:${link.line}:${link.target}`, kind: "broken-link", level: "error", title: "없는 파일을 가리킵니다", detail: `${link.target} 파일이 없습니다.`, line: link.line, quote: link.text,
        fix: { line: link.line, from: lines[link.line - 1], to: null } });
    }
  }
  // 다른 프로젝트에만 있는 절대 경로
  if (projectPath) {
    lines.forEach((line, index) => {
      for (const match of line.matchAll(ABS_PATH)) {
        const target = path.resolve(match[1].replace(/[.,;:]+$/, ""));
        if (within(projectPath, target) || (dir && within(dir, target))) continue;
        const other = roots.find((root) => within(root, target));
        if (!other && fs.existsSync(target)) continue;
        warnings.push({ id: `path:${index + 1}:${target}`, kind: "foreign-path", level: "error", title: other ? "다른 프로젝트에만 있는 경로" : "이 컴퓨터에 없는 경로", detail: other ? `${path.basename(other)} 프로젝트의 파일입니다. 이 프로젝트에서는 열 수 없습니다.` : "이 경로가 없습니다. 상대 경로로 쓰세요.", line: index + 1, quote: match[1] });
      }
    });
  }
  // AgentHub 연결과 부딪히는 문장
  for (const warning of checkGuide(body, {})) if (["approval", "report-tail", "commit-every"].includes(warning.kind)) warnings.push(warning);
  // 긴 본문
  const bytes = Buffer.byteLength(body);
  if (bytes > LONG_BYTES || lines.length > LONG_LINES) warnings.push({ id: "long", kind: "long", level: "info", title: `본문이 ${(bytes / 1024).toFixed(1)}KB · ${lines.length}줄입니다`, detail: "자주 안 쓰는 절차는 references/의 파일로 옮기고 링크하면 매번 읽는 양이 줄어듭니다.", line: 0, quote: "" });
  return warnings;
}

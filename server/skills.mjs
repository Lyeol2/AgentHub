// 스킬: <폴더>/<이름>/SKILL.md (Claude Code·Codex 공통 형식). 다섯 범위로 둔다.
// - project:    <프로젝트>/.agenthub/skills — AgentHub 전용. 흐름 그래프에서 노드로 이은 세션만 쓴다(새 프로젝트 스킬의 기본).
// - claude:     <프로젝트>/.claude/skills — Claude Code가 그 프로젝트에서 저절로 쓰는 스킬.
// - codex:      <프로젝트>/.agents/skills — Codex가 그 프로젝트에서 저절로 쓰는 스킬.
// - personal:   ~/.claude/skills와 ~/.agents/skills 두 곳에 같은 내용으로 둔다(공용). Claude와 Codex가 모든 프로젝트에서 저절로 찾는다.
// - codex-home: ~/.codex/skills — Codex가 모든 프로젝트에서 저절로 찾는다.
// 세션에는 이름으로 잇고, 이은 세션에 "이 작업을 할 때 이 스킬을 따르라"는 안내를 붙인다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SCOPES = ["project", "claude", "codex", "personal", "codex-home"];
// 누가 읽는지(화면 표시·필터): agenthub / claude / codex / shared
export const SCOPE_READER = { project: "agenthub", claude: "claude", codex: "codex", personal: "shared", "codex-home": "codex" };
export const DESCRIPTION_MAX = 1024;
const BODY_MAX = 200_000;

export const projectSkillsDir = (projectPath) => path.join(projectPath, ".agenthub", "skills");
export const claudeSkillsDir = (projectPath) => path.join(projectPath, ".claude", "skills");
export const codexSkillsDir = (projectPath) => path.join(projectPath, ".agents", "skills");
// 앞이 Claude, 뒤가 Codex가 찾는 곳. 고칠 때는 앞의 것을 원본으로 삼아 뒤로 복사한다.
export function personalSkillsDirs(home = os.homedir()) {
  const claude = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  return [path.join(claude, "skills"), path.join(home, ".agents", "skills")];
}
export function codexHomeSkillsDir(home) {
  if (home) return path.join(home, ".codex", "skills");
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "skills");
}

export function scopeDirs(scope, projectPath, home) {
  if (scope === "project") return [projectSkillsDir(projectPath)];
  if (scope === "claude") return [claudeSkillsDir(projectPath)];
  if (scope === "codex") return [codexSkillsDir(projectPath)];
  if (scope === "personal") return personalSkillsDirs(home);
  if (scope === "codex-home") return [codexHomeSkillsDir(home)];
  throw new Error("스킬 범위가 올바르지 않습니다.");
}

// 앞머리(--- name / description ---)와 본문을 나눈다. description은 YAML의 여러 줄 형식(>, |, 이어지는 줄)도 읽는다.
// frontmatter: 앞머리가 있는지, multiline: description을 여러 줄로 썼는지, lines: 앞머리 줄 수
export function parseSkill(text) {
  const match = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: String(text).trim(), frontmatter: false, multiline: false, lines: 0 };
  const meta = {};
  const rows = match[1].split(/\r?\n/);
  let multiline = false;
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const block = value.match(/^([>|])[+-]?\s*$/);
    // 다음 줄들이 들여 쓴 이어짐이면 모은다.
    const more = [];
    while (i + 1 < rows.length && /^\s+\S/.test(rows[i + 1]) && !/^[\w-]+:/.test(rows[i + 1])) more.push(rows[++i].trim());
    if (block) { value = block[1] === "|" ? more.join("\n") : more.join(" "); if (more.length) multiline = m[1] === "description" || multiline; }
    else if (more.length) { value = [value, ...more].join(" "); if (m[1] === "description") multiline = true; }
    meta[m[1]] = value.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  }
  return { name: meta.name ?? "", description: meta.description ?? "", body: match[2].trim(), frontmatter: true, multiline, lines: rows.length + 2 };
}

// 설명은 한 줄로 쓴다. 따옴표로 감싸 콜론 같은 문자도 YAML로 읽히게 한다.
export function formatSkill({ name, description, body }) {
  const desc = JSON.stringify(String(description ?? "").replace(/\s+/g, " ").trim());
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${String(body ?? "").trim()}\n`;
}

// 규칙에 맞지 않아 Claude·Codex가 건너뛸 스킬 폴더의 이유. [{ kind, text, line? }]
export function skipReasons(folder, parsed) {
  const reasons = [];
  if (!SKILL_NAME.test(folder)) reasons.push({ kind: "name", text: `이름 규칙: 소문자·숫자·하이픈만 씁니다 · ${folder} → ${suggestName(folder)}` });
  if (!parsed) reasons.push({ kind: "missing", text: "SKILL.md가 없습니다." });
  else if (!parsed.frontmatter) reasons.push({ kind: "frontmatter", text: "앞머리(--- name / description ---)가 없습니다.", line: 1 });
  else if (!parsed.description) reasons.push({ kind: "description", text: "description이 비어 있습니다.", line: 3 });
  return reasons;
}
export const suggestName = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "skill";

// 한 폴더를 읽는다. 규칙에 맞는 스킬과 건너뛴 폴더를 나눠 돌려준다.
function scanDir(dir, scope) {
  const skills = [], skipped = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { return { skills, skipped, error: error.code === "ENOENT" ? null : { dir, scope, code: error.code ?? "ERROR", message: error.message } }; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    let parsed = null;
    if (fs.existsSync(file)) {
      try { parsed = parseSkill(fs.readFileSync(file, "utf8")); } catch { parsed = null; }
    } else if (!SKILL_NAME.test(entry.name)) continue; // SKILL.md도 없고 이름도 다르면 스킬 폴더가 아니다.
    else continue;
    const reasons = skipReasons(entry.name, parsed);
    const base = { name: entry.name, description: parsed?.description ?? "", body: parsed?.body ?? "", file, scope, reader: SCOPE_READER[scope] };
    if (reasons.length) skipped.push({ ...base, skipped: true, reasons });
    else skills.push({ ...base, ...(parsed.multiline ? { multiline: true } : {}), ...(parsed.name && parsed.name !== entry.name ? { nameMismatch: parsed.name } : {}) });
  }
  return { skills, skipped, error: null };
}

// 개인 스킬이 두 곳에 다른 내용으로 있으면(각 CLI용 설치 도구가 따로 넣은 경우 등) 한쪽으로 덮어쓰지 않는다.
export function diverged(name, home) {
  const texts = personalSkillsDirs(home)
    .map((dir) => path.join(dir, name, "SKILL.md"))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  return texts.length > 1 && texts.some((t) => t !== texts[0]);
}

// 모든 범위를 읽는다. 이름이 겹치면 프로젝트 → Claude 프로젝트 → Codex 프로젝트 → 공용 → ~/.codex 순으로 앞의 것을 쓴다.
// { skills, skipped, errors, shadowed }
export function scanSkills(projectPath, { home } = {}) {
  const found = new Map();
  const skipped = [], errors = [], shadowed = [];
  const take = (scope, dir, extra = (s) => s) => {
    const result = scanDir(dir, scope);
    if (result.error) errors.push(result.error);
    for (const skill of result.skills) {
      if (found.has(skill.name)) { if (found.get(skill.name).file.toLowerCase() !== skill.file.toLowerCase()) shadowed.push(extra(skill)); continue; }
      found.set(skill.name, extra(skill));
    }
    skipped.push(...result.skipped);
  };
  if (projectPath) {
    take("project", projectSkillsDir(projectPath));
    take("claude", claudeSkillsDir(projectPath));
    take("codex", codexSkillsDir(projectPath));
  }
  const personal = personalSkillsDirs(home);
  for (const dir of personal) take("personal", dir, (s) => ({ ...s, locked: diverged(s.name, home) }));
  take("codex-home", codexHomeSkillsDir(home));
  // 공용 스킬의 두 번째 위치(~/.agents)는 같은 스킬이므로 가려진 목록에 넣지 않는다.
  const shown = shadowed.filter((s) => !(s.scope === "personal" && found.get(s.name)?.scope === "personal"));
  const sort = (a, b) => a.name.localeCompare(b.name);
  return { skills: [...found.values()].sort(sort), skipped: skipped.sort(sort), errors, shadowed: shown };
}

export function listSkills(projectPath, options = {}) {
  return scanSkills(projectPath, options).skills;
}

// 입력을 검사해 저장할 값만 돌려준다. 틀리면 오류를 던진다.
export function checkSkill({ name, description, body }) {
  name = String(name ?? "").trim();
  if (!SKILL_NAME.test(name)) throw new Error("스킬 이름은 영문 소문자·숫자·-로 64자까지 씁니다. 예: code-review");
  description = String(description ?? "").trim();
  if (!description) throw new Error("언제 쓰는 스킬인지 설명을 적으세요.");
  if (description.length > DESCRIPTION_MAX) throw new Error(`설명은 ${DESCRIPTION_MAX}자까지 씁니다.`);
  body = String(body ?? "");
  if (body.length > BODY_MAX) throw new Error("본문이 너무 깁니다.");
  return { name, description, body };
}

// 원본 폴더를 나머지 폴더로 통째로 복사한다(SKILL.md 옆의 참고 파일 포함).
function mirror(main, copies) {
  for (const copy of copies) {
    fs.rmSync(copy, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.cpSync(main, copy, { recursive: true });
  }
}

export function writeSkill(projectPath, skill, { create = false, scope = "project", home, force = false } = {}) {
  if (create && listSkills(projectPath, { home }).some((s) => s.name === skill.name)) {
    throw new Error(`스킬 "${skill.name}"이 이미 있습니다.`);
  }
  if (scope === "personal" && !force && diverged(skill.name, home)) {
    throw new Error(`개인 스킬 "${skill.name}"은 ~/.claude와 ~/.agents의 내용이 서로 달라 AgentHub에서 고치지 않습니다. 먼저 두 위치를 비교해 합치세요.`);
  }
  const [main, ...copies] = scopeDirs(scope, projectPath, home).map((dir) => path.join(dir, skill.name));
  // 원본 자리에 없고 복사본 자리에만 있으면(Codex 쪽에만 있던 개인 스킬) 참고 파일을 살리려고 먼저 가져온다.
  const existing = [main, ...copies].find((dir) => fs.existsSync(dir));
  if (existing && existing !== main) fs.cpSync(existing, main, { recursive: true });
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(main, "SKILL.md"), formatSkill(skill));
  mirror(main, copies);
  return { ...skill, scope, file: path.join(main, "SKILL.md") };
}

// 스킬 폴더를 통째로 지운다(SKILL.md 옆의 참고 파일 포함). 개인 스킬은 두 곳 모두 지운다.
export function deleteSkill(projectPath, name, { scope = "project", home } = {}) {
  if (!SKILL_NAME.test(name)) throw new Error("스킬 이름이 올바르지 않습니다.");
  for (const dir of scopeDirs(scope, projectPath, home)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

// 스킬을 다른 범위로 옮긴다(예: Claude 프로젝트 → AgentHub 전용, 프로젝트 → 공용).
export function moveSkill(projectPath, name, to, { home } = {}) {
  const skill = listSkills(projectPath, { home }).find((s) => s.name === name);
  if (!skill) throw new Error("스킬이 없습니다.");
  if (skill.scope === to) return skill;
  if (skill.locked) throw new Error(`개인 스킬 "${name}"은 두 곳의 내용이 서로 달라 옮기지 않습니다.`);
  const targets = scopeDirs(to, projectPath, home).map((dir) => path.join(dir, name));
  if (targets.some((dir) => fs.existsSync(dir))) throw new Error(`옮길 곳에 같은 이름의 스킬 "${name}"이 이미 있습니다.`);
  mirror(path.dirname(skill.file), targets);
  deleteSkill(projectPath, name, { scope: skill.scope, home });
  return { ...skill, scope: to, file: path.join(targets[0], "SKILL.md") };
}

// 이 세션의 CLI가 그 스킬을 저절로 읽는지(Claude: .claude·공용 / Codex: .agents·공용·~/.codex)
export function readsNatively(agent, scope) {
  if (agent === "claude") return scope === "claude" || scope === "personal";
  if (agent === "codex") return scope === "codex" || scope === "personal" || scope === "codex-home";
  return false;
}

// 세션에 이은 스킬 안내. 새 대화의 첫 요청과, 이은 스킬이 바뀐 직후(압축 뒤 포함) 요청에 붙인다.
// Claude는 .claude/skills(프로젝트·개인)를 Skill 도구로 불러올 수 있고, AgentHub 전용 스킬은 파일로 읽는다.
// Codex는 자체 스킬도 SKILL.md를 파일로 읽는 방식이라 경로만 준다.
// 스킬 목록(디스크 읽기)은 실제로 안내를 붙여야 할 때만 읽는다.
export function withSkills(session, input, skills = null) {
  const changed = session.skillsChanged;
  delete session.skillsChanged;
  if (session.agentSessionId && !changed) return input;
  const names = session.skills ?? [];
  if (names.length) skills ??= listSkills(session.projectPath);
  const attached = names.map((name) => skills.find((s) => s.name === name)).filter(Boolean);
  if (!attached.length) return changed ? `[이 세션에 이은 스킬이 모두 해제되었다]\n\n${input}` : input;
  const lines = attached.map((s) => {
    const native = session.agent === "claude" && (s.scope === "claude" || s.scope === "personal");
    return `- ${s.name}: ${s.description} (${native ? `Skill 도구로 불러 쓴다. 없으면 파일: ${s.file}` : `파일: ${s.file}`})`;
  });
  return `[이 세션에 이은 스킬]\n아래 작업을 할 때는 먼저 해당 스킬의 지침을 읽고 따른다. 관련 없는 작업에는 쓰지 않아도 된다.\n${lines.join("\n")}\n\n${input}`;
}

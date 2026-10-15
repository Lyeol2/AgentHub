// 스킬: <폴더>/<이름>/SKILL.md (Claude Code·Codex 공통 형식). 세 범위로 둔다.
// - project:  <프로젝트>/.agenthub/skills — AgentHub 전용. 흐름 그래프에서 노드로 이은 세션만 쓴다(새 프로젝트 스킬의 기본).
// - claude:   <프로젝트>/.claude/skills — Claude Code가 그 프로젝트에서 저절로 쓰는 스킬(예전에 AgentHub가 만들던 곳).
// - personal: ~/.claude/skills와 ~/.agents/skills 두 곳에 같은 내용으로 둔다. Claude와 Codex가 모든 프로젝트에서 저절로 찾는다.
// 세션에는 이름으로 잇고, 이은 세션에 "이 작업을 할 때 이 스킬을 따르라"는 안내를 붙인다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SCOPES = ["project", "claude", "personal"];
const DESCRIPTION_MAX = 1024;
const BODY_MAX = 100_000;

export const projectSkillsDir = (projectPath) => path.join(projectPath, ".agenthub", "skills");
export const claudeSkillsDir = (projectPath) => path.join(projectPath, ".claude", "skills");
// 앞이 Claude, 뒤가 Codex가 찾는 곳. 고칠 때는 앞의 것을 원본으로 삼아 뒤로 복사한다.
export function personalSkillsDirs(home = os.homedir()) {
  const claude = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  return [path.join(claude, "skills"), path.join(home, ".agents", "skills")];
}

function scopeDirs(scope, projectPath, home) {
  if (scope === "project") return [projectSkillsDir(projectPath)];
  if (scope === "claude") return [claudeSkillsDir(projectPath)];
  if (scope === "personal") return personalSkillsDirs(home);
  throw new Error("스킬 범위가 올바르지 않습니다.");
}

// 앞머리(--- name / description ---)와 본문을 나눈다.
export function parseSkill(text) {
  const match = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: text.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return { name: meta.name ?? "", description: meta.description ?? "", body: match[2].trim() };
}

// 설명은 한 줄로 쓴다. 따옴표로 감싸 콜론 같은 문자도 YAML로 읽히게 한다.
export function formatSkill({ name, description, body }) {
  const desc = JSON.stringify(String(description ?? "").replace(/\s+/g, " ").trim());
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${String(body ?? "").trim()}\n`;
}

function readDir(dir, scope) {
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseSkill(fs.readFileSync(file, "utf8"));
      skills.push({ name: entry.name, description: parsed.description, body: parsed.body, file, scope });
    } catch {
      // 읽을 수 없는 파일은 건너뛴다.
    }
  }
  return skills;
}

// 개인 스킬이 두 곳에 다른 내용으로 있으면(각 CLI용 설치 도구가 따로 넣은 경우 등) 한쪽으로 덮어쓰지 않는다.
function diverged(name, home) {
  const texts = personalSkillsDirs(home)
    .map((dir) => path.join(dir, name, "SKILL.md"))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  return texts.length > 1 && texts.some((t) => t !== texts[0]);
}

// 이름이 겹치면 프로젝트 → Claude 프로젝트 → 개인 순으로 앞의 것을 쓴다(세션에는 이름으로 잇는다).
export function listSkills(projectPath, { home } = {}) {
  const found = new Map();
  const add = (skill) => {
    if (!found.has(skill.name)) found.set(skill.name, skill);
  };
  if (projectPath) {
    readDir(projectSkillsDir(projectPath), "project").forEach(add);
    readDir(claudeSkillsDir(projectPath), "claude").forEach(add);
  }
  for (const dir of personalSkillsDirs(home)) {
    readDir(dir, "personal").forEach((s) => add({ ...s, locked: diverged(s.name, home) }));
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
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

export function writeSkill(projectPath, skill, { create = false, scope = "project", home } = {}) {
  if (create && listSkills(projectPath, { home }).some((s) => s.name === skill.name)) {
    throw new Error(`스킬 "${skill.name}"이 이미 있습니다.`);
  }
  if (scope === "personal" && diverged(skill.name, home)) {
    throw new Error(`개인 스킬 "${skill.name}"은 ~/.claude와 ~/.agents의 내용이 서로 달라 AgentHub에서 고치지 않습니다.`);
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

// 스킬을 다른 범위로 옮긴다(예: Claude 프로젝트 → AgentHub 전용, 프로젝트 → 개인).
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

// 세션에 이은 스킬 안내. 새 대화의 첫 요청과, 이은 스킬이 바뀐 직후(압축 뒤 포함) 요청에 붙인다.
// Claude는 .claude/skills(프로젝트·개인)를 Skill 도구로 불러올 수 있고, AgentHub 전용 스킬은 파일로 읽는다.
// Codex는 자체 스킬도 SKILL.md를 파일로 읽는 방식이라 경로만 준다.
export function withSkills(session, input, skills = listSkills(session.projectPath)) {
  const changed = session.skillsChanged;
  delete session.skillsChanged;
  if (session.agentSessionId && !changed) return input;
  const attached = (session.skills ?? []).map((name) => skills.find((s) => s.name === name)).filter(Boolean);
  if (!attached.length) return changed ? `[이 세션에 이은 스킬이 모두 해제되었다]\n\n${input}` : input;
  const lines = attached.map((s) => {
    const native = session.agent === "claude" && (s.scope === "claude" || s.scope === "personal");
    return `- ${s.name}: ${s.description} (${native ? `Skill 도구로 불러 쓴다. 없으면 파일: ${s.file}` : `파일: ${s.file}`})`;
  });
  return `[이 세션에 이은 스킬]\n아래 작업을 할 때는 먼저 해당 스킬의 지침을 읽고 따른다. 관련 없는 작업에는 쓰지 않아도 된다.\n${lines.join("\n")}\n\n${input}`;
}

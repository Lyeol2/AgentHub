// 프로젝트 스킬: <프로젝트>/.claude/skills/<이름>/SKILL.md (Claude Code 스킬 형식).
// 흐름 그래프에서 스킬 노드를 세션에 이으면, 그 세션에 "이 작업을 할 때 이 SKILL.md를 읽고 따르라"는 안내를 붙인다.
// 파일 경로만 알려 주므로 Claude·Codex 모두 쓸 수 있고, 필요할 때만 읽는다.
import fs from "node:fs";
import path from "node:path";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_MAX = 1024;
const BODY_MAX = 100_000;

export const skillsDir = (projectPath) => path.join(projectPath, ".claude", "skills");
export const skillFile = (projectPath, name) => path.join(skillsDir(projectPath), name, "SKILL.md");

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

export function listSkills(projectPath) {
  const dir = skillsDir(projectPath);
  if (!projectPath || !fs.existsSync(dir)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseSkill(fs.readFileSync(file, "utf8"));
      skills.push({ name: entry.name, description: parsed.description, body: parsed.body, file });
    } catch {
      // 읽을 수 없는 파일은 건너뛴다.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
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

export function writeSkill(projectPath, skill, { create = false } = {}) {
  const file = skillFile(projectPath, skill.name);
  if (create && fs.existsSync(file)) throw new Error(`스킬 "${skill.name}"이 이미 있습니다.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatSkill(skill));
  return { ...skill, file };
}

// 스킬 폴더를 통째로 지운다(SKILL.md 옆의 참고 파일 포함).
export function deleteSkill(projectPath, name) {
  if (!SKILL_NAME.test(name)) throw new Error("스킬 이름이 올바르지 않습니다.");
  fs.rmSync(path.join(skillsDir(projectPath), name), { recursive: true, force: true });
}

// 세션에 이은 스킬 안내. 새 대화의 첫 요청과, 이은 스킬이 바뀐 직후 요청에 붙인다.
export function withSkills(session, input, skills = listSkills(session.projectPath)) {
  const changed = session.skillsChanged;
  delete session.skillsChanged;
  if (session.agentSessionId && !changed) return input;
  const attached = (session.skills ?? []).map((name) => skills.find((s) => s.name === name)).filter(Boolean);
  if (!attached.length) return changed ? `[이 세션에 이은 스킬이 모두 해제되었다]\n\n${input}` : input;
  const lines = attached.map((s) => `- ${s.name}: ${s.description} (파일: ${s.file})`);
  // Claude는 .claude/skills를 Skill 도구로 불러올 수 있다. 작업 폴더를 분리한 세션에서 커밋 전 스킬처럼
  // Skill 도구에 없을 때만 파일을 읽게 한다. Codex는 자체 스킬도 SKILL.md를 파일로 읽는 방식이라 경로만 준다.
  const how = session.agent === "claude"
    ? "아래 작업을 할 때는 먼저 Skill 도구로 해당 스킬을 불러 그 지침을 따른다. Skill 도구에 없으면 적힌 SKILL.md 파일을 읽는다."
    : "아래 작업을 할 때는 먼저 해당 SKILL.md를 읽고 그 지침을 따른다.";
  return `[이 세션에 이은 스킬]\n${how} 관련 없는 작업에는 쓰지 않아도 된다.\n${lines.join("\n")}\n\n${input}`;
}

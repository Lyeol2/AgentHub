import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkill, formatSkill, listSkills, writeSkill, deleteSkill, checkSkill, withSkills } from "../server/skills.mjs";

test("skills: SKILL.md 앞머리와 본문을 읽고 쓴다", () => {
  const text = formatSkill({ name: "code-review", description: "리뷰할 때: 버그부터", body: "# 리뷰\n1. diff" });
  assert.match(text, /^---\nname: code-review\ndescription: "리뷰할 때: 버그부터"\n---\n/);
  assert.deepEqual(parseSkill(text), { name: "code-review", description: "리뷰할 때: 버그부터", body: "# 리뷰\n1. diff" });
  assert.equal(parseSkill("앞머리 없음").body, "앞머리 없음");
  assert.throws(() => checkSkill({ name: "Bad Name", description: "x" }));
  assert.throws(() => checkSkill({ name: "ok", description: "" }));
});

test("skills: 프로젝트 폴더에 만들고, 목록에 보이고, 지운다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-skill-"));
  try {
    writeSkill(dir, { name: "deploy", description: "배포할 때", body: "순서" }, { create: true });
    assert.throws(() => writeSkill(dir, { name: "deploy", description: "x", body: "" }, { create: true }));
    const [skill] = listSkills(dir);
    assert.equal(skill.name, "deploy");
    assert.equal(skill.file, path.join(dir, ".claude", "skills", "deploy", "SKILL.md"));
    deleteSkill(dir, "deploy");
    assert.equal(listSkills(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skills: 이은 스킬 안내는 새 대화와 바뀐 직후에만 붙인다", () => {
  const skills = [{ name: "deploy", description: "배포할 때", file: "C:/p/.claude/skills/deploy/SKILL.md" }];
  const s = { skills: ["deploy"], agentSessionId: null };
  assert.match(withSkills(s, "해", skills), /\[이 세션에 이은 스킬\][\s\S]*- deploy: 배포할 때 \(파일: C:\/p\/\.claude\/skills\/deploy\/SKILL\.md\)\n\n해$/);
  s.agentSessionId = "x";
  assert.equal(withSkills(s, "해", skills), "해");
  s.skills = [];
  s.skillsChanged = true;
  assert.match(withSkills(s, "해", skills), /모두 해제/);
  assert.equal(withSkills(s, "해", skills), "해");
});

test("skills: Claude에는 Skill 도구로, Codex에는 파일로 읽게 안내한다", () => {
  const skills = [{ name: "deploy", description: "배포할 때", file: "C:/p/.claude/skills/deploy/SKILL.md" }];
  assert.match(withSkills({ agent: "claude", skills: ["deploy"] }, "해", skills), /Skill 도구로 해당 스킬을 불러/);
  const codex = withSkills({ agent: "codex", skills: ["deploy"] }, "해", skills);
  assert.match(codex, /SKILL\.md를 읽고/);
  assert.doesNotMatch(codex, /Skill 도구/);
});

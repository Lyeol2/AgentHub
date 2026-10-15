import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkill, formatSkill, listSkills, writeSkill, deleteSkill, moveSkill, checkSkill, withSkills } from "../server/skills.mjs";

test("skills: SKILL.md 앞머리와 본문을 읽고 쓴다", () => {
  const text = formatSkill({ name: "code-review", description: "리뷰할 때: 버그부터", body: "# 리뷰\n1. diff" });
  assert.match(text, /^---\nname: code-review\ndescription: "리뷰할 때: 버그부터"\n---\n/);
  assert.deepEqual(parseSkill(text), { name: "code-review", description: "리뷰할 때: 버그부터", body: "# 리뷰\n1. diff" });
  assert.equal(parseSkill("앞머리 없음").body, "앞머리 없음");
  assert.throws(() => checkSkill({ name: "Bad Name", description: "x" }));
  assert.throws(() => checkSkill({ name: "ok", description: "" }));
});

// 프로젝트 폴더와 가짜 홈 폴더(개인 스킬)를 임시로 만든다.
function sandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-skill-"));
  const dir = path.join(root, "proj");
  const home = path.join(root, "home");
  fs.mkdirSync(dir);
  fs.mkdirSync(home);
  try {
    fn(dir, home);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("skills: 프로젝트 스킬은 .agenthub/skills에 만들고, 목록에 보이고, 지운다", () => sandbox((dir, home) => {
  writeSkill(dir, { name: "deploy", description: "배포할 때", body: "순서" }, { create: true, home });
  assert.throws(() => writeSkill(dir, { name: "deploy", description: "x", body: "" }, { create: true, home }));
  const [skill] = listSkills(dir, { home });
  assert.equal(skill.name, "deploy");
  assert.equal(skill.scope, "project");
  assert.equal(skill.file, path.join(dir, ".agenthub", "skills", "deploy", "SKILL.md"));
  deleteSkill(dir, "deploy", { home });
  assert.equal(listSkills(dir, { home }).length, 0);
}));

test("skills: 개인 스킬은 ~/.claude와 ~/.agents 두 곳에 두고 함께 지운다", () => sandbox((dir, home) => {
  writeSkill(dir, { name: "notes", description: "메모할 때", body: "a" }, { create: true, scope: "personal", home });
  const claude = path.join(home, ".claude", "skills", "notes", "SKILL.md");
  const agents = path.join(home, ".agents", "skills", "notes", "SKILL.md");
  assert.equal(fs.readFileSync(claude, "utf8"), fs.readFileSync(agents, "utf8"));
  assert.equal(listSkills(dir, { home })[0].scope, "personal");
  deleteSkill(dir, "notes", { scope: "personal", home });
  assert.ok(!fs.existsSync(claude) && !fs.existsSync(agents));
}));

test("skills: 두 곳의 내용이 다른 개인 스킬은 고치지 않는다", () => sandbox((dir, home) => {
  for (const [sub, text] of [[".claude", "A"], [".agents", "B"]]) {
    fs.mkdirSync(path.join(home, sub, "skills", "tool"), { recursive: true });
    fs.writeFileSync(path.join(home, sub, "skills", "tool", "SKILL.md"), formatSkill({ name: "tool", description: "d", body: text }));
  }
  assert.equal(listSkills(dir, { home })[0].locked, true);
  assert.throws(() => writeSkill(dir, { name: "tool", description: "d", body: "C" }, { scope: "personal", home }), /서로 달라/);
}));

test("skills: Claude 프로젝트 스킬을 AgentHub 전용으로, 다시 개인으로 옮긴다", () => sandbox((dir, home) => {
  const old = path.join(dir, ".claude", "skills", "review");
  fs.mkdirSync(path.join(old, "references"), { recursive: true });
  fs.writeFileSync(path.join(old, "SKILL.md"), formatSkill({ name: "review", description: "리뷰", body: "x" }));
  fs.writeFileSync(path.join(old, "references", "a.md"), "참고");
  assert.equal(listSkills(dir, { home })[0].scope, "claude");
  moveSkill(dir, "review", "project", { home });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(path.join(dir, ".agenthub", "skills", "review", "references", "a.md")));
  moveSkill(dir, "review", "personal", { home });
  assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "review", "references", "a.md")));
  assert.equal(listSkills(dir, { home })[0].scope, "personal");
}));

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

test("skills: Claude는 .claude 스킬만 Skill 도구로, 나머지와 Codex는 파일로 읽게 안내한다", () => {
  const skills = [
    { name: "deploy", description: "배포할 때", file: "C:/p/.claude/skills/deploy/SKILL.md", scope: "claude" },
    { name: "only", description: "전용", file: "C:/p/.agenthub/skills/only/SKILL.md", scope: "project" },
  ];
  const claude = withSkills({ agent: "claude", skills: ["deploy", "only"] }, "해", skills);
  assert.match(claude, /- deploy: 배포할 때 \(Skill 도구로 불러 쓴다/);
  assert.match(claude, /- only: 전용 \(파일: C:\/p\/\.agenthub\/skills\/only\/SKILL\.md\)/);
  const codex = withSkills({ agent: "codex", skills: ["deploy"] }, "해", skills);
  assert.doesNotMatch(codex, /Skill 도구/);
});

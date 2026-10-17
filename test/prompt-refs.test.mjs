import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRefs, resolveRef, expandRefs, parseSlash, expandSlash, expandPrompt, planRequest, PLAN_NOTE, rankFiles, projectFiles } from "../server/prompt-refs.mjs";
import { buildBundle } from "../server/session-bundle.mjs";

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-refs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(root, "src", "lib", "util.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(root, "my notes.md"), "메모\n");
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  return root;
}

test("@참조: 경로를 찾고 작업 폴더 밖은 받지 않는다", (t) => {
  const root = folder(t);
  assert.deepEqual(findRefs('@src/app.js 와 @"my notes.md", 메일 a@b.com\n@src/'), ["src/app.js", "my notes.md", "src/"]);
  assert.equal(resolveRef(root, "src/app.js").dir, false);
  assert.equal(resolveRef(root, "src/app.js,").ref, "src/app.js", "끝의 문장 부호는 떼어 본다");
  assert.equal(resolveRef(root, "src/").dir, true);
  assert.equal(resolveRef(root, "../outside.txt"), null);
  assert.equal(resolveRef(root, path.join(os.tmpdir(), "x")), null);
  assert.equal(resolveRef(root, "없는파일.js"), null);
});

test("@참조: 파일 내용·폴더 목록·세션 파일을 덧붙인다", async (t) => {
  const root = folder(t);
  const bundle = await buildBundle({ id: "s", title: "앞 세션", agent: "claude", events: [{ kind: "user", text: "로그인 만들기" }, { kind: "text", text: "만들었다" }] });
  fs.writeFileSync(path.join(root, "prev.agenthub"), JSON.stringify(bundle));
  const text = expandRefs(root, "봐 줘 @src/app.js @src/lib @bin.dat @prev.agenthub @없음.js");
  assert.match(text, /^봐 줘 @src\/app\.js/);
  assert.match(text, /\[요청에서 @로 참조한 파일\]/);
  assert.match(text, /- 파일 src\/app\.js [\s\S]*console\.log\(1\);/);
  assert.match(text, /- 폴더 src\/lib [\s\S]*  - util\.js/);
  assert.match(text, /bin\.dat .*텍스트가 아니라 경로만/);
  assert.match(text, /- 세션 파일 prev\.agenthub[\s\S]*로그인 만들기[\s\S]*만들었다/);
  assert.equal(expandRefs(root, "참조 없음 @없음.js"), "참조 없음 @없음.js");
});

test("/스킬: 요청 첫머리의 스킬 이름만 실행 지시로 바꾼다", () => {
  const skills = [{ name: "code-review", description: "리뷰", file: "C:/p/.claude/skills/code-review/SKILL.md", scope: "claude" },
    { name: "issue-fix", description: "이슈 수정", file: "C:/p/.agenthub/skills/issue-fix/SKILL.md", scope: "project" }];
  assert.deepEqual(parseSlash("/code-review src 폴더"), { prefix: "", name: "code-review", rest: "src 폴더" });
  assert.equal(parseSlash("경로 /usr/bin"), null);
  assert.equal(expandSlash({ agent: "claude" }, "/없는-스킬 해", skills), null);
  const claude = expandSlash({ agent: "claude" }, "/code-review src 폴더", skills).text;
  assert.match(claude, /^\[스킬 실행: \/code-review\][\s\S]*Skill 도구로 "code-review"[\s\S]*\[요청\]\nsrc 폴더$/);
  const codex = expandSlash({ agent: "codex" }, "[앞 작업을 멈췄다]\n\n/issue-fix", skills).text;
  assert.match(codex, /^\[앞 작업을 멈췄다\]\n\n\[스킬 실행: \/issue-fix\][\s\S]*issue-fix\/SKILL\.md을 읽는다[\s\S]*추가 요청 없음/);
});

test("요청 풀어 쓰기: 워크트리 Claude는 프로젝트 스킬 폴더를 열고, 일반 채팅은 그대로 둔다", (t) => {
  const root = folder(t);
  const skills = [{ name: "issue-fix", description: "이슈 수정", file: "C:/p/.agenthub/skills/issue-fix/SKILL.md", scope: "project" }];
  const session = { agent: "claude", cwd: root, projectPath: "C:/p" };
  const out = expandPrompt(session, "/issue-fix @src/app.js 고쳐", { skills });
  assert.match(out, /스킬 실행[\s\S]*@src\/app\.js 고쳐[\s\S]*console\.log/);
  assert.deepEqual(session.addDirs, [path.dirname(path.dirname(skills[0].file))]);
  assert.equal(expandPrompt({ chat: true, cwd: root }, "/issue-fix @src/app.js", { skills }), "/issue-fix @src/app.js");
});

test("/plan 요청은 계획 모드 안내로 풀어 쓰고, 일반 채팅에서도 쓴다", (t) => {
  const root = folder(t);
  assert.equal(planRequest("/plan 로그인 추가")?.rest, "로그인 추가");
  assert.equal(planRequest("/planner 로그인"), null);
  const out = expandPrompt({ agent: "claude", cwd: root, projectPath: root }, "/plan @src/app.js 고쳐", { skills: [] });
  assert.ok(out.startsWith(PLAN_NOTE));
  assert.match(out, /\[요청\]\n@src\/app\.js 고쳐[\s\S]*console\.log/);
  const chat = expandPrompt({ chat: true }, "/plan 여행 일정");
  assert.ok(chat.startsWith(PLAN_NOTE) && chat.endsWith("여행 일정"));
  assert.match(expandPrompt({ chat: true }, "/plan"), /추가 요청 없음/);
});

test("@자동 완성: 이름이 맞는 파일을 앞에 둔다", async (t) => {
  const root = folder(t);
  const files = await projectFiles(root);
  assert.ok(files.includes("src/app.js") && files.includes("src/lib/"));
  assert.deepEqual(rankFiles(["docs/app-notes.md", "src/app.js", "src/lib/mapper.js", "src/"], "app"), ["src/app.js", "docs/app-notes.md", "src/lib/mapper.js"]);
  assert.deepEqual(rankFiles(["a/b/c.js", "x.js"], "", 1), ["x.js"]);
});

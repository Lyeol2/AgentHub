// 스킬 보기: 다섯 위치 읽기, 건너뛴 스킬, 잠긴 공용 스킬 합치기, 다른 프로젝트 비교, 검사, 참고 파일, 바뀐 파일 보호, AI 초안·제안·발동 시험.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 실제 홈 폴더의 개인 스킬을 건드리지 않게 이 파일에서는 HOME을 임시 폴더로 바꾼다.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-skills-view-"));
const home = path.join(root, "home");
fs.mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
const { parseSkill, scanSkills } = await import("../server/skills.mjs");
const { checkSkillText, overlap } = await import("../server/skill-check.mjs");
const { createHub } = await import("../server/bootstrap.mjs");
test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (name, description, body = "# 본문\n1. 한다.") => `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`;

const project = path.join(root, "AgentHub");
const other = path.join(root, "GBS");
write(path.join(project, ".agenthub", "skills", "idea-discussion", "SKILL.md"), skill("idea-discussion", "게임 아이디어를 토론하고 릴리스 계획을 세울 때 쓴다", `# 토론\n- [템플릿](references/template.md)\n- 참고: ${path.join(other, "Docs", "idea.md")}\n- 작업마다 완료 보고서를 쓴다.`));
write(path.join(project, ".claude", "skills", "unity-cli", "SKILL.md"), skill("unity-cli", "Unity CLI를 다룰 때 쓴다", "# Unity\n" + "- 줄\n".repeat(520)));
write(path.join(project, ".claude", "skills", "unity-cli", "references", "cli-commands.md"), "# 명령\n");
write(path.join(project, ".claude", "skills", "unity-cli", "scripts", "probe.sh"), "echo hi\n");
write(path.join(project, ".agents", "skills", "figcraft-plan", "SKILL.md"), "---\nname: figcraft-plan\ndescription: >\n  FigCraft 화면 계획을\n  세울 때 쓴다\n---\n\n본문\n");
write(path.join(project, ".agents", "skills", "Bad_Name", "SKILL.md"), "---\nname: Bad_Name\ndescription: 이름이 틀렸다\n---\n본문\n");
write(path.join(home, ".claude", "skills", "git-commit", "SKILL.md"), skill("git-commit", "변경을 커밋할 때 쓴다", "# 커밋\n- feat: 형식"));
write(path.join(home, ".agents", "skills", "git-commit", "SKILL.md"), skill("git-commit", "변경을 커밋할 때 쓴다", "# 커밋\n- fix: 형식"));
write(path.join(home, ".claude", "skills", "release", "SKILL.md"), skill("release", "새 버전을 릴리스할 때 쓴다"));
write(path.join(home, ".agents", "skills", "release", "SKILL.md"), skill("release", "새 버전을 릴리스할 때 쓴다"));
write(path.join(home, ".codex", "skills", "codex-review", "SKILL.md"), skill("codex-review", "Codex로 리뷰할 때 쓴다"));
write(path.join(other, ".agenthub", "skills", "idea-discussion", "SKILL.md"), skill("idea-discussion", "다른 프로젝트의 토론 스킬"));
fs.mkdirSync(path.join(project, "docs"));

test("skills: 다섯 위치를 읽고, 규칙에 맞지 않는 폴더는 이유와 함께 건너뛴다", () => {
  const { skills, skipped } = scanSkills(project);
  assert.deepEqual(skills.map((s) => `${s.name}:${s.scope}`), ["codex-review:codex-home", "figcraft-plan:codex", "git-commit:personal", "idea-discussion:project", "release:personal", "unity-cli:claude"]);
  assert.equal(skills.find((s) => s.name === "figcraft-plan").description, "FigCraft 화면 계획을 세울 때 쓴다", "여러 줄 description도 읽는다");
  assert.equal(skills.find((s) => s.name === "figcraft-plan").multiline, true);
  assert.equal(skills.find((s) => s.name === "git-commit").locked, true);
  assert.equal(skills.find((s) => s.name === "release").locked, false);
  assert.deepEqual(skipped.map((s) => [s.name, s.reasons[0].kind]), [["Bad_Name", "name"]]);
  assert.match(skipped[0].reasons[0].text, /Bad_Name → bad-name/);
  assert.equal(parseSkill("---\nname: a\ndescription: |\n  첫 줄\n  둘째 줄\n---\n본문").description, "첫 줄\n둘째 줄");
});

test("skills: 검사는 앞머리·발동 충돌·깨진 링크·다른 프로젝트 경로·연결 충돌·긴 본문을 찾는다", () => {
  const file = path.join(project, ".agenthub", "skills", "idea-discussion", "SKILL.md");
  const parsed = parseSkill(fs.readFileSync(file, "utf8"));
  const warnings = checkSkillText({ name: "idea-discussion", folder: "idea-discussion", description: parsed.description, body: parsed.body, file },
    { projectPath: project, others: [{ name: "release", description: "새 버전을 릴리스할 때 쓴다. 릴리스 계획도 세운다" }], roots: [other] });
  const kinds = warnings.map((w) => w.kind);
  for (const kind of ["trigger", "broken-link", "foreign-path", "commit-every"]) assert.ok(kinds.includes(kind), `${kind} in ${kinds}`);
  assert.equal(warnings.find((w) => w.kind === "foreign-path").title, "다른 프로젝트에만 있는 경로");
  assert.ok(overlap("릴리스 계획을 세울 때", "릴리스 계획도 세운다") > 0.3);
  const bad = checkSkillText({ name: "Bad_Name", folder: "bad", description: "", body: "- 줄\n".repeat(600) }, {});
  assert.deepEqual(bad.map((w) => w.id).sort(), ["fm:empty", "fm:folder", "fm:name", "long"]);
});

test("skills api: 목록·자세히·저장 보호·참고 파일·두 위치 합치기·건너뜀 고치기·AI", { timeout: 30000 }, async (t) => {
  const asks = [];
  const hub = createHub({ port: 0, dataDir: path.join(root, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "AgentHub", path: project }, { name: "GBS", path: other }] },
    deps: { cliPaths: () => ({ claude: "claude", codex: "codex" }), discoverProjects: () => [], logger: { log() {} },
      ask: async (request) => {
        asks.push(request);
        if (request.label === "발동 시험") return JSON.stringify({ results: [{ name: "release", score: 86, reason: "릴리스와 맞음" }, { name: "idea-discussion", score: 41, reason: "겹침" }, { name: "없는-스킬", score: 99 }] });
        return "```markdown\n---\nname: deploy-check\ndescription: \"배포 전에 확인할 때 쓴다\"\n---\n\n# 배포 확인\n1. 본다.\n```";
      } } });
  const now = new Date().toISOString();
  hub.store.add({ id: "s1", title: "Unity 작업", agent: "claude", projectPath: project, cwd: project, state: "idle", skills: ["idea-discussion"], events: [], createdAt: now, updatedAt: now });
  await hub.start();
  t.after(() => hub.shutdown());
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status, reason: value.reason });
    return value;
  };
  const q = `path=${encodeURIComponent(project)}`;
  const catalog = await api("GET", `skills/catalog?${q}`);
  const row = (name) => catalog.skills.find((s) => s.name === name);
  assert.equal(row("idea-discussion").reader, "agenthub");
  assert.equal(row("idea-discussion").equipped, 1);
  assert.equal(row("idea-discussion").diverged, 1, "GBS에 내용이 다른 같은 이름 스킬");
  assert.ok(row("idea-discussion").warnings >= 2);
  assert.equal(row("unity-cli").reading, 1, "Claude 세션이 저절로 읽는다");
  assert.equal(row("git-commit").locked, true);
  assert.equal(row("codex-review").reader, "codex");
  assert.deepEqual(catalog.skipped.map((s) => s.name), ["Bad_Name"]);
  // 자세히
  const unity = await api("GET", `skills/unity-cli/detail?${q}`);
  assert.deepEqual(unity.files.map((f) => f.path), ["references", "references/cli-commands.md", "scripts", "scripts/probe.sh"]);
  assert.deepEqual(unity.sessions.map((s) => [s.title, s.native, s.equipped]), [["Unity 작업", true, false]]);
  assert.ok(unity.warnings.some((w) => w.kind === "long"));
  const idea = await api("GET", `skills/idea-discussion/detail?${q}`);
  assert.deepEqual(idea.elsewhere.map((e) => [e.projectName, e.same]), [["GBS", false]]);
  const locked = await api("GET", `skills/git-commit/detail?${q}`);
  assert.equal(locked.locations.length, 2);
  // 저장: 바뀐 파일은 덮어쓰지 않는다.
  const saved = await api("PUT", `skills/idea-discussion?${q}`, { description: idea.description, body: idea.body + "\n- 덧붙임", baseHash: idea.hash });
  await assert.rejects(api("PUT", `skills/idea-discussion?${q}`, { description: idea.description, body: idea.body, baseHash: idea.hash }), (e) => e.status === 409 && e.reason === "skill-changed");
  await api("PUT", `skills/idea-discussion?${q}`, { description: idea.description, body: idea.body, baseHash: saved.hash });
  // 잠긴 공용 스킬은 고칠 수 없고, 합치면 두 위치가 같아져 풀린다.
  await assert.rejects(api("PUT", `skills/git-commit?${q}`, { description: "x", body: "y" }), /먼저 두 위치를 비교해 합치세요/);
  const merged = await api("POST", `skills/git-commit/merge?${q}`, { text: locked.locations[0].text });
  assert.equal(merged.locked, false);
  assert.equal(fs.readFileSync(path.join(home, ".agents", "skills", "git-commit", "SKILL.md"), "utf8"), fs.readFileSync(path.join(home, ".claude", "skills", "git-commit", "SKILL.md"), "utf8"));
  // 참고 파일 읽기·쓰기(스킬 폴더 밖은 안 됨)
  const ref = await api("GET", `skills/unity-cli/file?${q}&rel=${encodeURIComponent("references/cli-commands.md")}`);
  assert.equal(ref.text, "# 명령\n");
  await api("PUT", `skills/unity-cli/file?${q}&rel=${encodeURIComponent("references/cli-commands.md")}`, { text: "# 바꿈\n", baseHash: ref.hash });
  assert.equal(fs.readFileSync(path.join(project, ".claude", "skills", "unity-cli", "references", "cli-commands.md"), "utf8"), "# 바꿈\n");
  await assert.rejects(api("GET", `skills/unity-cli/file?${q}&rel=${encodeURIComponent("../../x.md")}`), /스킬 폴더 안의 파일만/);
  // 건너뛴 스킬 고치기
  const fixed = await api("POST", `skills/fix-skipped?${q}`, { file: path.join(project, ".agents", "skills", "Bad_Name", "SKILL.md") });
  assert.equal(fixed.name, "bad-name");
  assert.ok(scanSkills(project).skills.some((s) => s.name === "bad-name" && s.scope === "codex"));
  // 새 범위로 만들기
  await api("POST", "skills", { projectPath: project, name: "codex-local", description: "Codex 전용", body: "본문", scope: "codex" });
  assert.ok(fs.existsSync(path.join(project, ".agents", "skills", "codex-local", "SKILL.md")));
  // AI: 초안·고칠 점(파일은 고치지 않는다)·발동 시험
  const draft = await api("POST", `skills/draft?${q}`, { name: "deploy-check", purpose: "배포 전에 확인할 때" });
  assert.deepEqual([draft.name, draft.description, draft.body], ["deploy-check", "배포 전에 확인할 때 쓴다", "# 배포 확인\n1. 본다."]);
  assert.match(asks[0].prompt, /\[기존 스킬\][\s\S]*release: 새 버전을 릴리스할 때 쓴다/);
  const before = fs.readFileSync(path.join(project, ".claude", "skills", "unity-cli", "SKILL.md"), "utf8");
  await api("POST", `skills/unity-cli/suggest?${q}`, {});
  assert.match(asks[1].prompt, /\[검사에서 나온 문제\][\s\S]*본문이/);
  assert.equal(fs.readFileSync(path.join(project, ".claude", "skills", "unity-cli", "SKILL.md"), "utf8"), before);
  const trial = await api("POST", `skills/trigger?${q}`, { request: "릴리스 노트 정리하고 태그 달아줘", agent: "claude", sessionId: "s1" });
  assert.deepEqual(trial.results.map((r) => [r.name, r.score]), [["release", 86], ["idea-discussion", 41]], "없는 스킬은 버린다");
  assert.match(asks[2].prompt, /- idea-discussion:/, "장착한 스킬도 후보");
  assert.doesNotMatch(asks[2].prompt, /codex-review/, "Claude는 ~/.codex 스킬을 읽지 않는다");
});

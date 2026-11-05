// 프로젝트 지침 도우미: 섹션 나누기, 저장 전 검사(연결 흐름 충돌·깨진 링크·긴 섹션·스킬 중복), CLAUDE.md 연결·합치기, 지침 지도, 순서도.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSections, checkGuide, applyFix, guideLinks, claudeStatus, guideMap, parseFlow, flowHighlights, sectionKey } from "../server/guide.mjs";
import { createHub } from "../server/bootstrap.mjs";

const GUIDE = `# 데모 에이전트 지침

## 프로젝트 요약
Electron 앱이다.

## 작업 절차
1. 요청을 읽고 조사한다.
2. 계획서를 쓴다.
3. 승인받은 뒤에만 구현한다.

## 필독 문서
- [개발 문서](docs/dev.md)
- C# 수정 시 [Unity 규칙](docs/unity.md)

## 응답 방식
- 응답 끝에 변경 파일과 다음 할 일을 보고한다.
- 작업이 끝나면 완료보고서를 쓰고 커밋한다.
`;

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-guide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "dev.md"), "# 개발\n");
  fs.writeFileSync(path.join(root, "docs", "old.md"), "# 아무도 안 봄\n");
  return root;
}

test("guide: 섹션을 나누고 비슷한 제목을 권장 섹션으로 본다", () => {
  const sections = parseSections(GUIDE);
  assert.deepEqual(sections.map((s) => [s.title, s.line, s.lines]), [["프로젝트 요약", 3, 1], ["작업 절차", 6, 3], ["필독 문서", 11, 2], ["응답 방식", 15, 2]]);
  assert.deepEqual(sections.map((s) => s.key), ["summary", "process", "docs", "response"]);
  assert.equal(sectionKey("3. 작업 전 필수 절차"), "process");
  assert.equal(sectionKey("디자인 메모"), null);
  assert.deepEqual(parseSections("## 가\n```\n## 코드 속 제목\n```\n").map((s) => s.title), ["가"]);
});

test("guide: 연결 흐름과 부딪히는 문장·깨진 링크·긴 섹션·스킬 중복을 찾고 고쳐 쓰기를 제안한다", (t) => {
  const root = project(t);
  const file = path.join(root, "AGENTS.md");
  const long = `${GUIDE}\n## 커밋 규칙\n${Array.from({ length: 64 }, (_, i) => `- 규칙 ${i}`).join("\n")}\n`;
  const warnings = checkGuide(long, { file, projectPath: root, skills: [{ name: "git-commit" }] });
  const kinds = warnings.map((w) => `${w.kind}:${w.line}`);
  assert.ok(kinds.includes("approval:9"), kinds.join(" "));
  assert.ok(!kinds.some((k) => k.startsWith("report-tail:")), "판정은 handoff 도구로 알리므로 응답 끝 보고는 연결과 부딪히지 않는다");
  assert.ok(kinds.includes("commit-every:17"));
  assert.ok(kinds.includes("broken-link:13"), "없는 docs/unity.md");
  assert.ok(!kinds.includes("broken-link:12"), "있는 파일은 괜찮다");
  assert.ok(kinds.some((k) => k.startsWith("long-section:")));
  assert.ok(kinds.some((k) => k.startsWith("skill-dup:")));
  const approval = warnings.find((w) => w.kind === "approval");
  const fixed = applyFix(long, approval.fix);
  assert.match(fixed.split("\n")[8], /승인받은 뒤에만 구현한다\. \(사용자가 직접 요청한 작업에만 적용한다\. 연결로 넘어온 작업은 승인 없이 바로 진행한다\.\)/);
  assert.ok(!checkGuide(fixed, { file, projectPath: root }).some((w) => w.kind === "approval"), "예외를 적은 줄은 다시 경고하지 않는다");
  const broken = warnings.find((w) => w.kind === "broken-link");
  assert.equal(applyFix(long, broken.fix).split("\n")[12], "- C# 수정 시 Unity 규칙");
  assert.throws(() => applyFix("다른 글", approval.fix), /바뀌었습니다/);
  // 링크의 조건과 @가져오기
  assert.deepEqual(guideLinks(GUIDE).map((l) => [l.target, l.condition]), [["docs/dev.md", ""], ["docs/unity.md", "C# 수정 시"]]);
  assert.equal(guideLinks("@AGENTS.md\n")[0].import, true);
});

test("guide: CLAUDE.md 상태와 지침 지도(가져오기·조건부·깨진 링크·참조 없는 문서·스킬·세션 역할)", (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, "AGENTS.md"), GUIDE);
  assert.deepEqual(claudeStatus(root), { agents: true, claude: false, imports: false, extraLines: 0, sections: [] });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# CLAUDE.md\n\n@AGENTS.md\n\n## Claude 메모\n- 길게 생각한다\n");
  const status = claudeStatus(root);
  assert.equal(status.imports, true);
  assert.equal(status.extraLines, 1);
  fs.mkdirSync(path.join(root, "server"));
  fs.writeFileSync(path.join(root, "server", "AGENTS.md"), "# 서버\n");
  const map = guideMap(root, {
    skills: [{ name: "git-commit", description: "커밋", file: path.join(root, ".claude", "skills", "git-commit", "SKILL.md"), scope: "claude" }],
    sessions: [{ id: "s1", title: "구현", agent: "claude", role: "구현한다", skills: ["git-commit"] }, { id: "s2", title: "검토", agent: "codex" }],
    links: [{ from: "s1", to: "s2", when: "success", enabled: true }],
  });
  const node = (id) => map.nodes.find((n) => n.id === id);
  assert.equal(node("AGENTS.md").readers, "둘 다 (Claude · Codex)");
  assert.equal(node("CLAUDE.md").sub, "@AGENTS.md + 1줄");
  assert.equal(node("server/AGENTS.md").kind, "nested");
  assert.equal(node("docs/unity.md").broken, true);
  assert.equal(node("docs/old.md").orphan, true);
  assert.equal(node("role:s1").kind, "role");
  assert.ok(node("inject:messages") && node("inject:handoff") && node("inject:skills"));
  const edge = (from, to) => map.edges.find((e) => e.from === from && e.to === to);
  assert.equal(edge("CLAUDE.md", "AGENTS.md").kind, "import");
  assert.deepEqual([edge("AGENTS.md", "docs/unity.md").kind, edge("AGENTS.md", "docs/unity.md").label, edge("AGENTS.md", "docs/unity.md").broken], ["conditional", "C# 수정 시", true]);
  assert.equal(edge("AGENTS.md", "skill:git-commit").kind, "skill");
  assert.equal(edge("inject:handoff", "role:s2").kind, "inject");
  assert.equal(edge("skill:git-commit", "role:s1").label, "이은 스킬");
});

test("guide: 순서도 답을 검사하고, 연결 작업이 멈추는 칸과 판정 줄과 부딪히는 칸을 찾는다", () => {
  const flow = parseFlow("```json\n" + JSON.stringify({
    nodes: [{ id: "a", type: "start", title: "요청" }, { id: "b", type: "step", title: "계획서", lines: [8, 8] }, { id: "c", type: "step", title: "승인", lines: [9] },
      { id: "d", type: "step", title: "구현" }, { id: "e", type: "step", title: "보고", lines: [16, 17] }, { id: "f", type: "end", title: "끝" }, { id: "x", type: "weird", title: "", lines: [999] }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }, { from: "d", to: "e" }, { from: "e", to: "f" }, { from: "a", to: "zzz" }],
  }) + "\n```", 20);
  assert.deepEqual(flow.nodes.find((n) => n.id === "c").lines, [9, 9]);
  assert.equal(flow.nodes.find((n) => n.id === "d").guess, true, "근거 줄이 없으면 추정");
  assert.equal(flow.nodes.find((n) => n.id === "x").type, "step");
  assert.equal(flow.edges.length, 5, "없는 노드로 가는 선은 버린다");
  const warnings = checkGuide(GUIDE, {});
  const highlights = flowHighlights(flow, warnings);
  assert.equal(highlights.stop.id, "c");
  assert.deepEqual(highlights.after.sort(), ["d", "e"]);
  assert.deepEqual(highlights.conflicts.map((c) => c.id), ["e"]);
  assert.throws(() => parseFlow("모르겠다", 10), /JSON/);
});

test("guide api: 읽기·검사·저장(바뀐 파일 보호)·CLAUDE.md 연결·합치기·AI 초안·섹션 다시 쓰기·순서도", { timeout: 30000 }, async (t) => {
  const root = project(t);
  const asks = [];
  const hub = createHub({ port: 0, dataDir: path.join(root, ".data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "demo", path: root }] },
    deps: { cliPaths: () => ({ claude: "claude", codex: null }), discoverProjects: () => [], logger: { log() {} },
      ask: async (request) => {
        asks.push(request);
        if (request.label === "지침 초안") return "초안입니다\n```markdown\n# demo 에이전트 지침\n\n## 프로젝트 요약\nNode 앱이다.\n```";
        if (request.label === "섹션 다시 쓰기") return "```markdown\n## 작업 절차\n1. 조사한다.\n2. 바로 구현한다.\n```";
        return JSON.stringify({ nodes: [{ id: "a", type: "start", title: "요청" }, { id: "b", type: "step", title: "승인", lines: [9, 9] }, { id: "c", type: "end", title: "끝" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] });
      } } });
  await hub.start();
  t.after(() => hub.shutdown());
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status, reason: value.reason });
    return value;
  };
  const q = `path=${encodeURIComponent(root)}`;
  const empty = await api("GET", `guide?${q}`);
  assert.equal(empty.exists, false);
  assert.match(empty.blank, /## 프로젝트 요약\n<!--/);
  assert.equal(empty.claude.claude, false);
  const checked = await api("POST", `guide/check?${q}`, { text: GUIDE });
  assert.ok(checked.warnings.some((w) => w.kind === "approval"));
  const saved = await api("PUT", `guide?${q}`, { text: GUIDE, baseHash: null });
  assert.equal(saved.exists, true);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), GUIDE);
  // 다른 곳에서 바뀐 파일은 덮어쓰지 않는다.
  fs.writeFileSync(path.join(root, "AGENTS.md"), GUIDE + "\n- 다른 세션이 덧붙임\n");
  await assert.rejects(api("PUT", `guide?${q}`, { text: GUIDE + "x", baseHash: saved.hash }), (error) => error.status === 409 && error.reason === "guide-changed");
  const forced = await api("PUT", `guide?${q}`, { text: GUIDE, baseHash: saved.hash, force: true });
  assert.equal(forced.hash, saved.hash);
  await assert.rejects(api("GET", `guide?${q}&file=${encodeURIComponent("../x.md")}`), /프로젝트 안의 \.md/);
  // CLAUDE.md 연결과 합치기
  const linked = await api("POST", `guide/claude/link?${q}`);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.equal(linked.claude.imports, true);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\n\n## Claude 메모\n- 길게 생각한다\n\n## 남길 것\n- 그대로\n");
  const view = await api("GET", `guide?${q}`);
  assert.deepEqual(view.claude.sections.map((s) => s.title), ["Claude 메모", "남길 것"]);
  const merged = await api("POST", `guide/claude/merge?${q}`, { sections: [0], baseHash: view.hash });
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /## Claude 메모\n- 길게 생각한다\n$/);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "# CLAUDE.md\n\n@AGENTS.md\n\n## 남길 것\n- 그대로\n");
  assert.equal(merged.claude.extraLines, 1);
  // AI 초안·섹션 다시 쓰기: 파일은 고치지 않고 글만 돌려준다.
  const draft = await api("POST", `guide/draft?${q}`, { agent: "claude" });
  assert.equal(draft.text, "# demo 에이전트 지침\n\n## 프로젝트 요약\nNode 앱이다.\n");
  assert.match(asks[0].prompt, /\[지금 지침\]/);
  assert.match(asks[0].prompt, /docs\/dev\.md/, "찾은 문서를 알려 준다");
  const rewritten = await api("POST", `guide/rewrite?${q}`, { text: GUIDE, line: 6, request: "승인 빼기" });
  assert.match(rewritten.text, /## 작업 절차\n1\. 조사한다\.\n2\. 바로 구현한다\.\n\n## 필독 문서/);
  assert.match(asks[1].prompt, /\[요청\] 승인 빼기/);
  // 순서도: 그리고, 저장하고, 연결로 작업을 받는 세션이면 멈추는 칸을 표시한다.
  fs.writeFileSync(path.join(root, "AGENTS.md"), GUIDE);
  hub.store.add({ id: "s1", title: "앞", agent: "claude", projectPath: root, cwd: root, state: "idle", events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  hub.store.add({ id: "s2", title: "뒤", agent: "codex", projectPath: root, cwd: root, state: "idle", events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await api("POST", "links", { from: "s1", to: "s2", when: "success" });
  assert.equal((await api("GET", `guide/flow?${q}`)).empty, true);
  const drawn = await api("POST", `guide/flow?${q}`, { session: "s2" });
  assert.equal(drawn.stale, false);
  assert.equal(drawn.highlights.stop.id, "b");
  assert.deepEqual(drawn.sessions.map((s) => [s.title, s.receives]).sort(), [["뒤", true], ["앞", false]]);
  assert.equal((await api("GET", `guide/flow?${q}&session=s1`)).highlights, null, "연결로 작업을 받지 않는 세션은 표시하지 않는다");
  fs.appendFileSync(path.join(root, "AGENTS.md"), "\n- 덧붙임\n");
  assert.equal((await api("GET", `guide/flow?${q}`)).stale, true, "지침이 바뀌면 다시 그리라고 알린다");
  // 지침 지도
  const map = await api("GET", `guide/map?${q}`);
  assert.ok(map.nodes.some((n) => n.id === "role:s2"));
});

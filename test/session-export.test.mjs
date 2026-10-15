import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportSession, renderSessionMarkdown } from "../server/session-export.mjs";

const NOW = "2026-10-15T09:10:11.000Z";
const BT = String.fromCharCode(96);
const session = (cwd, extra = {}) => ({
  id: "session-123", title: "작업 기록", agent: "codex", model: "gpt-test",
  projectName: "예제", projectPath: cwd, cwd, branch: "main",
  createdAt: "2026-10-14T00:00:00.000Z", updatedAt: NOW, events: [], ...extra,
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-export-"));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith("agenthub-export-") && !path.isAbsolute(relative) && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("내보내기: 메타데이터와 모든 사용자·AI 본문은 생략 없이 보존하고 내부 데이터는 제외한다", () => {
  const long = "검증 내용 ".repeat(3000);
  const md = renderSessionMarkdown(session("C:/project", {
    handover: "숨긴 인계 데이터", input: "숨긴 시스템 프롬프트", context: { used: 19443 },
    events: [
      { kind: "user", text: "처음 목표", raw: { token: "숨긴 원본" }, input: "숨긴 CLI input" },
      { kind: "text", text: long, tokens: "숨긴 토큰" },
      { kind: "result", text: "턴 완료 · 입력 12 / 출력 3 토큰", usage: { secret: "숨긴 사용량" } },
      { kind: "usage", text: "숨긴 usage" }, { kind: "unknown", text: "숨긴 종류" },
    ],
  }), { exportedAt: NOW });
  assert.match(md, /^# 작업 기록\n/);
  for (const value of ["AI: Codex", "모델: gpt-test", "프로젝트: 예제", "작업 폴더: C:/project", "브랜치: main", NOW, "처음 목표", long, "턴 완료"]) assert.ok(md.includes(value), value.slice(0, 50));
  assert.doesNotMatch(md, /숨긴|입력 12|출력 3|19443/);
});

test("내보내기: 질문 선택지·답·권한 결정·계획 결과·세션 메시지를 보존한다", () => {
  const md = renderSessionMarkdown(session("C:/p", { events: [
    { kind: "question", ts: NOW, status: "answered", questions: [{ header: "작업 방식", question: "어떻게 진행할까요?", options: [{ label: "진행", description: "코드 수정" }, { label: "대기" }], multiSelect: true }], answers: [{ selected: ["진행"], text: "테스트도" }] },
    { kind: "permission", status: "allowed", decision: "always", text: "npm test", reason: "테스트 실행", detail: "command: npm test" },
    { kind: "permission", status: "denied", text: "remove file" },
    { kind: "permission", status: "pending", text: "network" },
    { kind: "question", status: "skipped", questions: [{ question: "지난 질문", options: [] }] },
    { kind: "plan", status: "applied", plan: { sessions: [{ key: "ui", title: "UI", agent: "claude", roleText: "화면 구현" }], links: [{ from: "ui", to: "review" }], send: [{ to: "ui", prompt: "버튼 구현" }] }, result: "생성 완료" },
    { kind: "message", toTitle: "리뷰", text: "리뷰 요청" },
    { kind: "user", fromTitle: "리뷰", reply: true, text: "리뷰 답장", injected: true },
  ] }), { exportedAt: NOW });
  for (const value of ["상태: 답함", "작업 방식", "어떻게 진행할까요?", "진행 — 코드 수정", "답: 진행, 테스트도", "항상 허용함", "거절함", "대기 중", "지나감", "화면 구현", "버튼 구현", "생성 완료", "보낸 메시지 → 리뷰", "리뷰 답장", "작업 중 추가"]) assert.ok(md.includes(value), value);
});

test("내보내기: 구조화된 질문·메시지 블록을 중복하지 않고 카드가 없으면 본문을 남긴다", () => {
  const block = BT.repeat(3) + 'agenthub-question\n{"questions":[]}\n' + BT.repeat(3);
  const s = session("C:/p", { events: [{ kind: "text", text: "결정을 기다립니다.\n" + block }, { kind: "question", status: "invalid", error: "질문 형식 오류" }] });
  const md = renderSessionMarkdown(s, { exportedAt: NOW });
  assert.match(md, /결정을 기다립니다/);
  assert.match(md, /질문 형식 오류/);
  assert.doesNotMatch(md, /agenthub-question/);
  assert.match(renderSessionMarkdown({ ...s, events: [s.events[0]] }, { exportedAt: NOW }), /agenthub-question/);
});

test("내보내기: 도구·로그는 접고 코드 펜스 충돌 및 HTML 삽입을 막는다", () => {
  const payload = BT.repeat(3) + "\n</details>\n<script>alert(1)</script>\n" + BT.repeat(7);
  const md = renderSessionMarkdown(session("C:/p", { title: "제목 <script>", events: [
    { kind: "tool", text: "npm test", detail: payload },
    { kind: "tool_result", text: "오류 출력", isError: true },
    { kind: "log", text: "stderr 기록" },
    { kind: "text", text: "<script>alert(2)</script>" },
  ] }), { exportedAt: NOW });
  assert.match(md, /<details>\n<summary>도구<\/summary>/);
  assert.ok(md.includes(BT.repeat(8) + "text\n" + payload + "\n" + BT.repeat(8)));
  assert.match(md, /도구 결과 · 오류/);
  assert.match(md, /로그<\/summary>/);
  assert.match(md, /# 제목 &lt;script&gt;/);
  assert.match(md, /&lt;script>alert\(2\)&lt;\/script>/);
});

test("내보내기: 표시된 글 속 알려진 인증 문자열도 가린다", () => {
  const md = renderSessionMarkdown(session("C:/p", { events: [{ kind: "tool_result", text: [
    "Authorization: Bearer abc123private",
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv",
    '"access_token": "private-value"',
    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuv",
    "PASSWORD=local-private",
  ].join("\n") }] }), { exportedAt: NOW });
  assert.doesNotMatch(md, /abc123private|abcdefghijklmnopqrstuv|private-value|local-private/);
  assert.match(md, /\[가림\]/);
});

test("내보내기: 원본과 워크트리 중 세션 cwd 안에만 문서를 생성한다", async (t) => {
  const dir = await fixture(t);
  const project = path.join(dir, "project");
  const worktree = path.join(dir, "worktree");
  await fs.mkdir(project); await fs.mkdir(worktree);
  const result = await exportSession(session(worktree, { projectPath: project, worktree: { branch: "agenthub/feature" }, events: [{ kind: "text", text: "완료" }] }), { now: NOW });
  assert.equal(path.dirname(result.path), path.join(worktree, "docs", "agenthub"));
  assert.equal(result.relativePath, "docs/agenthub/" + result.fileName);
  assert.equal(await fs.readFile(result.path, "utf8"), result.markdown);
  assert.match(result.markdown, /브랜치: agenthub\/feature/);
  assert.equal(await fs.stat(path.join(project, "docs")).then(() => true, () => false), false);
});

test("내보내기: 동일 이름·시각의 동시 요청도 기존 파일을 덮어쓰지 않는다", async (t) => {
  const dir = await fixture(t);
  const [first, second] = await Promise.all([
    exportSession(session(dir, { events: [{ kind: "text", text: "첫 번째" }] }), { now: NOW }),
    exportSession(session(dir, { events: [{ kind: "text", text: "두 번째" }] }), { now: NOW }),
  ]);
  assert.notEqual(first.path, second.path);
  assert.match(await fs.readFile(first.path, "utf8"), /첫 번째/);
  assert.match(await fs.readFile(second.path, "utf8"), /두 번째/);
});

test("내보내기: 경로 탈출·장치 이름·상위 경로 구분자는 파일명에 사용할 수 없다", async (t) => {
  const dir = await fixture(t);
  const result = await exportSession(session(dir, { title: "CON", id: "../../LPT1:<bad>|?*  " }), { now: NOW });
  assert.ok(result.fileName.startsWith("_CON-"));
  assert.doesNotMatch(result.fileName, /[<>:"/\\|?*]/);
  assert.equal(path.dirname(result.path), path.join(dir, "docs", "agenthub"));
  assert.ok(!result.fileName.endsWith(". "));
});

test("내보내기: 이미지는 독립 복사하고 중복 첨부는 하나만 저장하며 상대 링크로 남긴다", async (t) => {
  const dir = await fixture(t);
  const image = path.join(dir, "source.png");
  const bytes = Buffer.from([137, 80, 78, 71, 0, 1, 2]);
  await fs.writeFile(image, bytes);
  const attachment = { id: "img-1", name: "../CON.png", mimeType: "image/png", size: bytes.length, url: "/api/private-image" };
  const s = session(dir, { events: [{ kind: "user", text: "", attachments: [attachment] }, { kind: "user", text: "이 이미지", attachments: [attachment] }] });
  let calls = 0;
  const result = await exportSession(s, { now: NOW, resolveAttachment: async (value, resolvedSession) => { calls++; assert.equal(value.id, attachment.id); assert.equal(resolvedSession, s); return { path: image }; } });
  assert.equal(calls, 1);
  assert.equal(result.attachments.length, 1);
  const copy = path.join(path.dirname(result.path), result.attachments[0].relativePath);
  assert.deepEqual(await fs.readFile(copy), bytes);
  assert.ok(result.markdown.includes("![")); assert.ok(result.markdown.includes(".assets/1-_CON.png)"));
  assert.doesNotMatch(result.markdown, /\/api\/private-image|source\.png/);
  await fs.unlink(image);
  assert.deepEqual(await fs.readFile(copy), bytes);
  const downloaded = renderSessionMarkdown(s, { exportedAt: NOW });
  assert.match(downloaded, /별도 이미지 파일/);
  assert.doesNotMatch(downloaded, /private-image/);
});

test("내보내기: 프로젝트 없는 채팅은 파일 생성을 거절하고 순수 Markdown은 제공한다", async (t) => {
  const dir = await fixture(t);
  const s = session(dir, { chat: true, projectName: "일반 채팅", projectPath: null, events: [{ kind: "text", text: "일반 대화" }] });
  await assert.rejects(exportSession(s), { code: "EXPORT_PROJECT_REQUIRED" });
  assert.deepEqual(await fs.readdir(dir), []);
  assert.match(renderSessionMarkdown(s, { exportedAt: NOW }), /프로젝트: 일반 채팅/);
  assert.doesNotMatch(renderSessionMarkdown(s, { exportedAt: NOW }), /작업 폴더:/);
  await assert.rejects(exportSession(session("relative/project")), { code: "EXPORT_UNSAFE_PATH" });
});

test("내보내기: 첨부 저장소 누락·파일 아닌 첨부는 실패로 돌려준다", async (t) => {
  const dir = await fixture(t);
  const image = { id: "img", name: "image.png", mimeType: "image/png" };
  const s = session(dir, { events: [{ kind: "user", attachments: [image] }] });
  await assert.rejects(exportSession(s), { code: "EXPORT_ATTACHMENT_MISSING" });
  await assert.rejects(exportSession(s, { resolveAttachment: () => dir }), { code: "EXPORT_ATTACHMENT_INVALID" });
  await assert.rejects(exportSession({ ...s, events: [{ kind: "user", attachments: [{ ...image, mimeType: "image/svg+xml" }] }] }, { resolveAttachment: () => dir }), { code: "EXPORT_ATTACHMENT_INVALID" });
  assert.deepEqual(await fs.readdir(path.join(dir, "docs", "agenthub")), []);
});

test("내보내기: 문서·SVG 첨부는 독립 복사하고 이미지 대신 다운로드 링크를 남긴다", async (t) => {
  const dir = await fixture(t);
  const sources = new Map();
  const attachments = [];
  for (const [id, name, mimeType, content] of [["json", "../data.json", "application/json", '{"name":"문서"}'], ["svg", "active.svg", "image/svg+xml", "<svg><script>example</script></svg>"]]) {
    const source = path.join(dir, id + ".source");
    await fs.writeFile(source, content);
    sources.set(id, source);
    attachments.push({ id, name, mimeType });
  }
  const result = await exportSession(session(dir, { events: [{ kind: "user", attachments }] }), { now: NOW, resolveAttachment: (file) => sources.get(file.id) });
  assert.equal(result.attachments.length, 2);
  assert.doesNotMatch(result.markdown, /!\[/);
  for (const file of result.attachments) {
    const copy = path.join(path.dirname(result.path), file.relativePath);
    assert.deepEqual(await fs.readFile(copy), await fs.readFile(sources.get(file.id)));
  }
  assert.match(result.markdown, /\.json\)/);
  assert.match(result.markdown, /\.svg\)/);
});

test("내보내기: docs·agenthub·cwd의 심볼릭 링크나 junction을 통한 외부 쓰기를 막는다", async (t) => {
  const dir = await fixture(t);
  const project = path.join(dir, "project");
  const external = path.join(dir, "external");
  await fs.mkdir(project); await fs.mkdir(external);
  await fs.symlink(external, path.join(project, "docs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportSession(session(project)), { code: "EXPORT_UNSAFE_PATH" });
  assert.deepEqual(await fs.readdir(external), []);
  await fs.unlink(path.join(project, "docs"));
  await fs.mkdir(path.join(project, "docs"));
  await fs.symlink(external, path.join(project, "docs", "agenthub"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportSession(session(project)), { code: "EXPORT_UNSAFE_PATH" });
  assert.deepEqual(await fs.readdir(external), []);
  await fs.symlink(external, path.join(dir, "linked-project"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportSession(session(path.join(dir, "linked-project"))), { code: "EXPORT_UNSAFE_PATH" });
});


test("내보내기: Markdown 코드와 인라인 코드·인용문 원문을 보존한다", () => {
  const code = BT.repeat(3) + 'html\n<div class="test">&amp;</div>\n' + BT.repeat(3);
  const text = '> 인용\n\n' + code + '\n\n인라인 ' + BT + '<span>&amp;</span>' + BT + '\n\n<script>bad()</script>';
  const md = renderSessionMarkdown(session("C:/p", { events: [{ kind: "text", text }] }), { exportedAt: NOW });
  assert.ok(md.includes(code));
  assert.ok(md.includes(BT + '<span>&amp;</span>' + BT));
  assert.ok(md.includes("> 인용"));
  assert.ok(md.includes("&lt;script>bad()&lt;/script>"));
  const unclosed = renderSessionMarkdown(session("C:/p", { events: [{ kind: "text", text: BT.repeat(4) + "html\n<div>" }, { kind: "user", text: "다음 요청" }] }), { exportedAt: NOW });
  assert.ok(unclosed.includes("<div>\n" + BT.repeat(4) + "\n\n## 사용자"));
});

test("내보내기: 이미지 복사 도중 실패하면 이번 생성한 문서·assets만 정리한다", async (t) => {
  const dir = await fixture(t);
  const previous = await exportSession(session(dir, { events: [{ kind: "text", text: "이전 기록" }] }), { now: NOW });
  const firstSource = path.join(dir, "first.png");
  const secondSource = path.join(dir, "second.png");
  await fs.writeFile(firstSource, "first"); await fs.writeFile(secondSource, "second");
  const first = { id: "first", name: "first.png", mimeType: "image/png" };
  const second = { id: "second", name: "second.png", mimeType: "image/png" };
  await assert.rejects(exportSession(session(dir, { events: [{ kind: "user", attachments: [first, second] }] }), {
    now: NOW,
    resolveAttachment: async (attachment) => {
      if (attachment.id === "first") return firstSource;
      await fs.unlink(firstSource);
      return secondSource;
    },
  }), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(dir, "docs", "agenthub")), [previous.fileName]);
  assert.match(await fs.readFile(previous.path, "utf8"), /이전 기록/);
});

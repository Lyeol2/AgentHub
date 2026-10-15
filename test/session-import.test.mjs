import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportSession, renderSessionMarkdown } from "../server/session-export.mjs";
import { parseSessionMarkdown, listRecords, readRecord, readRecordImage, unescapeInline } from "../server/session-import.mjs";
import { createHub } from "../server/bootstrap.mjs";

const NOW = "2026-10-15T09:10:11.000Z";
const BT = String.fromCharCode(96);
const FENCE = BT.repeat(3);
const ts = (n) => `2026-10-15T09:00:0${n}.000Z`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-import-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const sample = (cwd, extra = {}) => ({
  id: "session-123", title: "가방 *UI* [개편]", agent: "codex", model: "gpt-test", projectName: "예제", projectPath: cwd, cwd, branch: "main",
  createdAt: "2026-10-14T00:00:00.000Z", updatedAt: NOW, events: [
    { kind: "user", ts: ts(1), text: "처음 목표 <b>굵게</b> & `코드`" },
    { kind: "text", ts: ts(2), text: "## 결과\n답변 안의 제목입니다. a < b\n\n" + FENCE + "md\n## 사용자 · 2026-10-15T09:00:00.000Z\n<details>\n" + FENCE + "\n\n마지막 줄\n수정 필요" },
    { kind: "tool", ts: ts(3), text: "npm test", detail: "command: npm test" },
    { kind: "tool_result", ts: ts(4), text: "1 failed\n" + FENCE + " 펜스 포함", isError: true },
    { kind: "message", ts: ts(5), toTitle: "리뷰", text: "리뷰 요청" },
    { kind: "user", ts: ts(6), fromTitle: "리뷰", reply: true, injected: true, text: "리뷰 답장" },
    { kind: "error", ts: ts(7), text: "CLI 오류" },
    { kind: "question", ts: ts(8), status: "answered", questions: [{ question: "어떻게 할까요?", options: [{ label: "진행" }] }], answers: [{ selected: ["진행"] }] },
    { kind: "result", ts: ts(9), text: "턴 완료" },
  ], ...extra,
});

test("가져오기: 내보낸 문서를 대화 기록으로 되살린다", () => {
  const md = renderSessionMarkdown(sample("C:/p"), { exportedAt: NOW });
  const parsed = parseSessionMarkdown(md);
  assert.equal(parsed.title, "가방 *UI* [개편]");
  assert.deepEqual(parsed.meta, { sessionId: "session-123", agent: "codex", model: "gpt-test", project: "예제", branch: "main", exportedAt: NOW, createdAt: "2026-10-14T00:00:00.000Z" });
  const events = parsed.events;
  assert.deepEqual(events.map((e) => e.kind), ["user", "text", "tool", "tool_result", "message", "user", "error", "status", "result"]);
  assert.equal(events[0].text, "처음 목표 <b>굵게</b> & `코드`");
  assert.equal(events[0].ts, ts(1));
  assert.equal(events[1].text, sample("C:/p").events[1].text, "답변 안의 제목·펜스·<details>는 경계로 보지 않는다");
  assert.deepEqual([events[2].text, events[2].detail], ["npm test", "command: npm test"]);
  assert.equal(events[3].text, "1 failed\n" + FENCE + " 펜스 포함");
  assert.equal(events[3].isError, true);
  assert.deepEqual([events[4].toTitle, events[4].text], ["리뷰", "리뷰 요청"]);
  assert.deepEqual([events[5].fromTitle, events[5].reply, events[5].injected, events[5].text], ["리뷰", true, true, "리뷰 답장"]);
  assert.match(events[7].text, /^\[질문 기록\][\s\S]*어떻게 할까요\?[\s\S]*답: 진행/);
  assert.equal(events[8].text, "턴 완료");
});

test("가져오기: 내보낸 문서가 아니면 거절하고 이스케이프를 되돌린다", () => {
  assert.throws(() => parseSessionMarkdown("그냥 메모"), (e) => e.code === "IMPORT_FORMAT");
  assert.throws(() => parseSessionMarkdown("# 제목\n\n본문"), (e) => e.code === "IMPORT_FORMAT");
  assert.deepEqual(parseSessionMarkdown(renderSessionMarkdown(sample("C:/p", { events: [] }), { exportedAt: NOW })).events, []);
  assert.equal(unescapeInline("a\\*b\\_c &lt;d&gt; &amp;amp; \\" + BT), "a*b_c <d> &amp; " + BT);
});

test("가져오기: docs/agenthub 목록과 파일 읽기는 폴더 안의 문서만 다룬다", async (t) => {
  const dir = await fixture(t);
  const exported = await exportSession(sample(dir), { now: NOW });
  await fs.writeFile(path.join(dir, "docs", "agenthub", "notes.md"), "# 메모\n\n그냥 메모");
  const records = await listRecords(dir);
  assert.deepEqual(records.map((r) => [r.fileName, r.title, r.agent, r.exportedAt]), [[exported.fileName, "가방 *UI* [개편]", "codex", NOW]]);
  assert.deepEqual(await listRecords(path.join(dir, "없음")), []);
  const read = await readRecord(dir, exported.fileName);
  assert.equal(read.markdown, exported.markdown);
  for (const bad of ["../secret.md", "..\\x.md", "a/b.md", ".hidden.md", "x.txt"]) await assert.rejects(readRecord(dir, bad), (e) => e.code === "IMPORT_PATH");
  await assert.rejects(readRecord(dir, "없는파일.md"), (e) => e.code === "IMPORT_MISSING");
  await fs.writeFile(path.join(dir, "secret.png"), PNG);
  assert.equal(await readRecordImage(read.folder, "../../secret.png"), null);
  assert.equal(await readRecordImage(read.folder, "https://example.com/a.png"), null);
});

test("가져오기: 내보낸 세션을 이미지와 함께 새 세션으로 가져오고 이어받기를 붙인다", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-import-"));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false, deps: { logger: { log() {}, error() {} } },
    config: { port: 0, cli: { claude: "", codex: "" }, projects: [{ name: "project", path: project }], hiddenProjects: [], hiddenSessions: [], skillLayout: {} } });
  t.after(async () => { await hub.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const { sessions } = hub.services;
  const original = await sessions.create({ projectPath: project, agent: "codex", title: "원래 세션" });
  const image = await sessions.uploadAttachment(original.id, { name: "화면.png", mimeType: "image/png", data: PNG.toString("base64") });
  const stored = hub.store.get(original.id);
  stored.events.push({ seq: 0, ts: ts(1), kind: "user", text: "버튼을 고쳐", attachments: [image] }, { seq: 1, ts: ts(2), kind: "text", text: "절반 했습니다\n\n검토 요청" });
  const exported = await sessions.exportRecord(original.id);

  const listed = await sessions.listRecords({ projectPath: project });
  assert.deepEqual(listed.map((r) => [r.fileName, r.location]), [[exported.fileName, "project"]]);
  const created = await sessions.importRecord({ projectPath: project, fileName: exported.fileName, agent: "claude" });
  const session = hub.store.get(created.id);
  assert.equal(session.title, "원래 세션");
  assert.equal(session.agent, "claude");
  assert.deepEqual(session.events.slice(0, 2).map((e) => [e.seq, e.kind, e.text]), [[0, "user", "버튼을 고쳐"], [1, "text", "절반 했습니다\n\n검토 요청"]]);
  const [copied] = session.events[0].attachments;
  assert.equal(copied.name, "화면.png");
  assert.match(copied.url, new RegExp("/api/sessions/" + created.id + "/attachments/"));
  assert.deepEqual(sessions.attachmentContent(created.id, copied.id).bytes, PNG);
  assert.match(session.events.at(-1).text, /2건을 가져왔습니다\. 첫 요청에 기록을 붙여/);
  assert.match(session.handover, /^\[내보낸 기록에서 가져온 작업\][\s\S]*버튼을 고쳐[\s\S]*절반 했습니다/);
  assert.match(sessions.composeInput(session, "이어서 해"), /가져온 작업[\s\S]*이어서 해$/);
  assert.equal(session.importedFrom.sessionId, original.id);

  const uploaded = await sessions.importRecord({ projectPath: project, markdown: await fs.readFile(exported.path, "utf8"), fileName: "받은기록.md", carry: false, title: "새 제목" });
  const second = hub.store.get(uploaded.id);
  assert.equal(second.title, "새 제목");
  assert.equal(second.agent, "codex", "AI를 고르지 않으면 문서의 AI를 쓴다");
  assert.equal(second.handover, undefined);
  assert.equal(second.events[0].attachments, undefined);
  assert.match(second.events.at(-1).text, /첨부 1개는 찾지 못해 빠졌습니다/);

  await assert.rejects(sessions.importRecord({ projectPath: project, markdown: "그냥 메모" }), /내보낸 기록 문서가 아닙니다/);
  await assert.rejects(sessions.importRecord({ projectPath: project, fileName: "../x.md" }), /이름이 올바르지 않습니다/);
  await assert.rejects(sessions.importRecord({ projectPath: project, fileName: exported.fileName, location: "session" }), /위치가 올바르지 않습니다/);
});

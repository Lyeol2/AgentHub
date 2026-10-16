import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildBundle, parseBundle, bundleEvent, recordReadText } from "../server/session-bundle.mjs";
import { parseRecord } from "../server/session-import.mjs";
import { createHub } from "../server/bootstrap.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ts = (n) => `2026-10-15T09:00:0${n}.000Z`;

async function hubFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-bundle-"));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false, deps: { logger: { log() {}, error() {} } },
    config: { port: 0, cli: { claude: "", codex: "" }, projects: [{ name: "project", path: project }], hiddenProjects: [], hiddenSessions: [], skillLayout: {} } });
  t.after(async () => { await hub.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { hub, project, sessions: hub.services.sessions };
}

test(".agenthub: 보이는 필드만 담고 비밀값은 가린다", async () => {
  const event = bundleEvent({ kind: "text", text: "키 sk-ant-abcdefghijklmnop", raw: { x: 1 }, usage: 3, ts: ts(1) });
  assert.deepEqual(event, { kind: "text", text: "키 [가림]", ts: ts(1) });
  assert.equal(bundleEvent({ kind: "usage", text: "x" }), null);
  assert.equal(bundleEvent({ kind: "question", status: "pending", questions: [{ question: "어느 쪽?", options: ["A"] }] }).status, "skipped");
  const bundle = await buildBundle({ id: "s1", title: "제목", agent: "codex", events: [{ kind: "user", text: "해", message: true, attachments: [{ id: "f1", name: "a.png", mimeType: "image/png" }] }] },
    { readAttachment: () => PNG, now: new Date(ts(2)) });
  assert.equal(bundle.format, "agenthub-session");
  assert.equal(bundle.attachments[0].data, PNG.toString("base64"));
  const parsed = parseBundle(JSON.stringify(bundle));
  assert.equal(parsed.title, "제목");
  assert.equal(parsed.meta.agent, "codex");
  assert.deepEqual(parsed.events[0].files, [{ name: "a.png", mimeType: "image/png", data: PNG.toString("base64") }]);
  assert.equal(parsed.events[0].message, true);
  assert.throws(() => parseBundle("{}"), /세션 파일\(\.agenthub\)이 아닙니다/);
  assert.throws(() => parseBundle(JSON.stringify({ ...bundle, version: 99 })), /새 버전/);
  assert.equal(parseRecord(JSON.stringify(bundle), "받은.agenthub").format, "agenthub");
  assert.match(recordReadText("x.agenthub", parsed), /^\[다른 세션의 작업 기록: x\.agenthub\][\s\S]*\[사용자\]\n해/);
});

test(".agenthub: 확인 없이 실행하는 권한은 가져올 때 되살리지 않는다", async (t) => {
  const { project, hub, sessions } = await hubFixture(t);
  for (const [agent, permission, fallback] of [["codex", "danger-full-access", "workspace-write"], ["codex", "auto-review", "workspace-write"], ["claude", "bypassPermissions", "acceptEdits"]]) {
    const original = await sessions.create({ projectPath: project, agent, title: "위험한 " + permission, permission });
    hub.store.get(original.id).events.push({ seq: 0, ts: ts(1), kind: "user", text: "해" });
    const exported = await sessions.exportRecord(original.id, { format: "agenthub" });
    const created = await sessions.importRecord({ projectPath: project, fileName: exported.fileName });
    assert.equal(hub.store.get(created.id).permission, fallback, permission);
  }
});

test(".agenthub: 내보내고 새 세션으로 불러오거나 다른 세션에 읽힌다", async (t) => {
  const { hub, project, sessions } = await hubFixture(t);
  const original = await sessions.create({ projectPath: project, agent: "codex", title: "원래 세션", permission: "read-only", role: "리뷰만 한다" });
  const image = await sessions.uploadAttachment(original.id, { name: "화면.png", mimeType: "image/png", data: PNG.toString("base64") });
  const note = await sessions.uploadAttachment(original.id, { name: "메모.txt", mimeType: "text/plain", data: Buffer.from("메모").toString("base64") });
  hub.store.get(original.id).events.push(
    { seq: 0, ts: ts(1), kind: "user", text: "버튼을 고쳐", attachments: [image, note] },
    { seq: 1, ts: ts(2), kind: "text", text: "절반 했습니다\n\n검토 요청" });

  const exported = await sessions.exportRecord(original.id, { format: "agenthub" });
  assert.equal(exported.format, "agenthub");
  assert.match(exported.relativePath, /^docs\/agenthub\/.+\.agenthub$/);
  const listed = await sessions.listRecords({ projectPath: project });
  assert.deepEqual(listed.map((r) => [r.fileName, r.format, r.agent]), [[exported.fileName, "agenthub", "codex"]]);

  // 새 세션으로 불러오기: 같은 AI면 권한·역할도 되살리고 이미지 외 첨부도 함께 가져온다.
  const created = await sessions.importRecord({ projectPath: project, fileName: exported.fileName });
  const restored = hub.store.get(created.id);
  assert.equal(restored.agent, "codex");
  assert.equal(restored.permission, "read-only");
  assert.equal(restored.role, "리뷰만 한다");
  assert.deepEqual(restored.events[0].attachments.map((a) => a.name), ["화면.png", "메모.txt"]);
  assert.deepEqual(sessions.attachmentContent(created.id, restored.events[0].attachments[1].id).bytes, Buffer.from("메모"));
  assert.match(restored.handover, /버튼을 고쳐/);

  // 업로드한 파일 내용으로도 불러온다. AI를 바꾸면 권한은 그 AI의 기본값이다.
  const content = await fs.readFile(exported.path, "utf8");
  const uploaded = await sessions.importRecord({ projectPath: project, content, fileName: "받은.agenthub", agent: "claude", carry: false });
  assert.equal(hub.store.get(uploaded.id).permission, "acceptEdits");

  // 다른 세션에 읽히기: 다음 요청 하나에만 붙는다.
  const reader = await sessions.create({ projectPath: project, agent: "claude", title: "읽는 세션" });
  const read = await sessions.readRecordInto(reader.id, { fileName: exported.fileName });
  assert.equal(read.events, 2);
  const session = hub.store.get(reader.id);
  assert.match(session.events.at(-1).text, /읽혔습니다\. 다음 요청에 함께 보냅니다/);
  assert.match(sessions.composeInput(session, "이걸 이어서 해"), /다른 세션의 작업 기록[\s\S]*절반 했습니다[\s\S]*이걸 이어서 해$/);
  assert.doesNotMatch(sessions.composeInput(session, "다음"), /다른 세션의 작업 기록/);
  await assert.rejects(sessions.readRecordInto(reader.id, { content: "그냥 메모", fileName: "x.md" }), /내보낸 기록 문서가 아닙니다/);
  await assert.rejects(sessions.readRecordInto(reader.id, { fileName: "../x.agenthub" }), /이름이 올바르지 않습니다/);
});

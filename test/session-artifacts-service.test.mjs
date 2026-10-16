import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-artifact-service-"));
process.env.AGENTHUB_DATA = path.join(root, "config");
const { createSessionService } = await import("../server/application/sessions.mjs");
const { buildBundle, parseBundle } = await import("../server/session-bundle.mjs");
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("agenthub-artifact-service-"));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(root, "case-"));
  const session = { id: "artifact-service", agent: "codex", chat: true, projectPath: cwd, cwd, events: [], state: "idle" };
  const calls = { sends: [], injected: [], queued: [] };
  const runner = {
    isRunning: () => session.state === "running", canInject: () => true,
    send: (s, prompt, cli, input, meta) => { calls.sends.push({ prompt, input, meta }); s.events.push({ kind: "user", text: prompt, ...meta }); },
    inject: (s, prompt, meta, input) => { calls.injected.push({ prompt, input, meta }); s.events.push({ kind: "user", text: prompt, ...meta, injected: true }); },
  };
  const otherSession = { id: "other-session", projectPath: cwd }, otherTask = { id: "task-123", projectPath: cwd };
  const service = createSessionService({
    config: {}, dataDir: path.join(cwd, "data"), store: { get: (id) => id === session.id ? session : id === otherSession.id ? otherSession : null },
    runner, chain: { enqueue: (s, prompt, meta) => calls.queued.push({ prompt, meta }) },
    mcpDir: path.join(cwd, "mcp"), cliPaths: () => ({ codex: "unused" }),
    projects: { ensureProject() {}, projectSessions: () => [session] },
    tasks: () => ({ get: (id) => id === otherTask.id ? otherTask : null }),
  });
  const file = path.join(cwd, "source.js"); fs.writeFileSync(file, "const example = true;");
  return { session, service, calls, file, otherSession, otherTask };
}

test("session artifacts service: normal, steering and queued messages preserve validated references", (t) => {
  const { session, service, calls, file } = fixture(t);
  const body = { prompt: "@source.js 확인", references: [{ label: "source.js", path: "source.js" }] };
  assert.deepEqual(service.sendMessage(session.id, body), { ok: true });
  assert.deepEqual(session.events[0].references, body.references);
  assert.equal(calls.sends[0].input.includes("@source.js"), true);
  session.state = "running";
  assert.deepEqual(service.sendMessage(session.id, { ...body, mode: "steer" }), { injected: true });
  assert.deepEqual(session.events[1].references, session.events[0].references);
  assert.deepEqual(service.sendMessage(session.id, body), { queued: true });
  assert.deepEqual(calls.queued[0].meta.references, session.events[0].references);
  const count = calls.sends.length;
  assert.throws(() => service.sendMessage(session.id, { ...body, references: [{ label: "bad", path: "missing.js" }] }), { status: 404 });
  assert.equal(calls.sends.length, count);
});

test("session artifacts service: entity references retain URIs and validate existence and project", (t) => {
  const { session, service, otherSession } = fixture(t);
  for (const uri of ["agenthub://session/other-session", "agenthub://task/task-123"]) {
    const references = [{ label: "참조 대상", path: uri }];
    assert.deepEqual(service.sendMessage(session.id, { prompt: `@${uri} 확인`, references }), { ok: true });
    assert.deepEqual(session.events.at(-1).references, references);
  }
  assert.throws(() => service.sendMessage(session.id, { prompt: "@agenthub://session/missing", references: [{ label: "없음", path: "agenthub://session/missing" }] }), { status: 404 });
  assert.throws(() => service.sendMessage(session.id, { prompt: "@agenthub://session/../secret", references: [{ label: "잘못된 대상", path: "agenthub://session/../secret" }] }), { status: 400 });
  otherSession.projectPath = path.dirname(session.projectPath);
  assert.throws(() => service.sendMessage(session.id, { prompt: "@agenthub://session/other-session", references: [{ label: "다른 프로젝트", path: "agenthub://session/other-session" }] }), { status: 403 });
});

test("session artifacts service: preview enforces session existence, lock and supported HTML size", (t) => {
  const { session, service } = fixture(t);
  fs.writeFileSync(path.join(session.cwd, "screen.html"), "<h1>화면</h1>");
  const summary = service.artifact(session.id, "screen.html:12", { summary: true });
  assert.equal(summary.kind, "html");
  assert.equal(summary.line, 12);
  for (const field of ["realPath", "text", "previewHtml"]) assert.equal(Object.hasOwn(summary, field), false);
  assert.match(service.artifactPreview(session.id, "screen.html"), /화면/);
  assert.throws(() => service.artifactPreview(session.id, "source.js"), { status: 415 });
  assert.throws(() => service.artifact("unknown", "screen.html"), { status: 404 });
  session.locked = true;
  assert.throws(() => service.artifact(session.id, "screen.html"), { status: 423 });
});

test("session artifacts service: bundle round trips retain references without arbitrary metadata", async (t) => {
  const { session, file } = fixture(t);
  session.events.push({ kind: "user", text: `@${file}`, references: [{ label: "source.js", path: file, hidden: "omit" }, { label: "bad\nname", path: file }, { label: 42, path: file }] });
  const bundle = await buildBundle(session);
  assert.deepEqual(bundle.events[0].references, [{ label: "source.js", path: file }]);
  assert.deepEqual(parseBundle(JSON.stringify(bundle)).events[0].references, bundle.events[0].references);
});

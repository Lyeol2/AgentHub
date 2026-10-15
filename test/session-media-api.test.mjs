import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHub } from "../server/bootstrap.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAZ0AAAAASUVORK5CYII=";
class FakeRunner extends EventEmitter {
  calls = [];
  running = new Set();
  isRunning(id) { return this.running.has(id); }
  canInject(s) { return this.running.has(s.id); }
  hasPrompt() { return false; }
  append(s, e) {
    const event = { seq: s.events.length, ts: new Date().toISOString(), ...e };
    s.events.push(event);
    this.emit("event", s.id, event);
  }
  send(s, prompt, cli, input, meta) { this.calls.push({ id: s.id, prompt, cli, input, meta }); this.running.add(s.id); s.state = "running"; }
  inject(s, prompt, meta) { this.calls.push({ id: s.id, prompt, meta, injected: true }); }
  setState(s, state) { s.state = state; this.emit("state", s.id, state, null); }
  stop(s) { this.running.delete(s.id); return true; }
  stopAll() { this.running.clear(); }
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-media-api-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const runner = new FakeRunner();
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false, deps: { runner, cliPaths: () => ({ claude: "fixture", codex: "fixture" }), logger: { log() {} } } });
  for (const id of ["session-a", "session-b", "chat"]) hub.store.add({
    id, title: id, agent: "claude", permission: "acceptEdits", chat: id === "chat", state: "idle",
    projectPath: id === "chat" ? null : project, projectName: "project", cwd: project,
    worktree: null, events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await hub.start();
  t.after(async () => {
    await hub.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const api = async (method, url, body) => {
    const res = await fetch("http://127.0.0.1:" + hub.port + "/api" + url, {
      method, headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const upload = (id = "session-a", data = PNG) => api("POST", "/sessions/" + id + "/attachments", { name: "화면.png", mimeType: "image/png", data });
  return { root, project, hub, runner, api, upload };
}

test("media api: upload, binary image retrieval and session ownership", async (t) => {
  const f = await fixture(t);
  const image = await f.upload();
  assert.equal(image.status, 200);
  assert.equal(Object.hasOwn(image.body, "path"), false);
  const get = await fetch("http://127.0.0.1:" + f.hub.port + image.body.url);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("Content-Type"), "image/png");
  assert.equal(get.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), Buffer.from(PNG, "base64"));
  assert.equal((await f.api("GET", "/sessions/session-b/attachments/" + image.body.id)).status, 404);
  assert.equal((await f.api("POST", "/sessions/session-b/messages", { prompt: "x", attachments: [image.body.id] })).status, 404);
  const bad = await f.api("POST", "/sessions/session-a/messages", { prompt: "x", attachments: [{ path: "C:/secret" }] });
  assert.equal(bad.status, 400);
  assert.equal(f.runner.calls.length, 0);
  const noHeader = await fetch("http://127.0.0.1:" + f.hub.port + "/api/sessions/session-a/attachments", { method: "POST", body: "{}" });
  assert.equal(noHeader.status, 403);
});

test("media api: image-only messages and queued/steered images reach the runner", async (t) => {
  const f = await fixture(t);
  const image = (await f.upload()).body;
  assert.equal((await f.api("POST", "/sessions/session-a/messages", { prompt: "", attachments: [image.id] })).status, 200);
  const first = f.runner.calls[0];
  assert.match(first.prompt, /이미지/);
  assert.equal(first.meta.attachments[0].id, image.id);
  assert.ok(fs.existsSync(first.meta.attachments[0].path));
  const queued = await f.api("POST", "/sessions/session-a/messages", { prompt: "나중에", attachments: [image.id], mode: "queue" });
  assert.deepEqual(queued.body, { queued: true });
  const detail = (await f.api("GET", "/sessions/session-a")).body;
  assert.equal(detail.queue[0].attachments[0].id, image.id);
  assert.equal(Object.hasOwn(detail.queue[0].attachments[0], "path"), false);
  const steered = await f.api("POST", "/sessions/session-a/messages", { prompt: "지금", attachments: [image.id], mode: "steer" });
  assert.deepEqual(steered.body, { injected: true });
  assert.equal(f.runner.calls.at(-1).meta.attachments[0].id, image.id);
  assert.equal((await f.api("POST", "/sessions/session-a/queue/" + detail.queue[0].id, { action: "steer" })).status, 200);
  assert.equal(f.runner.calls.at(-1).meta.attachments[0].id, image.id);
  assert.equal((await f.api("POST", "/sessions/session-b/messages", { prompt: " ", attachments: [] })).status, 400);
  assert.equal((await f.api("POST", "/sessions/session-b/messages", { attachments: Array(5).fill(image.id) })).status, 400);
});

test("media api: image uploads have a separate bounded body limit", async (t) => {
  const f = await fixture(t);
  const large = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(1_100_000)]).toString("base64");
  assert.equal((await f.upload("session-a", large)).status, 200);
  assert.equal((await f.api("POST", "/sessions/session-a/messages", { prompt: "가".repeat(400_000) })).status, 413);
});

test("media api: export includes copied images in the selected session work folder", async (t) => {
  const f = await fixture(t);
  const image = (await f.upload()).body;
  const session = f.hub.store.get("session-a");
  const worktree = path.join(f.root, "worktree");
  fs.mkdirSync(worktree);
  session.cwd = worktree;
  session.worktree = { dir: worktree, branch: "agenthub/example" };
  session.events.push({ kind: "user", text: "이 화면을 고친다", attachments: [image] }, { kind: "text", text: "수정했습니다." });
  const exported = await f.api("POST", "/sessions/session-a/export", {});
  assert.equal(exported.status, 200);
  assert.equal(exported.body.format, "markdown");
  assert.equal(path.dirname(exported.body.path), path.join(worktree, "docs", "agenthub"));
  const text = fs.readFileSync(exported.body.path, "utf8");
  assert.match(text, /이 화면을 고친다/);
  assert.match(text, /수정했습니다/);
  assert.match(text, /agenthub\/example/);
  assert.match(text, /\.assets/);
  assert.equal(text.includes(image.url), false);
  assert.equal(text.includes(PNG), false);
  const files = fs.readdirSync(path.dirname(exported.body.path));
  const asset = files.find((name) => name.endsWith(".assets"));
  assert.equal(fs.readdirSync(path.join(path.dirname(exported.body.path), asset)).length, 1);
  assert.equal((await f.api("POST", "/sessions/chat/export", {})).status, 400);
  assert.equal((await f.api("DELETE", "/sessions/session-a")).status, 200);
  assert.equal(fs.existsSync(path.join(f.root, "data", "attachments", "session-a")), false);
  assert.ok(fs.existsSync(exported.body.path));
});


test("media api: export freezes its event and attachment snapshot before asynchronous file work", async (t) => {
  const f = await fixture(t);
  const first = (await f.upload()).body;
  const second = (await f.api("POST", "/sessions/session-a/attachments", { name: "late-image.png", mimeType: "image/png", data: PNG })).body;
  const session = f.hub.store.get("session-a");
  session.events.push({ kind: "user", text: "snapshot-original", attachments: [first] });
  const pending = f.hub.services.sessions.exportRecord(session.id);
  session.events.push({ kind: "user", text: "snapshot-late", attachments: [second] });
  const result = await pending;
  const markdown = fs.readFileSync(result.path, "utf8");
  assert.match(markdown, /snapshot-original/);
  assert.equal(markdown.includes("snapshot-late"), false);
  assert.equal(markdown.includes("late-image"), false);
});

test("media api: recreating a session removes its old private uploads", async (t) => {
  const f = await fixture(t);
  const image = (await f.upload()).body;
  const recreated = await f.api("POST", "/sessions/session-a/recreate", {});
  assert.equal(recreated.status, 200);
  assert.notEqual(recreated.body.id, "session-a");
  assert.equal(fs.existsSync(path.join(f.root, "data", "attachments", "session-a")), false);
  assert.equal((await f.api("GET", "/sessions/session-a/attachments/" + image.id)).status, 404);
  assert.equal(recreated.body.eventCount, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-bootstrap-"));
  const hubs = [];
  t.after(async () => {
    for (const hub of hubs) await hub.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, hubs };
}

test("bootstrap: 모듈 import만으로 서버를 열거나 데이터 폴더를 만들지 않는다", (t) => {
  const { root } = temporary(t);
  const dataDir = path.join(root, "untouched");
  const moduleUrl = new URL("../server/bootstrap.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    process.env.AGENTHUB_DATA = ${JSON.stringify(dataDir)};
    const { createHub } = await import(${JSON.stringify(moduleUrl)});
    assert.equal(typeof createHub, "function");
    assert.equal(fs.existsSync(${JSON.stringify(dataDir)}), false);
    console.log("imported-without-starting");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "imported-without-starting");
  assert.equal(fs.existsSync(dataDir), false);
});

test("bootstrap: 서버 생성·시작·종료를 명시적으로 제어한다", async (t) => {
  const { root, hubs } = temporary(t);
  const { createHub } = await import("../server/bootstrap.mjs");
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false });
  hubs.push(hub);
  assert.equal(hub.server.listening, false);
  await Promise.all([hub.start(), hub.start()]);
  assert.equal(hub.server.listening, true);
  assert.ok(hub.port > 0);
  const response = await fetch(`http://127.0.0.1:${hub.port}/api/sessions`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  await hub.shutdown();
  assert.equal(hub.server.listening, false);
});

test("bootstrap: 같은 프로세스의 서버들은 세션·연결·명령·설정을 공유하지 않는다", async (t) => {
  const { root, hubs } = temporary(t);
  const { createHub } = await import("../server/bootstrap.mjs");
  const firstDir = path.join(root, "first");
  const secondDir = path.join(root, "second");
  const a = createHub({ dataDir: firstDir, port: 0, warmup: false });
  const b = createHub({ dataDir: secondDir, port: 0, warmup: false });
  hubs.push(a, b);
  await Promise.all([a.start(), b.start()]);
  assert.notEqual(a.port, b.port);
  const session = (title) => ({
    id: "same-session", title, agent: "claude", chat: false, state: "idle", events: [],
    cwd: root, projectPath: root, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  });
  a.store.add(session("first"));
  b.store.add(session("second"));
  a.links.add({ id: "first-link", from: "same-session", to: "peer", enabled: true });
  a.commands.add({ id: "cmd-first", title: "first", state: "idle", projectPath: root });
  assert.deepEqual(b.links.list(), []);
  assert.deepEqual(b.commands.list(), []);
  for (const [hub, title] of [[a, "first"], [b, "second"]]) {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/sessions`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map((s) => s.title), [title]);
  }
  const registered = await fetch(`http://127.0.0.1:${a.port}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
    body: JSON.stringify({ path: root, name: "first-only" }),
  });
  assert.equal(registered.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(firstDir, "config.json"), "utf8")).projects[0].name, "first-only");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(secondDir, "config.json"), "utf8")).projects, []);
  a.runner.emit("limit", "claude", { rateLimitType: "five_hour", utilization: 0.25 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(firstDir, "limits.json"), "utf8")).claude.five_hour.usedPercent, 25);
  assert.equal(fs.existsSync(path.join(secondDir, "limits.json")), false);
  b.runner.emit("limit", "claude", { rateLimitType: "five_hour", utilization: 0.75 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(secondDir, "limits.json"), "utf8")).claude.five_hour.usedPercent, 75);
  assert.equal(JSON.parse(fs.readFileSync(path.join(firstDir, "limits.json"), "utf8")).claude.five_hour.usedPercent, 25);
  assert.equal(fs.existsSync(path.join(firstDir, "commands.json")), true);
  assert.equal(fs.existsSync(path.join(secondDir, "commands.json")), false);
});

test("bootstrap: 시작하기 전 종료와 반복 종료는 안전하고 재시작은 거절한다", async (t) => {
  const { root, hubs } = temporary(t);
  const { createHub } = await import("../server/bootstrap.mjs");
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false });
  hubs.push(hub);
  await Promise.all([hub.shutdown(), hub.shutdown()]);
  assert.equal(hub.server.listening, false);
  await assert.rejects(hub.start(), /종료/);
});

test("bootstrap: a failed shutdown save can be retried without disposing twice", async t => {
  const { root, hubs } = temporary(t);
  const { createHub } = await import("../server/bootstrap.mjs");
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false });
  hubs.push(hub);
  await hub.start();
  const dispose = t.mock.method(hub.chain, "dispose");
  const close = hub.store.close.bind(hub.store);
  let attempts = 0;
  t.mock.method(hub.store, "close", async () => {
    if (++attempts === 1) throw new Error("temporary disk failure");
    await close();
  });
  await assert.rejects(hub.shutdown(), /temporary disk failure/);
  assert.equal(hub.server.listening, false);
  await hub.shutdown();
  assert.equal(attempts, 2);
  assert.equal(dispose.mock.callCount(), 1);
});

test("bootstrap: SSE 구독과 상태 이벤트는 서버 인스턴스별로 분리된다", async (t) => {
  const { root, hubs } = temporary(t);
  const { createHub } = await import("../server/bootstrap.mjs");
  const a = createHub({ dataDir: path.join(root, "first"), port: 0, warmup: false });
  const b = createHub({ dataDir: path.join(root, "second"), port: 0, warmup: false });
  hubs.push(a, b);
  await Promise.all([a.start(), b.start()]);
  const abortA = new AbortController();
  const abortB = new AbortController();
  try {
    const [responseA, responseB] = await Promise.all([
      fetch(`http://127.0.0.1:${a.port}/api/stream`, { signal: abortA.signal }),
      fetch(`http://127.0.0.1:${b.port}/api/stream`, { signal: abortB.signal }),
    ]);
    const readerA = responseA.body.getReader();
    const readerB = responseB.body.getReader();
    assert.match(new TextDecoder().decode((await readerA.read()).value), /connected/);
    assert.match(new TextDecoder().decode((await readerB.read()).value), /connected/);
    const nextA = readerA.read();
    const nextB = readerB.read().then(() => "received", () => "closed");
    a.runner.emit("state", "first-only", "running", "2026-01-01T00:00:00.000Z");
    const update = new TextDecoder().decode((await nextA).value);
    assert.match(update, /event: state/);
    assert.match(update, /first-only/);
    assert.equal(await Promise.race([nextB, new Promise((resolve) => setTimeout(() => resolve("quiet"), 100))]), "quiet");
  } finally {
    abortA.abort();
    abortB.abort();
  }
});

test("bootstrap: listen 완료 전에 종료해도 서버가 뒤늦게 열리지 않는다", async (t) => {
  const { root, hubs } = temporary(t);
  const { createHub } = await import("../server/bootstrap.mjs");
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false });
  hubs.push(hub);
  const starting = hub.start();
  const closing = hub.shutdown();
  await Promise.allSettled([starting]);
  await closing;
  assert.equal(hub.server.listening, false);
  await assert.rejects(hub.start(), /종료/);
});

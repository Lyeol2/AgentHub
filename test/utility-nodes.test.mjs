import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHub } from "../server/bootstrap.mjs";
import { CommandStore, checkCommand } from "../server/commands.mjs";
import { MAX_HOPS } from "../server/chain.mjs";
import { finalAnswer, writeMessageOutput, readMessageOutput } from "../server/utility-output.mjs";

class FakeRunner extends EventEmitter {
  calls = [];
  running = new Set();
  isRunning(id) { return this.running.has(id); }
  append(session, event) { session.events.push(event); }
  send(session, prompt, cli, input, meta) { this.calls.push({ id: session.id, prompt, input, meta }); this.running.add(session.id); }
  stopAll() { this.running.clear(); }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-utility-nodes-"));
  const project = path.join(root, "project");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(project);
  fs.mkdirSync(worktree);
  const runner = new FakeRunner();
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false,
    deps: { runner, cliPaths: () => ({ claude: "fake-no-process", codex: "fake-no-process" }), logger: { log() {} } } });
  for (const id of ["source", "target", "other"]) hub.store.add({
    id, title: id, agent: "claude", permission: "acceptEdits", state: "idle", locked: id === "target",
    projectPath: project, projectName: "project", cwd: id === "source" ? worktree : project,
    events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await hub.start();
  t.after(async () => {
    await hub.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = (suffix) => `http://127.0.0.1:${hub.port}/api${suffix}`;
  const api = async (method, suffix, body) => {
    const response = await fetch(url(suffix), { method,
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = async (kind, extra = {}) => {
    const response = await api("POST", "/commands", { kind, projectPath: project, title: kind, ...(kind === "button" ? { prompt: "작업을 실행하세요." } : {}), ...extra });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const link = async (from, to, extra = {}) => {
    const response = await api("POST", "/links", { from, to, ...extra });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const complete = async (text, ok = true) => {
    const source = hub.store.get("source");
    source.events.push({ kind: "user", text: "작업" }, { kind: "text", text: "진행 중인 설명" }, { kind: "tool", text: "ignored" }, { kind: "text", text }, { kind: "result", text: "턴 완료" });
    await hub.chain.onTurnEnd(source, ok);
  };
  return { root, project, worktree, hub, runner, api, url, create, link, complete };
}

test("utility nodes: kinds validate without requiring a shell and cannot change after creation", async (t) => {
  assert.throws(() => checkCommand({ kind: "unknown" }));
  assert.throws(() => checkCommand({ kind: null }));
  assert.throws(() => checkCommand({ kind: "button", prompt: " " }));
  assert.throws(() => checkCommand({ kind: "button", prompt: "x".repeat(20001) }));
  assert.throws(() => checkCommand({ kind: "markdown", cwdMode: "outside" }));
  assert.equal(checkCommand({ kind: "markdown" }).cwdMode, "source");
  assert.equal(checkCommand({ command: "echo existing" }).kind, undefined);
  const f = await fixture(t);
  const button = await f.create("button", { pos: { x: 24, y: 50 } });
  assert.equal(button.command, undefined);
  assert.deepEqual(button.pos, { x: 24, y: 50 });
  assert.equal((await f.api("PUT", `/commands/${button.id}`, { kind: "markdown" })).status, 400);
  assert.equal((await f.api("PUT", `/commands/${button.id}`, { title: "갱신", prompt: "새 요청" })).body.prompt, "새 요청");
  const restored = new CommandStore({ dataDir: path.join(f.root, "data") }).get(button.id);
  assert.equal(restored.kind, "button");
  assert.equal(restored.prompt, "새 요청");
});

test("utility nodes: a button runs linked locked sessions with its prompt and queues while busy", async (t) => {
  const f = await fixture(t);
  const button = await f.create("button", { prompt: "검토하세요." });
  await f.link(button.id, "target", { note: "API도 확인하세요." });
  const first = await f.api("POST", `/commands/${button.id}/run`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.state, "success");
  assert.deepEqual(f.runner.calls.map(({ id, prompt }) => ({ id, prompt })), [{ id: "target", prompt: "검토하세요.\n\nAPI도 확인하세요." }]);
  assert.equal(f.runner.calls[0].meta.from, button.id);
  assert.equal(f.hub.store.get("target").locked, true);
  await f.api("POST", `/commands/${button.id}/run`, {});
  assert.equal(f.runner.calls.length, 1);
  assert.equal(f.hub.chain.pending("target"), 1);
  assert.equal(f.hub.chain.runs.size, 0);
});

test("utility nodes: button approvals snapshot the prompt and retain routing conditions", async (t) => {
  const f = await fixture(t);
  const button = await f.create("button", { prompt: "검토 요청" });
  const approved = await f.link(button.id, "target", { when: "keyword", keyword: "검토 요청", approve: true });
  await f.link(button.id, "other", { when: "success" });
  await f.api("POST", `/commands/${button.id}/run`, {});
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.hub.links.get(approved.id).pending.answer, "검토 요청");
  await f.api("PUT", `/commands/${button.id}`, { prompt: "바뀐 요청" });
  assert.equal((await f.api("POST", `/links/${approved.id}/decide`, { action: "approve" })).status, 200);
  assert.deepEqual(f.runner.calls.map(({ id, prompt }) => ({ id, prompt })), [{ id: "target", prompt: "검토 요청" }]);
});

test("utility nodes: graph endpoints enforce manual button sources and terminal Markdown sinks", async (t) => {
  const f = await fixture(t);
  const button = await f.create("button");
  const markdown = await f.create("markdown");
  const shell = (await f.api("POST", "/commands", { projectPath: f.project, command: "echo existing" })).body;
  for (const [from, to] of [["source", button.id], [markdown.id, "target"]]) {
    assert.equal((await f.api("POST", "/links", { from, to })).status, 400);
  }
  for (const [from, to] of [[button.id, markdown.id], [shell.id, markdown.id], [button.id, shell.id]]) {
    assert.equal((await f.api("POST", "/links", { from, to })).status, 200);
  }
  assert.equal((await f.api("POST", `/commands/${markdown.id}/run`, {})).status, 400);
  await f.hub.chain.deliver({ from: "source", to: button.id }, 0);
  await f.hub.chain.deliver({ from: markdown.id, to: "target" }, 0);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.hub.commands.get(button.id).state, "idle");
});

test("utility nodes: Markdown saves the complete final message verbatim as unique source-worktree files", async (t) => {
  const f = await fixture(t);
  const markdown = await f.create("markdown", { title: "../CON:<완료>/문서" });
  await f.link("source", markdown.id, { note: "파일에는 이 연결 메모가 들어가지 않아야 함" });
  const text = "  # 완료\r\n\r\n" + "매우 긴 원문\n".repeat(2500) + "```js\nconst x = '<b>원문</b>';\n```\n\n ";
  await f.complete(text);
  const output = await f.api("GET", `/commands/${markdown.id}/output`);
  assert.equal(output.status, 200);
  assert.equal(output.body.text, text);
  assert.equal(fs.readFileSync(output.body.path, "utf8"), text);
  assert.equal(path.dirname(output.body.path), path.join(f.worktree, "docs", "agenthub", "outputs"));
  assert.equal(f.runner.calls.length, 0);
  const node = f.hub.commands.get(markdown.id);
  assert.equal(node.state, "success");
  assert.equal(node.lastRun.originId, "source");
  assert.equal(node.lastRun.output.path, output.body.path);
  assert.ok(node.lastRun.tail.length < text.length);
  await f.complete("새 메시지");
  assert.notEqual(node.lastRun.output.path, output.body.path);
  assert.equal(fs.readFileSync(output.body.path, "utf8"), text);
  const downloaded = await fetch(f.url(`/commands/${markdown.id}/output/file`));
  assert.equal(await downloaded.text(), "새 메시지");
  assert.match(downloaded.headers.get("Content-Type"), /^text\/markdown/);
  assert.match(downloaded.headers.get("Content-Disposition"), /^attachment;/);
  const persisted = new CommandStore({ dataDir: path.join(f.root, "data") }).get(markdown.id);
  assert.equal(persisted.kind, "markdown");
  assert.equal(readMessageOutput(persisted).text, "새 메시지");
});

test("utility nodes: Markdown approval keeps the original full answer and project output directory", async (t) => {
  const f = await fixture(t);
  const markdown = await f.create("markdown", { cwdMode: "project" });
  const link = await f.link("source", markdown.id, { approve: true });
  const text = "  " + "오래된 완료 메시지\n".repeat(2000) + "  ";
  await f.complete(text);
  assert.equal((await f.api("GET", `/commands/${markdown.id}/output`)).status, 404);
  f.hub.store.get("source").events.push({ kind: "user", text: "다음 작업" }, { kind: "text", text: "새 메시지" });
  await f.api("POST", `/links/${link.id}/decide`, { action: "approve" });
  const output = (await f.api("GET", `/commands/${markdown.id}/output`)).body;
  assert.equal(output.text, text);
  assert.equal(path.dirname(output.path), path.join(f.project, "docs", "agenthub", "outputs"));
  assert.equal(f.runner.calls.length, 0);
});

test("utility nodes: absent final answers and missing output files report errors without running AI", async (t) => {
  const f = await fixture(t);
  const markdown = await f.create("markdown");
  const link = await f.link("source", markdown.id);
  await f.hub.chain.deliver(link, 0);
  const node = f.hub.commands.get(markdown.id);
  assert.equal(node.state, "error");
  assert.match(node.lastRun.error, /완료 메시지/);
  assert.equal((await f.api("GET", `/commands/${markdown.id}/output`)).status, 404);
  assert.equal((await f.api("GET", "/commands/missing/output")).status, 404);
  await f.complete("완료");
  fs.unlinkSync(node.lastRun.output.path);
  assert.equal((await f.api("GET", `/commands/${markdown.id}/output`)).status, 404);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(finalAnswer({ events: [{ kind: "text", text: "이전 답" }, { kind: "user", text: "새 요청" }] }), "");
});

test("utility nodes: interrupted, waiting and message-only turns do not print completion files", async (t) => {
  const f = await fixture(t);
  const markdown = await f.create("markdown");
  await f.link("source", markdown.id, { when: "always" });
  const source = f.hub.store.get("source");
  await f.complete("중지된 답변", null);
  source.waiting = true;
  await f.complete("질문 중");
  source.waiting = false;
  source.events.push({ kind: "user", text: "직접 메시지", message: true }, { kind: "text", text: "답장" });
  await f.hub.chain.onTurnEnd(source, true);
  assert.equal(f.hub.commands.get(markdown.id).lastRun, null);
  assert.equal(fs.existsSync(path.join(f.worktree, "docs")), false);
  assert.equal(f.runner.calls.length, 0);
});

test("utility nodes: a terminal Markdown output still saves at the automatic execution hop limit", async (t) => {
  const f = await fixture(t);
  const markdown = await f.create("markdown");
  await f.link("source", "target");
  await f.link("source", markdown.id);
  f.hub.store.get("source").chainDepth = MAX_HOPS;
  await f.complete("마지막 단계의 완료 메시지");
  assert.equal((await f.api("GET", `/commands/${markdown.id}/output`)).body.text, "마지막 단계의 완료 메시지");
  assert.equal(f.runner.calls.length, 0);
});

test("utility nodes: Markdown snapshots the completed answer before any earlier outgoing delivery yields", async (t) => {
  const f = await fixture(t);
  const printed = await f.create("markdown");
  const held = await f.create("markdown");
  await f.link("source", "target");
  await f.link("source", printed.id);
  const heldLink = await f.link("source", held.id, { approve: true });
  const deliver = f.hub.chain.deliver.bind(f.hub.chain);
  f.hub.chain.deliver = async (link, ...args) => {
    if (link.to === "target") {
      // Simulate a later user turn arriving while delivery awaits changedFiles().
      await Promise.resolve();
      f.hub.store.get("source").events.push({ kind: "user", text: "다음 작업" }, { kind: "text", text: "다른 턴의 답변" });
      return;
    }
    return deliver(link, ...args);
  };
  const original = "  원래 완료 메시지\n\n";
  await f.complete(original);
  assert.equal((await f.api("GET", `/commands/${printed.id}/output`)).body.text, original);
  assert.equal(f.hub.links.get(heldLink.id).pending.answer, original);
  await f.api("POST", `/links/${heldLink.id}/decide`, { action: "approve" });
  assert.equal((await f.api("GET", `/commands/${held.id}/output`)).body.text, original);
});

test("utility nodes: output directories cannot redirect files outside the selected worktree", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  const docs = path.join(f.worktree, "docs");
  try { fs.symlinkSync(outside, docs, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlinks unavailable"); throw error; }
  assert.throws(() => writeMessageOutput({ cwd: f.worktree, title: "test", text: "완료" }), { code: "OUTPUT_UNSAFE_PATH" });
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(docs);
  const output = writeMessageOutput({ cwd: f.worktree, title: "test", text: "완료" });
  const command = { lastRun: { cwd: f.worktree, output } };
  const badPath = { lastRun: { cwd: f.worktree, output: { ...output, path: path.join(outside, "secret.md") } } };
  assert.throws(() => readMessageOutput(badPath), { code: "OUTPUT_UNSAFE_PATH" });
  fs.unlinkSync(output.path);
  const secret = path.join(outside, "secret.md");
  fs.writeFileSync(secret, "secret");
  fs.linkSync(secret, output.path);
  assert.throws(() => readMessageOutput(command), { code: "OUTPUT_UNSAFE_PATH" });
});

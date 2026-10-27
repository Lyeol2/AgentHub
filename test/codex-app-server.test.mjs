import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServer, codexInput } from "../server/codex-app-server.mjs";
import { Runner } from "../server/runner.mjs";
import * as codex from "../server/agents/codex.mjs";
import * as claude from "../server/agents/claude.mjs";

function fixture({ resume = null, failMethod = null, response = null, resumeRetryMs = 0 } = {}) {
  const session = { id: "s", agent: "codex", cwd: process.cwd(), permission: "workspace-write", events: [], agentSessionId: resume };
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stderr = new PassThrough();
  const protocol = new CodexAppServer(child, session, { resolved: { model: "test-model", effort: "medium" }, resumeRetryMs });
  child.appServer = protocol;
  const sent = [], events = [], controls = [], cancelled = [];
  protocol.on("event", (event) => events.push(event));
  protocol.on("control", (msg) => controls.push(msg));
  protocol.on("cancel", (id) => cancelled.push(id));
  child.stdin.on("data", (data) => {
    const message = JSON.parse(data.toString()); sent.push(message);
    if (!message.method || !message.id) return;
    queueMicrotask(() => {
      const override = response?.(message, sent);
      if (override === false) return;
      if (override) return protocol.handleLine(JSON.stringify({ id: message.id, ...override }));
      if (message.method === failMethod) return protocol.handleLine(JSON.stringify({ id: message.id, error: { code: -1, message: "thread not found" } }));
      if (message.method === "turn/start") protocol.handleLine(JSON.stringify({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", status: "inProgress" } } }));
      const result = message.method.startsWith("thread/") ? { thread: { id: "thread" } } : message.method === "turn/start" ? { turn: { id: "turn", status: "inProgress" } } : {};
      protocol.handleLine(JSON.stringify({ id: message.id, result }));
    });
  });
  const notify = (method, params = {}) => protocol.handleLine(JSON.stringify({ method, params: { threadId: "thread", ...params } }));
  const approve = (method, extra = {}) => protocol.handleLine(JSON.stringify({ id: "server-1", method, params: { threadId: "thread", turnId: "turn", itemId: "item", ...extra } }));
  return { session, child, protocol, sent, events, controls, cancelled, notify, approve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("app-server: an approved plan resumes its conversation with write access instead of the plan sandbox", async () => {
  const planning = fixture();
  planning.session.planTurn = true;
  planning.session.permission = "auto-review";
  await planning.protocol.start("계획 수립");
  assert.equal(planning.sent.find((message) => message.method === "thread/start").params.sandbox, "read-only");
  planning.protocol.close();
  const implementation = fixture({ resume: "thread" });
  implementation.session.permission = "auto-review";
  await implementation.protocol.start("승인한 계획 구현");
  const params = implementation.sent.find((message) => message.method === "thread/resume").params;
  assert.equal(params.threadId, "thread");
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.approvalsReviewer, "auto_review");
  assert.ok(codex.buildArgs(implementation.session).includes('sandbox_mode="workspace-write"'));
  implementation.protocol.close();
});

test("app-server: initialization, resume and native text/image turn input are ordered", async () => {
  const f = fixture({ resume: "previous" });
  await f.protocol.start("사진 설명", [{ path: "C:/saved/image.png", mimeType: "image/png" }]);
  assert.deepEqual(f.sent.map((message) => message.method), ["initialize", "initialized", "thread/resume", "turn/start"]);
  assert.equal(f.sent[2].params.threadId, "previous");
  assert.equal(f.sent[2].params.approvalPolicy, "on-request");
  assert.equal(f.sent[2].params.approvalsReviewer, "user");
  assert.equal(f.sent[2].params.sandbox, "workspace-write");
  assert.deepEqual(f.sent[3].params.input, [{ type: "text", text: "사진 설명" }, { type: "localImage", path: "C:/saved/image.png" }]);
  assert.equal(f.sent[3].params.effort, "medium");
  assert.equal(f.events[0].agentSessionId, "thread");
  f.protocol.close();
});

test("app-server: selected permission settings apply to new, resumed and forked threads", async () => {
  for (const [permission, sandbox, approvalPolicy, approvalsReviewer] of [
    ["read-only", "read-only", "on-request", "user"],
    ["workspace-write", "workspace-write", "on-request", "user"],
    ["auto-review", "workspace-write", "on-request", "auto_review"],
    ["danger-full-access", "danger-full-access", "never", "user"],
  ]) {
    for (const mode of ["new", "resume", "fork"]) {
      const f = fixture({
        resume: mode === "new" ? null : "previous",
        response: (message) => mode === "fork" && message.method === "thread/resume"
          ? { error: { code: -1, message: "thread already has an active writer" } } : null,
      });
      f.session.permission = permission;
      try {
        await f.protocol.start("작업");
        const requests = f.sent.filter((message) => message.method?.startsWith("thread/"));
        assert.equal(requests.at(-1).method, `thread/${mode === "new" ? "start" : mode}`);
        for (const { params } of requests) {
          assert.deepEqual({ sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer },
            { sandbox, approvalPolicy, approvalsReviewer }, `${permission}: ${mode}`);
        }
        assert.equal(f.sent.filter((message) => message.method === "turn/start").length, 1);
      } finally { f.protocol.close(); }
    }
  }
});

test("app-server: command/file/permissions approvals use scoped opaque IDs and native decisions", async () => {
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
    for (const decision of ["allow", "always", "deny"]) {
      const f = fixture(); await f.protocol.start("작업");
      const permissions = { network: { enabled: true }, fileSystem: { write: ["C:/selected"] } };
      f.approve(method, { command: "npm test", reason: "필요한 접근", permissions });
      const msg = f.controls[0]; assert.match(msg.request_id, /^codex-/);
      const control = codex.parseControl(msg);
      assert.equal(control.kind, "permission");
      f.protocol.respond(msg.request_id, codex.permissionResponse(control, decision));
      const reply = f.sent.at(-1); assert.equal(reply.id, "server-1");
      if (method.includes("permissions")) assert.deepEqual(reply.result, { permissions: decision === "deny" ? {} : permissions, scope: decision === "always" ? "session" : "turn" });
      else assert.equal(reply.result.decision, { allow: "accept", always: "acceptForSession", deny: "decline" }[decision]);
      assert.throws(() => f.protocol.respond(msg.request_id, {}), /끝난 요청/);
      f.protocol.close();
    }
  }
});

test("app-server: resolves and interruption clear UI prompts and reject stale replies", async () => {
  const f = fixture(); await f.protocol.start("작업");
  f.approve("item/commandExecution/requestApproval");
  const first = f.controls[0].request_id;
  f.notify("serverRequest/resolved", { requestId: "server-1" });
  assert.deepEqual(f.cancelled, [first]);
  assert.throws(() => f.protocol.respond(first, { decision: "accept" }), /끝난 요청/);
  f.approve("item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
  const second = f.controls[1].request_id;
  f.protocol.interrupt();
  assert.equal(f.protocol.canInject(), false);
  assert.ok(f.cancelled.includes(second));
  assert.ok(f.sent.some((message) => message.id === "server-1" && message.result?.permissions && !Object.keys(message.result.permissions).length));
  assert.equal(f.sent.at(-1).method, "turn/interrupt");
  assert.throws(() => f.protocol.respond(second, {}), /끝난 요청/);
  await tick(); f.protocol.close();
});

test("app-server: unknown and wrong-turn requests are refused without executing or prompting", async () => {
  const f = fixture(); await f.protocol.start("작업");
  f.approve("unknown/requestApproval");
  assert.equal(f.sent.at(-1).error.code, -32601);
  assert.match(f.events.at(-1).text, /지원하지 않는/);
  f.approve("mcpServer/elicitation/request", { url: "https://example.com" });
  assert.deepEqual(f.sent.at(-1).result, { action: "decline", content: null });
  f.approve("item/commandExecution/requestApproval", { turnId: "old-turn" });
  assert.equal(f.sent.at(-1).result.decision, "cancel");
  assert.equal(f.controls.length, 0);
  f.protocol.close();
});

test("app-server: native questions, network context and available approval decisions are preserved", async () => {
  const f = fixture(); await f.protocol.start("작업");
  f.approve("item/tool/requestUserInput", { questions: [{ id: "choice", header: "저장", question: "위치?", options: [{ label: "폴더" }] }] });
  const question = codex.parseControl(f.controls[0]);
  assert.equal(question.questions[0].multiSelect, false);
  f.protocol.respond(f.controls[0].request_id, codex.questionResponse(question.input, [{ selected: ["폴더"], text: "이름" }]));
  assert.deepEqual(f.sent.at(-1).result, { answers: { choice: { answers: ["폴더", "이름"] } } });
  f.approve("item/commandExecution/requestApproval", { networkApprovalContext: { host: "example.com", protocol: "https" }, availableDecisions: ["accept", "decline"] });
  const network = codex.parseControl(f.controls[1]);
  // 세션 범위 허용이 없어도 AgentHub가 규칙을 기억하므로 "이 세션에서 계속 허용"은 이번 요청을 그냥 허용한다.
  assert.match(network.text, /example.com/); assert.deepEqual(network.suggestions, ["session"]);
  assert.deepEqual(codex.permissionResponse(network, "always"), { decision: "accept" });
  assert.deepEqual(codex.rememberedRules(network).rules.map((rule) => rule.key), ["network:example.com"]);
  const declineOnly = { ...network, input: { ...network.input, availableDecisions: ["decline"] } };
  assert.deepEqual(codex.parseControl({ request: { method: network.method, params: declineOnly.input } }).suggestions, []);
  assert.throws(() => codex.permissionResponse(declineOnly, "allow"), /지원하지 않는/);
  assert.throws(() => codex.permissionResponse(network, "arbitrary"), /올바른/);
  f.protocol.close();
});

test("app-server: turn results, compaction, token usage, tool failures and retry warnings keep their meaning", async () => {
  const f = fixture(); await f.protocol.start("작업");
  f.notify("item/completed", { item: { type: "agentMessage", text: "완료" } });
  f.notify("item/completed", { item: { type: "contextCompaction" } });
  f.notify("thread/tokenUsage/updated", { tokenUsage: { last: { totalTokens: 123 }, modelContextWindow: 200000 } });
  f.notify("item/completed", { item: { type: "commandExecution", aggregatedOutput: "오류", exitCode: 2, status: "failed" } });
  f.notify("error", { willRetry: true, error: { message: "재시도 중" } });
  f.notify("turn/completed", { turn: { id: "turn", status: "failed", error: { message: "사용 한도" } } });
  assert.equal(f.events.find((event) => event.text === "완료").kind, "text");
  assert.equal(f.events.find((event) => event.compact).compact, true);
  assert.deepEqual(f.events.find((event) => event.context).context, { used: 123, window: 200000 });
  assert.equal(f.events.find((event) => event.kind === "tool_result").isError, true);
  assert.equal(f.events.find((event) => event.text === "재시도 중").kind, "log");
  assert.deepEqual(f.events.at(-1), { kind: "error", text: "사용 한도", final: true });
  assert.equal(f.protocol.canInject(), false);
  f.protocol.close();
});

test("app-server: steering carries images and interruption before initialization never starts inference", async () => {
  const f = fixture(); await f.protocol.start("작업");
  f.protocol.inject("보완", [{ path: "C:/saved/a.png" }]);
  assert.deepEqual(f.sent.at(-1).params, { threadId: "thread", expectedTurnId: "turn", input: codexInput("보완", [{ path: "C:/saved/a.png" }]) });
  await tick(); f.protocol.close();
  const stopped = fixture();
  const start = stopped.protocol.start("작업"); stopped.protocol.interrupt(); await start;
  assert.ok(!stopped.sent.some((message) => message.method === "turn/start")); stopped.protocol.close();
});

test("app-server: missing resume is reported for Runner's one-time recovery without a new paid turn", async () => {
  const f = fixture({ resume: "deleted", failMethod: "thread/resume" }); let stderr = ""; f.child.stderr.on("data", (chunk) => { stderr += chunk; });
  await f.protocol.start("작업");
  assert.match(stderr, /No conversation found with session ID/);
  assert.ok(!f.sent.some((message) => message.method === "turn/start"));
  assert.equal(f.child.stdin.writableEnded, true); f.protocol.close();
});

test("runner: approval answers and cancellations mutate the stored history event", async () => {
  const f = fixture(); const runner = new Runner({ touch() {}, get: () => f.session });
  runner.running.set(f.session.id, f.child);
  f.protocol.on("control", (msg) => runner.ask(f.session, f.child, codex, msg));
  f.protocol.on("cancel", (id) => runner.dropPrompts(f.session.id, id));
  await f.protocol.start("작업"); f.approve("item/commandExecution/requestApproval");
  const event = f.session.events.at(-1);
  assert.equal(event.promptId, event.requestId); assert.equal(f.session.waiting, true);
  runner.answer(event.requestId, { decision: "allow" });
  assert.equal(event.status, "allowed"); assert.equal(f.session.waiting, false);
  f.approve("item/fileChange/requestApproval"); const cancelled = f.session.events.at(-1);
  f.notify("serverRequest/resolved", { requestId: "server-1" });
  assert.equal(cancelled.status, "skipped"); assert.equal(runner.hasPrompt(cancelled.requestId, f.session.id), false);
  f.protocol.close();
});

test("native images: Claude streams base64 and Runner keeps server filesystem paths out of user events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-image-adapter-"));
  try {
    const file = path.join(dir, "image.png"); fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    const attachment = { id: "a", name: "image.png", mimeType: "image/png", size: 3, path: file, url: "/api/attachments/a" };
    const line = JSON.parse(claude.userLine("설명", [attachment]));
    assert.deepEqual(line.message.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } });
    const session = { id: "s", agent: "claude", events: [] };
    const runner = new Runner({ touch() {}, get: () => session });
    const lines = []; runner.running.set("s", { stdin: { write(line) { lines.push(line); } } });
    runner.inject(session, "설명", { attachments: [attachment] });
    assert.equal(JSON.parse(lines[0]).message.content[1].source.data, "AQID");
    assert.equal(session.events[0].attachments[0].path, undefined);
    assert.equal(session.events[0].attachments[0].url, attachment.url);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function runnerFixture({ missing = false, activeWriter = false, forkError = null, holdPipe = false } = {}) {
  const session = { id: "runtime", agent: "codex", cwd: process.cwd(), permission: "workspace-write", state: "idle", events: [], agentSessionId: missing ? "deleted" : activeWriter ? "previous" : null };
  const children = [];
  const runner = new Runner({ touch() {}, get: () => session }, { spawn() {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    child.messages = [];
    child.send = (method, params) => child.stdout.write(JSON.stringify({ method, params: { threadId: "thread", ...params } }) + "\n");
    child.reply = (id, result) => child.stdout.write(JSON.stringify({ id, result }) + "\n");
    child.approve = (id = "approval") => child.stdout.write(JSON.stringify({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "item", command: "npm test" } }) + "\n");
    child.stdin.on("data", (data) => {
      const message = JSON.parse(data.toString()); child.messages.push(message);
      if (!message.method || !message.id) return;
      queueMicrotask(() => {
        if (message.method === "thread/resume" && missing && children.length === 1) return child.stdout.write(JSON.stringify({ id: message.id, error: { message: "thread not found" } }) + "\n");
        if (message.method === "thread/resume" && activeWriter) return child.stdout.write(JSON.stringify({ id: message.id, ...writerConflict }) + "\n");
        if (message.method === "thread/fork" && forkError) return child.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: forkError } }) + "\n");
        const result = message.method.startsWith("thread/") ? { thread: { id: "thread" } } : message.method === "turn/start" ? { turn: { id: "turn", status: "inProgress" } } : {};
        if (message.method === "turn/start") child.send("turn/started", { turn: result.turn });
        child.reply(message.id, result);
        if (message.method === "turn/interrupt") child.send("turn/completed", { turn: { id: "turn", status: "interrupted" } });
      });
    });
    // holdPipe: Codex는 끝났지만 남은 하위 프로세스가 출력 파이프를 잡아 close가 오지 않는 경우
    if (holdPipe) {
      child.stdin.on("finish", () => queueMicrotask(() => child.emit("exit", 0, null)));
      child.stdout.on("close", () => child.emit("close", 0, null));
    } else child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0, null)));
    return child;
  } });
  return { runner, session, children };
}

test("runner app-server integration: complete a native image turn and persist its history with no server paths", async () => {
  const f = runnerFixture(); const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "사진", "fake-codex", "전체 요청", { attachments: [{ id: "a", path: "C:/internal/photo.png", name: "photo.png", mimeType: "image/png", size: 5, url: "/image/a" }] });
  const began = f.session.runningStartedAt; assert.equal(f.session.state, "running");
  await tick(); const child = f.children[0];
  assert.equal(f.runner.canInject(f.session), true);
  assert.equal(child.messages.find((message) => message.method === "turn/start").params.input[1].path, "C:/internal/photo.png");
  child.send("item/completed", { item: { type: "agentMessage", text: "사진의 설명" } });
  assert.equal(f.session.runningStartedAt, began);
  child.send("turn/completed", { turn: { id: "turn", status: "completed" } });
  const [, ok] = await ended;
  assert.equal(ok, true); assert.equal(f.session.state, "idle"); assert.equal(f.session.runningStartedAt, null);
  assert.equal(f.session.agentSessionId, "thread"); assert.deepEqual(f.session.cliSessionIds, ["thread"]);
  assert.equal(f.session.events[0].attachments[0].path, undefined);
  assert.equal(f.session.events.find((event) => event.kind === "text").text, "사진의 설명");
  assert.equal(f.runner.isRunning(f.session.id), false);
});

test("runner app-server integration: a finished turn ends even when a leftover child process holds the output pipe", async () => {
  const f = runnerFixture({ holdPipe: true }); const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "커밋해 줘", "fake-codex"); await tick(); const child = f.children[0];
  child.send("item/completed", { item: { type: "agentMessage", text: "커밋했습니다." } });
  child.send("turn/completed", { turn: { id: "turn", status: "completed" } });
  const [, ok] = await ended;
  assert.equal(ok, true); assert.equal(f.session.state, "idle");
  assert.equal(f.runner.isRunning(f.session.id), false);
});

test("runner app-server integration: approval answer, pause and shutdown remove pending requests", async () => {
  const f = runnerFixture(); const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "작업", "fake-codex"); await tick(); const child = f.children[0]; child.approve();
  const first = f.session.events.at(-1); assert.equal(first.kind, "permission"); assert.equal(first.rememberLabel, "이 세션에서 계속 허용");
  f.runner.answer(first.requestId, { decision: "allow" });
  assert.equal(first.status, "allowed"); assert.deepEqual(child.messages.at(-1).result, { decision: "accept" });
  child.approve("second"); const second = f.session.events.at(-1); f.session.paused = true;
  assert.equal(f.runner.interrupt(f.session), true);
  assert.equal(second.status, "skipped");
  assert.throws(() => f.runner.answer(second.requestId, { decision: "allow" }), /끝난 요청/);
  const [, ok] = await ended; assert.equal(ok, null); assert.equal(f.session.state, "paused");
  assert.equal(f.session.agentSessionId, "thread"); assert.equal(f.session.waiting, false);
  assert.ok(!f.session.events.some((event) => event.kind === "error"));
});

test("runner shutdown settles unanswered Codex injections before storage closes", async () => {
  const f = runnerFixture();
  f.runner.send(f.session, "작업", "fake-codex");
  await tick();
  const child = f.children[0];
  child.stdin.removeAllListeners("data");
  child.stdin.removeAllListeners("finish");
  f.runner.kill = () => {};
  f.runner.inject(f.session, "아직 반영되지 않은 요청");
  const injected = f.session.events.at(-1);
  let closed = false, lateTouches = 0;
  f.runner.store.touch = () => { if (closed) lateTouches++; };
  await f.runner.shutdown({ timeout: 10 });
  closed = true;
  assert.equal(injected.delivery, "dropped");
  assert.equal(child.appServer.requests.size, 0);
  assert.equal(child.pendingInjections.size, 0);
  const count = f.session.events.length;
  child.appServer.close();
  child.emit("close", 1, "SIGTERM");
  await tick();
  assert.equal(lateTouches, 0);
  assert.equal(f.session.events.length, count);
});

test("runner app-server integration: missing thread retries once with one visible request and unchanged timer", async () => {
  const f = runnerFixture({ missing: true }); const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "작업", "fake-codex"); const began = f.session.runningStartedAt; await tick();
  assert.equal(f.children.length, 2); assert.equal(f.session.runningStartedAt, began);
  assert.equal(f.session.events.filter((event) => event.kind === "user").length, 1);
  assert.ok(f.children[1].messages.some((message) => message.method === "thread/start"));
  f.children[1].send("turn/completed", { turn: { id: "turn", status: "completed" } });
  const [, ok] = await ended; assert.equal(ok, true); assert.equal(f.session.state, "idle");
});

test("app-server: a late turn/start response cannot reactivate a completed turn", async () => {
  const f = fixture(); await f.protocol.start("작업");
  f.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  f.notify("turn/started", { turn: { id: "turn", status: "inProgress" } });
  assert.equal(f.protocol.turnId, null); assert.equal(f.protocol.canInject(), false); f.protocol.close();
});

test("app-server: file approval retains proposed paths and patch diff from its pending item", async () => {
  const f = fixture(); await f.protocol.start("작업");
  f.notify("item/started", { item: { id: "item", type: "fileChange", changes: [{ path: "C:/project/a.txt", kind: { type: "update" }, diff: "+content" }] } });
  f.approve("item/fileChange/requestApproval"); const control = codex.parseControl(f.controls[0]);
  assert.match(control.text, /a.txt/); assert.match(control.detail, /\+content/); f.protocol.close();
});

test("app-server: late approvals after shutdown and close cannot write to ended stdin", async () => {
  const f = fixture(); await f.protocol.start("작업"); f.protocol.shutdown();
  const count = f.sent.length;
  assert.doesNotThrow(() => f.approve("item/commandExecution/requestApproval"));
  assert.doesNotThrow(() => f.approve("unknown/requestApproval"));
  assert.equal(f.sent.length, count); f.protocol.close();
  assert.doesNotThrow(() => f.approve("item/permissions/requestApproval"));
});

test("app-server: unexpected clean process exit before completion is an error", async () => {
  const f = runnerFixture(); const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "작업", "fake-codex"); await tick(); f.children[0].emit("close", 0, null);
  const [, ok] = await ended; assert.equal(ok, false); assert.equal(f.session.state, "error");
  assert.match(f.session.events.at(-1).text, /완료하기 전에/);
});

test("app-server: a Codex crash before completion shows the stderr cause in the error", async () => {
  const f = runnerFixture(); const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "작업", "fake-codex"); await tick();
  f.children[0].stderr.emit("data", "codex.js:107\r\n  throw new Error(\r\n        ^\r\n\r\nError: Missing optional dependency @openai/codex-win32-x64. Reinstall Codex: npm install -g @openai/codex@latest\r\n    at findCodexExecutable (codex.js:107:9)\r\n\r\nNode.js v24.12.0\r\n");
  f.children[0].emit("close", 1, null);
  await ended;
  const error = f.session.events.find((event) => event.kind === "error");
  assert.match(error.text, /완료하기 전에 끝났습니다\.\nError: Missing optional dependency @openai\/codex-win32-x64/);
});


test("app-server: declined or failed file changes are not displayed as applied changes", () => {
  const f = fixture();
  for (const status of ["declined", "failed"]) {
    f.notify("item/completed", { item: { id: status, type: "fileChange", status, changes: [{ path: "not-written.txt", kind: { type: "update" } }] } });
    assert.equal(f.events.at(-1).kind, "tool_result");
    assert.equal(f.events.at(-1).isError, true);
    assert.match(f.events.at(-1).text, status === "declined" ? /거절/ : /실패/);
  }
  f.notify("item/completed", { item: { id: "ok", type: "fileChange", status: "completed", changes: [{ path: "written.txt", kind: { type: "add" } }] } });
  assert.equal(f.events.at(-1).kind, "tool");
  assert.match(f.events.at(-1).text, /파일 변경: add written.txt/);
  f.protocol.close();
});

const writerConflict = { error: { code: -32600, message: "thread previous already has an active writer" } };

test("app-server: a temporary writer conflict resumes the same history with one turn", async () => {
  let resumes = 0;
  const f = fixture({ resume: "previous", response: (msg) => msg.method === "thread/resume" && ++resumes === 1 ? writerConflict : null });
  await f.protocol.start("작업");
  assert.equal(resumes, 2);
  assert.equal(f.sent.filter((m) => m.method === "thread/fork").length, 0);
  assert.equal(f.sent.filter((m) => m.method === "turn/start").length, 1);
  assert.ok(!f.events.some((e) => e.kind === "error"));
  f.protocol.close();
});

test("app-server: a persistent writer conflict forks saved history instead of starting an empty conversation", async () => {
  const f = fixture({ resume: "previous", response: (msg) => msg.method === "thread/resume" ? writerConflict : null });
  await f.protocol.start("사진", [{ path: "C:/image.png" }]);
  assert.equal(f.sent.filter((m) => m.method === "thread/resume").length, 2);
  const fork = f.sent.find((m) => m.method === "thread/fork");
  assert.equal(fork.params.threadId, "previous");
  assert.equal(fork.params.cwd, f.session.cwd);
  assert.equal(fork.params.sandbox, "workspace-write");
  assert.equal(fork.params.approvalPolicy, "on-request");
  assert.equal(fork.params.model, "test-model");
  assert.equal(f.sent.filter((m) => m.method === "thread/start").length, 0);
  const turns = f.sent.filter((m) => m.method === "turn/start");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].params.threadId, "thread");
  assert.deepEqual(turns[0].params.input, codexInput("사진", [{ path: "C:/image.png" }]));
  assert.ok(f.events.some((e) => e.kind === "status" && /기록을 복사/.test(e.text)));
  assert.equal(f.events.find((e) => e.agentSessionId).agentSessionId, "thread");
  f.protocol.close();
});

test("app-server: fork failures never trigger missing-conversation recovery or an empty paid turn", async () => {
  const f = fixture({ resume: "previous", response: (msg) => msg.method === "thread/resume" ? writerConflict : msg.method === "thread/fork" ? { error: { code: -32601, message: "method thread/fork not found" } } : null });
  let stderr = ""; f.child.stderr.on("data", (s) => { stderr += s; });
  await f.protocol.start("작업");
  assert.equal(f.sent.filter((m) => m.method === "thread/fork").length, 1);
  assert.ok(!f.sent.some((m) => ["thread/start", "turn/start"].includes(m.method)));
  assert.doesNotMatch(stderr, /No conversation found/);
  assert.match(f.events.at(-1).text, /method thread\/fork not found/);
  f.protocol.close();
});

test("app-server: auth, timeout and unsupported-resume errors never discard the original history", async () => {
  for (const message of ["authentication required", "Codex 응답 시간 초과: thread/resume", "method thread/resume not found"]) {
    const f = fixture({ resume: "previous", response: (msg) => msg.method === "thread/resume" ? { error: { code: message.startsWith("method") ? -32601 : -1, message } } : null });
    let stderr = ""; f.child.stderr.on("data", (s) => { stderr += s; });
    await f.protocol.start("작업");
    assert.equal(f.sent.filter((m) => m.method === "thread/resume").length, 1);
    assert.ok(!f.sent.some((m) => ["thread/fork", "thread/start", "turn/start"].includes(m.method)));
    assert.doesNotMatch(stderr, /No conversation found/);
    assert.equal(f.session.agentSessionId, "previous");
    f.protocol.close();
  }
});

test("app-server: stopping or closing during writer retry clears its wait and starts no turn", async () => {
  for (const action of ["interrupt", "close"]) {
    const f = fixture({ resume: "previous", resumeRetryMs: 60_000, response: (msg) => msg.method === "thread/resume" ? writerConflict : null });
    const started = f.protocol.start("작업");
    await tick(); assert.ok(f.protocol.resumeWait);
    f.protocol[action](); await started;
    assert.equal(f.protocol.resumeWait, null);
    assert.equal(f.sent.filter((m) => m.method === "thread/resume").length, 1);
    assert.ok(!f.sent.some((m) => ["thread/fork", "turn/start"].includes(m.method)));
    f.protocol.close();
  }
});

test("app-server: stopping after retry or fork was sent never launches a turn from the late response", async () => {
  for (const stopAt of ["retry", "fork"]) {
    let resumes = 0, blocked;
    const f = fixture({ resume: "previous", response: (msg) => {
      if (msg.method === "thread/resume") {
        resumes++;
        if (resumes === 1 || stopAt === "fork") return writerConflict;
        blocked = msg; return false;
      }
      if (msg.method === "thread/fork") { blocked = msg; return false; }
      return null;
    } });
    const started = f.protocol.start("작업");
    while (!blocked) await new Promise((resolve) => setTimeout(resolve, 1));
    f.protocol.interrupt();
    f.protocol.handleLine(JSON.stringify({ id: blocked.id, result: { thread: { id: "forked" } } }));
    await started;
    assert.ok(!f.sent.some((m) => m.method === "turn/start"));
    f.protocol.close();
  }
});


test("runner app-server integration: writer conflict preserves both history IDs and one visible request", async () => {
  const f = runnerFixture({ activeWriter: true });
  const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "이어가기", "fake-codex");
  const began = f.session.runningStartedAt;
  while (!f.children[0].messages.some((m) => m.method === "turn/start")) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.children.length, 1);
  assert.equal(f.session.runningStartedAt, began);
  assert.equal(f.session.agentSessionId, "thread");
  assert.deepEqual(f.session.cliSessionIds, ["previous", "thread"]);
  assert.equal(f.session.events.filter((e) => e.kind === "user").length, 1);
  f.children[0].send("turn/completed", { turn: { id: "turn", status: "completed" } });
  const [, ok] = await ended;
  assert.equal(ok, true);
  assert.equal(f.session.state, "idle");
});

test("runner app-server integration: unsupported fork does not retry in an empty conversation", async () => {
  const f = runnerFixture({ activeWriter: true, forkError: "method thread/fork not found" });
  const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "이어가기", "fake-codex");
  const [, ok] = await ended;
  assert.equal(ok, false);
  assert.equal(f.children.length, 1);
  assert.equal(f.session.agentSessionId, "previous");
  assert.ok(!f.children[0].messages.some((m) => ["thread/start", "turn/start"].includes(m.method)));
});


test("runner app-server integration: even a missing-history error from fork cannot discard the source conversation", async () => {
  const f = runnerFixture({ activeWriter: true, forkError: "No conversation found with session ID: previous" });
  const ended = new Promise((resolve) => f.runner.once("turnEnd", (...args) => resolve(args)));
  f.runner.send(f.session, "이어가기", "fake-codex");
  f.children[0].stderr.write("No conversation found with session ID: previous\n");
  const [, ok] = await ended;
  assert.equal(ok, false);
  assert.equal(f.children.length, 1);
  assert.equal(f.session.agentSessionId, "previous");
  assert.equal(f.children[0].appServer.missingConversation, false);
  assert.ok(!f.children[0].messages.some((m) => ["thread/start", "turn/start"].includes(m.method)));
});

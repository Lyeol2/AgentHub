// 세션 사이 메시지(블록·Mailbox), MCP 요청 처리, 공유 노트. 실제 CLI는 실행하지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-msg-"));
process.env.AGENTHUB_DATA = tmp;
const { extractMessages, stripMessages, findTarget, Mailbox, readBoard, postBoard, clearBoard } = await import("../server/messages.mjs");
const { Chain, MAX_HOPS } = await import("../server/chain.mjs");
const { handleRpc, McpTokens } = await import("../server/mcp.mjs");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const session = (id, extra = {}) => ({ id, title: id.toUpperCase(), agent: "claude", projectPath: "C:/p", cwd: "C:/p", events: [], state: "idle", ...extra });

// 세션 여러 개와 가짜 runner로 Chain·Mailbox를 만든다. 시작한 턴은 runner.sent에, 붙인 요청은 runner.injected에 쌓인다.
function world(list) {
  const sessions = new Map(list.map((s) => [s.id, s]));
  const runner = Object.assign(new EventEmitter(), {
    sent: [], injected: [], running: new Set(), live: new Set(),
    isRunning(id) { return this.running.has(id); },
    canInject(s) { return this.live.has(s.id); },
    inject(s, text, meta) { this.injected.push([s.id, text]); this.append(s, { kind: "user", text, ...meta, injected: true }); },
    send(s, prompt, cli, input, meta) { this.sent.push([s.id, prompt]); this.running.add(s.id); this.append(s, { kind: "user", text: prompt, ...meta }); },
    append(s, e) { s.events.push(e); },
  });
  const links = { list: () => [], from: () => [], update: (l, c) => Object.assign(l, c) };
  const chain = new Chain({ store: { get: (id) => sessions.get(id) }, runner, links, cliPaths: () => ({ claude: "x", codex: "x" }), compose: (s, t) => t });
  const mailbox = new Mailbox({ store: {}, runner, chain, sessions: () => [...sessions.values()] });
  // 턴을 끝낸다(runner가 내는 turnEnd를 흉내 낸다).
  const finish = async (s, ok = true) => {
    runner.running.delete(s.id);
    runner.emit("turnEnd", s, ok);
    await new Promise((r) => setImmediate(r));
  };
  return { sessions, runner, chain, mailbox, finish };
}

test("messages: 답변에서 메시지 블록을 꺼낸다", () => {
  const one = "고쳤다.\n```agenthub-message\n{\"to\": \"리뷰\", \"text\": \"봐 줘\", \"wait\": true}\n```";
  assert.deepEqual(extractMessages(one), { messages: [{ to: "리뷰", text: "봐 줘", wait: true }] });
  const many = "```agenthub-message\n[{\"to\": \"a\", \"text\": \"1\"}, {\"to\": \"b\", \"text\": \"2\"}]\n```\n```agenthub-message\n{\"messages\": [{\"to\": \"c\", \"text\": \"3\"}]}\n```";
  assert.deepEqual(extractMessages(many).messages.map((m) => m.to), ["a", "b", "c"]);
  assert.equal(extractMessages("블록 없음"), null);
  assert.match(extractMessages("```agenthub-message\n{깨짐\n```").error, /JSON/);
  assert.match(extractMessages("```agenthub-message\n{\"to\": \"a\"}\n```").error, /text/);
  assert.equal(stripMessages(one), "고쳤다.");
});

test("messages: 이름·역할·id·흐름 제목 뒷부분으로 받는 세션을 찾는다", () => {
  const me = session("me");
  const list = [me, session("s1", { title: "작업 · 리뷰", roleName: "리뷰" }), session("s2", { title: "프론트" }),
    session("s3", { title: "같음" }), session("s4", { title: "같음" }), session("s5", { title: "채팅", chat: true })];
  assert.equal(findTarget(list, me, "리뷰").id, "s1");
  assert.equal(findTarget(list, me, "작업 · 리뷰").id, "s1");
  assert.equal(findTarget(list, me, "프론트").id, "s2");
  assert.equal(findTarget(list, me, "S2").id, "s2");
  assert.throws(() => findTarget(list, me, "같음"), /여럿/);
  assert.throws(() => findTarget(list, me, "채팅"), /찾지 못했습니다/); // 일반 채팅에는 보내지 않는다.
  assert.throws(() => findTarget(list, me, "me"), /찾지 못했습니다/); // 자기 자신에게는 보내지 않는다.
});

test("messages: 쉬는 세션은 대기열로 바로 시작하고, 실행 중인 Claude 세션에는 작업 중에 붙인다", () => {
  const { sessions, runner, mailbox } = world([session("a"), session("b"), session("c")]);
  const a = sessions.get("a");
  assert.equal(mailbox.send(a, "B", "API 모양 알려 줘").via, "queue");
  assert.equal(runner.sent[0][0], "b");
  assert.match(runner.sent[0][1], /\[세션 메시지\] 보낸 세션: A[\s\S]*API 모양 알려 줘/);
  assert.equal(sessions.get("b").events.at(-1).message, true);

  runner.live.add("c");
  assert.equal(mailbox.send(a, "C", "지금 그 파일 건드리지 마").via, "live");
  assert.equal(runner.injected[0][0], "c");
  // 보낸 세션의 기록에도 남는다.
  assert.deepEqual(a.events.filter((e) => e.kind === "message").map((e) => [e.toTitle, e.via]), [["B", "queue"], ["C", "live"]]);
  assert.equal(mailbox.list("C:/p", (x, y) => x === y).length, 2);
});

test("messages: ask_session은 상대의 답을 도구 결과로 받는다", async () => {
  const { sessions, runner, mailbox } = world([session("a"), session("b")]);
  const a = sessions.get("a");
  const b = sessions.get("b");
  runner.running.add("a"); // 묻는 세션은 도구를 부르는 중이다.
  const pending = mailbox.ask(a, "B", "status 필드 있어?");
  assert.match(runner.sent[0][1], /답을 기다리고 있다/);
  // 서로 기다리면 막힌다.
  await assert.rejects(async () => mailbox.ask(b, "A", "너는?"), /기다리고 있습니다/);
  assert.equal(mailbox.send(b, "A", "있다. string이다.").via, "answer");
  const { target, answer } = await pending;
  assert.equal(target.id, "b");
  assert.equal(answer, "있다. string이다.");
  assert.equal(runner.sent.length, 1); // 답은 새 턴이 아니라 도구 결과로 갔다.
});

test("messages: 답을 기다리던 턴이 끝나면 ask는 null로 끝나고 늦은 답은 다음 요청으로 간다", async () => {
  const { sessions, runner, mailbox, finish } = world([session("a"), session("b")]);
  const a = sessions.get("a");
  runner.running.add("a");
  const pending = mailbox.ask(a, "B", "언제 끝나?");
  await finish(a);
  assert.equal((await pending).answer, null);
  mailbox.send(sessions.get("b"), "A", "곧");
  assert.equal(runner.sent.at(-1)[0], "a");
});

test("messages: 블록으로 답을 기다리던 세션이 받은 답은 하던 일을 잇는 요청이라 연결로도 넘긴다", async () => {
  const { sessions, runner, chain, mailbox, finish } = world([session("a"), session("b"), session("c")]);
  const a = sessions.get("a");
  const b = sessions.get("b");
  const toC = { id: "l", from: "a", to: "c", when: "success", enabled: true };
  chain.links = { list: () => [toC], from: (id) => (id === "a" ? [toC] : []), update: () => {} };

  a.awaitingReply = "b";
  mailbox.send(b, "A", "이렇게 해");
  assert.equal(a.events.at(-1).reply, true);
  assert.equal(a.awaitingReply, undefined);
  await finish(a);
  assert.equal(runner.sent.at(-1)[0], "c"); // 답을 받은 턴은 연결로 넘긴다.

  // 그냥 메시지로 시작한 턴은 곁가지 대화라 연결로 넘기지 않는다.
  const before = runner.sent.length;
  mailbox.send(b, "A", "그런데 하나 더");
  await finish(a);
  assert.equal(runner.sent.length, before + 1);
  assert.notEqual(runner.sent.at(-1)[0], "c");
});

test("messages: 메시지가 끝없이 오가지 않게 막는다", () => {
  const { sessions, runner, mailbox } = world([session("a"), session("b")]);
  const a = sessions.get("a");
  a.chainDepth = MAX_HOPS;
  assert.throws(() => mailbox.send(a, "B", "또"), /단계/);
  a.chainDepth = 0;
  runner.live.add("b");
  for (let i = 0; i < 12; i++) mailbox.send(a, "B", `${i}`);
  assert.throws(() => mailbox.send(a, "B", "13번째"), /한 턴에/);
});

test("messages: check_messages는 대기열의 메시지만 꺼낸다", () => {
  const { sessions, runner, chain, mailbox } = world([session("a"), session("b")]);
  const b = sessions.get("b");
  runner.running.add("b"); // Codex처럼 작업 중에 붙일 수 없는 세션
  chain.enqueue(b, "사용자 요청", { user: true }, 0);
  mailbox.send(sessions.get("a"), "B", "참고로 이거 바뀜");
  const inbox = mailbox.inbox(b);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0], /참고로 이거 바뀜/);
  assert.deepEqual(chain.list("b").map((i) => i.text), ["사용자 요청"]);
  assert.deepEqual(mailbox.inbox(b), []);
});

test("messages: 공유 노트에 덧붙이고 비운다", () => {
  const project = path.join(tmp, "proj");
  assert.equal(readBoard(project), "");
  postBoard(project, "프론트", "API는 /orders?status=");
  postBoard(project, "백엔드", "status는 string");
  const board = readBoard(project);
  assert.match(board, /^## 프론트 · .+\n\nAPI는 \/orders\?status=\n\n## 백엔드/);
  assert.throws(() => postBoard(project, "x", " "), /내용이 없습니다/);
  clearBoard(project);
  assert.equal(readBoard(project), "");
});

test("mcp: 초기화·도구 목록·도구 호출·알림을 처리한다", async () => {
  const tools = [
    { name: "echo", description: "되돌린다", inputSchema: { type: "object" }, run: (s, { text }) => `${s.id}:${text}` },
    { name: "fail", description: "실패", inputSchema: { type: "object" }, run: () => { throw new Error("안 된다"); } },
  ];
  const me = { id: "a" };
  const init = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, me, tools, { instructions: "규칙" });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.instructions, "규칙");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, me, tools), null);
  const list = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, me, tools);
  assert.deepEqual(list.result.tools.map((t) => t.name), ["echo", "fail"]);
  assert.equal(list.result.tools[0].run, undefined);
  const call = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }, me, tools);
  assert.deepEqual(call.result, { content: [{ type: "text", text: "a:hi" }] });
  const failed = await handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fail" } }, me, tools);
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text, "안 된다");
  assert.equal((await handleRpc({ jsonrpc: "2.0", id: 5, method: "nope" }, me, tools)).error.code, -32601);
  const batch = await handleRpc([{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }], me, tools);
  assert.deepEqual(batch, [{ jsonrpc: "2.0", id: 6, result: {} }]);
});

test("mcp: 세션마다 토큰이 하나다", () => {
  const tokens = new McpTokens();
  const t = tokens.token("a");
  assert.match(t, /^[0-9a-f]{48}$/);
  assert.equal(tokens.token("a"), t);
  assert.equal(tokens.session(t), "a");
  tokens.forget("a");
  assert.equal(tokens.session(t), null);
});

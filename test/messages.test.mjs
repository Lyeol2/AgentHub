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
const mailboxBlocks = await import("../server/messages.mjs");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const session = (id, extra = {}) => ({ id, title: id.toUpperCase(), agent: "claude", projectPath: "C:/p", cwd: "C:/p", events: [], state: "idle", ...extra });

const link = (from, to, extra = {}) => ({ id: `${from}-${to}`, from, to, when: "manual", enabled: true, ...extra });

// 세션 여러 개와 가짜 runner로 Chain·Mailbox를 만든다. 시작한 턴은 runner.sent에, 붙인 요청은 runner.injected에 쌓인다.
function world(list, connections = []) {
  const sessions = new Map(list.map((s) => [s.id, s]));
  const runner = Object.assign(new EventEmitter(), {
    sent: [], injected: [], running: new Set(), live: new Set(),
    isRunning(id) { return this.running.has(id); },
    canInject(s) { return this.live.has(s.id); },
    inject(s, text, meta) { this.injected.push([s.id, text]); this.append(s, { kind: "user", text, ...meta, injected: true }); },
    send(s, prompt, cli, input, meta) { this.sent.push([s.id, prompt]); this.running.add(s.id); this.append(s, { kind: "user", text: prompt, ...meta }); },
    append(s, e) { s.events.push(e); },
  });
  const links = { list: () => connections, from: (id) => connections.filter((l) => l.from === id), update: (l, c) => Object.assign(l, c) };
  const chain = new Chain({ store: { get: (id) => sessions.get(id) }, runner, links, cliPaths: () => ({ claude: "x", codex: "x" }), compose: (s, t) => t });
  const mailbox = new Mailbox({ store: {}, runner, chain, links, sessions: () => [...sessions.values()] });
  // 턴을 끝낸다(runner가 내는 turnEnd를 흉내 낸다).
  const finish = async (s, ok = true) => {
    runner.running.delete(s.id);
    runner.emit("turnEnd", s, ok);
    await new Promise((r) => setImmediate(r));
  };
  return { sessions, runner, chain, links, connections, mailbox, finish };
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
  const { sessions, runner, mailbox } = world([session("a"), session("b"), session("c")], [link("a", "b"), link("c", "a")]);
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
  const { sessions, runner, mailbox } = world([session("a"), session("b")], [link("a", "b")]);
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
  const { sessions, runner, mailbox, finish } = world([session("a"), session("b")], [link("a", "b")]);
  const a = sessions.get("a");
  runner.running.add("a");
  const pending = mailbox.ask(a, "B", "언제 끝나?");
  await finish(a);
  assert.equal((await pending).answer, null);
  mailbox.send(sessions.get("b"), "A", "곧");
  assert.equal(runner.sent.at(-1)[0], "a");
});

test("messages: 블록으로 답을 기다리던 세션이 받은 답은 하던 일을 잇는 요청이라 연결로도 넘긴다", async () => {
  const { sessions, runner, connections, mailbox, finish } = world([session("a"), session("b"), session("c")], [link("a", "b"), link("c", "a")]);
  const a = sessions.get("a");
  const b = sessions.get("b");
  const toC = { id: "l", from: "a", to: "c", when: "success", enabled: true };
  connections.push(toC);

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
  const { sessions, runner, mailbox } = world([session("a"), session("b")], [link("a", "b")]);
  const a = sessions.get("a");
  a.chainDepth = MAX_HOPS;
  assert.throws(() => mailbox.send(a, "B", "또"), /단계/);
  a.chainDepth = 0;
  runner.live.add("b");
  for (let i = 0; i < 12; i++) mailbox.send(a, "B", `${i}`);
  assert.throws(() => mailbox.send(a, "B", "13번째"), /한 턴에/);
});

test("messages: check_messages는 대기열의 메시지만 꺼낸다", () => {
  const { sessions, runner, chain, mailbox } = world([session("a"), session("b")], [link("a", "b")]);
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

test("messages: 활성 직접 연결 상대만 보이며 연결 방향과 관계없이 연락할 수 있다", () => {
  const { sessions, runner, chain, mailbox } = world([
    session("a"), session("b"), session("c"), session("disabled"), session("command-neighbor"),
    session("indirect"), session("foreign", { projectPath: "C:/elsewhere" }), session("chat", { chat: true }),
  ], [
    link("a", "b"), link("c", "a"), link("a", "disabled", { enabled: false }),
    link("a", "cmd:build"), link("cmd:build", "command-neighbor"), link("b", "indirect"),
    link("a", "foreign"), link("a", "chat"), link("a", "a"),
  ]);
  const a = sessions.get("a");
  const disabled = sessions.get("disabled");
  disabled.awaitingReply = "a";
  runner.live.add(disabled.id); // 차단된 상대가 실행 중이어도 주입하지 않는다.
  const beforeLog = mailbox.log.length;
  const directory = mailbox.directory(a);
  assert.match(directory, /- B \(id b,/);
  assert.match(directory, /- C \(id c,/);
  assert.doesNotMatch(directory, /DISABLED|COMMAND-NEIGHBOR|INDIRECT|FOREIGN|CHAT|id a,/);
  assert.equal(mailbox.directory(sessions.get("chat")), "직접 연결된 다른 세션이 없습니다.");
  for (const id of ["a", "disabled", "command-neighbor", "indirect", "foreign", "chat", "cmd:build"]) {
    assert.throws(() => mailbox.send(a, id, "전달하면 안 됨"), /직접 연결된 세션끼리만/);
    assert.throws(() => mailbox.ask(a, id, "답해 줘"), /직접 연결된 세션끼리만/);
  }
  assert.throws(() => mailbox.send(sessions.get("chat"), "a", "안 됨"), /일반 채팅/);
  assert.throws(() => mailbox.ask(sessions.get("chat"), "a", "안 됨"), /일반 채팅/);
  assert.equal(runner.sent.length, 0);
  assert.equal(runner.injected.length, 0);
  assert.equal(chain.queue.size, 0);
  assert.equal(mailbox.log.length, beforeLog);
  assert.equal(mailbox.sentThisTurn.size, 0);
  assert.equal(mailbox.asks.size, 0);
  assert.ok([...sessions.values()].every((s) => s.events.length === 0));
  assert.equal(disabled.awaitingReply, "a");

  assert.equal(mailbox.send(a, "b", "정방향 허용").target.id, "b");
  assert.equal(mailbox.send(a, "c", "역방향 허용").target.id, "c");
});

test("messages: 같은 이름의 미연결 세션은 연결된 상대 찾기를 방해하지 않는다", () => {
  const { sessions, mailbox } = world([
    session("a"), session("connected", { title: "리뷰" }), session("unconnected", { title: "리뷰" }),
  ], [link("a", "connected")]);
  assert.equal(mailbox.send(sessions.get("a"), "리뷰", "검토 부탁").target.id, "connected");
});

test("messages: 연결 저장소가 없으면 목록과 발신 모두 허용하지 않는다", () => {
  const { sessions, runner, chain } = world([session("a"), session("b")], [link("a", "b")]);
  const mailbox = new Mailbox({ store: {}, runner, chain, sessions: () => [...sessions.values()] });
  const a = sessions.get("a");
  const beforeLog = mailbox.log.length;
  assert.equal(mailbox.directory(a), "직접 연결된 다른 세션이 없습니다.");
  assert.throws(() => mailbox.send(a, "b", "안 됨"), /직접 연결된 세션끼리만/);
  assert.throws(() => mailbox.ask(a, "b", "안 됨"), /직접 연결된 세션끼리만/);
  assert.equal(mailbox.asks.size, 0);
  assert.equal(mailbox.sentThisTurn.size, 0);
  assert.equal(runner.sent.length, 0);
  assert.equal(chain.queue.size, 0);
  assert.equal(mailbox.log.length, beforeLog);
});

test("messages: 질문한 뒤 연결을 해제하면 답장도 도구 결과나 재개 요청으로 전달하지 않는다", async () => {
  const { sessions, runner, chain, connections, mailbox } = world([session("a"), session("b")], [link("a", "b")]);
  const a = sessions.get("a");
  const b = sessions.get("b");
  runner.running.add(a.id);
  const pending = mailbox.ask(a, "b", "답해 줘");
  connections[0].enabled = false;
  a.awaitingReply = b.id;
  const beforeLog = mailbox.log.length;
  const beforeEvents = a.events.length;
  try {
    assert.throws(() => mailbox.send(b, "a", "연결 해제 뒤의 답"), /직접 연결된 세션끼리만/);
    assert.equal(mailbox.asks.has(a.id), true);
    assert.equal(a.awaitingReply, b.id);
    assert.equal(a.events.length, beforeEvents);
    assert.equal(b.events.filter((event) => event.kind === "message").length, 0);
    assert.equal(mailbox.log.length, beforeLog);
    assert.equal(runner.sent.length, 1);
    assert.equal(runner.injected.length, 0);
    assert.equal(chain.pending(a.id), 0);
    assert.equal(mailbox.sentThisTurn.has(b.id), false);
  } finally {
    mailbox.settleAsk(a.id, null);
  }
  assert.equal((await pending).answer, null);
});

test("messages: check_messages는 대기 중 연결을 해제하거나 발신 세션을 지운 메시지를 버린다", () => {
  for (const revoke of ["disable", "remove-link", "remove-session", "change-project"]) {
    const { sessions, runner, chain, connections, mailbox } = world([session("a"), session("b")], [link("a", "b")]);
    const a = sessions.get("a");
    const b = sessions.get("b");
    runner.running.add(b.id);
    mailbox.send(a, "b", "대기 중인 메시지");
    assert.equal(chain.pending(b.id), 1);
    if (revoke === "disable") connections[0].enabled = false;
    if (revoke === "remove-link") connections.splice(0);
    if (revoke === "remove-session") sessions.delete(a.id);
    if (revoke === "change-project") a.projectPath = "C:/elsewhere";
    const beforeEvents = b.events.length;
    assert.deepEqual(mailbox.inbox(b), []);
    assert.equal(chain.pending(b.id), 0);
    assert.equal(b.events.length, beforeEvents);
  }
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

test("messages: 요청 시 부르기는 사용자가 직접 보낸 요청에서 대상을 말했을 때만 부르고, 그 밖에는 거절한다", () => {
  const release = session("rel", { title: "릴리즈", roleName: "배포" });
  const { sessions, runner, mailbox } = world([session("a"), release, session("c")], [link("a", "rel", { when: "call" })]);
  const a = sessions.get("a");
  // 사용자가 대상을 말하지 않은 요청: 부르지 말고 사용자에게 묻게 한다.
  a.events.push({ kind: "user", text: "작업 끝나면 정리해 줘" });
  assert.throws(() => mailbox.call(a, "릴리즈", "v0.16 릴리즈"), /직접 말하지 않았다/);
  assert.equal(runner.sent.length, 0);
  // 작업 중에 덧붙인 사용자 요청에서 이름을 말하면 부른다.
  a.events.push({ kind: "user", text: "응 릴리즈 세션에 넘겨", injected: true });
  assert.equal(mailbox.call(a, "릴리즈", "develop을 main에 합치고 릴리즈해 줘").via, "queue");
  assert.equal(runner.sent[0][0], "rel");
  assert.match(runner.sent[0][1], /\[세션 호출\] 부른 세션: A[\s\S]*develop을 main에 합치고/);
  assert.equal(release.events.at(-1).call, true);
  assert.equal(a.events.at(-1).kind, "message");
  assert.equal(a.events.at(-1).call, true);
  // 불린 세션은 결과를 부른 세션에 돌려줄 수 있지만, 부른 세션은 이 연결로 메시지를 먼저 보내거나 반대로 부를 수 없다.
  assert.equal(mailbox.send(release, "A", "릴리즈 끝").via, "queue");
  assert.throws(() => mailbox.send(a, "릴리즈", "그냥 메시지"), /찾지 못했습니다/);
  release.events.push({ kind: "user", text: "A 세션 불러" });
  assert.throws(() => mailbox.call(release, "A", "되부르기"), /찾지 못했습니다/);
  // 연결 없는 세션은 부를 수 없다.
  assert.throws(() => mailbox.call(a, "C", "C 불러"), /찾지 못했습니다/);
  // 목록에는 부르기 가능 여부가 보인다.
  assert.match(mailbox.directory(a), /릴리즈 .*부르기\(사용자가 요청할 때만\)/);
  assert.doesNotMatch(mailbox.directory(a), /릴리즈 .*메시지/);
});

test("messages: 연결로 넘어온 작업에서는 부를 수 없고, @세션 참조는 이름 대신 쓸 수 있다", () => {
  const { sessions, mailbox } = world([session("a"), session("b", { title: "검토" })], [link("a", "b", { when: "call" })]);
  const a = sessions.get("a");
  a.events.push({ kind: "user", text: "검토 세션 불러", from: "x", fromTitle: "X" });
  assert.throws(() => mailbox.call(a, "검토", "봐 줘"), /사용자가 직접 보낸 요청/);
  a.events.push({ kind: "user", text: "@agenthub://session/b 한테 넘겨", references: [{ label: "세션/검토", path: "agenthub://session/b" }] });
  assert.equal(mailbox.call(a, "b", "봐 줘").target.id, "b");
});

test("messages: 부르고 기다리면 불린 세션이 send_message로 돌려준 결과를 도구 결과로 받는다", async () => {
  const { sessions, runner, mailbox } = world([session("a"), session("b", { title: "릴리즈" })], [link("a", "b", { when: "call" })]);
  const a = sessions.get("a"), b = sessions.get("b");
  a.events.push({ kind: "user", text: "릴리즈 불러서 결과 받아 줘" });
  runner.running.add("a");
  const pending = mailbox.callAndWait(a, "릴리즈", "v0.16 릴리즈");
  assert.match(runner.sent[0][1], /결과를 기다리고 있다/);
  assert.equal(mailbox.send(b, "A", "v0.16 배포 완료").via, "answer");
  assert.equal((await pending).answer, "v0.16 배포 완료");
});

test("messages: 답변 블록의 call은 부르기 규칙을 거친다", async () => {
  const { processMessageBlocks } = mailboxBlocks;
  const { sessions, runner, mailbox } = world([session("a"), session("b", { title: "릴리즈" })], [link("a", "b", { when: "call" })]);
  const a = sessions.get("a");
  a.events.push({ kind: "user", text: "정리해 줘" });
  a.events.push({ kind: "text", text: "```agenthub-message\n{\"to\": \"릴리즈\", \"text\": \"릴리즈해 줘\", \"call\": true}\n```" });
  processMessageBlocks(a, true, { mailbox, runner });
  assert.match(a.events.at(-1).text, /세션을 부르지 못했습니다: .*직접 말하지 않았다/);
  a.events.push({ kind: "user", text: "릴리즈에 넘겨" });
  a.events.push({ kind: "text", text: "```agenthub-message\n{\"to\": \"릴리즈\", \"text\": \"릴리즈해 줘\", \"call\": true}\n```" });
  processMessageBlocks(a, true, { mailbox, runner });
  assert.equal(runner.sent.at(-1)[0], "b");
});

test("messages: 요청 시 부르기 연결은 턴이 끝나도 결과를 넘기지 않는다", async () => {
  const { sessions, runner, finish } = world([session("a"), session("b")], [link("a", "b", { when: "call" }), link("a", "b", { id: "always", when: "always", enabled: false })]);
  const a = sessions.get("a");
  a.events.push({ kind: "user", text: "작업" }, { kind: "text", text: "끝" });
  runner.running.add("a");
  await finish(a);
  assert.equal(runner.sent.length, 0);
});

// 애플리케이션 포트와 파일 저장소의 경계, 명시적인 턴 종료 순서를 검증한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Mailbox, ProjectBoard, processMessageBlocks, createMessagingService } from "../server/application/messaging.mjs";
import { Mailbox as FileMailbox, createBoardStore } from "../server/messages.mjs";
import { LinkStore } from "../server/links.mjs";
import { Chain } from "../server/chain.mjs";
import { FileMessageLog } from "../server/infrastructure/persistence/messages.mjs";
import { FileBoardRepository } from "../server/infrastructure/persistence/boards.mjs";
import { createMessagingTools, handleRpc } from "../server/mcp.mjs";

function fixture({ dataDir, connections = [{ from: "a", to: "b", enabled: true, when: "manual" }] } = {}) {
  const sessions = new Map(["a", "b", "c"].map((id) => [id, {
    id, title: id.toUpperCase(), agent: "claude", projectPath: "C:/p", cwd: "C:/p", events: [], state: "idle",
  }]));
  const runner = Object.assign(new EventEmitter(), {
    sent: [], running: new Set(),
    isRunning(id) { return this.running.has(id); },
    canInject() { return false; },
    send(session, text, cli, input, meta) {
      this.running.add(session.id);
      this.sent.push(session.id);
      this.append(session, { kind: "user", text, ...meta });
    },
    append(session, event) { session.events.push(event); },
  });
  const links = { list: () => connections, from: (id) => connections.filter((link) => link.from === id) };
  const chain = new Chain({
    store: { get: (id) => sessions.get(id) }, runner, links,
    cliPaths: () => ({ claude: "fake" }), compose: (session, text) => text, autoTurnEnd: false,
  });
  let recorded = [];
  const options = { runner, chain, links, sessions: () => [...sessions.values()], autoTurnEnd: false };
  const mailbox = dataDir
    ? new FileMailbox({ ...options, dataDir })
    : new Mailbox({ ...options, messageLog: { list: () => [], save: (entries) => { recorded = structuredClone(entries); } } });
  return { sessions, runner, chain, mailbox, connections, recorded: () => recorded };
}

test("messaging service: 명시한 턴 종료만 질문을 정리하며 dispose는 남은 질문을 끝낸다", async () => {
  const { sessions, runner, chain, mailbox, recorded } = fixture();
  const a = sessions.get("a");
  runner.running.add(a.id);
  assert.equal(runner.listenerCount("turnEnd"), 0);
  const pending = mailbox.ask(a, "b", "결정이 필요하다");
  runner.emit("turnEnd", a, true);
  assert.equal(mailbox.asks.has(a.id), true);
  assert.equal(recorded().length, 1);
  mailbox.onTurnEnd(a);
  assert.equal((await pending).answer, null);
  assert.equal(mailbox.sentThisTurn.has(a.id), false);
  const next = mailbox.ask(a, "b", "다음 결정");
  mailbox.dispose();
  chain.dispose();
  assert.equal((await next).answer, null);
  assert.equal(mailbox.asks.size, 0);
});

test("messaging service: MCP와 답변 블록이 한 턴의 전송 한도를 공유한다", () => {
  const { sessions, runner, chain, mailbox } = fixture();
  const a = sessions.get("a");
  runner.running.add("b");
  for (let i = 0; i < 12; i++) mailbox.send(a, "b", "필요한 결과 " + i);
  a.events.push({ kind: "text", text: '\x60\x60\x60agenthub-message\n{"to":"b","text":"한도 초과"}\n\x60\x60\x60' });
  processMessageBlocks(a, true, { runner, mailbox });
  assert.equal(chain.pending("b"), 12);
  assert.match(a.events.at(-1).text, /12개까지/);
  mailbox.onTurnEnd(a);
  mailbox.send(a, "b", "다음 턴의 결과");
  assert.equal(chain.pending("b"), 13);
  mailbox.dispose();
  chain.dispose();
});

test("messaging service: 블록의 wait를 확정한 뒤 연결을 평가하고 답장이 오면 흐름을 잇는다", async () => {
  const { sessions, runner, chain, mailbox } = fixture({ connections: [
    { from: "a", to: "b", enabled: true, when: "manual" },
    { from: "a", to: "c", enabled: true, when: "success" },
  ] });
  const a = sessions.get("a");
  a.events.push({ kind: "user", text: "일해" }, {
    kind: "text", text: '\x60\x60\x60agenthub-message\n{"to":"b","text":"필요한 결정","wait":true}\n\x60\x60\x60',
  });
  processMessageBlocks(a, true, { runner, mailbox });
  mailbox.onTurnEnd(a);
  await chain.onTurnEnd(a, true);
  assert.equal(a.awaitingReply, "b");
  assert.deepEqual(runner.sent, ["b"]);
  mailbox.send(sessions.get("b"), "a", "결정했다");
  assert.equal(a.awaitingReply, undefined);
  assert.equal(a.events.at(-1).reply, true);
  a.waiting = false; // 실제 Runner.send가 새 요청을 시작하며 지우는 상태
  runner.running.delete(a.id);
  mailbox.onTurnEnd(a);
  await chain.onTurnEnd(a, true);
  assert.deepEqual(runner.sent, ["b", "a", "c"]);
  mailbox.dispose();
  chain.dispose();
});

test("messaging persistence: dataDir를 주입하면 연결·메시지·노트가 서로 격리된다", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-message-services-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const firstDir = path.join(temporary, "first");
  const secondDir = path.join(temporary, "second");
  const first = fixture({ dataDir: firstDir });
  const second = fixture({ dataDir: secondDir });
  first.mailbox.send(first.sessions.get("a"), "b", "첫 서버 기록");
  assert.equal(new FileMessageLog({ dataDir: firstDir }).list().length, 1);
  assert.deepEqual(new FileMessageLog({ dataDir: secondDir }).list(), []);
  assert.deepEqual(second.mailbox.log, []);
  const links = new LinkStore({ dataDir: firstDir });
  links.add({ id: "a-b", from: "a", to: "b", enabled: true });
  assert.equal(new LinkStore({ dataDir: firstDir }).list().length, 1);
  assert.deepEqual(new LinkStore({ dataDir: secondDir }).list(), []);
  const firstBoard = createBoardStore({ dataDir: firstDir });
  const secondBoard = new ProjectBoard({ repository: new FileBoardRepository({ dataDir: secondDir }) });
  firstBoard.post("C:/p", "A", "첫 서버 노트");
  assert.match(firstBoard.read("c:/P"), /첫 서버 노트/);
  assert.equal(secondBoard.read("C:/p"), "");
  secondBoard.write("C:/p", "둘째 서버 노트");
  assert.match(firstBoard.read("C:/p"), /첫 서버 노트/);
  secondBoard.clear("C:/p");
  assert.equal(secondBoard.read("C:/p"), "");
  first.mailbox.dispose();
  first.chain.dispose();
  second.mailbox.dispose();
  second.chain.dispose();
});

test("messaging MCP adapter: 주입한 노트·알림을 사용하며 미연결 수신자는 서비스에서 차단한다", async () => {
  const { sessions, runner, chain, mailbox } = fixture();
  const notes = new Map();
  const notifications = [];
  const board = new ProjectBoard({ repository: {
    read: (project) => notes.get(project) ?? "",
    write: (project, text) => notes.set(project, text),
    clear: (project) => notes.delete(project),
  } });
  const tools = createMessagingTools({ mailbox, board, notify: (...args) => notifications.push(args) });
  const call = (name, args = {}) => handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, sessions.get("a"), tools);
  const rejected = await call("send_message", { to: "c", text: "전달 금지" });
  assert.equal(rejected.result.isError, true);
  assert.deepEqual(runner.sent, []);
  assert.equal((await call("board_post", { text: "공유할 결정" })).result.isError, undefined);
  assert.match((await call("board_read")).result.content[0].text, /공유할 결정/);
  assert.deepEqual(notifications, [["board", { projectPath: "C:/p" }]]);
  mailbox.dispose();
  chain.dispose();
});


test("messaging service: 노트 수정의 검증·정규화·삭제와 알림을 전송 계층 없이 처리한다", () => {
  const { sessions, chain, mailbox } = fixture();
  const notes = new Map();
  const notifications = [];
  const board = new ProjectBoard({ repository: {
    read: (project) => notes.get(project) ?? "",
    write: (project, text) => notes.set(project, text),
    clear: (project) => notes.delete(project),
  } });
  const projects = { ensureProject(projectPath) {
    if (!projectPath) throw new Error("필수 프로젝트");
    return { path: "C:/p" };
  } };
  const service = createMessagingService({ mailbox, board, projects, notify: (...args) => notifications.push(args) });
  assert.throws(() => service.readBoard(""), { status: 400 });
  assert.throws(() => service.list(""), { status: 400 });
  assert.throws(() => service.writeBoard({ text: "값" }), /필수 프로젝트/);
  assert.throws(() => service.writeBoard({ path: "C:/p", text: "x".repeat(60001) }), { status: 400 });
  assert.equal(notes.size, 0);
  assert.deepEqual(notifications, []);
  assert.deepEqual(service.writeBoard({ path: "c:/P", text: "  결정한 내용  " }), { text: "결정한 내용\n" });
  assert.deepEqual(service.readBoard("C:/p"), { text: "결정한 내용\n" });
  mailbox.send(sessions.get("a"), "b", "기록");
  assert.equal(service.list("c:/P").length, 1);
  assert.deepEqual(service.writeBoard({ path: "C:/p", text: "  " }), { text: "" });
  assert.equal(notes.size, 0);
  assert.deepEqual(notifications, [["board", { projectPath: "C:/p" }], ["board", { projectPath: "C:/p" }]]);
  mailbox.dispose();
  chain.dispose();
});


test("chain lifecycle: 종료 도중 명령이 끝나도 다음 명령·대기 작업을 시작하지 않는다", async () => {
  const { sessions, runner, chain } = fixture();
  const command = { id: "cmd:check", title: "검사", queued: { depth: 2 } };
  chain.commands = { get: (id) => id === command.id ? command : null, update: (cmd, changes) => Object.assign(cmd, changes) };
  let stopped = 0;
  chain.runs.set(command.id, { stop: () => stopped++ });
  runner.running.add("b");
  chain.enqueue(sessions.get("b"), "다음 사용자 작업", { user: true }, 0);
  chain.dispose();
  assert.equal(stopped, 1);
  assert.equal(command.queued, null);
  assert.equal(chain.pending("b"), 0);
  command.queued = { depth: 2 }; // 중지 요청 전에 완료된 비동기 실행의 남은 상태
  let restarted = 0;
  chain.runCommand = () => restarted++;
  await chain.afterCommand(command, { exitCode: 0, output: "완료", stopped: false }, { origin: sessions.get("a"), depth: 1 });
  runner.running.delete("b");
  chain.enqueue(sessions.get("b"), "늦게 들어온 작업", { user: true }, 0);
  await chain.onTurnEnd(sessions.get("a"), true);
  assert.equal(restarted, 0);
  assert.deepEqual(runner.sent, []);
});

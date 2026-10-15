import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Chain } from "../server/chain.mjs";
import { Mailbox } from "../server/application/messaging.mjs";
import { createTurnLifecycle } from "../server/application/lifecycle.mjs";

// Real chain and mailbox, with execution and persistence replaced by in-memory ports.
function world(t) {
  const make = (id) => ({ id, title: id, agent: "codex", cwd: "C:/fixture", projectPath: "C:/fixture", events: [], state: "idle" });
  const [source, peer, next] = ["source", "peer", "next"].map(make);
  const sessions = new Map([source, peer, next].map((s) => [s.id, s]));
  const runner = Object.assign(new EventEmitter(), {
    running: new Set(), sent: [],
    isRunning(id) { return this.running.has(id); },
    canInject() { return false; },
    append(session, event) { session.events.push(event); },
    send(session, text, cli, prompt, meta) {
      session.waiting = false;
      this.running.add(session.id);
      this.sent.push({ id: session.id, text, meta });
      this.append(session, { kind: "user", text, ...meta });
    },
  });
  const edges = [
    { id: "contact", from: source.id, to: peer.id, when: "manual", enabled: true },
    { id: "workflow", from: source.id, to: next.id, when: "success", enabled: true },
  ];
  const links = { list: () => edges, from: (id) => edges.filter((edge) => edge.from === id) };
  const chain = new Chain({ store: { get: (id) => sessions.get(id) }, runner, links,
    cliPaths: () => ({ codex: "fixture" }), compose: (session, text) => text, autoTurnEnd: false });
  const mailbox = new Mailbox({ runner, chain, links, sessions: () => [...sessions.values()],
    messageLog: { list: () => [], save() {} }, autoTurnEnd: false });
  t.after(() => { mailbox.dispose(); chain.dispose(); });
  const complete = createTurnLifecycle({ runner, mailbox, chain,
    sessions: { finishHandover() {} }, workflows: { recordPlan() {} }, notify() {} });
  async function finish(session, answer) {
    runner.running.delete(session.id);
    runner.append(session, { kind: "text", text: answer });
    await complete(session, true);
  }
  source.events.push({ kind: "user", text: "작업을 진행해 줘" });
  return { source, peer, next, runner, chain, mailbox, finish };
}

const block = (type, value) => "```agenthub-" + type + "\n" + JSON.stringify(value) + "\n```";

test("lifecycle: 유효한 질문은 자동 연결을 멈추고 잘못된 질문은 실행을 막지 않는다", async (t) => {
  const waiting = world(t);
  await waiting.finish(waiting.source, block("question", { questions: [{
    header: "배포", question: "어느 환경에 배포할까요?", multiSelect: false,
    options: [{ label: "개발", description: "개발 환경" }, { label: "운영", description: "운영 환경" }],
  }] }));
  assert.equal(waiting.source.waiting, true);
  assert.equal(waiting.source.events.find((event) => event.kind === "question").status, "pending");
  assert.deepEqual(waiting.runner.sent, []);

  const invalid = world(t);
  await invalid.finish(invalid.source, block("question", { questions: [] }));
  assert.equal(invalid.source.events.find((event) => event.kind === "question").status, "invalid");
  assert.deepEqual(invalid.runner.sent.map((item) => item.id), [invalid.next.id]);
});

test("lifecycle: 메시지 답을 기다리면 흐름을 멈추고 답장으로 재개한 작업은 다음 노드로 넘긴다", async (t) => {
  const { source, peer, next, runner, mailbox, finish } = world(t);
  await finish(source, block("message", { to: peer.id, text: "API 응답 필드를 알려 주세요", wait: true }));
  assert.equal(source.awaitingReply, peer.id);
  assert.equal(source.waiting, true);
  assert.deepEqual(runner.sent.map((item) => item.id), [peer.id]);

  mailbox.send(peer, source.id, "status는 문자열입니다");
  assert.equal(source.awaitingReply, undefined);
  assert.equal(source.waiting, false);
  assert.equal(source.events.at(-1).reply, true);
  await finish(source, "응답 필드를 적용했습니다");
  assert.deepEqual(runner.sent.map((item) => item.id), [peer.id, source.id, next.id]);
  assert.match(runner.sent.at(-1).text, /응답 필드를 적용했습니다/);
});

test("lifecycle: 대기열이 새 요청을 시작하기 전에 완료 답변의 질문을 기록한다", async (t) => {
  const { source, runner, chain, finish } = world(t);
  runner.running.add(source.id);
  chain.enqueue(source, "사용자가 대기열에 넣은 다음 요청", { user: true }, 0);
  await finish(source, block("question", { questions: [{ question: "어떤 방법으로 할까요?", options: ["A", "B"] }] }));
  assert.equal(source.events.filter((event) => event.kind === "question").length, 1);
  const questionIndex = source.events.findIndex((event) => event.kind === "question");
  const queuedIndex = source.events.findIndex((event) => event.kind === "user" && event.user);
  assert.ok(questionIndex < queuedIndex);
  assert.deepEqual(runner.sent.map((item) => item.id), [source.id]);
});

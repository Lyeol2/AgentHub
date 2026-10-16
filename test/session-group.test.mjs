import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkCommand } from "../server/commands.mjs";
import { Chain, groupOutcome, groupHandoffText } from "../server/chain.mjs";

const answered = (text) => [{ kind: "user", text: "해 줘" }, { kind: "text", text }];

function setup({ links = [], extra = [] } = {}) {
  const sessions = new Map([
    ["a", { id: "a", title: "프런트", agent: "claude", cwd: process.cwd(), state: "idle", events: answered("화면 완료\n\n완료") }],
    ["b", { id: "b", title: "서버", agent: "codex", cwd: process.cwd(), state: "idle", events: answered("API 완료\n\n완료") }],
    ["next", { id: "next", title: "통합 리뷰", agent: "claude", cwd: process.cwd(), state: "idle", events: [] }],
  ]);
  const nodes = [{ id: "cmd-g", kind: "group", title: "구현 묶음", members: ["a", "b"], projectPath: process.cwd(), state: "idle" }, ...extra];
  const commands = {
    get: (id) => nodes.find((n) => n.id === id) ?? null,
    list: () => nodes,
    update: (c, ch) => Object.assign(c, ch),
  };
  const runner = Object.assign(new EventEmitter(), {
    sent: [], running: new Set(),
    isRunning(id) { return this.running.has(id); },
    send(s, prompt) { this.sent.push([s.id, prompt]); this.running.add(s.id); },
    append() {},
  });
  const chain = new Chain({
    store: { get: (id) => sessions.get(id) }, runner, commands, autoTurnEnd: false,
    links: { list: () => links, from: (id) => links.filter((l) => l.from === id), update: (l, c) => Object.assign(l, c) },
    cliPaths: () => ({ claude: "x", codex: "x" }), compose: (s, t) => t,
  });
  return { sessions, nodes, runner, chain, group: nodes[0] };
}

test("세션 묶음: 묶을 세션이 있어야 하고 개수에 한도가 있다", () => {
  assert.deepEqual(checkCommand({ kind: "group", members: ["a", "b", "a"] }), { kind: "group", title: "결과 모으기", members: ["a", "b"] });
  assert.throws(() => checkCommand({ kind: "group", members: [] }), /하나 이상/);
  assert.throws(() => checkCommand({ kind: "group", members: Array.from({ length: 21 }, (_, i) => `s${i}`) }), /20개까지/);
  assert.throws(() => checkCommand({ kind: "command" }, { id: "cmd-1", kind: "group", members: ["a"] }), /종류는 바꿀 수 없습니다/);
});

test("세션 묶음: 모든 세션이 끝나야 다음 노드로 한 번 넘긴다", async () => {
  const links = [{ id: "l1", from: "cmd-g", to: "next", when: "success", enabled: true, keyword: "" }];
  const { sessions, runner, chain, group } = setup({ links });
  runner.running.add("b"); // 서버 세션은 아직 실행 중
  await chain.onTurnEnd(sessions.get("a"), true);
  assert.deepEqual(runner.sent, [], "실행 중인 세션이 있으면 넘기지 않는다");

  runner.running.delete("b");
  await chain.onTurnEnd(sessions.get("b"), true);
  assert.deepEqual(runner.sent.map(([id]) => id), ["next"]);
  const text = runner.sent[0][1];
  assert.match(text, /세션 묶음 "구현 묶음"에서 넘어온 결과/);
  assert.match(text, /프런트[\s\S]*화면 완료[\s\S]*서버[\s\S]*API 완료/);
  assert.equal(group.state, "success");
  assert.match(group.lastRun.tail, /세션 2개 완료/);
});

test("세션 묶음: 일시중지·답 대기·대기열이 남은 세션도 진행 중으로 본다", async () => {
  const links = [{ id: "l1", from: "cmd-g", to: "next", when: "always", enabled: true, keyword: "" }];
  const { sessions, runner, chain, group } = setup({ links });
  sessions.get("b").paused = true;
  assert.deepEqual((await chain.fireGroup(group)).busy.map((s) => s.id), ["b"]);
  delete sessions.get("b").paused;
  sessions.get("b").waiting = true;
  assert.equal((await chain.fireGroup(group)).busy.length, 1);
  sessions.get("b").waiting = false;
  chain.queue.set("b", [{ id: "q", text: "다음", meta: {}, depth: 0 }]);
  assert.equal((await chain.fireGroup(group)).busy.length, 1);
  chain.queue.delete("b");
  assert.equal((await chain.fireGroup(group)).picked, 1);
  assert.deepEqual(runner.sent.map(([id]) => id), ["next"]);
});

test("세션 묶음: 실패·키워드 조건과 들어오는 연결의 전달", async () => {
  const links = [
    { id: "l1", from: "cmd-g", to: "next", when: "error", enabled: true, keyword: "" },
    { id: "l2", from: "cmd-btn", to: "cmd-g", when: "success", enabled: true, keyword: "" },
  ];
  const button = { id: "cmd-btn", kind: "button", title: "시작", prompt: "각자 맡은 부분을 구현해", projectPath: process.cwd(), state: "idle" };
  const { sessions, runner, chain, group } = setup({ links, extra: [button] });
  sessions.get("b").state = "error";
  assert.deepEqual(groupOutcome([...sessions.values()].slice(0, 2)), { ok: false, verdict: "완료\n완료" });
  await chain.fireGroup(group);
  assert.deepEqual(runner.sent.map(([id]) => id), ["next"], "하나라도 실패하면 실패 연결로 간다");
  assert.equal(group.state, "error");

  // 묶음으로 들어오는 연결은 묶은 세션 모두에 같은 요청을 보낸다.
  runner.sent.length = 0;
  runner.running.clear();
  await chain.runButton(button);
  assert.deepEqual(runner.sent.map(([id, text]) => [id, text]), [["a", "각자 맡은 부분을 구현해"], ["b", "각자 맡은 부분을 구현해"]]);
});

test("세션 묶음: 넘기는 글은 연결 지시를 마지막에 둔다", () => {
  const text = groupHandoffText({ title: "묶음" }, [{ session: { title: "A", agent: "claude", cwd: "C:/a", state: "idle" }, answer: "끝", files: " M a.js" }], { note: "합쳐서 검토하라" });
  assert.match(text, /--- A \(claude\) ---[\s\S]*M a\.js[\s\S]*끝/);
  assert.match(text, /합쳐서 검토하라$/);
});

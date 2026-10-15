import test from "node:test";
import assert from "node:assert/strict";
import { matches, lastAnswer, handoffText } from "../server/chain.mjs";
import { withRole } from "../server/role.mjs";

const link = (when, extra = {}) => ({ when, enabled: true, keyword: "", ...extra });

test("chain: 조건에 따라 넘길지 정한다", () => {
  assert.equal(matches(link("success"), true, ""), true);
  assert.equal(matches(link("success"), false, ""), false);
  assert.equal(matches(link("error"), false, ""), true);
  assert.equal(matches(link("always"), false, ""), true);
  assert.equal(matches(link("manual"), true, ""), false);
  assert.equal(matches(link("keyword", { keyword: "검토 요청" }), true, "끝. 검토 요청"), true);
  assert.equal(matches(link("keyword", { keyword: "검토 요청" }), true, "끝"), false);
  assert.equal(matches(link("success", { enabled: false }), true, ""), false);
  // 사용자가 멈춘 턴은 넘기지 않는다.
  assert.equal(matches(link("always"), null, ""), false);
});

test("chain: 마지막 요청 이후의 답변만 모은다", () => {
  const session = { events: [
    { kind: "user", text: "1" }, { kind: "text", text: "옛 답" },
    { kind: "user", text: "2" }, { kind: "tool", text: "Bash" }, { kind: "text", text: "가" }, { kind: "text", text: "나" },
  ] };
  assert.equal(lastAnswer(session), "가\n\n나");
});

test("chain: 넘기는 내용에 폴더·파일·답변·지시가 들어간다", () => {
  const text = handoffText(
    { title: "A", agent: "claude", role: "프론트\n자세히", cwd: "C:/w/a", worktree: { branch: "agenthub/a" } },
    { note: "리뷰해" }, "답", "M\tx.js");
  assert.match(text, /보낸 세션: A \(claude\)\n보낸 세션의 역할: 프론트\n/);
  assert.match(text, /작업 폴더: C:\/w\/a \(브랜치 agenthub\/a\)/);
  assert.match(text, /M\tx\.js/);
  assert.ok(text.endsWith("리뷰해"));
});

test("role: 새 대화와 역할을 바꾼 직후에만 붙인다", () => {
  const s = { role: "테스트 담당", agentSessionId: null };
  assert.match(withRole(s, "해"), /^\[이 세션의 역할\]\n테스트 담당/);
  s.agentSessionId = "x";
  assert.equal(withRole(s, "해"), "해");
  s.roleChanged = true;
  assert.match(withRole(s, "해"), /역할이 바뀌었다/);
  assert.equal(withRole(s, "해"), "해");
});

test("chain: 승인 연결은 연결선 위에 멈췄다가 승인하면 넘긴다", async () => {
  const { EventEmitter } = await import("node:events");
  const { Chain } = await import("../server/chain.mjs");
  const sessions = new Map([["a", { id: "a", title: "A", agent: "claude", cwd: "C:/a", events: [{ kind: "text", text: "끝냈다" }] }],
    ["b", { id: "b", title: "B", agent: "claude", cwd: "C:/a", events: [] }]]);
  const runner = Object.assign(new EventEmitter(), {
    sent: [], appended: [], running: new Set(),
    isRunning(id) { return this.running.has(id); },
    send(s, prompt) { this.sent.push([s.id, prompt]); this.running.add(s.id); },
    append(s, e) { this.appended.push([s.id, e.text]); },
  });
  const theLink = { id: "l1", from: "a", to: "b", when: "success", keyword: "", enabled: true, approve: true };
  const links = { list: () => [theLink], from: (id) => (id === "a" ? [theLink] : []), update: (l, c) => Object.assign(l, c) };
  const notes = [];
  const chain = new Chain({ store: { get: (id) => sessions.get(id) }, runner, links, cliPaths: () => ({ claude: "x" }), compose: (s, t) => t, notify: (k) => notes.push(k) });

  await chain.onTurnEnd(sessions.get("a"), true);
  assert.equal(runner.sent.length, 0); // 승인 전에는 넘기지 않는다.
  assert.equal(theLink.pending.preview, "끝냈다");
  assert.ok(notes.includes("links"));

  await chain.decide(theLink, true);
  assert.equal(theLink.pending, null);
  assert.equal(runner.sent[0][0], "b");
  await assert.rejects(chain.decide(theLink, true)); // 이미 처리했다.
});

test("chain: 사용자 대기열은 턴이 끝나면 보내고, 멈추면 남겨 둔다", async () => {
  const { EventEmitter } = await import("node:events");
  const { Chain } = await import("../server/chain.mjs");
  const s = { id: "a", title: "A", agent: "claude", cwd: "C:/a", events: [] };
  const runner = Object.assign(new EventEmitter(), {
    sent: [], running: new Set(["a"]),
    isRunning(id) { return this.running.has(id); },
    send(x, prompt) { this.sent.push(prompt); this.running.add(x.id); },
    append() {},
  });
  const chain = new Chain({ store: { get: () => s }, runner, links: { from: () => [] }, cliPaths: () => ({ claude: "x" }), compose: (x, t) => t });

  const first = chain.enqueue(s, "하나", { user: true }, 0);
  chain.enqueue(s, "둘", { user: true }, 0);
  assert.deepEqual(chain.list("a").map((i) => i.text), ["하나", "둘"]);
  assert.equal(runner.sent.length, 0); // 실행 중이면 기다린다.

  runner.running.delete("a");
  await chain.onTurnEnd(s, null); // 사용자가 멈춤: 대기열은 남기고 시작하지 않는다.
  assert.equal(runner.sent.length, 0);
  assert.equal(chain.list("a").length, 2);

  assert.equal(chain.take("a", first.id).text, "하나");
  await chain.onTurnEnd(s, true);
  assert.deepEqual(runner.sent, ["둘"]);
  assert.equal(chain.list("a").length, 0);
});

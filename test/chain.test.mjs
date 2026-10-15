import test from "node:test";
import assert from "node:assert/strict";
import { matches, lastAnswer, handoffText, verdictLine, hasKeyword, pickLinks, noMatchNote, CONDITIONS, CONDITION_LABELS, MAX_HOPS } from "../server/chain.mjs";
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
  // 키워드는 에이전트가 쓴 판정이므로 실패로 끝난 턴에서도 본다.
  assert.equal(matches(link("keyword", { keyword: "통과" }), false, "통과"), true);
  assert.equal(matches(link("success", { enabled: false }), true, ""), false);
  // 사용자가 멈춘 턴은 넘기지 않는다.
  assert.equal(matches(link("always"), null, ""), false);
  // 화면에 내려 주는 선택지는 서버가 받는 조건과 같다.
  assert.deepEqual(Object.keys(CONDITION_LABELS).sort(), [...CONDITIONS].sort());
});

test("chain: 판정 줄은 답변의 마지막 글 줄이고 꾸밈을 걷어 낸다", () => {
  assert.equal(verdictLine("수정 필요가 있나 봤다.\n\n**통과**\n"), "통과");
  assert.equal(verdictLine("정리\n- 결과: \"수정 필요\""), "결과: \"수정 필요\"");
  assert.equal(verdictLine("> ## 검토 요청"), "검토 요청");
  assert.equal(verdictLine("```js\nx\n```"), "x");
  assert.equal(verdictLine(""), "");
});

test("chain: 키워드 뒤에 부정이 오면 맞지 않는다", () => {
  assert.equal(hasKeyword("수정 필요 없음. 통과", "수정 필요"), false);
  assert.equal(hasKeyword("수정 필요 없음. 통과", "통과"), true);
  assert.equal(hasKeyword("검토 요청 아님", "검토 요청"), false);
  assert.equal(hasKeyword("수정이 불필요", "수정이"), false);
  assert.equal(hasKeyword("수정 필요", "수정 필요"), true);
  assert.equal(hasKeyword("Fix needed", "fix needed"), true);
  assert.equal(hasKeyword("fix needed: none", "fix needed"), true); // 부정은 키워드 바로 뒤만 본다.
  assert.equal(hasKeyword("needs fix: no", "needs fix"), true);
  // 쉼표로 여러 키워드
  assert.equal(hasKeyword("LGTM", "통과, lgtm"), true);
  assert.equal(hasKeyword("수정 필요 없음, 그런데 수정 필요", "수정 필요"), true);
  assert.equal(hasKeyword("아무 말", ""), false);
});

test("chain: 나가는 연결을 키워드 → 성공·실패 → 그 외 순서로 고른다", () => {
  const ok = link("success", { id: "ok" });
  const fail = link("error", { id: "fail" });
  const pass = link("keyword", { id: "pass", keyword: "통과" });
  const fix = link("keyword", { id: "fix", keyword: "수정 필요" });
  const rest = link("otherwise", { id: "rest" });
  const log = link("always", { id: "log" });
  const all = [ok, fail, pass, fix, rest, log];
  const ids = (ok_, verdict, links = all) => pickLinks(links, ok_, verdict).map((l) => l.id);

  assert.deepEqual(ids(true, "통과"), ["pass", "log"]); // 키워드가 맞으면 성공 연결은 건너뛴다.
  assert.deepEqual(ids(true, "수정 필요 없음"), ["ok", "log"]);
  assert.deepEqual(ids(false, "수정 필요"), ["fix", "log"]);
  assert.deepEqual(ids(false, "모르겠다"), ["fail", "log"]);
  assert.deepEqual(ids(true, "모르겠다", [pass, fix, rest]), ["rest"]); // 아무것도 안 맞으면 그 외
  assert.deepEqual(ids(true, "통과", [pass, rest]), ["pass"]);
  assert.deepEqual(ids(true, "", [link("manual")]), []);
  assert.deepEqual(ids(null, "통과"), []); // 사용자가 멈춘 턴
  assert.deepEqual(ids(true, "통과", [{ ...pass, enabled: false }, rest]), ["rest"]); // 꺼진 연결은 없는 셈이다.
});

test("chain: 조건을 따지는 연결이 모두 안 맞으면 기록에 이유를 남긴다", () => {
  assert.match(noMatchNote([link("keyword", { keyword: "통과" })], "모르겠다"), /마지막 줄: "모르겠다"/);
  assert.equal(noMatchNote([link("manual"), link("always")], "x"), null);
  assert.equal(noMatchNote([], "x"), null);
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

// 세션 두세 개와 가짜 runner로 Chain을 만든다. 보낸 요청은 runner.sent에 [세션 id, 내용]으로 쌓인다.
async function fakeChain(linkList, answers) {
  const { EventEmitter } = await import("node:events");
  const { Chain } = await import("../server/chain.mjs");
  const sessions = new Map(Object.entries(answers).map(([id, text]) =>
    [id, { id, title: id.toUpperCase(), agent: "claude", cwd: "C:/a", events: [{ kind: "text", text }] }]));
  const runner = Object.assign(new EventEmitter(), {
    sent: [], notes: [],
    isRunning: () => false,
    send(s, prompt) { this.sent.push([s.id, prompt]); },
    append(s, e) { this.notes.push([s.id, e.text]); },
  });
  const links = { list: () => linkList, from: (id) => linkList.filter((l) => l.from === id), update: (l, c) => Object.assign(l, c) };
  const chain = new Chain({ store: { get: (id) => sessions.get(id) }, runner, links, cliPaths: () => ({ claude: "x" }), compose: (s, t) => t });
  return { chain, runner, sessions };
}

test("chain: 리뷰가 '수정 필요 없음'이라 써도 구현으로 되돌리지 않는다", async () => {
  const toImpl = { id: "l1", from: "review", to: "impl", when: "keyword", keyword: "수정 필요", enabled: true };
  const toDone = { id: "l2", from: "review", to: "done", when: "keyword", keyword: "통과", enabled: true };
  const { chain, runner, sessions } = await fakeChain([toImpl, toDone], { review: "수정 필요 없음.\n\n통과", impl: "", done: "" });
  await chain.onTurnEnd(sessions.get("review"), true);
  assert.deepEqual(runner.sent.map(([id]) => id), ["done"]);
});

test("chain: 아무 연결도 맞지 않으면 기록에 남기고 넘기지 않는다", async () => {
  const l = { id: "l1", from: "a", to: "b", when: "keyword", keyword: "검토 요청", enabled: true };
  const { chain, runner, sessions } = await fakeChain([l], { a: "아직 하는 중", b: "" });
  await chain.onTurnEnd(sessions.get("a"), true);
  assert.equal(runner.sent.length, 0);
  assert.ok(runner.notes.some(([id, text]) => id === "a" && text.includes("조건에 맞는 연결이 없어")));
});

test("chain: 승인한 넘기기는 조건이 맞았던 그 답변을 넘긴다", async () => {
  const l = { id: "l1", from: "a", to: "b", when: "success", enabled: true, approve: true };
  const { chain, runner, sessions } = await fakeChain([l], { a: "첫 답변", b: "" });
  await chain.onTurnEnd(sessions.get("a"), true);
  sessions.get("a").events.push({ kind: "user", text: "다음" }, { kind: "text", text: "둘째 답변" });
  await chain.decide(l, true);
  assert.match(runner.sent[0][1], /첫 답변/);
  assert.doesNotMatch(runner.sent[0][1], /둘째 답변/);
});

test("chain: 자동 연결은 최대 단계를 넘지 않는다", async () => {
  const l = { id: "l1", from: "a", to: "b", when: "always", enabled: true };
  const { chain, runner, sessions } = await fakeChain([l], { a: "끝", b: "" });
  sessions.get("a").chainDepth = MAX_HOPS;
  await chain.onTurnEnd(sessions.get("a"), true);
  assert.equal(runner.sent.length, 0);
  assert.ok(runner.notes.some(([, text]) => text.includes(`${MAX_HOPS}단계`)));
  sessions.get("a").chainDepth = MAX_HOPS - 1;
  await chain.onTurnEnd(sessions.get("a"), true);
  assert.equal(runner.sent.length, 1);
  assert.equal(sessions.get("b").chainDepth, MAX_HOPS);
});

test("chain: 일시중지한 세션은 대기열을 쌓아 두기만 하고, 멈춰도 버리지 않는다", async () => {
  const l = { id: "l1", from: "a", to: "b", when: "always", enabled: true };
  const { chain, runner, sessions } = await fakeChain([l], { a: "끝", b: "" });
  const b = sessions.get("b");
  b.paused = true;
  await chain.onTurnEnd(sessions.get("a"), true);
  assert.equal(runner.sent.length, 0); // 넘어온 작업이 쌓이기만 한다.
  assert.equal(chain.list("b").length, 1);
  await chain.onTurnEnd(b, null); // 일시중지로 멈춘 턴
  assert.equal(chain.list("b").length, 1);
  delete b.paused;
  chain.flush(b);
  assert.equal(runner.sent[0][0], "b");
});

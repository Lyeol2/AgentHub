import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkCommand, commandHandoffText, parseGenerated, outputTail, runShell, shells } from "../server/commands.mjs";
import { Chain } from "../server/chain.mjs";

const shell = shells()[0].id;

test("commands: 입력 검사와 출력 꼬리", () => {
  assert.throws(() => checkCommand({ command: " " }));
  assert.throws(() => checkCommand({ command: "x", shell: "없는셸" }));
  const c = checkCommand({ command: "npm test\nnpm run lint" });
  assert.equal(c.title, "npm test");
  assert.equal(c.cwdMode, "source");
  assert.equal(outputTail("a\nb\nc\n\n", 2), "b\nc");
});

test("commands: 생성 답에서 JSON을 꺼낸다", () => {
  const made = parseGenerated('설명입니다\n```json\n{"title":"테스트","command":"npm test","explanation":"테스트를 돌린다"}\n```');
  assert.deepEqual(made, { title: "테스트", command: "npm test", explanation: "테스트를 돌린다" });
  assert.throws(() => parseGenerated("JSON 없음"));
  assert.throws(() => parseGenerated('{"command": ""}'));
});

test("commands: 셸로 실행하고 종료 코드를 받는다", async () => {
  const ok = await runShell({ shell, command: "echo 안녕", cwd: process.cwd(), timeoutSec: 30 }).done;
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /안녕/);
  const fail = await runShell({ shell, command: "exit 3", cwd: process.cwd(), timeoutSec: 30 }).done;
  assert.equal(fail.exitCode, 3);
});

test("commands: 결과를 넘기는 내용에 명령·종료 코드·출력이 들어간다", () => {
  const text = commandHandoffText({ title: "테스트", shell: "cmd", command: "npm test" },
    { exitCode: 1, cwd: "C:/w", tail: "FAIL x" }, { note: "" }, { title: "구현" });
  assert.match(text, /결과: 실패 \(종료 코드 1\)/);
  assert.match(text, /이 명령을 실행시킨 세션: 구현/);
  assert.match(text, /FAIL x/);
  assert.match(text, /원인을 찾아 고쳐라/);
});

test("chain: 세션 → 명령 → 성공·실패에 따라 다음 세션으로 넘긴다", async () => {
  const sessions = new Map([
    ["a", { id: "a", title: "구현", agent: "claude", cwd: process.cwd(), events: [{ kind: "text", text: "고쳤다" }] }],
    ["ok", { id: "ok", title: "리뷰", agent: "claude", cwd: process.cwd(), events: [] }],
    ["bad", { id: "bad", title: "수정", agent: "claude", cwd: process.cwd(), events: [] }],
  ]);
  const cmd = { id: "cmd-1", title: "검사", shell, command: "echo 검사 중\nexit 2", cwdMode: "source", timeoutSec: 30, projectPath: process.cwd(), state: "idle" };
  const commands = { get: (id) => (id === cmd.id ? cmd : null), update: (c, ch) => Object.assign(c, ch) };
  const allLinks = [
    { id: "l1", from: "a", to: "cmd-1", when: "success", enabled: true, keyword: "" },
    { id: "l2", from: "cmd-1", to: "ok", when: "success", enabled: true, keyword: "" },
    { id: "l3", from: "cmd-1", to: "bad", when: "error", enabled: true, keyword: "" },
  ];
  const runner = Object.assign(new EventEmitter(), {
    sent: [], running: new Set(),
    isRunning(id) { return this.running.has(id); },
    send(s, prompt) { this.sent.push([s.id, prompt]); this.running.add(s.id); },
    append() {},
  });
  const chain = new Chain({
    store: { get: (id) => sessions.get(id) }, runner, commands,
    links: { list: () => allLinks, from: (id) => allLinks.filter((l) => l.from === id), update: (l, c) => Object.assign(l, c) },
    cliPaths: () => ({ claude: "x" }), compose: (s, t) => t,
  });
  await chain.onTurnEnd(sessions.get("a"), true);
  await new Promise((r) => { const t = setInterval(() => { if (cmd.state !== "running") { clearInterval(t); r(); } }, 50); });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cmd.state, "error");
  assert.equal(cmd.lastRun.exitCode, 2);
  assert.equal(cmd.lastRun.originTitle, "구현");
  assert.deepEqual(runner.sent.map((x) => x[0]), ["bad"]); // 실패 시 연결로만 갔다.
  assert.match(runner.sent[0][1], /검사 중/);
});

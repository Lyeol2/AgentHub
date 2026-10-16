import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Chain } from "../server/chain.mjs";

class FakeRunner extends EventEmitter {
  calls = [];
  running = new Set();
  isRunning(id) { return this.running.has(id); }
  append(session, event) { session.events.push(event); }
  send(session, prompt, cli, input, meta) {
    this.calls.push({ id: session.id, prompt, input, meta });
    this.running.add(session.id);
    session.state = "running";
    session.events.push({ kind: "user", text: prompt, ...meta });
  }
}

function fixture(t, { nodes = [], connections = [], runGit } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-flow-runtime-"));
  const sessions = new Map(["a", "b", "next", "fail"].map((id) => [id, {
    id, title: id.toUpperCase(), agent: "claude", cwd: directory, projectPath: directory,
    state: "idle", events: [],
  }]));
  const nodeList = nodes.map((node) => ({ projectPath: directory, state: "idle", lastRun: null, ...node }));
  const commands = {
    list: () => nodeList,
    get: (id) => nodeList.find((node) => node.id === id) ?? null,
    update: (node, changes) => Object.assign(node, changes),
  };
  const links = connections.map((link, index) => ({ id: "link-" + index, enabled: true, when: "success", keyword: "", note: "", ...link }));
  const runner = new FakeRunner();
  const chain = new Chain({
    store: { get: (id) => sessions.get(id) ?? null, list: () => [...sessions.values()], touch() {}, flush() {} },
    runner, commands, autoTurnEnd: false, cliPaths: () => ({ claude: "fake-cli" }), compose: (_session, text) => text,
    links: { list: () => links, from: (id) => links.filter((link) => link.from === id), update: (link, changes) => Object.assign(link, changes) },
    ...(runGit ? { runGit } : {}),
  });
  t.after(() => {
    chain.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const node = (id) => commands.get(id);
  const complete = async (id, text, ok = true) => {
    const session = sessions.get(id);
    runner.running.delete(id);
    session.state = ok ? "idle" : "error";
    session.events.push({ kind: "text", text }, { kind: "result", text: "턴 완료" });
    await chain.onTurnEnd(session, ok);
  };
  return { chain, runner, sessions, node, commands, links, complete, directory };
}

async function until(predicate, message, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(15);
  assert.ok(predicate(), message);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const platformShell = process.platform === "win32" ? "powershell" : "sh";
const echoCommand = (text) => process.platform === "win32" ? "Write-Output '" + text.replaceAll("'", "''") + "'" : "printf '%s\\n' '" + text.replaceAll("'", "'\\''") + "'";

test("flow runtime: mixed AI, shell and Git results join once per execution using completion snapshots", async (t) => {
  const gitRuns = [];
  const f = fixture(t, {
    nodes: [
      { id: "cmd-shell", kind: "command", title: "테스트", shell: platformShell, command: echoCommand("shell-first"), timeoutSec: 10, cwdMode: "project" },
      { id: "cmd-git", kind: "git", title: "Git 확인", gitAction: "use", branch: "feature/test" },
      { id: "cmd-group", kind: "group", title: "혼합 결과", members: ["a", "cmd-shell", "cmd-git"] },
    ],
    connections: [{ from: "cmd-group", to: "next" }],
    runGit: () => {
      const run = deferred();
      gitRuns.push(run);
      return run.promise;
    },
  });
  const first = f.chain.newFlow({ target: "first" });
  f.chain.setFlow(f.sessions.get("a"), first);
  f.runner.send(f.sessions.get("a"), "first request");
  const shellFirst = f.chain.runCommand(f.node("cmd-shell"), { flow: first });
  const gitFirst = f.chain.runCommand(f.node("cmd-git"), { flow: first });
  await f.complete("a", "AI-first");
  await shellFirst;
  assert.equal(f.runner.calls.filter((call) => call.id === "next").length, 0, "all three results are required");
  // Neither a later AI turn nor a mutated command card may replace the already completed result.
  f.sessions.get("a").events.push({ kind: "user", text: "unrelated" }, { kind: "text", text: "AI-later" });
  f.node("cmd-shell").lastRun.tail = "shell-later";
  gitRuns[0].resolve({ ok: true, output: "git-first", branch: "feature/test", cwd: f.directory });
  await gitFirst;
  let forwarded = f.runner.calls.filter((call) => call.id === "next");
  assert.equal(forwarded.length, 1);
  assert.match(forwarded[0].prompt, /AI-first/);
  assert.match(forwarded[0].prompt, /shell-first/);
  assert.match(forwarded[0].prompt, /git-first/);
  assert.doesNotMatch(forwarded[0].prompt, /AI-later|shell-later/);
  await f.chain.checkGroups(f.sessions.get("a"));
  assert.equal(f.runner.calls.filter((call) => call.id === "next").length, 1, "rechecking completion cannot duplicate a join");

  f.runner.running.delete("next");
  const second = f.chain.newFlow({ target: "second" });
  f.chain.setFlow(f.sessions.get("a"), second);
  f.runner.send(f.sessions.get("a"), "second request");
  await f.complete("a", "AI-second");
  f.node("cmd-shell").command = echoCommand("shell-second");
  await f.chain.runCommand(f.node("cmd-shell"), { flow: second });
  assert.equal(f.runner.calls.filter((call) => call.id === "next").length, 1, "a previous Git completion cannot fill a new execution");
  const gitSecond = f.chain.runCommand(f.node("cmd-git"), { flow: second });
  await until(() => gitRuns.length === 2, "second Git operation starts");
  gitRuns[1].resolve({ ok: true, output: "git-second", branch: "feature/test", cwd: f.directory });
  await gitSecond;
  forwarded = f.runner.calls.filter((call) => call.id === "next");
  assert.equal(forwarded.length, 2);
  assert.match(forwarded[1].prompt, /AI-second[\s\S]*shell-second[\s\S]*git-second/);
  assert.doesNotMatch(forwarded[1].prompt, /AI-first|shell-first|git-first/);
  assert.equal(f.chain.flowFor(f.sessions.get("next")).id, second.id);
});

test("flow runtime: a failed mixed result takes only the group failure route", async (t) => {
  const f = fixture(t, {
    nodes: [
      { id: "cmd-git", kind: "git", title: "Git 확인", gitAction: "use", branch: "feature/test" },
      { id: "cmd-group", kind: "group", title: "검증", members: ["a", "cmd-git"] },
    ],
    connections: [{ from: "cmd-group", to: "next" }, { from: "cmd-group", to: "fail", when: "error" }],
    runGit: async () => ({ ok: false, output: "merge conflict", reason: "conflict", exitCode: 1 }),
  });
  const flow = f.chain.newFlow();
  f.chain.setFlow(f.sessions.get("a"), flow);
  f.runner.send(f.sessions.get("a"), "run");
  await f.complete("a", "AI succeeded");
  await f.chain.runCommand(f.node("cmd-git"), { flow });
  assert.deepEqual(f.runner.calls.filter((call) => call.id !== "a").map((call) => call.id), ["fail"]);
  assert.equal(f.node("cmd-group").state, "error");
  assert.match(f.runner.calls.at(-1).prompt, /merge conflict/);
});

test("flow runtime: input forms render shared values in requests and pass shell variables without interpolating code", async (t) => {
  const shellCommand = process.platform === "win32"
    ? "[Console]::WriteLine($env:AGENTHUB_REQUEST)\n[Console]::WriteLine($env:AGENTHUB_ATTEMPTS)\n[Console]::WriteLine($env:AGENTHUB_INPUT_JSON)"
    : 'printf \'%s\\n\' "$AGENTHUB_REQUEST" "$AGENTHUB_ATTEMPTS" "$AGENTHUB_INPUT_JSON"';
  const f = fixture(t, {
    nodes: [
      { id: "cmd-input", kind: "input", title: "작업 입력", prompt: "{{request}} · 시도 {{attempts}}", fields: [
        { key: "request", label: "요청", type: "textarea", required: true, defaultValue: "" },
        { key: "branch", label: "브랜치", type: "text", required: false, defaultValue: "main" },
        { key: "attempts", label: "횟수", type: "number", required: true, defaultValue: 2 },
      ] },
      { id: "cmd-shell", kind: "command", title: "환경 확인", shell: platformShell, command: shellCommand, timeoutSec: 10, cwdMode: "project" },
    ],
    connections: [{ from: "cmd-input", to: "a", note: "브랜치 {{branch}}" }, { from: "cmd-input", to: "cmd-shell" }],
  });
  const value = "요청 ' \" $(ignored) ; & <tag>";
  await f.chain.runCommand(f.node("cmd-input"), { values: { request: value, attempts: "3" } });
  await until(() => f.node("cmd-shell").state !== "running" && f.node("cmd-shell").lastRun, "shell completes", 10_000);
  assert.equal(f.node("cmd-input").state, "success");
  assert.equal(f.runner.calls[0].prompt, value + " · 시도 3\n\n브랜치 main");
  const flow = f.chain.flowFor(f.sessions.get("a"));
  assert.deepEqual(flow.variables, { request: value, branch: "main", attempts: 3 });
  const shell = f.node("cmd-shell");
  assert.equal(shell.state, "success", shell.lastRun.tail);
  const output = shell.lastRun.tail.split(/\r?\n/);
  assert.equal(output[0], value);
  assert.equal(output[1], "3");
  assert.deepEqual(JSON.parse(output[2]), { request: value, branch: "main", attempts: 3 });
  assert.equal(f.chain.flowFor(shell).id, flow.id);
});

test("flow runtime: required or invalid numeric inputs fail before launching downstream work", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-input", kind: "input", title: "입력", prompt: "{{request}}", fields: [
      { key: "request", label: "요청", type: "text", required: true, defaultValue: "" },
      { key: "count", label: "횟수", type: "number", required: true, defaultValue: 1 },
    ] }],
    connections: [{ from: "cmd-input", to: "a" }],
  });
  await assert.rejects(async () => f.chain.runCommand(f.node("cmd-input"), { values: { request: " " } }), /필수/);
  await assert.rejects(async () => f.chain.runCommand(f.node("cmd-input"), { values: { request: "go", count: "NaN" } }), /숫자/);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.chain.runs.size, 0);
});

test("flow runtime: an approved handoff retains its original input values and execution", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-input", kind: "input", title: "입력", prompt: "요청 {{request}}", fields: [
      { key: "request", label: "요청", type: "text", required: true, defaultValue: "" },
    ] }],
    connections: [{ from: "cmd-input", to: "a", approve: true, note: "확인 {{request}}" }],
  });
  await f.chain.runCommand(f.node("cmd-input"), { values: { request: "original" } });
  assert.equal(f.runner.calls.length, 0);
  const original = f.chain.flowFor(f.node("cmd-input"));
  original.variables.request = "changed after approval request";
  f.node("cmd-input").prompt = "다른 요청";
  await f.chain.decide(f.links[0], true);
  assert.equal(f.runner.calls.length, 1);
  assert.match(f.runner.calls[0].prompt, /요청 original[\s\S]*확인 original/);
  assert.doesNotMatch(f.runner.calls[0].prompt, /changed|다른 요청/);
  assert.equal(f.chain.flowFor(f.sessions.get("a")).id, original.id);
  assert.equal(f.chain.flowFor(f.sessions.get("a")).variables.request, "original");
});

test("flow runtime: bounded retries cross the normal hop limit and exhaust after exactly the configured attempts", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-repeat", kind: "repeat", title: "최대 12회", maxIterations: 12, delayMs: 0 }],
    connections: [
      { from: "cmd-repeat", to: "a", when: "success" },
      { from: "cmd-repeat", to: "fail", when: "error" },
      { from: "a", to: "cmd-repeat", when: "error" },
      { from: "a", to: "next", when: "success" },
    ],
  });
  await f.chain.runCommand(f.node("cmd-repeat"), { prompt: "테스트 후 수정" });
  const runId = f.chain.flowFor(f.sessions.get("a")).id;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await until(() => f.runner.calls.filter((call) => call.id === "a").length === attempt, "attempt " + attempt + " starts");
    assert.equal(f.chain.flowFor(f.sessions.get("a")).id, runId, "retries retain the same execution");
    await f.complete("a", "실패 " + attempt, false);
  }
  await until(() => f.runner.calls.some((call) => call.id === "fail"), "exhaustion is routed");
  assert.equal(f.runner.calls.filter((call) => call.id === "a").length, 12);
  assert.equal(f.runner.calls.filter((call) => call.id === "fail").length, 1);
  assert.equal(f.runner.calls.filter((call) => call.id === "next").length, 0);
  assert.equal(f.node("cmd-repeat").state, "error");
  assert.match(f.node("cmd-repeat").lastRun.tail, /12/);
});

test("flow runtime: a retry body can finish successfully without taking the exhaustion route", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-repeat", kind: "repeat", title: "최대 5회", maxIterations: 5, delayMs: 0 }],
    connections: [
      { from: "cmd-repeat", to: "a" },
      { from: "cmd-repeat", to: "fail", when: "error" },
      { from: "a", to: "cmd-repeat", when: "error" },
      { from: "a", to: "next" },
    ],
  });
  await f.chain.runCommand(f.node("cmd-repeat"), { prompt: "빌드" });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await until(() => f.runner.calls.filter((call) => call.id === "a").length === attempt, "retry body is started");
    await f.complete("a", "수정 필요", false);
  }
  await until(() => f.runner.calls.filter((call) => call.id === "a").length === 3, "third attempt starts");
  await f.complete("a", "세 번째 성공", true);
  await until(() => f.runner.calls.some((call) => call.id === "next"), "success is forwarded");
  assert.deepEqual(f.runner.calls.map((call) => call.id), ["a", "a", "a", "next"]);
  assert.equal(f.chain.runs.size, 0);
});

test("flow runtime: JSON extraction passes only the requested value to the next node", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-transform", kind: "transform", title: "실패 항목", transformMode: "json", expression: "tests.failures[0].name", template: "{{input}}" }],
    connections: [{ from: "a", to: "cmd-transform" }, { from: "cmd-transform", to: "next" }],
  });
  const flow = f.chain.newFlow();
  f.chain.setFlow(f.sessions.get("a"), flow);
  f.runner.send(f.sessions.get("a"), "테스트 실행");
  await f.complete("a", JSON.stringify({ tests: { failures: [{ name: "login.spec failed" }], passes: ["should not forward"] } }));
  await until(() => f.runner.calls.some((call) => call.id === "next"), "transformed value is forwarded");
  const output = f.runner.calls.find((call) => call.id === "next").prompt;
  assert.match(output, /login\.spec failed/);
  assert.doesNotMatch(output, /should not forward/);
  assert.equal(f.node("cmd-transform").state, "success");
  assert.equal(f.chain.flowFor(f.sessions.get("next")).id, flow.id);
});

test("flow runtime: lines extraction filters upstream output and templates share execution variables", async (t) => {
  const f = fixture(t, {
    nodes: [
      { id: "cmd-lines", kind: "transform", title: "실패 줄", transformMode: "lines", expression: "FAIL", template: "{{input}}" },
      { id: "cmd-template", kind: "transform", title: "보고서", transformMode: "template", expression: "", template: "브랜치 {{branch}}\n{{input}}" },
    ],
    connections: [{ from: "a", to: "cmd-lines" }, { from: "cmd-lines", to: "cmd-template" }, { from: "cmd-template", to: "next", note: "{{branch}} 수정" }],
  });
  const flow = f.chain.newFlow({ branch: "feature/login" });
  f.chain.setFlow(f.sessions.get("a"), flow);
  f.runner.send(f.sessions.get("a"), "테스트 실행");
  await f.complete("a", "PASS unaffected\nFAIL login\nPASS ignored\nFAIL logout");
  await until(() => f.runner.calls.some((call) => call.id === "next"), "line and template pipeline completes");
  const output = f.runner.calls.find((call) => call.id === "next").prompt;
  assert.match(output, /브랜치 feature\/login[\s\S]*FAIL login\nFAIL logout/);
  assert.match(output, /feature\/login 수정/);
  assert.doesNotMatch(output, /PASS unaffected|PASS ignored/);
});

for (const [label, input, expression, message] of [
  ["invalid JSON", "not JSON", "tests", /JSON/],
  ["missing JSON path", '{"tests":{}}', "tests.failures[0]", /값을 찾을 수 없습니다/],
]) {
  test("flow runtime: " + label + " marks transformation failed and takes only the error route", async (t) => {
    const f = fixture(t, {
      nodes: [{ id: "cmd-transform", kind: "transform", title: "가공", transformMode: "json", expression, template: "{{input}}" }],
      connections: [{ from: "a", to: "cmd-transform" }, { from: "cmd-transform", to: "next" }, { from: "cmd-transform", to: "fail", when: "error" }],
    });
    f.chain.setFlow(f.sessions.get("a"), f.chain.newFlow());
    f.runner.send(f.sessions.get("a"), "실행");
    await f.complete("a", input);
    await until(() => f.runner.calls.some((call) => call.id === "fail"), "transform error is routed");
    assert.equal(f.node("cmd-transform").state, "error");
    assert.match(f.node("cmd-transform").lastRun.tail, message);
    assert.equal(f.runner.calls.filter((call) => call.id === "next").length, 0);
  });
}

test("flow runtime: file watches debounce changes, coalesce busy bursts, and create a fresh execution each time", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-watch", kind: "watch", title: "소스 감시", watchPaths: ["src"], debounceMs: 100, prompt: "변경 {{changedFiles}}" }],
    connections: [{ from: "cmd-watch", to: "a" }],
  });
  const source = path.join(f.directory, "src");
  fs.mkdirSync(source);
  await f.chain.runCommand(f.node("cmd-watch"));
  assert.equal(f.node("cmd-watch").state, "watching");
  assert.equal(f.runner.calls.length, 0, "arming the watch does not launch downstream work");
  fs.writeFileSync(path.join(source, "one.txt"), "one");
  fs.writeFileSync(path.join(source, "two.txt"), "two");
  await until(() => f.runner.calls.length === 1, "the first file burst starts work");
  await delay(180);
  assert.equal(f.runner.calls.length, 1, "the burst is debounced into one invocation");
  assert.match(f.runner.calls[0].prompt, /src\/one\.txt/);
  assert.match(f.runner.calls[0].prompt, /src\/two\.txt/);
  const firstId = f.chain.flowFor(f.sessions.get("a")).id;

  fs.writeFileSync(path.join(source, "three.txt"), "three");
  fs.writeFileSync(path.join(source, "four.txt"), "four");
  await delay(230);
  assert.equal(f.runner.calls.length, 1, "changes wait while the previous invocation is active");
  assert.equal(f.chain.pending("a"), 0, "watch changes coalesce before becoming queued AI requests");
  await f.complete("a", "first invocation complete");
  await until(() => f.runner.calls.length === 2, "the pending burst starts after completion");
  assert.notEqual(f.chain.flowFor(f.sessions.get("a")).id, firstId);
  assert.match(f.runner.calls[1].prompt, /src\/three\.txt/);
  assert.match(f.runner.calls[1].prompt, /src\/four\.txt/);
  assert.doesNotMatch(f.runner.calls[1].prompt, /src\/one\.txt|src\/two\.txt/);

  assert.equal(f.chain.stopCommand(f.node("cmd-watch")), true);
  assert.equal(f.node("cmd-watch").state, "idle");
  fs.writeFileSync(path.join(source, "five.txt"), "five");
  await delay(230);
  assert.equal(f.runner.calls.length, 2, "a stopped watch cannot launch additional work");
});

test("flow runtime: stopping or disposing a watch clears a pending debounce trigger", async (t) => {
  for (const action of ["stop", "dispose"]) {
    const f = fixture(t, {
      nodes: [{ id: "cmd-watch", kind: "watch", title: "감시", watchPaths: ["src"], debounceMs: 100, prompt: "{{changedFiles}}" }],
      connections: [{ from: "cmd-watch", to: "a" }],
    });
    const source = path.join(f.directory, "src");
    fs.mkdirSync(source);
    await delay(120);
    assert.equal(f.runner.calls.length, 0, "saved watches require an explicit start");
    await f.chain.runCommand(f.node("cmd-watch"));
    fs.writeFileSync(path.join(source, "changed.txt"), action);
    if (action === "stop") f.chain.stopCommand(f.node("cmd-watch"));
    else f.chain.dispose();
    await delay(220);
    assert.equal(f.runner.calls.length, 0, action + " cancels the trailing change");
    assert.equal(f.chain.runs.has("cmd-watch"), false);
  }
});

test("flow runtime: queued AI invocations retain their own execution variables", async (t) => {
  const f = fixture(t, {
    nodes: [
      { id: "cmd-input", kind: "input", title: "요청", prompt: "{{request}}", fields: [{ key: "request", label: "요청", type: "text", required: true, defaultValue: "" }] },
      { id: "cmd-template", kind: "transform", title: "실행 확인", transformMode: "template", expression: "", template: "{{request}}: {{input}}" },
    ],
    connections: [{ from: "cmd-input", to: "a" }, { from: "a", to: "cmd-template" }, { from: "cmd-template", to: "next" }],
  });
  await f.chain.runCommand(f.node("cmd-input"), { values: { request: "first" } });
  const first = f.chain.flowFor(f.sessions.get("a"));
  await f.chain.runCommand(f.node("cmd-input"), { values: { request: "second" } });
  assert.equal(f.chain.pending("a"), 1);
  assert.equal(f.chain.flowFor(f.sessions.get("a")).id, first.id, "queueing must not replace the currently running flow");
  await f.complete("a", "first-result");
  await until(() => f.runner.calls.some((call) => call.id === "next"), "the first result completes");
  assert.match(f.runner.calls.find((call) => call.id === "next").prompt, /first: first-result/);
  assert.notEqual(f.chain.flowFor(f.sessions.get("a")).id, first.id);
  assert.equal(f.runner.calls.filter((call) => call.id === "a").at(-1).prompt, "second");
  f.runner.running.delete("next");
  await f.complete("a", "second-result");
  await until(() => f.runner.calls.filter((call) => call.id === "next").length === 2, "the second result completes");
  assert.match(f.runner.calls.filter((call) => call.id === "next")[1].prompt, /second: second-result/);
});

for (const cancellation of ["original flow flag", "stop command"]) {
  test("flow runtime: approval snapshots cannot restart a cancelled execution via " + cancellation, async (t) => {
    const f = fixture(t, {
      nodes: [
        { id: "cmd-input", kind: "input", title: "입력", prompt: "{{request}}", fields: [{ key: "request", label: "요청", type: "text", required: true, defaultValue: "" }] },
        { id: "cmd-repeat", kind: "repeat", title: "대기", maxIterations: 3, delayMs: 500 },
      ],
      connections: [
        { from: "cmd-input", to: "a", approve: true },
        ...(cancellation === "stop command" ? [{ from: "cmd-input", to: "cmd-repeat" }] : []),
      ],
    });
    await f.chain.runCommand(f.node("cmd-input"), { values: { request: "original request" } });
    const flow = f.chain.flowFor(f.node("cmd-input"));
    assert.notEqual(f.links[0].pending.flow, flow, "approval keeps a separate variables snapshot");
    if (cancellation === "original flow flag") flow.cancelled = true;
    else {
      await until(() => f.chain.runs.has("cmd-repeat"), "the repeat delay is active");
      assert.equal(f.chain.stopCommand(f.node("cmd-repeat")), true);
    }
    await f.chain.decide(f.links[0], true);
    assert.equal(f.links[0].pending, null);
    assert.equal(f.runner.calls.length, 0, "approval cannot revive a cancelled run");
    assert.equal(f.chain.pending("a"), 0);
  });
}

test("flow runtime: group delivery retains the selected result snapshots across asynchronous rendering", async (t) => {
  const f = fixture(t, {
    nodes: [
      { id: "cmd-group", kind: "group", title: "결과", members: ["a", "b"] },
      { id: "cmd-markdown", kind: "markdown", title: "선택된 결과", cwdMode: "project" },
    ],
    connections: [{ from: "cmd-group", to: "next" }, { from: "cmd-group", to: "cmd-markdown", when: "always" }],
  });
  const flow = f.chain.newFlow();
  for (const id of ["a", "b"]) {
    f.chain.setFlow(f.sessions.get(id), flow);
    f.chain.workflow.record(f.sessions.get(id), true, "original-" + id, flow);
  }
  const render = f.chain.groupText.bind(f.chain);
  let changed = false;
  f.chain.groupText = async (...args) => {
    const text = await render(...args);
    if (!changed) {
      changed = true;
      f.chain.workflow.record(f.sessions.get("a"), false, "newer-failed-result", flow);
    }
    return text;
  };
  await f.chain.fireGroup(f.node("cmd-group"), flow);
  assert.equal(changed, true);
  assert.equal(f.runner.calls.length, 1);
  assert.equal(f.node("cmd-group").state, "success");
  assert.match(f.runner.calls[0].prompt, /original-a[\s\S]*original-b/);
  assert.doesNotMatch(f.runner.calls[0].prompt, /newer-failed-result/);
  const printed = fs.readFileSync(f.node("cmd-markdown").lastRun.output.path, "utf8");
  assert.match(printed, /original-a[\s\S]*original-b/);
  assert.doesNotMatch(printed, /newer-failed-result/);
});

test("flow runtime: asynchronous linked command delivery errors are recorded without unhandled rejections", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-transform", kind: "transform", title: "연결 가공", transformMode: "template", expression: "", template: "{{input}}" }],
    connections: [{ from: "a", to: "cmd-transform" }, { from: "cmd-transform", to: "next", note: "{{missing}}" }],
  });
  f.chain.setFlow(f.sessions.get("a"), f.chain.newFlow());
  f.runner.send(f.sessions.get("a"), "source request");
  await f.complete("a", "valid source output");
  await until(() => {
    const result = f.node("cmd-transform").lastRun;
    return !!result && (result.error || result.deliveryErrors?.length);
  }, "the detached delivery failure is attached to the node result");
  const result = f.node("cmd-transform").lastRun;
  assert.match([result.error, ...(result.deliveryErrors ?? [])].filter(Boolean).join("\n"), /missing/);
  assert.equal(f.runner.calls.filter((call) => call.id === "next").length, 0);
  await delay(20); // node:test reports any detached unhandled rejection as a test failure.
});

test("flow runtime: an unknown watch prompt variable rejects before creating a watcher", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-watch", kind: "watch", title: "잘못된 감시", watchPaths: ["src"], debounceMs: 100, prompt: "{{unknown}}" }],
    connections: [{ from: "cmd-watch", to: "a" }],
  });
  fs.mkdirSync(path.join(f.directory, "src"));
  await assert.rejects(async () => f.chain.runCommand(f.node("cmd-watch")), /unknown/);
  assert.equal(f.chain.runs.has("cmd-watch"), false);
  assert.equal(f.runner.calls.length, 0);
});

test("flow runtime: a watch delivery template error disarms the watcher and records the failure", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-watch", kind: "watch", title: "감시", watchPaths: ["src"], debounceMs: 100, prompt: "{{changedFiles}}" }],
    connections: [{ from: "cmd-watch", to: "a", note: "{{missing}}" }],
  });
  const source = path.join(f.directory, "src");
  fs.mkdirSync(source);
  await f.chain.runCommand(f.node("cmd-watch"));
  fs.writeFileSync(path.join(source, "first.txt"), "change");
  await until(() => f.node("cmd-watch").state === "error", "watch delivery failure is visible");
  assert.match(f.node("cmd-watch").lastRun.tail, /missing/);
  assert.equal(f.chain.runs.has("cmd-watch"), false, "the invalid watcher is disarmed");
  assert.equal(f.runner.calls.length, 0);
  fs.writeFileSync(path.join(source, "second.txt"), "later change");
  await delay(180);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.node("cmd-watch").state, "error");
});

test("flow runtime: overlapping inputs queue at a delayed repeat and preserve each execution's variables", async (t) => {
  const f = fixture(t, {
    nodes: [
      { id: "cmd-input", kind: "input", title: "입력", prompt: "{{request}}", fields: [{ key: "request", label: "요청", type: "text", required: true, defaultValue: "" }] },
      { id: "cmd-repeat", kind: "repeat", title: "순서대로 반복", maxIterations: 3, delayMs: 120 },
      { id: "cmd-transform", kind: "transform", title: "값 확인", transformMode: "template", expression: "", template: "{{request}}:{{input}}" },
    ],
    connections: [
      { from: "cmd-input", to: "cmd-repeat" },
      { from: "cmd-repeat", to: "cmd-transform" },
      { from: "cmd-transform", to: "a", note: "{{request}}-note" },
    ],
  });
  await f.chain.runCommand(f.node("cmd-input"), { values: { request: "first" } });
  const first = f.chain.flowFor(f.node("cmd-input"));
  assert.equal(f.chain.runs.has("cmd-repeat"), true, "the first invocation is still waiting");
  await f.chain.runCommand(f.node("cmd-input"), { values: { request: "second" } });
  const second = f.chain.flowFor(f.node("cmd-input"));
  assert.notEqual(second.id, first.id);
  await until(() => f.runner.calls.length === 1, "the first repeat invocation finishes");
  assert.equal(f.runner.calls[0].prompt, "first:first\n\nfirst-note");
  assert.equal(f.chain.flowFor(f.sessions.get("a")).id, first.id);
  await f.complete("a", "first complete");
  await until(() => f.runner.calls.length === 2, "the queued second invocation also finishes");
  assert.equal(f.runner.calls[1].prompt, "second:second\n\nsecond-note");
  assert.equal(f.chain.flowFor(f.sessions.get("a")).id, second.id);
  assert.equal(f.node("cmd-repeat").lastRun.runId, second.id);
  assert.equal(f.node("cmd-repeat").lastRun.iteration, 1, "each execution has its own repeat counter");
});

test("flow runtime: rejecting a watch approval releases an already pending change without another file event", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-watch", kind: "watch", title: "감시", watchPaths: ["src"], debounceMs: 100, prompt: "{{changedFiles}}" }],
    connections: [{ from: "cmd-watch", to: "a", approve: true }],
  });
  const source = path.join(f.directory, "src");
  fs.mkdirSync(source);
  await f.chain.runCommand(f.node("cmd-watch"));
  fs.writeFileSync(path.join(source, "first.txt"), "first change");
  await until(() => !!f.links[0].pending, "the first change requests approval");
  const firstId = f.links[0].pending.flow.id;
  assert.match(f.links[0].pending.answer, /first\.txt/);
  fs.writeFileSync(path.join(source, "second.txt"), "second change");
  await until(() => !!f.chain.workflow.watchers.get("cmd-watch")?.pending, "the second change has finished debouncing and is waiting");
  assert.equal(f.links[0].pending.flow.id, firstId, "approval keeps the first change selected");
  assert.equal(f.runner.calls.length, 0);
  await f.chain.decide(f.links[0], false);
  await until(() => f.links[0].pending?.flow.id !== firstId && !!f.links[0].pending, "the waiting change immediately requests its own approval");
  assert.match(f.links[0].pending.answer, /second\.txt/);
  assert.doesNotMatch(f.links[0].pending.answer, /first\.txt/);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.node("cmd-watch").state, "watching");
});

test("flow runtime: manually firing a group starts a fresh execution with current results after its old execution was cancelled", async (t) => {
  const f = fixture(t, {
    nodes: [{ id: "cmd-group", kind: "group", title: "수동 결과 모으기", members: ["a", "b"] }],
    connections: [{ from: "cmd-group", to: "next" }],
  });
  const previous = f.chain.newFlow();
  for (const id of ["a", "b"]) {
    const member = f.sessions.get(id);
    member.events.push({ kind: "user", text: "old request" }, { kind: "text", text: "old-" + id });
    f.chain.setFlow(member, previous);
    f.chain.workflow.record(member, true, "old-" + id, previous);
  }
  await f.chain.fireGroup(f.node("cmd-group"), previous);
  assert.equal(f.runner.calls.length, 1);
  assert.equal(f.chain.flowFor(f.sessions.get("next")).id, previous.id);
  previous.cancelled = true;
  f.runner.running.delete("next");
  for (const id of ["a", "b"]) {
    f.sessions.get(id).events.push({ kind: "user", text: "latest request" }, { kind: "text", text: "latest-" + id });
  }
  await f.chain.fireGroup(f.node("cmd-group"));
  assert.equal(f.runner.calls.length, 2, "a manual trigger runs independently of the cancelled automatic flow");
  assert.match(f.runner.calls[1].prompt, /latest-a[\s\S]*latest-b/);
  assert.doesNotMatch(f.runner.calls[1].prompt, /old-a|old-b/);
  const current = f.chain.flowFor(f.node("cmd-group"));
  assert.notEqual(current.id, previous.id);
  assert.equal(current.cancelled, false);
  assert.equal(f.chain.flowFor(f.sessions.get("next")).id, current.id);
  assert.equal(f.node("cmd-group").lastRun.runId, current.id);
  assert.equal(previous.cancelled, true, "manual execution must not revive the cancelled run");
  await f.chain.checkGroups(f.sessions.get("a"), previous);
  assert.equal(f.runner.calls.length, 2, "the cancelled automatic completion remains suppressed");
});

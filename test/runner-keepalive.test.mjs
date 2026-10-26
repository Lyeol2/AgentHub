import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Runner } from "../server/runner.mjs";

// 가짜 Claude CLI로 턴 사이에 띄워 두기·백그라운드 작업(서브에이전트) 처리를 확인한다.
const tick = () => new Promise((resolve) => setImmediate(resolve));
const MINUTE = 60000;

function fakeChild(args) {
  const child = Object.assign(new EventEmitter(), { args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), messages: [], killed: false, acknowledgePermission: true });
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) {
      const message = JSON.parse(line);
      child.messages.push(message);
      if (child.acknowledgePermission && message.request?.subtype === "set_permission_mode") {
        queueMicrotask(() => child.emit_({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } }));
      }
    }
  });
  child.stdin.once("finish", () => queueMicrotask(() => child.emit("close", 0, null)));
  child.emit_ = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  return child;
}

function fixture(t, { keepAlive = { idleMinutes: 15, maxProcesses: 8 }, ids = ["keep"] } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-18T00:00:00Z") });
  const sessions = new Map(ids.map((id) => [id, { id, agent: "claude", cwd: process.cwd(), permission: "acceptEdits", state: "idle", events: [] }]));
  const children = [];
  const runner = new Runner({ touch() {}, get: (id) => sessions.get(id) }, { spawn: (file, args) => { const child = fakeChild(args); children.push(child); return child; }, keepAlive: () => keepAlive });
  // 테스트에서는 taskkill 대신 바로 끝낸다.
  runner.kill = (child) => { child.killed = true; queueMicrotask(() => child.emit("close", 1, "SIGTERM")); };
  const states = [], ended = [], patches = [];
  runner.on("state", (id, state) => states.push([id, state]));
  runner.on("turnEnd", (session, ok) => ended.push([session.id, ok]));
  runner.on("subtasks", (id, patch) => patches.push([id, patch]));
  t.after(() => {
    for (const child of children) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  });
  const session = sessions.get(ids[0]);
  return { runner, session, sessions, children, states, ended, patches, stateOf: (id = ids[0]) => states.filter(([sid]) => sid === id).map(([, state]) => state) };
}

const lines = (child, subtype) => child.messages.filter((message) => message.type === "control_request" && message.request?.subtype === subtype);
const userTexts = (child) => child.messages.filter((message) => message.type === "user").map((message) => message.message.content[0].text);
const init = (child, id = "conv-1") => child.emit_({ type: "system", subtype: "init", session_id: id, model: "opus" });
const result = (child, extra = {}) => child.emit_({ type: "result", is_error: false, result: "완료", duration_ms: 1000, ...extra });
const launchAgent = (child, taskId = "task-1", toolUseId = "toolu_agent") => {
  child.emit_({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "조사", prompt: "조사해", run_in_background: true } }] } });
  child.emit_({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, description: "조사", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent", prompt: "조사해", spawn_depth: 1 });
  child.emit_({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Async agent launched" }] } });
};

test("shutdown waits for final CLI events before persistence may close", async t => {
  const f = fixture(t);
  f.runner.send(f.session, "work", "fake-cli");
  const child = f.children.at(-1);
  init(child);
  let killed = false;
  f.runner.kill = () => { killed = true; };
  let stopped = false;
  const closing = f.runner.shutdown().then(() => { stopped = true; });
  await tick();
  assert.equal(killed, true);
  assert.equal(stopped, false);
  child.emit_({ type: "assistant", message: { content: [{ type: "text", text: "Last output" }] } });
  child.emit("close", 1, "SIGTERM");
  await closing;
  assert.equal(f.session.events.some(event => event.text === "Last output"), true);
  assert.equal(f.session.state, "idle");
  assert.equal(f.runner.isRunning(f.session.id), false);
  assert.throws(() => f.runner.send(f.session, "late", "fake-cli"), /종료/);
});

test("shutdown retires an unresponsive CLI and ignores late output", async t => {
  const f = fixture(t);
  f.runner.send(f.session, "work", "fake-cli");
  const child = f.children.at(-1);
  init(child);
  f.runner.kill = () => {};
  const closing = f.runner.shutdown({ timeout: 100 });
  t.mock.timers.tick(100);
  await closing;
  assert.equal(child.retired, true);
  assert.equal(f.session.state, "idle");
  const count = f.session.events.length;
  child.emit_({ type: "assistant", message: { content: [{ type: "text", text: "Too late" }] } });
  child.emit("close", 1, "SIGTERM");
  assert.equal(f.session.events.length, count);
});

// 첫 턴에서 백그라운드 서브에이전트를 띄우고 결과까지 받은 상태
async function toBackground(f) {
  f.runner.send(f.session, "조사 맡겨", "fake-cli");
  const child = f.children.at(-1);
  init(child);
  launchAgent(child);
  child.emit_({ type: "assistant", message: { content: [{ type: "text", text: "백그라운드로 맡겼습니다" }] } });
  result(child);
  await tick();
  return child;
}

test("keep-alive: 백그라운드 작업이 있으면 result 뒤에도 입력을 닫지 않고, 작업 완료 후 CLI가 시작한 턴을 실행 중으로 보인다", async (t) => {
  const f = fixture(t);
  const child = await toBackground(f);
  assert.equal(child.stdin.writableEnded, false, "백그라운드 작업 중에는 stdin을 닫지 않는다");
  assert.equal(f.session.state, "background");
  assert.equal(f.runner.isRunning(f.session.id), false);
  assert.equal(f.runner.isBusy(f.session.id), true);
  assert.deepEqual(f.ended, [[f.session.id, true]], "턴 마무리는 프로세스 종료가 아니라 result에서 한다");
  assert.equal(f.session.subtasks.length, 1);
  assert.equal(f.session.subtasks[0].status, "running");
  assert.equal(f.session.subtasks[0].background, true);
  assert.equal(lines(child, "initialize")[0].request.perTaskStopAffordance, true);

  // 서브에이전트의 대화는 본 기록에 섞지 않고 작업의 최근 활동으로만 모은다.
  child.emit_({ type: "assistant", parent_tool_use_id: "toolu_agent", message: { content: [{ type: "text", text: "하위 작업 중간 보고" }, { type: "tool_use", id: "toolu_sub", name: "Read", input: { file_path: "a.txt" } }] } });
  child.emit_({ type: "system", subtype: "task_progress", task_id: "task-1", tool_use_id: "toolu_agent", description: "읽는 중", usage: { total_tokens: 100, tool_uses: 1, duration_ms: 500 }, last_tool_name: "Read", summary: "파일을 읽는 중" });
  await tick();
  assert.equal(f.session.events.some((event) => /하위 작업 중간 보고/.test(event.text ?? "")), false);
  const task = f.session.subtasks[0];
  assert.deepEqual(task.activity.map((item) => [item.kind, item.label ?? null]), [["text", null], ["tool", "파일 읽기"]]);
  assert.equal(task.lastTool, "파일 읽기");
  assert.equal(task.summary, "파일을 읽는 중");
  assert.deepEqual(task.usage, { totalTokens: 100, toolUses: 1, durationMs: 500 });
  assert.equal(f.session.state, "background");

  // 작업 완료 알림 → CLI가 스스로 다음 턴을 시작한다.
  child.emit_({ type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "toolu_agent", status: "completed", output_file: "out.txt", summary: "조사 끝", usage: { total_tokens: 200, tool_uses: 3, duration_ms: 9000 } });
  init(child);
  child.emit_({ type: "assistant", message: { content: [{ type: "text", text: "하위 작업 결과를 정리했습니다" }] } });
  await tick();
  assert.equal(f.session.state, "running");
  assert.equal(f.runner.isRunning(f.session.id), true);
  result(child);
  await tick();
  assert.equal(f.session.state, "idle");
  assert.deepEqual(f.stateOf(), ["running", "background", "running", "idle"]);
  assert.deepEqual(f.ended, [[f.session.id, true], [f.session.id, true]]);
  assert.equal(task.status, "completed");
  assert.equal(task.summary, "조사 끝");
  assert.equal(child.stdin.writableEnded, false, "작업이 없어도 다음 요청까지 띄워 둔다");
  assert.equal(f.session.events.filter((event) => event.kind === "status" && /세션 시작/.test(event.text)).length, 1, "같은 대화의 반복 시작 알림은 남기지 않는다");
  assert.ok(f.patches.length >= 3);
});

test("keep-alive: 백그라운드 작업 중 새 요청은 새 프로세스 없이 열린 입력에 쓴다(대기열 전송 포함)", async (t) => {
  const f = fixture(t);
  const child = await toBackground(f);
  f.runner.send(f.session, "그동안 다른 일", "fake-cli");
  assert.equal(f.children.length, 1);
  assert.equal(f.session.state, "running");
  assert.deepEqual(userTexts(child), ["조사 맡겨", "그동안 다른 일"]);
  assert.equal(lines(child, "set_permission_mode").at(-1).request.mode, "acceptEdits", "다시 쓰는 CLI에는 이번 턴의 권한 모드를 먼저 맞춘다");
  // 턴이 끝나면 대기열(turnEnd 처리)이 같은 프로세스로 바로 다음 요청을 보낼 수 있다.
  f.runner.once("turnEnd", (session) => f.runner.send(session, "대기열 요청", "fake-cli"));
  result(child);
  await tick();
  assert.equal(f.children.length, 1);
  assert.equal(f.session.state, "running");
  assert.deepEqual(userTexts(child).at(-1), "대기열 요청");
  result(child);
  await tick();
  assert.equal(f.session.state, "background", "작업이 남아 있으면 다시 백그라운드 작업 중이다");
});

test("keep-alive: 일시중지는 턴만 멈추고 백그라운드 작업과 프로세스는 유지한다", async (t) => {
  const f = fixture(t);
  f.runner.send(f.session, "조사 맡겨", "fake-cli");
  const child = f.children[0];
  init(child);
  launchAgent(child);
  await tick();
  f.session.paused = true;
  assert.equal(f.runner.interrupt(f.session), true);
  assert.equal(lines(child, "interrupt").length, 1);
  child.emit_({ type: "result", is_error: true, subtype: "error_during_execution", errors: ["interrupted"] });
  await tick();
  assert.equal(f.session.state, "paused");
  assert.deepEqual(f.ended, [[f.session.id, null]]);
  t.mock.timers.tick(10001);
  await tick();
  assert.equal(child.killed, false, "턴이 멈췄으면 강제로 끝내지 않는다");
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(f.session.subtasks[0].status, "running");
  assert.equal(f.runner.isBusy(f.session.id), true);
});

test("keep-alive: 하위 작업 하나만 stop_task로 멈추고, 세션 중지는 남은 작업을 stopped로 표시한다", async (t) => {
  const f = fixture(t);
  const child = await toBackground(f);
  child.emit_({ type: "system", subtype: "task_started", task_id: "task-2", tool_use_id: "toolu_two", description: "두 번째", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent" });
  await tick();
  const stopping = f.runner.stopSubtask(f.session, "task-1");
  const request = lines(child, "stop_task")[0];
  assert.equal(request.request.task_id, "task-1");
  child.emit_({ type: "system", subtype: "task_updated", task_id: "task-1", patch: { status: "killed", end_time: Date.now() } });
  child.emit_({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: {} } });
  assert.deepEqual(await stopping, { confirmed: true });
  assert.equal(f.session.subtasks.find((task) => task.id === "task-1").status, "stopped");
  assert.equal(f.session.state, "background");
  await assert.rejects(() => f.runner.stopSubtask(f.session, "task-1"), /이미 끝난/);

  assert.equal(f.runner.stop(f.session), true);
  await tick();
  assert.equal(child.killed, true);
  assert.equal(f.session.subtasks.find((task) => task.id === "task-2").status, "stopped");
  assert.equal(f.session.state, "idle");
  assert.equal(f.runner.hasProcess(f.session.id), false);
});

test("keep-alive: 프로세스가 비정상 종료되면 실행 중이던 작업을 interrupted로 표시하고 알린다", async (t) => {
  const f = fixture(t);
  const child = await toBackground(f);
  child.stderr.write("boom\n");
  child.emit("close", 3, null);
  await tick();
  assert.equal(f.session.subtasks[0].status, "interrupted");
  assert.equal(f.session.state, "interrupted");
  assert.ok(f.session.events.some((event) => event.kind === "status" && /하위 작업 1개가 중단/.test(event.text)));
  assert.equal(f.runner.isBusy(f.session.id), false);
});

test("keep-alive: 작업이 없으면 쉬는 시간이 지난 뒤 입력을 닫고, 0분이면 바로 닫는다", async (t) => {
  const f = fixture(t);
  f.runner.send(f.session, "짧은 일", "fake-cli");
  const child = f.children[0];
  init(child);
  result(child);
  await tick();
  assert.equal(f.session.state, "idle");
  assert.equal(f.runner.hasProcess(f.session.id), true);
  t.mock.timers.tick(15 * MINUTE - 1);
  assert.equal(child.stdin.writableEnded, false);
  t.mock.timers.tick(1);
  assert.equal(child.stdin.writableEnded, true);
  await tick();
  assert.equal(f.runner.hasProcess(f.session.id), false);
  assert.equal(f.session.state, "idle");
  // 닫힌 뒤의 요청은 같은 대화를 이어 새로 띄운다.
  f.runner.send(f.session, "다음 일", "fake-cli");
  assert.equal(f.children.length, 2);
  assert.ok(f.children[1].args.includes("--resume"));
});

test("keep-alive: 백그라운드 작업은 쉬는 시간이 지나도 닫지 않고, 끝난 뒤부터 쉬는 시간을 센다", async (t) => {
  const f = fixture(t, { keepAlive: { idleMinutes: 0, maxProcesses: 8 } });
  const child = await toBackground(f);
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(child.stdin.writableEnded, false);
  child.emit_({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", output_file: "", summary: "끝" });
  await tick();
  assert.equal(f.session.state, "background", "CLI가 결과 정리 턴을 시작할 수 있도록 잠시 기다린다");
  t.mock.timers.tick(2000);
  assert.equal(f.session.state, "idle");
  assert.equal(child.stdin.writableEnded, true, "0분이면 작업이 끝나는 대로 닫는다");
});

test("keep-alive: 동시 유지 상한을 넘으면 가장 오래 쉰 프로세스부터 닫고, 백그라운드 작업 중인 프로세스는 남긴다", async (t) => {
  const f = fixture(t, { keepAlive: { idleMinutes: 15, maxProcesses: 2 }, ids: ["a", "b", "c"] });
  const a = f.sessions.get("a"), b = f.sessions.get("b"), c = f.sessions.get("c");
  f.runner.send(a, "백그라운드", "fake-cli");
  init(f.children[0], "conv-a");
  launchAgent(f.children[0]);
  result(f.children[0]);
  await tick();
  t.mock.timers.tick(1000);
  f.runner.send(b, "짧은 일", "fake-cli");
  init(f.children[1], "conv-b");
  result(f.children[1]);
  await tick();
  t.mock.timers.tick(1000);
  assert.equal(f.children[1].stdin.writableEnded, false);
  f.runner.send(c, "또 짧은 일", "fake-cli");
  assert.equal(f.children[1].stdin.writableEnded, true, "쉬고 있던 b부터 닫는다");
  assert.equal(f.children[0].stdin.writableEnded, false, "백그라운드 작업 중인 a는 닫지 않는다");
  assert.equal(a.state, "background");
  await tick();
  assert.equal(f.runner.hasProcess("b"), false);
  assert.equal(b.state, "idle");
});

test("keep-alive: 모델처럼 CLI 인자가 바뀌면 다음 요청에서 다시 띄우고, 권한 변경과 실행 중 계속 허용한 규칙은 그대로 쓴다", async (t) => {
  const f = fixture(t);
  f.runner.send(f.session, "첫 요청", "fake-cli");
  const first = f.children[0];
  init(first);
  // 실행 중에 "이 세션에서 계속 허용"한 규칙은 CLI에도 바로 적용되므로 다시 띄우지 않는다.
  first.emit_({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" }, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" }] } });
  await tick();
  f.runner.answer("perm-1", { decision: "always" });
  result(first);
  await tick();

  f.session.permission = "default";
  assert.equal(f.runner.setPermissionMode(f.session), true, "쉬고 있는 CLI에도 권한을 바로 적용한다");
  f.runner.send(f.session, "권한만 바꿈", "fake-cli");
  assert.equal(f.children.length, 1);
  assert.equal(lines(first, "set_permission_mode").at(-1).request.mode, "default");
  result(first);
  await tick();

  f.session.model = "sonnet";
  f.runner.send(f.session, "모델 바꿈", "fake-cli");
  assert.equal(f.children.length, 2);
  assert.equal(first.stdin.writableEnded, true, "인자가 바뀌면 이전 CLI를 닫는다");
  const second = f.children[1];
  assert.deepEqual(second.args.slice(second.args.indexOf("--model"), second.args.indexOf("--model") + 2), ["--model", "sonnet"]);
  assert.deepEqual(second.args.slice(second.args.indexOf("--resume"), second.args.indexOf("--resume") + 2), ["--resume", "conv-1"]);
  assert.equal(lines(second, "initialize").length, 1);
  init(second);
  result(second);
  await tick();

  // 지운 허용 규칙은 띄워 둔 CLI에 남아 있으므로 다시 띄운다.
  f.session.allowRules = [];
  f.runner.send(f.session, "규칙 지움", "fake-cli");
  assert.equal(f.children.length, 3);
  assert.equal(second.stdin.writableEnded, true);
  init(f.children[2]);
  result(f.children[2]);
  await tick();
  // 시작할 때 모두 허용을 선택하지 않은 CLI는 해당 모드로 전환할 수 없어 다시 띄운다.
  f.session.permission = "bypassPermissions";
  f.runner.send(f.session, "모두 허용", "fake-cli");
  assert.equal(f.children.length, 4);
  assert.ok(f.children[3].args.includes("bypassPermissions"));
});

test("keep-alive: 모두 허용 세션을 /plan으로 시작해도 같은 CLI에서 원래 권한으로 돌아간다", async (t) => {
  const f = fixture(t);
  f.session.permission = "bypassPermissions";
  f.session.planTurn = true;
  f.runner.send(f.session, "/plan 계획", "fake-cli");
  const child = f.children[0];
  assert.equal(child.args[child.args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(child.args.includes("--allow-dangerously-skip-permissions"));
  init(child);
  child.emit_({ type: "control_request", request_id: "plan-approval", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "구현 계획" } } });
  f.runner.answer("plan-approval", { decision: "deny", message: "계획 보완" });
  assert.equal(f.session.planTurn, true);
  child.emit_({ type: "control_request", request_id: "plan-approval-2", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "보완한 계획" } } });
  f.runner.answer("plan-approval-2", { decision: "allow" });
  assert.equal(f.session.planTurn, undefined);
  result(child);
  await tick();
  f.runner.send(f.session, "구현", "fake-cli");
  await tick();
  assert.equal(f.children.length, 1);
  assert.equal(lines(child, "set_permission_mode").at(-1).request.mode, "bypassPermissions");
  assert.equal(child.permissionRestart, false);
});

test("keep-alive: 시작할 때 선택하지 않은 모두 허용은 백그라운드 작업 종료 뒤 적용한다", async (t) => {
  const f = fixture(t);
  const child = await toBackground(f);
  f.session.permission = "bypassPermissions";
  assert.equal(f.runner.setPermissionMode(f.session), false);
  assert.equal(lines(child, "set_permission_mode").length, 0, "적용할 수 없는 전환을 보내지 않는다");
  f.runner.send(f.session, "다음 작업", "fake-cli");
  assert.equal(f.children.length, 1);
  assert.equal(child.killed, false);
  assert.match(f.session.events.findLast((event) => event.kind === "status").text, /현재 권한으로 진행/);
  result(child);
  child.emit_({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed" });
  await tick();
  f.runner.send(f.session, "작업 종료 뒤", "fake-cli");
  assert.equal(f.children.length, 2);
  assert.ok(f.children[1].args.includes("bypassPermissions"));
});

for (const failure of ["reject", "timeout"]) test(`keep-alive: 권한 변경 ${failure}은 완료로 표시하지 않고 다음 실행을 새로 띄운다`, async (t) => {
  const f = fixture(t);
  f.runner.send(f.session, "첫 요청", "fake-cli");
  const child = f.children[0];
  init(child);
  child.acknowledgePermission = false;
  f.session.permission = "default";
  assert.equal(f.runner.setPermissionMode(f.session), true);
  const request = lines(child, "set_permission_mode").at(-1);
  if (failure === "reject") child.emit_({ type: "control_response", response: { subtype: "error", request_id: request.request_id, error: "mode unavailable" } });
  else t.mock.timers.tick(10000);
  assert.equal(child.controls.size, 0);
  assert.equal(child.permissionRestart, true);
  assert.ok(f.session.events.some((event) => event.kind === "status" && /적용을 확인하지 못했습니다/.test(event.text)));
  assert.equal(f.session.events.some((event) => /적용을 확인했습니다/.test(event.text ?? "")), false);
  result(child);
  await tick();
  f.runner.send(f.session, "재시도", "fake-cli");
  assert.equal(f.children.length, 2);
  assert.equal(f.children[1].args[f.children[1].args.indexOf("--permission-mode") + 1], "default");
});

test("keep-alive: 이전 권한 변경의 늦은 응답이 새로 선택한 모두 허용의 적용 대기를 지우지 않는다", async (t) => {
  const f = fixture(t);
  f.runner.send(f.session, "첫 요청", "fake-cli");
  const child = f.children[0];
  init(child);
  child.acknowledgePermission = false;
  f.session.permission = "default";
  assert.equal(f.runner.setPermissionMode(f.session), true);
  const previous = lines(child, "set_permission_mode").at(-1);
  f.session.permission = "bypassPermissions";
  assert.equal(f.runner.setPermissionMode(f.session), false);
  child.emit_({ type: "control_response", response: { subtype: "success", request_id: previous.request_id } });
  assert.equal(child.permissionRestart, true);
  assert.equal(f.session.events.some((event) => /적용을 확인했습니다/.test(event.text ?? "")), false);
});

test("keep-alive: 다시 시작·세션 삭제 정리는 띄워 둔 프로세스를 닫는다", async (t) => {
  const f = fixture(t);
  f.runner.send(f.session, "첫 요청", "fake-cli");
  init(f.children[0]);
  result(f.children[0]);
  await tick();
  f.runner.restart(f.session);
  assert.equal(f.children[0].stdin.writableEnded, true);
  assert.equal(f.runner.hasProcess(f.session.id), false);
  f.runner.send(f.session, "새 대화", "fake-cli");
  assert.ok(f.children[1].args.includes("--session-id"));
  init(f.children[1], "conv-2");
  result(f.children[1]);
  await tick();
  assert.equal(f.runner.release(f.session, { kill: true }), true);
  assert.equal(f.children[1].killed, true);
});

test("keep-alive: 백그라운드 작업 중에는 인자가 바뀌어도 작업을 끊지 않고 같은 프로세스를 쓴다", async (t) => {
  const f = fixture(t);
  const child = await toBackground(f);
  f.session.model = "haiku";
  f.runner.send(f.session, "모델 바꾼 요청", "fake-cli");
  assert.equal(f.children.length, 1);
  assert.equal(child.stdin.writableEnded, false);
  assert.ok(f.session.events.some((event) => event.kind === "status" && /백그라운드 작업이 진행 중이라 다시 실행해야 하는 설정/.test(event.text)));
});

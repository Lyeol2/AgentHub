import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommand, CommandStore } from "../server/commands.mjs";
import { checkFlowNode, inputValues, renderTemplate, transformResult } from "../server/flow-nodes.mjs";

test("flow nodes: forms validate unique keys, defaults, required values and numeric types", () => {
  const node = checkCommand({ kind: "input", fields: [
    { key: "goal", label: "목표", type: "textarea", required: true },
    { key: "count", label: "횟수", type: "number", defaultValue: "3" },
  ], prompt: "{{goal}} · {{count}}회" });
  assert.deepEqual(inputValues(node, { goal: "테스트 고치기", ignored: "사용하지 않음" }), { goal: "테스트 고치기", count: 3 });
  assert.equal(renderTemplate(node.prompt, inputValues(node, { goal: "검사", count: "0" })), "검사 · 0회");
  assert.throws(() => inputValues(node, {}), /목표.*필수/);
  assert.throws(() => inputValues(node, { goal: "검사", count: "abc" }), /숫자/);
  assert.throws(() => inputValues(node, { goal: {} }), /문자나 숫자/);
  for (const fields of [[], [{ key: "a" }, { key: "a" }], [{ key: "foo" }, { key: "FOO" }], [{ key: "input_json" }], [{ key: "INPUT_JSON" }], [{ key: "__proto__" }], [{ key: "bad-key" }], [{ key: "a", type: "code" }], [{ key: "a", type: "number", defaultValue: "NaN" }]]) {
    assert.throws(() => checkCommand({ kind: "input", fields }));
  }
  assert.equal(checkFlowNode({ kind: "command" }), null);
  assert.throws(() => checkCommand({ kind: "watch" }, { id: "cmd-input", kind: "input" }), /종류/);
});

test("flow nodes: JSON paths and templates access own values without code execution", () => {
  const source = JSON.stringify({ tests: { failures: [{ file: "api.test.mjs", count: 2 }] }, zero: 0 });
  assert.equal(transformResult({ transformMode: "json", expression: "$.tests.failures[0].file" }, source), "api.test.mjs");
  assert.equal(transformResult({ transformMode: "json", expression: "zero" }, source), "0");
  assert.deepEqual(JSON.parse(transformResult({ transformMode: "json", expression: "tests.failures" }, source)), [{ file: "api.test.mjs", count: 2 }]);
  assert.equal(transformResult({ transformMode: "template", template: "{{goal}}\n{{input}}\n{{details.file}}" }, "FAIL", { goal: "수정", details: { file: "api.test.mjs" } }), "수정\nFAIL\napi.test.mjs");
  assert.equal(transformResult({ transformMode: "lines", expression: "FAIL" }, "PASS a\r\nFAIL b\r\nFAIL c"), "FAIL b\nFAIL c");
  assert.equal(transformResult({ transformMode: "lines", expression: "" }, "a\n\n \nb"), "a\nb");
  assert.throws(() => transformResult({ transformMode: "json", expression: "x" }, "not json"), /JSON/);
  assert.throws(() => transformResult({ transformMode: "json", expression: "missing" }, source), /찾을 수/);
  for (const expression of ["__proto__.polluted", "tests.constructor", "tests[process.exit()]", "tests?.failures", "tests[0];throw 1"]) {
    assert.throws(() => checkCommand({ kind: "transform", expression }));
  }
  assert.throws(() => renderTemplate("{{missing}}", {}), /찾을 수/);
  assert.throws(() => renderTemplate("{{constructor.name}}", {}));
  assert.equal({}.polluted, undefined);
});

test("flow nodes: retry and watch limits reject malformed or outside paths", () => {
  assert.deepEqual(checkCommand({ kind: "repeat" }), { kind: "repeat", title: "반복 제어", maxIterations: 3, delayMs: 0 });
  for (const change of [{ maxIterations: 0 }, { maxIterations: 21 }, { maxIterations: 1.5 }, { delayMs: -1 }, { delayMs: 60001 }]) assert.throws(() => checkCommand({ kind: "repeat", ...change }));
  assert.deepEqual(checkCommand({ kind: "watch", watchPaths: ["./src", "src", "README.md"] }).watchPaths, ["src", "README.md"]);
  for (const watchPaths of [[], ["../secret"], ["C:\\secret"], ["/secret"], ["src/../../secret"], [".git"], ["node_modules/a"], ["data/commands.json"], ["src/*.mjs"]]) assert.throws(() => checkCommand({ kind: "watch", watchPaths }));
  assert.throws(() => checkCommand({ kind: "watch", debounceMs: 10 }));
});

test("flow nodes: schedules validate modes, absolute dates, daily time, interval and template variables", () => {
  const once = checkCommand({ kind: "schedule", runAt: "2030-02-15T09:30:00+09:00", prompt: "{{scheduledAt}} / {{triggeredAt}}" });
  assert.equal(once.scheduleMode, "once");
  assert.equal(once.runAt, "2030-02-15T00:30:00.000Z");
  assert.equal(once.title, "시간 예약");
  assert.equal(checkCommand({ kind: "schedule", scheduleMode: "daily", timeOfDay: "23:59" }).timeOfDay, "23:59");
  assert.equal(checkCommand({ kind: "schedule", scheduleMode: "interval", intervalMinutes: 10080 }).intervalMinutes, 10080);
  for (const fields of [
    {}, { runAt: "2030-02-30T09:30:00Z" }, { runAt: "2030-02-15T24:00:00Z" }, { runAt: "2030-02-15T09:30" },
    { runAt: "tomorrow" }, { runAt: [] }, { scheduleMode: "cron" },
    { scheduleMode: "daily", timeOfDay: "24:00" }, { scheduleMode: "daily", timeOfDay: "09:60" }, { scheduleMode: "daily", timeOfDay: "9:00" },
    ...[0, -1, 1.5, 10081, "NaN"].map(intervalMinutes => ({ scheduleMode: "interval", intervalMinutes })),
    { scheduleMode: "interval", prompt: "{{missing}}" },
  ]) assert.throws(() => checkCommand({ kind: "schedule", ...fields }), JSON.stringify(fields));
  const edited = checkCommand({ title: "새 예약" }, { id: "cmd-schedule", ...once });
  assert.equal(edited.runAt, once.runAt);
  assert.equal(edited.title, "새 예약");
});

test("flow nodes: restart leaves watches off and invalidates interrupted flow results", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-flow-persistence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "commands.json"), JSON.stringify([
    { id: "cmd-watch", kind: "watch", state: "watching", live: { tail: "감시 중" }, queued: { depth: 0 } },
    { id: "cmd-repeat", kind: "repeat", state: "running", live: { startedAt: "now" }, lastRun: { ok: true } },
  ]));
  const commands = new CommandStore({ dataDir: root });
  assert.equal(commands.get("cmd-watch").state, "idle");
  assert.equal(commands.get("cmd-watch").live, null);
  assert.equal(commands.get("cmd-watch").queued, null);
  assert.equal(commands.get("cmd-repeat").lastRun.ok, false);
  assert.equal(commands.get("cmd-repeat").lastRun.stopped, true);
});

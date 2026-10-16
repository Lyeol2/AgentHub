import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunHistoryStore, RUN_HISTORY_TEXT_MAX } from "../server/run-history.mjs";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-run-history-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, history: new RunHistoryStore({ dataDir, ...options }), projectPath: path.join(dataDir, "project") };
}
const flow = (id, variables = {}) => ({ id, variables, repeats: {} });

test("run history: persisted steps retain immutable resume inputs and results", t => {
  const { history, dataDir, projectPath } = fixture(t);
  const input = { goal: "검토", details: { limit: 2 } };
  const invocation = flow("flow-1", input);
  const run = history.start(invocation, { projectPath, sourceId: "cmd-input", sourceTitle: "개발 시작" });
  const options = { prompt: "첫 요청", values: { goal: "수정" }, origin: { id: "source", cwd: projectPath } };
  const step = history.beginStep(run.id, { nodeId: "cmd-test", title: "테스트", kind: "command", input: "첫 요청", variables: input, options, cwd: projectPath, depth: 2 });
  input.details.limit = 9;
  options.values.goal = "덮어쓰기";
  const result = { exitCode: 0, files: ["a.mjs"] };
  history.finishStep(run.id, step.id, { ok: true, output: "PASS", durationMs: 24, result });
  result.files.push("later.mjs");
  history.update(run.id, { status: "success", variables: { goal: "완료" }, repeats: { retry: 1 } });
  const restored = new RunHistoryStore({ dataDir }).get(run.id);
  assert.equal(restored.status, "success");
  assert.ok(restored.endedAt);
  assert.equal(restored.steps[0].status, "success");
  assert.equal(restored.steps[0].input, "첫 요청");
  assert.equal(restored.steps[0].variables.details.limit, 2);
  assert.equal(restored.steps[0].options.values.goal, "수정");
  assert.deepEqual(restored.steps[0].result.files, ["a.mjs"]);
  assert.equal(restored.steps[0].durationMs, 24);
  assert.equal(restored.steps[0].depth, 2);
  assert.equal(restored.steps[0].cwd, projectPath);
  assert.deepEqual(restored.repeats, { retry: 1 });
});

test("run history: restart interrupts active runs and steps without resuming work", t => {
  const { history, dataDir, projectPath } = fixture(t);
  for (const [id, status] of [["running-flow", "running"], ["waiting-flow", "waiting"], ["done-flow", "success"]]) {
    const run = history.start(flow(id), { projectPath });
    history.beginStep(run.id, { nodeId: "session", kind: "session", input: id });
    history.update(id, { status });
    if (status === "success") history.finishStep(id, run.steps[0].id, { ok: true, output: "완료" });
  }
  const restarted = new RunHistoryStore({ dataDir });
  for (const id of ["running-flow", "waiting-flow"]) {
    assert.equal(restarted.get(id).status, "interrupted");
    assert.equal(restarted.get(id).steps[0].status, "interrupted");
    assert.ok(restarted.get(id).endedAt);
    assert.ok(restarted.get(id).steps[0].endedAt);
  }
  assert.equal(restarted.get("done-flow").status, "success");
  assert.equal(new RunHistoryStore({ dataDir }).get("waiting-flow").status, "interrupted");
});

test("run history: retention evicts completed runs before older active runs", t => {
  const { history, projectPath } = fixture(t, { maxRuns: 3 });
  history.start(flow("old-active"), { projectPath });
  history.start(flow("finished"), { projectPath });
  history.update("finished", { status: "error" });
  history.start(flow("new-active"), { projectPath });
  history.start(flow("newest-active"), { projectPath });
  assert.equal(history.get("finished"), undefined);
  assert.deepEqual(history.list(projectPath).map(run => run.id), ["newest-active", "new-active", "old-active"]);
  history.start(flow("beyond-cap"), { projectPath });
  assert.equal(history.list().length, 4);
  assert.ok(history.get("old-active"));
  history.update("new-active", { status: "success" });
  assert.equal(history.list().length, 3);
  assert.equal(history.get("new-active"), undefined);
});

test("run history: nested JSON snapshots and text are bounded and tolerate cycles", t => {
  const { history, dataDir, projectPath } = fixture(t);
  const values = { large: "가".repeat(RUN_HISTORY_TEXT_MAX + 20), ignored: () => {}, badNumber: Infinity };
  values.self = values;
  const run = history.start(flow("bounded", values), { projectPath });
  const step = history.beginStep(run.id, { nodeId: "cmd", input: "x".repeat(RUN_HISTORY_TEXT_MAX + 10), options: { values, processHandle: new Map([["secret", true]]) } });
  history.finishStep(run.id, step.id, { ok: false, output: "y".repeat(RUN_HISTORY_TEXT_MAX + 10), error: new Error("실패") });
  assert.equal(step.input.length, RUN_HISTORY_TEXT_MAX);
  assert.equal(step.output.length, RUN_HISTORY_TEXT_MAX);
  assert.ok(run.variables.large.length <= RUN_HISTORY_TEXT_MAX);
  assert.equal(run.variables.ignored, undefined);
  assert.equal(step.error, "실패");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dataDir, "run-history.json"), "utf8")));
});

test("run history: repeated final events cannot overwrite a stopped step", t => {
  const { history, projectPath } = fixture(t);
  const run = history.start(flow("stop-once"), { projectPath });
  const step = history.beginStep(run.id, { nodeId: "session" });
  history.finishStep(run.id, step.id, { stopped: true, output: "사용자 중지" });
  history.finishStep(run.id, step.id, { ok: true, output: "늦은 완료" });
  assert.equal(step.status, "stopped");
  assert.equal(step.output, "사용자 중지");
  assert.equal(history.start(flow(run.id), { projectPath }), run);
  assert.equal(history.list().length, 1);
});

test("run history: projects are isolated and immutable identifiers cannot be overwritten", t => {
  const { history, projectPath } = fixture(t);
  history.start(flow("first"), { projectPath });
  history.start(flow("other"), { projectPath: projectPath + "-other" });
  const run = history.update("first", { id: "replaced", projectPath: "elsewhere", steps: [{ fake: true }], status: "waiting", resumedFrom: "old" });
  assert.equal(run.id, "first");
  assert.equal(run.projectPath, projectPath);
  assert.deepEqual(run.steps, []);
  assert.equal(run.resumedFrom, "old");
  assert.deepEqual(history.list(projectPath.toUpperCase()).map(item => item.id), ["first"]);
  assert.throws(() => history.update("first", { status: "unknown" }), /상태/);
  assert.equal(history.beginStep("missing", { nodeId: "x" }), null);
  assert.equal(history.finishStep("first", "missing", { ok: true }), null);
});

test("run history: questions and approvals persist waiting steps until completion", t => {
  const { history, projectPath } = fixture(t);
  const run = history.start(flow("wait-flow"), { projectPath });
  const step = history.beginStep(run.id, { nodeId: "session" });
  history.waitStep(run.id, step.id, { output: "승인을 기다립니다" });
  assert.equal(run.status, "waiting");
  assert.equal(step.status, "waiting");
  assert.equal(step.output, "승인을 기다립니다");
  history.finishStep(run.id, step.id, { ok: true, output: "승인 후 완료" });
  assert.equal(step.status, "success");
  history.waitStep(run.id, step.id, { output: "늦은 질문" });
  assert.equal(step.status, "success");
  assert.equal(step.output, "승인 후 완료");
});

test("run history: a large variable snapshot cannot consume status and resume metadata", t => {
  const { history, projectPath } = fixture(t);
  history.start(flow("large-update"), { projectPath });
  const run = history.update("large-update", { variables: { long: "x".repeat(RUN_HISTORY_TEXT_MAX) }, status: "error", resumedFrom: "prior-run" });
  assert.equal(run.status, "error");
  assert.equal(run.resumedFrom, "prior-run");
  assert.ok(run.endedAt);
});

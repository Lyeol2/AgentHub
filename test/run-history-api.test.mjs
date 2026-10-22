import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunHistoryStore } from "../server/run-history.mjs";
import { createRunService } from "../server/application/runs.mjs";
import { runRoutes } from "../server/transport/routes/runs.mjs";
import { HttpError } from "../server/application/errors.mjs";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-run-history-api-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const projectPath = path.join(dataDir, "project");
  const history = new RunHistoryStore({ dataDir });
  const calls = [], notifications = [];
  const chain = {
    stopRun(id) { calls.push(["stop", id]); history.update(id, { status: "stopped" }); return history.get(id); },
    resumeRun(id, stepId) { calls.push(["resume", id, stepId]); return { ...history.get(id), id: "resumed-run", resumedFrom: id }; },
  };
  const projects = { ensureProject(value) {
    if (value !== projectPath) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
    return { path: projectPath };
  } };
  const service = createRunService({ history, chain, projects, notify: (...args) => notifications.push(args) });
  const start = (id, status = "running") => {
    const run = history.start({ id, variables: {}, repeats: {} }, { projectPath, sourceId: "source", sourceTitle: "작업" });
    history.update(id, { status });
    return run;
  };
  return { history, projectPath, chain, calls, notifications, service, start };
}
const status = (expected) => error => error instanceof HttpError && error.status === expected;

test("run history API: lists project records and returns full step snapshots", t => {
  const f = fixture(t);
  f.start("older", "success");
  const latest = f.start("latest");
  const step = f.history.beginStep(latest.id, { nodeId: "session", input: "고쳐줘", options: { prompt: "고쳐줘" } });
  assert.deepEqual(f.service.list(f.projectPath).runs.map(run => run.id), ["latest", "older"]);
  assert.equal(f.service.list(f.projectPath).runs[0].stepCount, 1);
  assert.equal(Object.hasOwn(f.service.list(f.projectPath).runs[0], "steps"), false);
  const first = f.service.list(f.projectPath, { limit: 1 });
  assert.equal(first.nextCursor, "latest");
  assert.deepEqual(f.service.list(f.projectPath, { cursor: first.nextCursor, limit: 1 }).runs.map(run => run.id), ["older"]);
  assert.throws(() => f.service.list(f.projectPath, { limit: 10000 }), status(400));
  assert.equal(f.service.get("latest").steps[0].id, step.id);
  assert.equal(f.service.get("latest").steps[0].options.prompt, "고쳐줘");
  assert.throws(() => f.service.list(null), status(400));
  assert.throws(() => f.service.list("unknown"), status(400));
  assert.throws(() => f.service.get("bad/id"), status(400));
  assert.throws(() => f.service.get("absent"), status(404));
});

test("run history API: stop delegates once and rejects completed or missing runs", async t => {
  const f = fixture(t);
  f.start("active", "waiting");
  assert.equal((await f.service.stop("active")).status, "stopped");
  assert.deepEqual(f.calls, [["stop", "active"]]);
  assert.deepEqual(f.notifications, [["runs", { id: "active", projectPath: f.projectPath }]]);
  await assert.rejects(f.service.stop("active"), status(409));
  await assert.rejects(f.service.stop("missing"), status(404));
  await assert.rejects(f.service.stop("bad/id"), status(400));
  assert.equal(f.calls.length, 1);
});

test("run history API: resume delegates a preserved failed step and returns the new run", async t => {
  const f = fixture(t);
  const run = f.start("failed");
  const step = f.history.beginStep(run.id, { nodeId: "test", input: "기존 입력" });
  f.history.finishStep(run.id, step.id, { ok: false, output: "FAIL" });
  f.history.update(run.id, { status: "error" });
  const resumed = await f.service.resume(run.id, { stepId: step.id });
  assert.equal(resumed.id, "resumed-run");
  assert.equal(resumed.resumedFrom, run.id);
  assert.deepEqual(f.calls, [["resume", "failed", step.id]]);
  assert.equal(run.steps[0].input, "기존 입력");
  assert.equal(run.status, "error");
  await f.service.resume(run.id);
  assert.deepEqual(f.calls[1], ["resume", "failed", undefined]);
});

test("run history API: resume rejects invalid bodies, active flows and successful steps", async t => {
  const f = fixture(t);
  const run = f.start("mixed");
  const step = f.history.beginStep(run.id, { nodeId: "done" });
  f.history.finishStep(run.id, step.id, { ok: true, output: "PASS" });
  f.history.update(run.id, { status: "error" });
  for (const body of [null, [], { stepId: 3 }, { stepId: "bad/id" }]) await assert.rejects(f.service.resume(run.id, body), status(400));
  await assert.rejects(f.service.resume(run.id, { stepId: "missing" }), status(404));
  await assert.rejects(f.service.resume(run.id, { stepId: step.id }), status(409));
  for (const state of ["running", "waiting", "success"]) {
    f.start(state, state);
    await assert.rejects(f.service.resume(state), status(409));
  }
  assert.equal(f.calls.length, 0);
});

test("run history API: runtime conflicts remain HTTP 409 and no change event is sent", async t => {
  const f = fixture(t);
  f.start("busy", "error");
  f.chain.resumeRun = () => { throw new Error("대상 노드가 이미 실행 중입니다."); };
  await assert.rejects(f.service.resume("busy"), error => error.status === 409 && /이미 실행/.test(error.message));
  f.start("gone");
  f.chain.stopRun = () => false;
  await assert.rejects(f.service.stop("gone"), status(409));
  assert.deepEqual(f.notifications, []);
});

test("run history routes: list, detail, stop and resume preserve IDs and request data", async () => {
  const calls = [];
  const service = Object.fromEntries(["list", "get", "stop", "resume"].map(name => [name, (...args) => { calls.push([name, ...args]); return name; }]));
  const routes = runRoutes(service);
  assert.deepEqual(routes.map(([method, route]) => [method, route]), [
    ["GET", "runs"], ["GET", "runs/:id"], ["POST", "runs/:id/stop"], ["POST", "runs/:id/resume"],
  ]);
  await routes[0][2]({ query: new URLSearchParams({ path: "project" }) });
  await routes[1][2]({ params: { id: "run-1" } });
  await routes[2][2]({ params: { id: "run-1" } });
  await routes[3][2]({ params: { id: "run-1" }, body: { stepId: "step-2" } });
  assert.deepEqual(calls, [["list", "project"], ["get", "run-1"], ["stop", "run-1"], ["resume", "run-1", { stepId: "step-2" }]]);
});

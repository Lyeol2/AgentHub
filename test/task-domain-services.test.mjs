import test from "node:test";
import assert from "node:assert/strict";
import { createTaskPublication } from "../server/application/task-publication.mjs";
import { createTaskRecovery } from "../server/application/task-recovery.mjs";

test("publication persists write intent before dispatch and recovery observes an uncertain push without retrying it", async () => {
  const task = { id: "one", state: "working", type: "feature", branch: "feature/one", remote: "origin" };
  const saved = [], operations = [];
  const save = (value) => saved.push(structuredClone(value));
  const publication = createTaskPublication({ save });
  const timeout = Object.assign(Error("response lost"), { outcomeUnknown: true });
  await assert.rejects(publication.externalWrite(task, "push", "expected-head", async () => {
    assert.equal(saved.at(-1).pendingAction.action, "push");
    assert.equal(saved.at(-1).pendingAction.expectedHead, "expected-head");
    operations.push("write");
    throw timeout;
  }), (error) => error === timeout);
  assert.equal(task.pendingAction.outcomeUnknown, true);
  const recovery = createTaskRecovery({
    mutate: async (id, action) => { assert.equal(id, task.id); return action(task); },
    freshness: async () => {}, githubTarget: async () => ({ repo: "example/repo" }), findPull: async () => null,
    github: { remoteHead: async () => { operations.push("observe"); return "expected-head"; } },
    save, syncIssue: async () => {},
  });
  const result = await recovery.refresh(task.id);
  assert.deepEqual(operations, ["write", "observe"]);
  assert.equal(task.pendingAction, undefined);
  assert.equal(task.lastRecovery.result, "confirmed");
  assert.equal(task.publishedHead, "expected-head");
  assert.notEqual(result.task, task, "public results remain isolated from shared mutable records");
  assert.equal(saved.at(-1).publishedHead, "expected-head");
});

test("publication clears intent after a known rejection or successful write", async () => {
  const task = { id: "one" }, saved = [];
  const publication = createTaskPublication({ save: (value) => saved.push(structuredClone(value)) });
  const rejected = Error("rejected before writing");
  await assert.rejects(publication.externalWrite(task, "push", "head", async () => { throw rejected; }), (error) => error === rejected);
  assert.equal(task.pendingAction, undefined);
  assert.equal(await publication.externalWrite(task, "push", "head", async () => "done"), "done");
  assert.equal(task.pendingAction, undefined);
  assert.deepEqual(saved.map((value) => value.pendingAction?.action ?? "clear"), ["push", "clear", "push", "clear"]);
});

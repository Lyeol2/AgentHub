import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GitHubError } from "../server/github.mjs";
import { fixture } from "../test-support/tasks-fixture.mjs";

test("tasks: without a worktree the source folder switches to the task branch and returns on cleanup", async (t) => {
  const f = fixture(t);
  f.change(f.repo, "dirty.txt");
  await assert.rejects(f.create("feature", { worktree: false }), (error) => error.reason === "task-dirty");
  fs.rmSync(path.join(f.repo, "dirty.txt"));
  await assert.rejects(f.create("feature", { worktree: false, workBranch: "feature/x" }), /새 작업 브랜치만/);

  const { task, session } = await f.create("feature", { worktree: false });
  assert.equal(task.inPlace, true); assert.equal(task.previousBranch, "main"); assert.equal(task.ownsWorktree, false);
  assert.equal(path.resolve(task.cwd), path.resolve(f.repo)); assert.equal(session.cwd, task.cwd);
  assert.equal(f.git(f.repo, "branch", "--show-current"), task.branch);
  assert.equal(fs.existsSync(path.join(path.dirname(f.repo), "repo.agenthub")), false); // 워크트리 폴더를 만들지 않는다.
  await assert.rejects(f.create("feature", { worktree: false }), (error) => error.reason === "task-in-place");

  f.change(task.cwd);
  await f.service.finish(task.id);
  const raw = f.state.pulls[0]; raw.merged = true; raw.state = "closed";
  const cleaned = await f.service.cleanup(task.id);
  assert.equal(cleaned.task.state, "cleaned"); assert.equal(cleaned.task.localBranchRemoved, true);
  assert.equal(f.git(f.repo, "branch", "--show-current"), "main"); // 작업 전 브랜치로 돌아온다.
  assert.ok(fs.existsSync(f.repo));
});

test("tasks: concurrent create and start requests reuse one task, session and initial dispatch after restart", async (t) => {
  const f = fixture(t);
  const body = { title: "Start once", content: "Implement the requested change", start: true, requestId: "start-concurrent-001" };
  const results = await Promise.all([f.create("feature", body), f.create("feature", body)]);
  assert.equal(results[0].task.id, results[1].task.id);
  assert.equal(results[0].session.id, results[1].session.id);
  assert.equal(results.filter((result) => result.reused).length, 1);
  assert.equal(f.service.list(f.repo).tasks.length, 1);
  assert.equal(f.stored.size, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal(results[0].task.initialStart.state, "sent");
  assert.equal(results[0].task.initialStart.sessionId, results[0].session.id);

  f.restart();
  f.state.running.add(results[0].session.id);
  f.git(f.repo, "remote", "set-url", "origin", path.join(f.repo, "missing-origin.git"));
  const replay = await f.create("feature", body);
  assert.equal(replay.reused, true);
  assert.equal(replay.task.id, results[0].task.id);
  assert.equal(replay.session.id, results[0].session.id);
  assert.equal(replay.startError, undefined);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.stored.size, 1);
});

test("tasks: a create request id cannot silently apply a changed draft", async (t) => {
  const f = fixture(t);
  const body = { title: "Original draft", content: "Original request", start: true, requestId: "start-draft-change-001" };
  const first = await f.create("feature", body);
  await assert.rejects(f.create("feature", { ...body, content: "A different request" }),
    (error) => error.status === 409 && error.reason === "task-request-changed");
  assert.equal(f.service.list(f.repo).tasks.length, 1);
  assert.equal(f.service.list(f.repo).tasks[0].content, body.content);
  assert.equal(f.stored.size, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal((await f.create("feature", body)).task.id, first.task.id);
});

test("tasks: create and start dispatches the persisted title, content and acceptance criteria", async (t) => {
  const f = fixture(t);
  const body = { title: "  Task title  ", content: "  Implement this\nwith these details  ", acceptance: "  Check A\nCheck B  ",
    start: true, requestId: "start-prompt-content-001", initialPrompt: "Untrusted replacement prompt" };
  const { task, session } = await f.create("feature", body);
  assert.equal(task.title, "Task title");
  assert.equal(task.content, "Implement this\nwith these details");
  assert.equal(task.acceptance, "Check A\nCheck B");
  assert.deepEqual(f.state.sends, [{ id: session.id, prompt: "Task title\n\nImplement this\nwith these details\n\n완료 기준:\nCheck A\nCheck B" }]);
  const persisted = f.restart().list(f.repo).tasks[0];
  assert.equal(persisted.content, task.content);
  assert.equal(persisted.acceptance, task.acceptance);
  assert.equal(persisted.initialStart.state, "sent");
});

test("tasks: a failed initial dispatch preserves the task and never automatically sends again", async (t) => {
  const f = fixture(t);
  const body = { title: "Retain partial result", start: true, requestId: "start-send-failure-001" };
  f.state.sendError = Error("connection lost after dispatch");
  const first = await f.create("feature", body);
  assert.equal(first.task.initialStart.state, "failed");
  assert.equal(first.task.initialStart.sessionId, first.session.id);
  assert.match(first.startError, /connection lost after dispatch/);
  assert.ok(fs.existsSync(first.task.cwd));
  assert.equal(f.git(first.task.cwd, "branch", "--show-current"), first.task.branch);
  assert.equal(f.state.sends[0].prompt, body.title);
  f.state.sendError = null;
  for (const restart of [false, true]) {
    if (restart) f.restart();
    const replay = await f.create("feature", body);
    assert.equal(replay.reused, true);
    assert.equal(replay.task.id, first.task.id);
    assert.equal(replay.session.id, first.session.id);
    assert.equal(replay.startError, first.startError);
  }
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.stored.size, 1);
  assert.equal(f.service.list(f.repo).tasks.length, 1);
});

test("tasks: interrupted initial dispatch records remain reviewable without replaying on restart", async (t) => {
  const f = fixture(t);
  const body = { title: "Interrupted start", start: true, requestId: "start-interrupted-001" };
  const first = await f.create("feature", body);
  const file = path.join(f.dataDir, "tasks", `${first.task.id}.json`);
  for (const state of [undefined, "sending"]) {
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state) persisted.initialStart = { state, sessionId: first.session.id, startedAt: new Date().toISOString() };
    else delete persisted.initialStart;
    fs.writeFileSync(file, JSON.stringify(persisted));
    f.restart();
    const replay = await f.create("feature", body);
    assert.equal(replay.reused, true);
    assert.equal(replay.task.id, first.task.id);
    assert.equal(replay.session.id, first.session.id);
    assert.equal(typeof replay.startError, "string");
    assert.ok(replay.startError.length > 0);
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.stored.size, 1);
  }
});

test("tasks: initial session creation failure returns a reusable task without retrying creation", async (t) => {
  const f = fixture(t);
  const body = { title: "Session failure", start: true, requestId: "start-session-failure-001" };
  f.state.createSessionError = Error("provider unavailable");
  const first = await f.create("feature", body);
  assert.equal(first.session, undefined);
  assert.equal(first.task.initialStart.state, "failed");
  assert.deepEqual(first.task.sessionIds, []);
  assert.match(first.startError, /provider unavailable/);
  assert.ok(fs.existsSync(first.task.cwd));
  f.state.createSessionError = null;
  f.restart();
  const replay = await f.create("feature", body);
  assert.equal(replay.reused, true);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.session, undefined);
  assert.equal(replay.startError, first.startError);
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.stored.size, 0);
  assert.equal(f.service.list(f.repo).tasks.length, 1);
});

test("tasks: start requires an explicit boolean, request id and session before any task is created", async (t) => {
  const f = fixture(t);
  for (const start of ["true", "false", 1, 0, null, {}]) {
    await assert.rejects(f.create("feature", { start }), (error) => error.status === 400);
  }
  await assert.rejects(f.create("feature", { start: true }), (error) => error.status === 400);
  await assert.rejects(f.create("feature", { start: true, requestId: "start-invalid-session-001", session: false }),
    (error) => error.status === 400);
  assert.equal(f.service.list(f.repo).tasks.length, 0);
  assert.equal(f.stored.size, 0);
  assert.equal(f.state.sends.length, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(f.repo), "repo.agenthub")), false);
  const created = await f.create("feature", { start: false });
  assert.ok(created.session);
  assert.equal(created.task.initialStart, undefined);
  assert.equal(f.state.sends.length, 0);
});

test("tasks: issues link by number or creation, survive restart, close through the PR and sync state", async (t) => {
  const f = fixture(t);
  const { task, session } = await f.create();
  f.state.issues.push({ number: 7, title: "로그인 버튼", body: "", state: "open", user: { login: "lead" } });
  await assert.rejects(f.service.linkIssue(task.id, { number: "abc" }), (error) => error.status === 400);
  await assert.rejects(f.service.linkIssue(task.id, { number: 8 }), (error) => error.status === 404 && /#8/.test(error.message));
  f.state.running.add(session.id);
  const linked = await f.service.linkIssue(task.id, { number: "#7" });
  f.state.running.clear();
  assert.deepEqual([linked.task.issue.number, linked.task.issue.state, linked.task.issue.url], [7, "open", "https://github.com/acme/widget/issues/7"]);
  const other = await f.create();
  await assert.rejects(f.service.linkIssue(other.task.id, { number: 7 }), (error) => error.reason === "task-issue-linked");
  const created = await f.service.linkIssue(other.task.id, { create: true });
  assert.equal(created.task.issue.number, 101); assert.equal(f.state.issues.at(-1).title, "새 작업");
  assert.equal(f.restart().get(task.id).issue.number, 7, "the link is stored with the task");
  f.change(task.cwd);
  const finished = await f.service.finish(task.id, { verification: "확인" });
  assert.match(finished.pull.body, /Closes #7/);
  f.state.issues[0].state = "closed";
  assert.equal((await f.service.refresh(task.id)).task.issue.state, "closed");
  f.state.issueError = new GitHubError("GitHub CLI 인증이 필요합니다.", "gh-auth", 401);
  const failed = await f.service.refresh(task.id);
  assert.equal(failed.task.state, "review", "an unreadable issue never fails the task refresh");
  assert.equal(failed.task.issue.errorReason, "gh-auth"); assert.equal(failed.task.issue.state, "closed");
  assert.equal((await f.service.unlinkIssue(task.id)).task.issue, undefined);
});

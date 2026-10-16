import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHub } from "../server/bootstrap.mjs";
import { Chain } from "../server/chain.mjs";
import { CommandStore, checkCommand, shells } from "../server/commands.mjs";

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete gitEnv[key];

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, env: gitEnv, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-git-node-flow-"));
  const repo = path.join(root, "repository");
  const worktree = path.join(root, "feature-worktree");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Git Node Workflow Test");
  git(repo, "config", "user.email", "git-node-flow@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "Git node workflow fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "Initial fixture");
  git(repo, "branch", "develop");
  git(repo, "branch", "feature/existing");
  git(repo, "worktree", "add", worktree, "feature/existing");
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("agenthub-git-node-flow-"));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const context = {
    cwd: worktree, branch: "feature/existing", head: git(worktree, "rev-parse", "HEAD"),
    repoCommonDir: path.resolve(repo, git(repo, "rev-parse", "--git-common-dir")),
  };
  return { root, repo, worktree, context, onCleanup: close => cleanup.push(close) };
}

class FakeRunner extends EventEmitter {
  calls = [];
  running = new Set();
  isRunning(id) { return this.running.has(id); }
  append(session, event) { session.events.push(event); }
  send(session, prompt, cli, input, meta) {
    this.calls.push({ id: session.id, cwd: session.cwd, prompt, cli, input, meta });
    this.running.add(session.id);
  }
  stopAll() { this.running.clear(); }
}

function gitResult(f, changes = {}) {
  return {
    ok: true, reason: "ready", output: "feature/existing 준비 완료", cwd: f.worktree,
    branch: f.context.branch, targetBranch: "", beforeHead: f.context.head,
    afterHead: f.context.head, context: { ...f.context }, durationMs: 3, exitCode: 0,
    ...changes,
  };
}

function harness(t, options = {}) {
  const f = repository(t);
  const runner = new FakeRunner();
  const sessions = new Map(["source", "target", "failure", "always", "keyword", "manual"].map(id => [id, {
    id, title: id, agent: "claude", projectPath: f.repo, cwd: f.repo, state: "idle", events: [],
  }]));
  sessions.get("source").events.push({ kind: "user", text: "실행" }, { kind: "text", text: "준비" });
  const commands = new Map();
  const command = { id: "cmd-git", kind: "git", title: "기존 브랜치 사용", gitAction: "use", branch: f.context.branch,
    projectPath: f.repo, timeoutSec: 30, state: "idle", lastRun: null };
  commands.set(command.id, command);
  const links = [];
  const touched = [];
  const chain = new Chain({
    store: { get: id => sessions.get(id), list: () => [...sessions.values()], touch: session => touched.push(session.id),
      save: session => touched.push(session.id), update: (session, changes) => Object.assign(session, changes) },
    runner, commands: { get: id => commands.get(id), list: () => [...commands.values()], update: (cmd, changes) => Object.assign(cmd, changes) },
    links: { list: () => links, from: id => links.filter(link => link.from === id), update: (link, changes) => Object.assign(link, changes) },
    cliPaths: () => ({ claude: "fake-cli" }), compose: (session, text) => text,
    runGit: async request => options.runGit ? options.runGit(request, f) : gitResult(f),
  });
  f.onCleanup(() => chain.dispose());
  const link = (to, when = "success", extra = {}) => {
    const value = { id: "link-" + links.length, from: command.id, to, when, enabled: true, keyword: "", ...extra };
    links.push(value);
    return value;
  };
  return { ...f, runner, sessions, commands, command, chain, links, link, touched };
}

async function apiFixture(t) {
  const f = repository(t);
  const runner = new FakeRunner();
  const dataDir = path.join(f.root, "data");
  const hub = createHub({ dataDir, port: 0, warmup: false,
    deps: { runner, cliPaths: () => ({ claude: "fake-cli", codex: "fake-cli" }), logger: { log() {} } } });
  for (const id of ["source", "target"]) hub.store.add({ id, title: id, agent: "claude", cwd: f.repo,
    permission: "acceptEdits", projectPath: f.repo, projectName: "repository", state: "idle", events: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await hub.start();
  f.onCleanup(() => hub.shutdown());
  async function request(method, suffix, body) {
    const response = await fetch("http://127.0.0.1:" + hub.port + "/api" + suffix, { method,
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  async function success(method, suffix, body) {
    const response = await request(method, suffix, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  const create = changes => success("POST", "/commands", { kind: "git", title: "브랜치 사용", gitAction: "use", branch: f.context.branch, projectPath: f.repo, ...changes });
  return { ...f, dataDir, hub, runner, request, success, create };
}

test("Git nodes: validate local branch actions without shell input", () => {
  const use = checkCommand({ kind: "git", gitAction: "use", branch: "feature/existing", timeoutSec: 45 });
  assert.equal(use.kind, "git");
  assert.equal(use.gitAction, "use");
  assert.equal(use.branch, "feature/existing");
  assert.equal(use.timeoutSec, 45);
  assert.equal(use.command, undefined);
  assert.equal(use.shell, undefined);
  const merge = checkCommand({ kind: "git", gitAction: "merge", branch: "feature/existing", targetBranch: "develop" });
  assert.equal(merge.targetBranch, "develop");
  for (const input of [
    { gitAction: "push", branch: "feature/existing" },
    { gitAction: "use", branch: "" },
    { gitAction: "use", branch: "-bad" },
    { gitAction: "use", branch: "feature/../escape" },
    { gitAction: "use", branch: "feature/a b" },
    { gitAction: "use", branch: "feature/x\nmain" },
    { gitAction: "merge", branch: "feature/existing" },
    { gitAction: "merge", branch: "develop", targetBranch: "develop" },
    { gitAction: "use", branch: "feature/existing", timeoutSec: 0 },
    { gitAction: "use", branch: "feature/existing", timeoutSec: 3601 },
  ]) assert.throws(() => checkCommand({ kind: "git", ...input }), JSON.stringify(input));
});

test("Git nodes API: action fields update and persist, and branch listing is read-only", async t => {
  const f = await apiFixture(t);
  const refs = git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads");
  const worktrees = git(f.repo, "worktree", "list", "--porcelain");
  const listing = await f.success("GET", "/commands/git-branches?path=" + encodeURIComponent(f.repo));
  assert.ok(Array.isArray(listing.branches));
  for (const name of ["main", "develop", f.context.branch]) assert.ok(listing.branches.some(item => item.name === name), name);
  assert.equal(git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads"), refs);
  assert.equal(git(f.repo, "worktree", "list", "--porcelain"), worktrees);
  const node = await f.create({ pos: { x: 40, y: 90 } });
  assert.deepEqual(node.pos, { x: 40, y: 90 });
  const edited = await f.success("PUT", "/commands/" + node.id, { gitAction: "merge", branch: f.context.branch, targetBranch: "develop", timeoutSec: 75 });
  assert.equal(edited.gitAction, "merge");
  assert.equal(edited.targetBranch, "develop");
  assert.equal(edited.timeoutSec, 75);
  assert.equal((await f.request("PUT", "/commands/" + node.id, { kind: "button", prompt: "실행" })).status, 400);
  assert.equal((await f.request("PUT", "/commands/" + node.id, { targetBranch: f.context.branch })).status, 400);
  const restored = new CommandStore({ dataDir: f.dataDir }).get(node.id);
  assert.equal(restored.kind, "git");
  assert.equal(restored.gitAction, "merge");
  assert.equal(restored.branch, f.context.branch);
  assert.equal(restored.targetBranch, "develop");
  assert.equal(restored.timeoutSec, 75);
});

test("Git nodes API: button and command edges allow separate success/error connections", async t => {
  const f = await apiFixture(t);
  const node = await f.create();
  const merge = await f.create({ gitAction: "merge", targetBranch: "develop" });
  const button = await f.success("POST", "/commands", { kind: "button", projectPath: f.repo, prompt: "브랜치 준비" });
  const shell = await f.success("POST", "/commands", { projectPath: f.repo, command: "echo ready" });
  await f.success("POST", "/links", { from: button.id, to: node.id });
  const ok = await f.success("POST", "/links", { from: node.id, to: "target", when: "success" });
  assert.equal(ok.useGitWorktree, true);
  const failed = await f.success("POST", "/links", { from: node.id, to: "target", when: "error" });
  assert.equal(failed.useGitWorktree, false);
  assert.equal((await f.request("POST", "/links", { from: node.id, to: "target", when: "success" })).status, 409);
  await f.success("POST", "/links", { from: node.id, to: shell.id });
  await f.success("POST", "/links", { from: node.id, to: merge.id });
  const mergeLink = await f.success("POST", "/links", { from: merge.id, to: "source" });
  assert.equal(mergeLink.useGitWorktree, false);
  for (const when of ["keyword", "otherwise"]) {
    assert.equal((await f.request("POST", "/links", { from: node.id, to: "source", when, keyword: "준비" })).status, 400);
    assert.equal((await f.request("PUT", "/links/" + ok.id, { when, keyword: "준비" })).status, 400);
  }
  assert.equal((await f.success("PUT", "/links/" + ok.id, { useGitWorktree: false })).useGitWorktree, false);
});

test("Git chain: success routes by Git status and stores the structured result", async t => {
  const f = harness(t, { runGit: async (request, repo) => {
    assert.equal(request.command.gitAction, "use");
    assert.ok(request.signal instanceof AbortSignal);
    request.onOutput("브랜치 확인 중");
    return gitResult(repo, { exitCode: 9, output: "키워드가 있어도 출력으로 판정하지 않음" });
  } });
  f.link("target");
  f.link("failure", "error");
  f.link("always", "always");
  f.link("keyword", "keyword", { keyword: "키워드" });
  f.link("manual", "manual");
  await f.chain.runCommand(f.command, { origin: f.sessions.get("source") });
  assert.equal(f.command.state, "success");
  assert.equal(f.command.lastRun.ok, true);
  assert.equal(f.command.lastRun.gitResult.reason, "ready");
  assert.equal(f.command.lastRun.gitResult.context.cwd, f.worktree);
  assert.equal(f.command.lastRun.originId, "source");
  assert.deepEqual(f.runner.calls.map(call => call.id), ["target", "always"]);
  assert.match(f.runner.calls[0].prompt, /feature\/existing/);
  assert.match(f.runner.calls[0].prompt, /키워드가 있어도/);
});

test("Git chain: a Git failure uses the failure edge even when exit code is zero", async t => {
  const f = harness(t, { runGit: async (request, repo) => gitResult(repo, {
    ok: false, reason: "conflict", exitCode: 0, context: null, output: "충돌: README.md", conflicts: ["README.md"],
  }) });
  f.link("target");
  f.link("failure", "error");
  f.link("always", "always");
  await f.chain.runCommand(f.command);
  assert.equal(f.command.state, "error");
  assert.equal(f.command.lastRun.ok, false);
  assert.equal(f.command.lastRun.gitResult.reason, "conflict");
  assert.deepEqual(f.runner.calls.map(call => call.id), ["failure", "always"]);
  assert.match(f.runner.calls[0].prompt, /README\.md/);
});

test("Git chain: stopping an in-flight operation aborts it and suppresses every outgoing edge", async t => {
  let release;
  let signal;
  const f = harness(t, { runGit: (request, repo) => {
    signal = request.signal;
    return new Promise(resolve => { release = () => resolve(gitResult(repo)); });
  } });
  f.link("target");
  f.link("failure", "error");
  f.link("always", "always");
  const running = f.chain.runCommand(f.command);
  await Promise.resolve();
  assert.equal(f.chain.stopCommand(f.command), true);
  assert.equal(signal.aborted, true);
  release();
  await running;
  assert.equal(f.command.lastRun.stopped, true);
  assert.equal(f.command.state, "idle");
  assert.deepEqual(f.runner.calls, []);
});

test("Git chain: a fresh session starts in the selected worktree and persists its association", async t => {
  const f = harness(t);
  const target = f.sessions.get("target");
  target.events.push({ kind: "status", text: "세션 생성" });
  f.link("target", "success", { useGitWorktree: true });
  await f.chain.runCommand(f.command);
  assert.equal(f.runner.calls.length, 1);
  assert.equal(path.resolve(f.runner.calls[0].cwd), path.resolve(f.worktree));
  assert.equal(path.resolve(target.cwd), path.resolve(f.worktree));
  assert.equal(target.worktree.branch, f.context.branch);
  assert.equal(target.baseCommit, f.context.head);
  assert.ok(f.touched.includes("target"));
});

test("Git chain: a session already in that worktree keeps its conversation and can continue", async t => {
  const f = harness(t);
  const target = f.sessions.get("target");
  target.cwd = f.worktree;
  target.agentSessionId = "existing-agent-conversation";
  target.events.push({ kind: "user", text: "앞선 작업" }, { kind: "text", text: "작업 완료" });
  f.link("target", "success", { useGitWorktree: true });
  await f.chain.runCommand(f.command);
  assert.equal(f.runner.calls.length, 1);
  assert.equal(path.resolve(f.runner.calls[0].cwd), path.resolve(f.worktree));
  assert.equal(target.agentSessionId, "existing-agent-conversation");
  assert.equal(target.events.some(event => event.text === "앞선 작업"), true);
});

test("Git chain: work history or an existing agent conversation prevents changing a session folder", async t => {
  const f = harness(t);
  const target = f.sessions.get("target");
  const failure = f.sessions.get("failure");
  const existingWorktree = f.sessions.get("always");
  existingWorktree.worktree = { dir: f.repo, branch: "main", shared: true };
  target.events.push({ kind: "user", text: "원래 폴더에서 작업" }, { kind: "text", text: "기존 대화" });
  failure.agentSessionId = "persisted-agent-session";
  f.link("target", "success", { useGitWorktree: true });
  f.link("failure", "success", { useGitWorktree: true });
  f.link("always", "success", { useGitWorktree: true });
  await f.chain.runCommand(f.command);
  assert.deepEqual(f.runner.calls, []);
  assert.equal(target.cwd, f.repo);
  assert.equal(failure.cwd, f.repo);
  assert.equal(existingWorktree.cwd, f.repo);
  assert.equal(existingWorktree.worktree.branch, "main");
  assert.equal(failure.agentSessionId, "persisted-agent-session");
  assert.ok(target.events.some(event => /폴더|대화|이력/.test(event.text) && ["error", "status"].includes(event.kind)));
  assert.ok(failure.events.some(event => /폴더|대화|이력/.test(event.text) && ["error", "status"].includes(event.kind)));
});

test("Git chain: result handoff alone leaves the receiving session folder unchanged", async t => {
  const f = harness(t);
  f.link("target", "success", { useGitWorktree: false });
  await f.chain.runCommand(f.command);
  assert.equal(f.runner.calls.length, 1);
  assert.equal(f.runner.calls[0].cwd, f.repo);
  assert.equal(f.sessions.get("target").worktree, undefined);
});

test("Git chain: a changed worktree branch is rejected before binding a fresh session", async t => {
  const f = harness(t, { runGit: async (request, repo) => {
    const result = gitResult(repo);
    git(repo.worktree, "switch", "-c", "feature/replaced");
    return result;
  } });
  f.link("target", "success", { useGitWorktree: true });
  await f.chain.runCommand(f.command);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.sessions.get("target").cwd, f.repo);
  assert.ok(f.sessions.get("target").events.some(event => ["error", "status"].includes(event.kind)));
});

test("Git chain: repository identity in a result is validated before session binding", async t => {
  const f = harness(t, { runGit: async (request, repo) => gitResult(repo, {
    context: { ...repo.context, repoCommonDir: path.join(repo.root, "another.git") },
  }) });
  f.link("target", "success", { useGitWorktree: true });
  await f.chain.runCommand(f.command);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(f.sessions.get("target").cwd, f.repo);
});

test("Git chain: downstream source-folder commands execute in the Git result worktree", async t => {
  const f = harness(t);
  const command = { id: "cmd-report-cwd", title: "실행 폴더 검사", shell: shells()[0].id,
    command: 'node -e "process.stdout.write(process.cwd())"', cwdMode: "source", timeoutSec: 30,
    projectPath: f.repo, state: "idle", lastRun: null };
  f.commands.set(command.id, command);
  f.link(command.id, "success", { useGitWorktree: true });
  const notifications = [];
  const originalNotify = f.chain.notify;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  f.chain.notify = (kind, ...args) => {
    originalNotify(kind, ...args);
    notifications.push(kind);
    if (command.lastRun) resolveDone();
  };
  await f.chain.runCommand(f.command, { origin: f.sessions.get("source") });
  await Promise.race([done, new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("downstream command did not finish")), 15000);
    done.finally(() => clearTimeout(timer));
  })]);
  assert.equal(command.state, "success");
  assert.equal(path.resolve(command.lastRun.cwd), path.resolve(f.worktree));
  assert.equal(path.resolve(command.lastRun.tail.trim()), path.resolve(f.worktree));
  assert.equal(command.lastRun.origin.gitContext.branch, f.context.branch);
  assert.equal(f.sessions.get("source").cwd, f.repo);
});


test("Git chain: commits made in a valid worktree refresh the new session base commit", async t => {
  let currentHead;
  const f = harness(t, { runGit: async (request, repo) => {
    const result = gitResult(repo);
    fs.writeFileSync(path.join(repo.worktree, "follow-up.txt"), "A completed follow-up commit\n");
    git(repo.worktree, "add", "follow-up.txt");
    git(repo.worktree, "commit", "-qm", "Follow-up work");
    currentHead = git(repo.worktree, "rev-parse", "HEAD");
    return result;
  } });
  f.link("target", "success", { useGitWorktree: true });
  await f.chain.runCommand(f.command);
  assert.notEqual(currentHead, f.context.head);
  assert.equal(f.runner.calls.length, 1);
  assert.equal(f.sessions.get("target").baseCommit, currentHead);
  assert.equal(f.sessions.get("target").gitContext.head, currentHead);
});


test("Git chain: approving a held result uses its original worktree and complete result text", async t => {
  const f = harness(t);
  const link = f.link("target", "success", { useGitWorktree: true, approve: true });
  await f.chain.runCommand(f.command);
  assert.equal(f.runner.calls.length, 0);
  assert.equal(link.pending.sourceRun.gitResult.branch, f.context.branch);
  const originalAnswer = link.pending.answer;
  assert.match(originalAnswer, /feature\/existing 준비 완료/);
  const otherWorktree = path.join(f.root, "second-worktree");
  git(f.repo, "branch", "feature/second");
  git(f.repo, "worktree", "add", otherWorktree, "feature/second");
  // In-place changes and a newer result must not mutate the held snapshot.
  f.command.lastRun.gitResult.output = "새 결과";
  f.command.lastRun.gitResult.context.cwd = otherWorktree;
  f.command.branch = "feature/second";
  f.command.lastRun = { ...f.command.lastRun, cwd: otherWorktree, tail: "새 결과", gitResult: gitResult(f, {
    output: "새 결과", cwd: otherWorktree, branch: "feature/second",
    context: { ...f.context, cwd: otherWorktree, branch: "feature/second" },
  }) };
  assert.equal(link.pending.sourceRun.gitResult.context.cwd, f.worktree);
  await f.chain.decide(link, true);
  assert.equal(link.pending, null);
  assert.equal(f.runner.calls.length, 1);
  assert.equal(path.resolve(f.runner.calls[0].cwd), path.resolve(f.worktree));
  assert.equal(f.runner.calls[0].prompt, originalAnswer);
  assert.doesNotMatch(f.runner.calls[0].prompt, /새 결과/);
  assert.equal(f.sessions.get("target").worktree.branch, f.context.branch);
});

test("Git nodes: restarting during an operation invalidates the previous success and requires recovery", t => {
  const f = repository(t);
  const dataDir = path.join(f.root, "data");
  fs.mkdirSync(dataDir);
  const startedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, "commands.json"), JSON.stringify([{
    id: "cmd-interrupted-git", kind: "git", gitAction: "merge", title: "중단된 병합", projectPath: f.repo,
    branch: f.context.branch, targetBranch: "develop", state: "running",
    live: { startedAt, cwd: f.worktree, tail: "병합 중" }, queued: { depth: 2 },
    lastRun: { ok: true, exitCode: 0, cwd: f.worktree, gitResult: gitResult(f) },
  }]));
  const store = new CommandStore({ dataDir });
  const recovered = store.get("cmd-interrupted-git");
  assert.equal(recovered.state, "error");
  assert.equal(recovered.live, null);
  assert.equal(recovered.queued, null);
  assert.equal(recovered.lastRun.ok, false);
  assert.equal(recovered.lastRun.stopped, true);
  assert.equal(recovered.lastRun.gitResult.ok, false);
  assert.equal(recovered.lastRun.gitResult.recoveryRequired, true);
  assert.equal(recovered.lastRun.gitResult.context, undefined);
  assert.match(recovered.lastRun.tail, /상태|확인|다시/);
  store.save();
  const persisted = new CommandStore({ dataDir }).get(recovered.id);
  assert.equal(persisted.lastRun.gitResult.recoveryRequired, true);
  assert.equal(persisted.lastRun.gitResult.context, undefined);
});


test("Git chain: an existing conversation cannot adopt a different branch at the same path", async t => {
  const f = harness(t, { runGit: async (request, repo) => gitResult(repo, {
    branch: request.command.branch, context: { ...repo.context, branch: request.command.branch },
  }) });
  const target = f.sessions.get("target");
  target.cwd = f.worktree;
  target.worktree = { dir: f.worktree, branch: f.context.branch, shared: true };
  target.gitContext = { ...f.context };
  target.agentSessionId = "conversation-for-original-branch";
  target.events.push({ kind: "user", text: "원래 브랜치 작업" });
  const legacy = f.sessions.get("failure");
  legacy.cwd = f.worktree;
  legacy.worktree = { dir: f.worktree, branch: f.context.branch, shared: true };
  legacy.events.push({ kind: "text", text: "Git 컨텍스트 도입 이전의 대화" });
  git(f.worktree, "switch", "-c", "feature/replaced");
  f.command.branch = "feature/replaced";
  f.link("target", "success", { useGitWorktree: true });
  f.link("failure", "success", { useGitWorktree: true });
  await f.chain.runCommand(f.command);
  assert.deepEqual(f.runner.calls, []);
  assert.equal(target.gitContext.branch, f.context.branch);
  assert.equal(target.worktree.branch, f.context.branch);
  assert.equal(target.agentSessionId, "conversation-for-original-branch");
  assert.equal(legacy.gitContext, undefined);
  assert.equal(legacy.worktree.branch, f.context.branch);
  assert.equal(f.command.lastRun.deliveryErrors.length, 2);
});

test("Git chain: queued requests remain in order during Git work and resume after it settles", async t => {
  let release;
  const f = harness(t, { runGit: (request, repo) => new Promise(resolve => {
    release = () => resolve(gitResult(repo));
  }) });
  const target = f.sessions.get("target");
  const running = f.chain.runCommand(f.command);
  await Promise.resolve();
  f.chain.enqueue(target, "첫 번째 사용자 요청", { user: true }, 0);
  f.chain.enqueue(target, "두 번째 연결 요청", { from: "source", fromTitle: "source" }, 1);
  f.chain.flush(target);
  assert.equal(f.command.state, "running");
  assert.deepEqual(f.runner.calls, []);
  assert.equal(f.chain.pending(target.id), 2);
  assert.deepEqual(f.chain.list(target.id).map(item => item.text), ["첫 번째 사용자 요청", "두 번째 연결 요청"]);
  release();
  await running;
  assert.equal(f.command.state, "success");
  assert.deepEqual(f.runner.calls.map(call => call.prompt), ["첫 번째 사용자 요청"]);
  assert.equal(f.chain.pending(target.id), 1);
  f.runner.running.delete(target.id);
  f.chain.flush(target);
  assert.deepEqual(f.runner.calls.map(call => call.prompt), ["첫 번째 사용자 요청", "두 번째 연결 요청"]);
  assert.equal(f.chain.pending(target.id), 0);
});


test("Git chain: deleting a running node keeps its project busy until completion and resumes the queue", async t => {
  let release;
  let signal;
  const f = harness(t, { runGit: (request, repo) => {
    signal = request.signal;
    return new Promise(resolve => { release = () => resolve(gitResult(repo, { stopped: true, ok: false })); });
  } });
  const target = f.sessions.get("target");
  f.link("failure", "always");
  const running = f.chain.runCommand(f.command);
  await Promise.resolve();
  f.chain.enqueue(target, "삭제된 Git 작업이 끝나면 실행", { user: true }, 0);
  assert.equal(f.chain.pending(target.id), 1);
  assert.equal(f.chain.stopCommand(f.command), true);
  assert.equal(signal.aborted, true);
  f.commands.delete(f.command.id);
  assert.equal(f.chain.gitBusy(target), true);
  f.chain.flush(target);
  assert.equal(f.chain.pending(target.id), 1);
  assert.deepEqual(f.runner.calls, []);
  release();
  await running;
  assert.equal(f.chain.gitBusy(target), false);
  assert.equal(f.chain.runs.size, 0);
  assert.equal(f.chain.pending(target.id), 0);
  assert.deepEqual(f.runner.calls.map(call => ({ id: call.id, prompt: call.prompt })), [
    { id: target.id, prompt: "삭제된 Git 작업이 끝나면 실행" },
  ]);
});


test("Git nodes API: recreating a connected session preserves its validated Git context and worktree", async t => {
  const f = await apiFixture(t);
  const node = await f.create();
  await f.success("POST", "/links", { from: node.id, to: "target", when: "success" });
  f.hub.chain.runGit = async () => gitResult(f);
  await f.hub.chain.runCommand(f.hub.commands.get(node.id));
  const previous = f.hub.store.get("target");
  assert.equal(previous.gitContext.branch, f.context.branch);
  f.runner.running.delete(previous.id);
  const recreated = await f.success("POST", "/sessions/" + previous.id + "/recreate", {});
  assert.notEqual(recreated.id, previous.id);
  assert.equal(path.resolve(recreated.cwd), path.resolve(f.worktree));
  assert.equal(recreated.worktree.branch, f.context.branch);
  assert.deepEqual(recreated.gitContext, previous.gitContext);
  const detail = await f.success("GET", "/sessions/" + recreated.id);
  assert.deepEqual(detail.gitContext, previous.gitContext);
  assert.equal((await f.request("GET", "/sessions/" + previous.id)).status, 404);
  f.hub.store.flush(recreated.id);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, "sessions", recreated.id + ".json"), "utf8"));
  assert.deepEqual(saved.gitContext, previous.gitContext);
  assert.equal(path.resolve(saved.cwd), path.resolve(f.worktree));
  assert.equal(saved.worktree.branch, f.context.branch);
  // An externally switched branch must be rejected before a replacement session is created.
  const count = f.hub.store.list().length;
  git(f.worktree, "switch", "-c", "feature/recreate-changed");
  const rejected = await f.request("POST", "/sessions/" + recreated.id + "/recreate", {});
  assert.equal(rejected.status, 409);
  assert.equal(f.hub.store.list().length, count);
  assert.ok(f.hub.store.get(recreated.id));
  assert.equal(f.hub.store.get(recreated.id).gitContext.branch, f.context.branch);
});

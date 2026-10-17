import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHub } from "../server/bootstrap.mjs";
import { checkCommand } from "../server/commands.mjs";
import { taskResultText } from "../server/task-nodes.mjs";
import { normalizePull } from "../server/github.mjs";

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete gitEnv[key];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

class FakeRunner extends EventEmitter {
  calls = [];
  running = new Set();
  isRunning(id) { return this.running.has(id); }
  append(session, event) { session.events.push(event); }
  send(session, prompt) { this.calls.push({ id: session.id, cwd: session.cwd, prompt }); }
  stopAll() { this.running.clear(); }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-task-nodes-"));
  const repo = path.join(root, "repository"), remote = path.join(root, "origin.git");
  fs.mkdirSync(repo);
  git(root, "init", "--bare", "-q", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Task Node Test"); git(repo, "config", "user.email", "task-node@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "Task node fixture\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", remote); git(repo, "push", "-q", "origin", "main");
  git(repo, "branch", "develop"); git(repo, "push", "-q", "origin", "develop");
  const pulls = [];
  const github = {
    async target(dir, selected) { return { dir, repo: "acme/widget", name: selected, pushMatches: true }; },
    async api(target, method, endpoint) {
      if (method === "GET" && endpoint.includes("/pulls?")) return pulls.filter((pull) => endpoint.includes(encodeURIComponent(`acme:${pull.head.ref}`)));
      throw Error(`Unexpected GitHub call: ${method} ${endpoint}`);
    },
    async push(dir, body) { git(dir, "push", "-q", remote, `${body.expectedHead}:refs/heads/${body.branch}`); return { ok: true }; },
    async create(dir, body) {
      const raw = { number: pulls.length + 1, title: body.title, body: body.body, state: "open", html_url: `https://github.com/acme/widget/pull/${pulls.length + 1}`,
        head: { ref: body.head, sha: body.expectedHead }, base: { ref: body.base } };
      pulls.push(raw);
      return { pull: normalizePull(raw, "acme/widget") };
    },
    async detail(dir, number) { return { pull: normalizePull(pulls.find((pull) => pull.number === number), "acme/widget") }; },
    async remoteHead() { return null; },
  };
  const runner = new FakeRunner();
  const hub = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false,
    deps: { runner, github, cliPaths: () => ({ claude: "fake-cli" }), logger: { log() {} } } });
  const now = new Date().toISOString();
  for (const id of ["worker", "reporter", "failed"]) hub.store.add({ id, title: id, agent: "claude", cwd: repo, permission: "acceptEdits",
    projectPath: repo, projectName: "repository", state: "idle", events: [], createdAt: now, updatedAt: now });
  await hub.start();
  t.after(async () => {
    await hub.shutdown();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function request(method, suffix, body) {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api${suffix}`, { method,
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  async function ok(method, suffix, body) {
    const response = await request(method, suffix, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  // 전체 테스트를 함께 돌리면 혼자 6초 걸리는 Git 처리도 15초를 넘길 수 있어 30초까지 기다린다.
  async function until(check, label) {
    for (let i = 0; i < 600; i++) {
      const value = check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`시간 안에 끝나지 않았습니다: ${label}`);
  }
  return { repo, hub, runner, pulls, request, ok, until };
}

test("task nodes: validate start and finish settings", () => {
  const start = checkCommand({ kind: "task", taskType: "hotfix", titleTemplate: "{{input}}" });
  assert.deepEqual(start, { kind: "task", title: "새 작업", taskAction: "start", taskType: "hotfix", titleTemplate: "{{input}}", version: "", inPlace: false });
  const finish = checkCommand({ kind: "task", taskAction: "finish" });
  assert.equal(finish.title, "작업 마무리");
  assert.equal(finish.description, "{{input}}");
  assert.equal(finish.finishMode, "project");
  assert.equal(finish.pushTarget, false);
  assert.equal(checkCommand({ kind: "task", taskAction: "finish", finishMode: "pr", pushTarget: true }).pushTarget, false, "PR 방식에는 대상 브랜치 푸시가 없다");
  assert.equal(checkCommand({ kind: "task", taskAction: "finish", finishMode: "local", pushTarget: true }).pushTarget, true);
  assert.throws(() => checkCommand({ kind: "task", taskAction: "finish", finishMode: "squash" }), /반영 방식/);
  assert.throws(() => checkCommand({ kind: "task", taskAction: "merge" }), /새 작업 또는 작업 마무리/);
  assert.throws(() => checkCommand({ kind: "task", taskType: "release" }), /배포 버전/);
  assert.throws(() => checkCommand({ kind: "task", titleTemplate: "  " }), /작업 제목/);
});

test("task nodes: result text describes failures without hiding unknown outcomes", () => {
  const text = taskResultText({ ok: false, action: "finish", message: "응답이 끊겼습니다.", outcomeUnknown: true }, "요청");
  assert.match(text, /\[작업 마무리 실패\]/);
  assert.match(text, /상태 확인/);
  assert.match(text, /원래 요청:\n요청/);
});

test("task nodes: start creates a task for the connected session and finish opens its PR", async (t) => {
  const f = await fixture(t);
  const button = await f.ok("POST", "/commands", { kind: "button", title: "시작", prompt: "흐름 기능 작업\n자세한 설명", projectPath: f.repo });
  const start = await f.ok("POST", "/commands", { kind: "task", taskAction: "start", projectPath: f.repo });
  const finish = await f.ok("POST", "/commands", { kind: "task", taskAction: "finish", verification: "npm test 통과", projectPath: f.repo });
  await f.ok("POST", "/links", { from: button.id, to: start.id });
  const handoff = await f.ok("POST", "/links", { from: start.id, to: "worker", when: "success" });
  assert.equal(handoff.useGitWorktree, true);
  const review = await f.ok("POST", "/links", { from: "worker", to: finish.id });
  assert.equal(review.approve, true, "작업 마무리로 들어가는 연결은 기본으로 승인을 받는다");
  await f.ok("POST", "/links", { from: finish.id, to: "reporter", when: "success" });
  await f.ok("POST", "/links", { from: finish.id, to: "failed", when: "error" });
  assert.equal((await f.request("POST", "/links", { from: start.id, to: "failed", when: "keyword", keyword: "통과" })).status, 400);

  await f.ok("POST", `/commands/${button.id}/run`);
  const sent = await f.until(() => f.runner.calls.find((call) => call.id === "worker"), "작업 세션 전달");
  const { tasks } = await f.ok("GET", `/tasks?path=${encodeURIComponent(f.repo)}`);
  assert.equal(tasks.length, 1);
  const [task] = tasks;
  assert.equal(task.title, "흐름 기능 작업");
  assert.match(task.branch, /^feature\//);
  assert.deepEqual(task.sessionIds, ["worker"]);
  const worker = f.hub.store.get("worker");
  assert.equal(worker.taskId, task.id);
  assert.equal(path.resolve(worker.cwd), path.resolve(task.cwd));
  assert.equal(path.resolve(sent.cwd), path.resolve(task.cwd));
  assert.match(sent.prompt, /\[새 작업\]/);
  assert.match(sent.prompt, /원래 요청:\n흐름 기능 작업/);
  assert.equal(git(task.cwd, "symbolic-ref", "--short", "HEAD"), task.branch);

  fs.writeFileSync(path.join(task.cwd, "feature.txt"), "flow change\n");
  await f.ok("POST", `/commands/${finish.id}/run`);
  const reported = await f.until(() => f.runner.calls.find((call) => call.id === "reporter"), "PR 결과 전달");
  assert.match(reported.prompt, /PR #1: https:\/\/github\.com\/acme\/widget\/pull\/1/);
  assert.equal(f.pulls.length, 1);
  assert.match(f.pulls[0].body, /npm test 통과/);
  assert.equal(git(task.cwd, "log", "-1", "--format=%s"), "feat: 흐름 기능 작업");
  assert.equal(f.runner.calls.some((call) => call.id === "failed"), false);
});

test("task nodes: local finish merges into the target branch without opening a PR", async (t) => {
  const f = await fixture(t);
  const button = await f.ok("POST", "/commands", { kind: "button", title: "시작", prompt: "로컬 반영 작업", projectPath: f.repo });
  const start = await f.ok("POST", "/commands", { kind: "task", taskAction: "start", projectPath: f.repo });
  const finish = await f.ok("POST", "/commands", { kind: "task", taskAction: "finish", finishMode: "local", projectPath: f.repo });
  assert.equal(finish.finishMode, "local");
  await f.ok("POST", "/links", { from: button.id, to: start.id });
  await f.ok("POST", "/links", { from: start.id, to: "worker", when: "success" });
  await f.ok("POST", "/links", { from: "worker", to: finish.id });
  await f.ok("POST", "/links", { from: finish.id, to: "reporter", when: "success" });
  await f.ok("POST", "/links", { from: finish.id, to: "failed", when: "error" });
  await f.ok("POST", `/commands/${button.id}/run`);
  await f.until(() => f.runner.calls.find((call) => call.id === "worker"), "작업 세션 전달");
  const [task] = (await f.ok("GET", `/tasks?path=${encodeURIComponent(f.repo)}`)).tasks;
  fs.writeFileSync(path.join(task.cwd, "local.txt"), "local change\n");

  await f.ok("POST", `/commands/${finish.id}/run`);
  const done = await f.until(() => f.runner.calls.find((call) => ["reporter", "failed"].includes(call.id)), "로컬 반영 결과 전달");
  assert.equal(done.id, "reporter", done.prompt);
  assert.match(done.prompt, new RegExp(`로컬 반영: ${task.targetBranch} [0-9a-f]{8}`));
  assert.equal(f.pulls.length, 0);
  const merged = (await f.ok("GET", `/tasks?path=${encodeURIComponent(f.repo)}`)).tasks[0];
  assert.equal(merged.state, "merged");
  assert.equal(git(f.repo, "show", `${task.targetBranch}:local.txt`), "local change");
});

test("task nodes: finish without a task goes to the failure output", async (t) => {
  const f = await fixture(t);
  const finish = await f.ok("POST", "/commands", { kind: "task", taskAction: "finish", projectPath: f.repo });
  await f.ok("POST", "/links", { from: finish.id, to: "failed", when: "error" });
  await f.ok("POST", `/commands/${finish.id}/run`);
  const failed = await f.until(() => f.runner.calls.find((call) => call.id === "failed"), "실패 출력 전달");
  assert.match(failed.prompt, /\[작업 마무리 실패\]/);
  assert.match(failed.prompt, /마무리할 작업을 찾지 못했습니다/);
  const node = (await f.ok("GET", `/commands?path=${encodeURIComponent(f.repo)}`)).commands.find((item) => item.id === finish.id);
  assert.equal(node.state, "error");
});

test("task nodes: sessions with conversation history are not moved into a new task", async (t) => {
  const f = await fixture(t);
  f.hub.store.get("worker").events.push({ kind: "user", text: "이전 대화" });
  const start = await f.ok("POST", "/commands", { kind: "task", taskAction: "start", titleTemplate: "고정 제목", projectPath: f.repo });
  await f.ok("POST", "/links", { from: start.id, to: "worker", when: "success" });
  await f.ok("POST", `/commands/${start.id}/run`);
  const node = await f.until(() => {
    const item = f.hub.commands.get(start.id);
    return item.state !== "running" && item.lastRun?.deliveryErrors?.length ? item : null;
  }, "전달 실패 기록");
  assert.match(node.lastRun.deliveryErrors[0], /기존 대화/);
  const worker = f.hub.store.get("worker");
  assert.equal(worker.taskId, undefined);
  assert.equal(path.resolve(worker.cwd), path.resolve(f.repo));
  assert.equal(f.runner.calls.length, 0);
});

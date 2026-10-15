import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../server/bootstrap.mjs';

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[key];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function configureIdentity(cwd) {
  git(cwd, 'config', 'user.name', 'Task API Test');
  git(cwd, 'config', 'user.email', 'task-api-test@example.invalid');
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agenthub-task-api-'));
  const repo = path.join(root, 'repository');
  const origin = path.join(root, 'origin.git');
  const writer = path.join(root, 'remote-writer');
  const dataDir = path.join(root, 'data');
  let hub;
  t.after(async () => {
    try {
      await hub?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  await mkdir(repo);
  git(root, 'init', '--bare', origin);
  git(repo, 'init', '-b', 'main');
  configureIdentity(repo);
  await writeFile(path.join(repo, 'README.md'), 'Task API fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'Initial fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'branch', 'develop');
  git(repo, 'push', 'origin', 'develop');
  const mainSha = git(repo, 'rev-parse', 'HEAD');

  // Advance the remote from another checkout, leaving the project's tracking ref stale.
  git(root, 'clone', '--branch', 'develop', origin, writer);
  configureIdentity(writer);
  await writeFile(path.join(writer, 'remote-development.txt'), 'Latest development change\n');
  git(writer, 'add', 'remote-development.txt');
  git(writer, 'commit', '-m', 'Advance remote development');
  git(writer, 'push', 'origin', 'develop');
  const developSha = git(writer, 'rev-parse', 'HEAD');
  assert.notEqual(git(repo, 'rev-parse', 'origin/develop'), developSha);

  async function start() {
    hub = createHub({ dataDir, port: 0, warmup: false });
    // Creating or managing a task must not launch a real agent in this fixture.
    if (hub.runner) hub.runner.send = () => { throw new Error('Task API fixture must not run an agent'); };
    await hub.start();
  }
  await start();

  async function request(method, pathname, body) {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-AgentHub': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { status: response.status, ok: response.ok, body: value };
  }
  async function success(method, pathname, body) {
    const response = await request(method, pathname, body);
    assert.equal(response.ok, true, `${method} ${pathname}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  }
  async function createTask(type, title) {
    return success('POST', '/tasks', {
      projectPath: repo,
      title,
      type,
      ...(type === 'release' ? { version: title } : {}),
      agent: 'codex',
      permission: 'workspace-write',
    });
  }
  async function tasks() {
    const result = await success('GET', `/tasks?path=${encodeURIComponent(repo)}`);
    assert.ok(Array.isArray(result.tasks));
    return result.tasks;
  }
  return {
    repo, origin, dataDir, mainSha, developSha, request, success, createTask, tasks,
    get hub() { return hub; },
    async restart() {
      await hub.shutdown();
      hub = undefined;
      await start();
    },
  };
}

test('task API creates GitFlow branches from the latest remote bases', async t => {
  const f = await fixture(t);
  const definitions = [
    { type: 'feature', title: 'Latest feature', base: 'develop', target: 'develop', sha: f.developSha },
    { type: 'hotfix', title: 'Urgent fix', base: 'main', target: 'main', sha: f.mainSha },
    { type: 'release', title: '1.2.3', base: 'develop', target: 'main', sha: f.developSha },
  ];
  const ids = [];
  for (const definition of definitions) {
    const { task, session } = await f.createTask(definition.type, definition.title);
    assert.ok(task.id);
    assert.ok(session.id);
    assert.equal(task.state, 'working');
    assert.equal(task.baseBranch, definition.base);
    assert.equal(task.targetBranch, definition.target);
    assert.ok(task.branch.startsWith(`${definition.type}/`));
    assert.ok(task.sessionIds.includes(session.id));
    assert.equal(git(task.cwd, 'branch', '--show-current'), task.branch);
    assert.equal(git(task.cwd, 'rev-parse', 'HEAD'), definition.sha);
    assert.equal(path.resolve(session.cwd), path.resolve(task.cwd));
    ids.push(task.id);
  }
  assert.deepEqual((await f.tasks()).map(task => task.id).sort(), ids.sort());
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  assert.equal(await readFile(path.join(f.repo, 'README.md'), 'utf8'), 'Task API fixture\n');
});

test('task sessions can be recreated and detached without deleting their worktree', async t => {
  const f = await fixture(t);
  const { task, session } = await f.createTask('feature', 'Session lifecycle');
  const blocked = await f.request('DELETE', `/sessions/${session.id}?removeWorktree=1`);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.ok(existsSync(task.cwd));
  assert.ok((await f.tasks()).find(item => item.id === task.id).sessionIds.includes(session.id));

  const recreated = await f.success('POST', `/sessions/${session.id}/recreate`, {});
  const replacement = recreated.session || recreated;
  assert.ok(replacement.id);
  assert.notEqual(replacement.id, session.id);
  assert.equal(path.resolve(replacement.cwd), path.resolve(task.cwd));
  const afterRecreate = (await f.tasks()).find(item => item.id === task.id);
  assert.ok(afterRecreate.sessionIds.includes(replacement.id));
  assert.equal(afterRecreate.sessionIds.includes(session.id), false);

  await f.success('DELETE', `/sessions/${replacement.id}`);
  const detached = (await f.tasks()).find(item => item.id === task.id);
  assert.deepEqual(detached.sessionIds, []);
  assert.ok(existsSync(task.cwd));
  assert.equal(git(task.cwd, 'branch', '--show-current'), task.branch);

  await f.restart();
  const restored = (await f.tasks()).find(item => item.id === task.id);
  assert.ok(restored);
  assert.equal(restored.cwd, task.cwd);
  assert.equal(restored.branch, task.branch);
  assert.deepEqual(restored.sessionIds, []);
  assert.ok(existsSync(restored.cwd));
  const reattached = await f.success('POST', `/tasks/${task.id}/session`, {});
  assert.equal(reattached.session.agent, 'codex');
  assert.equal(reattached.session.permission, 'workspace-write');
  assert.equal(reattached.session.taskId, task.id);
});

test('unfinished tasks cannot have their worktree cleaned up', async t => {
  const f = await fixture(t);
  const { task } = await f.createTask('feature', 'Keep unfinished work');
  await writeFile(path.join(task.cwd, 'unfinished.txt'), 'Uncommitted work must survive\n');
  const cleanup = await f.request('POST', `/tasks/${task.id}/cleanup`, {});
  assert.equal(cleanup.ok, false, JSON.stringify(cleanup.body));
  assert.ok(cleanup.status >= 400 && cleanup.status < 500);
  assert.equal(await readFile(path.join(task.cwd, 'unfinished.txt'), 'utf8'), 'Uncommitted work must survive\n');
  const stored = (await f.tasks()).find(item => item.id === task.id);
  assert.equal(stored.state, 'working');
});

test('removing a project preserves task worktrees and keeps their records accessible', async t => {
  const f = await fixture(t);
  const { task } = await f.createTask('feature', 'Keep task after project removal');
  await writeFile(path.join(task.cwd, 'unfinished.txt'), 'Keep this task work\n');

  await f.success('DELETE', `/projects?path=${encodeURIComponent(f.repo)}&removeWorktrees=1`);
  const remaining = (await f.tasks()).find(item => item.id === task.id);
  assert.ok(remaining);
  assert.deepEqual(remaining.sessionIds, []);
  assert.equal(await readFile(path.join(task.cwd, 'unfinished.txt'), 'utf8'), 'Keep this task work\n');
  assert.equal(git(task.cwd, 'branch', '--show-current'), task.branch);

  await f.restart();
  const restored = (await f.tasks()).find(item => item.id === task.id);
  assert.ok(restored);
  assert.deepEqual(restored.sessionIds, []);
  assert.ok(existsSync(restored.cwd));
});

test('public session creation cannot inject task ownership or reuse a task worktree', async t => {
  const f = await fixture(t);
  const { task, session } = await f.createTask('feature', 'Owned worktree');
  const unrelated = await f.success('POST', '/sessions', {
    projectPath: f.repo,
    title: 'Unrelated session',
    agent: 'codex',
    permission: 'workspace-write',
    taskId: task.id,
    cwd: task.cwd,
    worktree: { dir: task.cwd, branch: task.branch },
  });
  assert.ok(unrelated.id);
  assert.equal(unrelated.taskId, undefined);
  assert.equal(path.resolve(unrelated.cwd), path.resolve(f.repo));
  assert.equal(unrelated.worktree, null);
  const stored = (await f.tasks()).find(item => item.id === task.id);
  assert.deepEqual(stored.sessionIds, [session.id]);
});


test('task deletion removes the task and its sessions persistently while preserving the worktree', async t => {
  const f = await fixture(t);
  const { task, session } = await f.createTask('feature', 'Delete task with draft work');
  const second = await f.success('POST', '/tasks/' + task.id + '/session', {});
  const unrelated = await f.success('POST', '/sessions', {
    projectPath: f.repo, title: 'Keep unrelated session', agent: 'codex', permission: 'workspace-write',
  });
  await writeFile(path.join(task.cwd, 'unpublished.txt'), 'Local commit must remain\n');
  git(task.cwd, 'add', 'unpublished.txt'); git(task.cwd, 'commit', '-m', 'Unpublished task work');
  const head = git(task.cwd, 'rev-parse', 'HEAD');
  await writeFile(path.join(task.cwd, 'draft.txt'), 'Draft must remain\n');
  const sourceHead = git(f.repo, 'rev-parse', 'HEAD');

  const result = await f.success('DELETE', '/tasks/' + task.id);

  assert.equal(result.ok, true);
  assert.deepEqual(await f.tasks(), []);
  for (const id of [session.id, second.session.id]) {
    assert.equal((await f.request('GET', '/sessions/' + id)).status, 404);
    assert.equal(existsSync(path.join(f.dataDir, 'sessions', id + '.json')), false);
  }
  assert.equal(existsSync(path.join(f.dataDir, 'tasks', task.id + '.json')), false);
  assert.equal((await f.success('GET', '/sessions/' + unrelated.id)).id, unrelated.id);
  assert.equal(await readFile(path.join(task.cwd, 'draft.txt'), 'utf8'), 'Draft must remain\n');
  assert.equal(await readFile(path.join(task.cwd, 'unpublished.txt'), 'utf8'), 'Local commit must remain\n');
  assert.equal(git(f.repo, 'rev-parse', 'refs/heads/' + task.branch), head);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), sourceHead);

  await f.restart();
  assert.deepEqual(await f.tasks(), []);
  assert.equal((await f.success('GET', '/sessions')).length, 1);
  assert.equal((await f.success('GET', '/sessions'))[0].id, unrelated.id);
  assert.ok(existsSync(task.cwd));
});

test('task deletion returns not found for an unknown task', async t => {
  const f = await fixture(t);

  const result = await f.request('DELETE', '/tasks/missing-task');

  assert.equal(result.status, 404);
  assert.equal(result.body.reason, 'task-missing');
});

test('task deletion refuses running sessions and retains the task', async t => {
  const f = await fixture(t);
  const { task, session } = await f.createTask('feature', 'Running task');
  const isRunning = f.hub.runner.isRunning;
  f.hub.runner.isRunning = id => id === session.id;
  let result;
  try {
    result = await f.request('DELETE', '/tasks/' + task.id);
  } finally {
    f.hub.runner.isRunning = isRunning;
  }

  assert.equal(result.status, 409);
  assert.equal(result.body.reason, 'running');
  assert.equal((await f.tasks())[0].id, task.id);
  assert.equal((await f.success('GET', '/sessions/' + session.id)).id, session.id);
  assert.ok(existsSync(task.cwd));
});

test('task deletion refuses a persisted uncertain operation after restart', async t => {
  const f = await fixture(t);
  const { task, session } = await f.createTask('feature', 'Pending publication');
  const file = path.join(f.dataDir, 'tasks', task.id + '.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.pendingAction = { action: 'push', expectedHead: git(task.cwd, 'rev-parse', 'HEAD'), outcomeUnknown: true };
  await writeFile(file, JSON.stringify(stored));
  await f.restart();

  const result = await f.request('DELETE', '/tasks/' + task.id);

  assert.equal(result.status, 409);
  assert.equal(result.body.reason, 'task-outcome-unknown');
  assert.equal((await f.tasks())[0].pendingAction.action, 'push');
  assert.equal((await f.success('GET', '/sessions/' + session.id)).id, session.id);
  assert.ok(existsSync(task.cwd));
});

test('task deletion can be retried after a session file removal fails', async t => {
  const f = await fixture(t);
  const { task, session } = await f.createTask('feature', 'Retry deletion');
  const remove = f.hub.store.remove;
  f.hub.store.remove = () => { throw Error('Simulated session file error'); };
  let failed;
  try {
    failed = await f.request('DELETE', '/tasks/' + task.id);
  } finally {
    f.hub.store.remove = remove;
  }

  assert.equal(failed.ok, false);
  assert.match(failed.body.error, /Simulated session file error/);
  assert.equal((await f.tasks())[0].id, task.id);
  assert.equal((await f.success('GET', '/sessions/' + session.id)).id, session.id);
  assert.ok(existsSync(path.join(f.dataDir, 'tasks', task.id + '.json')));
  await f.success('DELETE', '/tasks/' + task.id);
  await f.restart();
  assert.deepEqual(await f.tasks(), []);
  assert.deepEqual(await f.success('GET', '/sessions'), []);
  assert.ok(existsSync(task.cwd));
});

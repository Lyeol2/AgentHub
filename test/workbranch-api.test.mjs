import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../server/bootstrap.mjs';

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[key];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: gitEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agenthub-workbranch-api-'));
  const repo = path.join(root, 'repository');
  const origin = path.join(root, 'origin.git');
  const shared = path.join(root, 'existing-worktree');
  const dataDir = path.join(root, 'data');
  const branch = 'agenthub/existing';
  let hub;
  t.after(async () => {
    try { await hub?.shutdown(); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  await mkdir(repo);
  git(root, 'init', '--bare', origin);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Workbranch API Test');
  git(repo, 'config', 'user.email', 'workbranch-api@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repo, 'README.md'), 'Existing branch fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'Initial fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', 'origin', 'main');
  git(repo, 'branch', 'develop');
  git(repo, 'push', 'origin', 'develop');
  git(repo, 'branch', branch);
  git(repo, 'worktree', 'add', shared, branch);
  await writeFile(path.join(shared, 'draft.txt'), 'Existing uncommitted work\n');

  async function start() {
    hub = createHub({ dataDir, port: 0, warmup: false });
    if (hub.runner) hub.runner.send = () => { throw new Error('Workbranch fixture must not launch an agent'); };
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
    return { ok: response.ok, status: response.status, body: value };
  }
  async function success(method, pathname, body) {
    const result = await request(method, pathname, body);
    assert.equal(result.ok, true, `${method} ${pathname}: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const options = { projectPath: repo, agent: 'codex', permission: 'workspace-write' };
  return {
    root, repo, origin, shared, branch, dataDir, options, request, success,
    refs: () => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads').split(/\r?\n/).filter(Boolean).sort(),
    async branches() {
      const result = await success('GET', `/workbranches?path=${encodeURIComponent(repo)}`);
      assert.ok(Array.isArray(result.branches));
      return result.branches;
    },
    createSession: (workBranch = branch, extra = {}) => success('POST', '/sessions', { ...options, title: 'Use existing branch', workBranch, ...extra }),
    createTask: (workBranch = branch, extra = {}) => success('POST', '/tasks', { ...options, title: 'Use existing work', type: 'feature', workBranch, ...extra }),
    async restart() {
      await hub.shutdown(); hub = undefined;
      await start();
    },
  };
}

test('workbranch listing distinguishes reusable worktrees and protected source branches', async t => {
  const f = await fixture(t);
  const before = f.refs();
  const branches = await f.branches();
  const existing = branches.find(item => item.name === f.branch);
  assert.ok(existing);
  assert.equal(existing.checkedOut, true);
  assert.equal(path.resolve(existing.cwd), path.resolve(f.shared));
  assert.equal(existing.selectableForSession, true);
  assert.equal(existing.selectableForTask, true);
  for (const name of ['main', 'develop']) {
    const protectedBranch = branches.find(item => item.name === name);
    assert.ok(protectedBranch);
    assert.equal(protectedBranch.selectable, false);
    assert.equal(protectedBranch.selectableForSession, false);
    assert.equal(protectedBranch.selectableForTask, false);
  }
  assert.deepEqual(f.refs(), before);
});

test('selecting an existing dirty worktree shares it without forking or removing its work', async t => {
  const f = await fixture(t);
  const before = f.refs();
  const first = await f.createSession();
  const second = await f.createSession();
  for (const session of [first, second]) {
    assert.equal(path.resolve(session.cwd), path.resolve(f.shared));
    assert.equal(session.worktree.branch, f.branch);
    assert.equal(session.worktree.shared, true);
  }
  assert.deepEqual(f.refs(), before);
  assert.equal(await readFile(path.join(f.shared, 'draft.txt'), 'utf8'), 'Existing uncommitted work\n');
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');

  const blocked = await f.request('DELETE', `/sessions/${first.id}?removeWorktree=1`);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  await f.success('DELETE', `/sessions/${first.id}`);
  assert.ok(existsSync(f.shared));
  await f.success('DELETE', `/projects?path=${encodeURIComponent(f.repo)}&removeWorktrees=1`);
  assert.ok(existsSync(f.shared));
  assert.equal(await readFile(path.join(f.shared, 'draft.txt'), 'utf8'), 'Existing uncommitted work\n');
  assert.deepEqual(f.refs(), before);
});

test('selecting an unchecked local branch materializes that branch without creating another ref', async t => {
  const f = await fixture(t);
  const branch = 'agenthub/not-checked-out';
  git(f.repo, 'branch', branch);
  const before = f.refs();
  const originalHead = git(f.repo, 'rev-parse', `refs/heads/${branch}`);
  const session = await f.createSession(branch);
  assert.notEqual(path.resolve(session.cwd), path.resolve(f.repo));
  assert.ok(existsSync(session.cwd));
  assert.equal(git(session.cwd, 'branch', '--show-current'), branch);
  assert.equal(git(session.cwd, 'rev-parse', 'HEAD'), originalHead);
  assert.equal(session.worktree.shared, true);
  assert.deepEqual(f.refs(), before);
  const again = await f.createSession(branch);
  assert.equal(path.resolve(again.cwd), path.resolve(session.cwd));
  assert.deepEqual(f.refs(), before);
});

test('existing work can become one task and later sessions attach to its ownership', async t => {
  const f = await fixture(t);
  const legacy = await f.createSession();
  const before = f.refs();
  const { task, session } = await f.createTask();
  assert.equal(task.branch, f.branch);
  assert.equal(path.resolve(task.cwd), path.resolve(f.shared));
  assert.equal(task.ownsWorktree, false);
  assert.equal(task.ownsBranch, false);
  assert.equal(task.selectedWorkBranch, true);
  assert.ok(task.sessionIds.includes(legacy.id));
  assert.ok(task.sessionIds.includes(session.id));
  assert.equal(session.taskId, task.id);
  assert.equal((await f.success('GET', `/sessions/${legacy.id}`)).taskId, task.id);

  const attached = await f.createSession();
  assert.equal(attached.taskId, task.id);
  assert.equal(path.resolve(attached.cwd), path.resolve(task.cwd));
  const duplicate = await f.request('POST', '/tasks', { ...f.options, title: 'Duplicate task', type: 'feature', workBranch: f.branch });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  const listed = (await f.branches()).find(item => item.name === f.branch);
  assert.equal(listed.taskId, task.id);
  assert.equal(listed.selectableForTask, false);
  assert.equal(listed.selectableForSession, true);
  assert.deepEqual(f.refs(), before);
  assert.equal(await readFile(path.join(f.shared, 'draft.txt'), 'utf8'), 'Existing uncommitted work\n');

  await f.restart();
  const persisted = await f.success('GET', `/tasks?path=${encodeURIComponent(f.repo)}`);
  const restored = persisted.tasks.find(item => item.id === task.id);
  assert.equal(restored.ownsWorktree, false);
  assert.equal(restored.ownsBranch, false);
  assert.ok(restored.sessionIds.includes(legacy.id));
  assert.ok(restored.sessionIds.includes(attached.id));
  assert.equal((await f.createSession()).taskId, task.id);
});

test('tasks own only the folder materialized for an existing unchecked branch', async t => {
  const f = await fixture(t);
  const branch = 'agenthub/task-materialized';
  git(f.repo, 'branch', branch);
  const before = f.refs();
  const { task } = await f.createTask(branch);
  assert.equal(task.branch, branch);
  assert.equal(task.ownsWorktree, true);
  assert.equal(task.ownsBranch, false);
  assert.notEqual(path.resolve(task.cwd), path.resolve(f.repo));
  assert.equal(git(task.cwd, 'branch', '--show-current'), branch);
  assert.deepEqual(f.refs(), before);
});

test('an existing branch task uses the original folder and preserves that branch after restart and removal', async t => {
  const f = await fixture(t);
  const branch = 'feature/in-place';
  git(f.repo, 'branch', branch, 'develop');
  const refs = f.refs();
  const worktrees = git(f.repo, 'worktree', 'list', '--porcelain');
  const requestId = 'existing-original-folder';
  const { task, session } = await f.createTask(branch, { worktree: false, requestId });
  assert.equal(path.resolve(task.cwd), path.resolve(f.repo));
  assert.equal(path.resolve(session.cwd), path.resolve(f.repo));
  assert.equal(task.inPlace, true);
  assert.equal(task.previousBranch, 'main');
  assert.equal(task.selectedWorkBranch, true);
  assert.equal(task.ownsWorktree, false);
  assert.equal(task.ownsBranch, false);
  assert.equal(git(f.repo, 'branch', '--show-current'), branch);
  assert.equal(existsSync(f.repo + '.agenthub'), false);
  assert.deepEqual(f.refs(), refs);

  await f.restart();
  const retry = await f.createTask(branch, { worktree: false, requestId });
  assert.equal(retry.reused, true);
  assert.equal(retry.task.id, task.id);
  assert.equal(retry.session.id, session.id);
  const restored = await f.success('GET', `/sessions/${session.id}`);
  assert.equal(path.resolve(restored.cwd), path.resolve(f.repo));
  assert.equal(restored.taskId, task.id);

  const removed = await f.success('DELETE', `/tasks/${task.id}?branch=delete`);
  assert.equal(removed.worktreeRemoved, false);
  assert.equal(removed.branchRemoved, false);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain'), worktrees);
  assert.deepEqual(f.refs(), refs);
  assert.equal(await readFile(path.join(f.repo, 'README.md'), 'utf8'), 'Existing branch fixture\n');
  assert.equal(await readFile(path.join(f.shared, 'draft.txt'), 'utf8'), 'Existing uncommitted work\n');
});

test('original-folder branch listing enables only the current project folder and revalidates creation', async t => {
  const f = await fixture(t);
  const branch = 'feature/current-source';
  git(f.repo, 'switch', '-c', branch);
  const before = git(f.repo, 'worktree', 'list', '--porcelain');
  const normal = (await f.branches()).find(item => item.name === branch);
  assert.equal(normal.selectableForTask, false);
  const inPlace = await f.success('GET', `/workbranches?path=${encodeURIComponent(f.repo)}&inPlace=true`);
  assert.equal(inPlace.branches.find(item => item.name === branch).selectableForTask, true);
  for (const name of ['main', 'develop', f.branch]) {
    assert.equal(inPlace.branches.find(item => item.name === name).selectableForTask, false, name);
    const rejected = await f.request('POST', '/tasks', {
      ...f.options, title: 'Cannot switch original folder', type: 'feature', workBranch: name, worktree: false,
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  }
  await writeFile(path.join(f.repo, 'unfinished.txt'), 'Keep original work\n');
  const dirty = await f.request('POST', '/tasks', {
    ...f.options, title: 'Keep dirty folder', type: 'feature', workBranch: branch, worktree: false,
  });
  assert.equal(dirty.status, 409, JSON.stringify(dirty.body));
  assert.equal(dirty.body.reason, 'task-dirty');
  assert.equal(await readFile(path.join(f.repo, 'unfinished.txt'), 'utf8'), 'Keep original work\n');
  await rm(path.join(f.repo, 'unfinished.txt'));
  const { task } = await f.createTask(branch, { worktree: false });
  assert.equal(task.inPlace, true);
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain'), before);
  assert.equal(existsSync(f.repo + '.agenthub'), false);
});

test('source, missing, malformed and foreign-only branches cannot be selected', async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, 'foreign-project');
  await mkdir(foreign);
  git(foreign, 'init', '-b', 'main');
  git(foreign, 'config', 'user.name', 'Foreign Test');
  git(foreign, 'config', 'user.email', 'foreign@example.invalid');
  git(foreign, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(foreign, 'foreign.txt'), 'Foreign project\n');
  git(foreign, 'add', '.'); git(foreign, 'commit', '-m', 'Foreign fixture');
  git(foreign, 'branch', 'agenthub/foreign-only');
  const before = f.refs();
  for (const workBranch of ['main', 'develop', 'agenthub/missing', 'agenthub/foreign-only', '../escape', '', { branch: f.branch, cwd: foreign }]) {
    for (const endpoint of ['/sessions', '/tasks']) {
      const result = await f.request('POST', endpoint, { ...f.options, title: 'Rejected selection', type: 'feature', workBranch });
      assert.equal(result.ok, false, `${endpoint} unexpectedly accepted ${JSON.stringify(workBranch)}`);
      assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result.body));
    }
  }
  assert.deepEqual(f.refs(), before);
  assert.equal(await readFile(path.join(f.shared, 'draft.txt'), 'utf8'), 'Existing uncommitted work\n');
  const contradictory = await f.request('POST', '/sessions', { ...f.options, workBranch: f.branch, isolate: true, worktreeName: 'ignored' });
  assert.equal(contradictory.status, 400, JSON.stringify(contradictory.body));
});

test('an existing task owner does not bypass locked worktree selection checks', async t => {
  const f = await fixture(t);
  await f.createTask();
  git(f.repo, 'worktree', 'lock', f.shared);
  const listed = (await f.branches()).find(item => item.name === f.branch);
  assert.equal(listed.locked, true);
  assert.equal(listed.selectableForSession, false);
  const rejected = await f.request('POST', '/sessions', { ...f.options, workBranch: f.branch });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
});

test('a moved selected worktree never falls back to the source branch after restart', async t => {
  const f = await fixture(t);
  const session = await f.createSession();
  const moved = path.join(f.root, 'moved-worktree');
  git(f.repo, 'worktree', 'move', f.shared, moved);
  await f.restart();
  const restored = await f.success('GET', `/sessions/${session.id}`);
  assert.equal(path.resolve(restored.cwd), path.resolve(f.shared));
  assert.equal(path.resolve(restored.worktree.dir), path.resolve(f.shared));
  assert.equal(restored.worktree.shared, true);
  assert.notEqual(path.resolve(restored.cwd), path.resolve(f.repo));
  assert.equal(await readFile(path.join(moved, 'draft.txt'), 'utf8'), 'Existing uncommitted work\n');
  const blocked = await f.request('POST', `/sessions/${session.id}/messages`, { prompt: 'Must not run on main' });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.notEqual(blocked.body.error, 'Workbranch fixture must not launch an agent');
});

test('wrapping a legacy isolated session in a task immediately persists its folder protection', async t => {
  const f = await fixture(t);
  const legacy = await f.success('POST', '/sessions', {
    ...f.options,
    title: 'Legacy isolated session',
    isolate: true,
    worktreeName: 'legacy-durable',
  });
  assert.equal(legacy.worktree.shared, undefined);
  const sessionFile = path.join(f.dataDir, 'sessions', `${legacy.id}.json`);
  const before = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(before.taskId, undefined);
  assert.equal(before.worktree.shared, undefined);
  await writeFile(path.join(legacy.cwd, 'legacy-draft.txt'), 'Preserve legacy work\n');

  const { task } = await f.createTask(legacy.worktree.branch);
  // These ownership fields must be durable when the create response returns,
  // before SessionStore's normal delayed touch flush or a graceful shutdown.
  const persisted = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(persisted.taskId, task.id);
  assert.equal(persisted.worktree.shared, true);
  assert.equal(path.resolve(persisted.cwd), path.resolve(task.cwd));
  assert.ok(task.sessionIds.includes(legacy.id));
  assert.equal(await readFile(path.join(legacy.cwd, 'legacy-draft.txt'), 'utf8'), 'Preserve legacy work\n');
});

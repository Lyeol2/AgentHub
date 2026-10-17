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

async function fixture(t, { mainBranch = 'main', developBranch = 'develop' } = {}) {
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
  git(repo, 'init', '-b', mainBranch);
  configureIdentity(repo);
  await writeFile(path.join(repo, 'README.md'), 'Task API fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'Initial fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', mainBranch);
  git(repo, 'branch', developBranch);
  git(repo, 'push', 'origin', developBranch);
  const mainSha = git(repo, 'rev-parse', 'HEAD');

  // Advance the remote from another checkout, leaving the project's tracking ref stale.
  git(root, 'clone', '--branch', developBranch, origin, writer);
  configureIdentity(writer);
  await writeFile(path.join(writer, 'remote-development.txt'), 'Latest development change\n');
  git(writer, 'add', 'remote-development.txt');
  git(writer, 'commit', '-m', 'Advance remote development');
  git(writer, 'push', 'origin', developBranch);
  const developSha = git(writer, 'rev-parse', 'HEAD');
  assert.notEqual(git(repo, 'rev-parse', `origin/${developBranch}`), developSha);

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
    root, repo, origin, mainSha, developSha, request, success, createTask, tasks,
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

const defaultGitflowSettings = {
  main: 'main', develop: 'develop',
  featurePrefix: 'feature/', hotfixPrefix: 'hotfix/', releasePrefix: 'release/',
};
const customGitflowSettings = {
  main: 'Main', develop: 'Develop',
  featurePrefix: 'Feature/', hotfixPrefix: 'Hotfix/', releasePrefix: 'Release/',
};
const settingsPath = repo => `/tasks/settings?path=${encodeURIComponent(repo)}`;
const gitRefs = repo => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');

test('GitFlow settings preserve case, persist per project, and do not change Git branches', async t => {
  const f = await fixture(t, { mainBranch: 'Main', developBranch: 'Develop' });
  const initial = await f.success('GET', settingsPath(f.repo));
  assert.equal(path.resolve(initial.projectPath), path.resolve(f.repo));
  assert.deepEqual(initial.settings, defaultGitflowSettings);
  const localRefs = gitRefs(f.repo);
  const remoteRefs = gitRefs(f.origin);
  const localConfig = git(f.repo, 'config', '--local', '--list');

  const saved = await f.success('PUT', settingsPath(f.repo), { settings: customGitflowSettings });
  assert.equal(path.resolve(saved.projectPath), path.resolve(f.repo));
  assert.deepEqual(saved.settings, customGitflowSettings);
  assert.equal(gitRefs(f.repo), localRefs);
  assert.equal(gitRefs(f.origin), remoteRefs);
  assert.equal(git(f.repo, 'config', '--local', '--list'), localConfig);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'Main');

  const otherRepo = path.join(f.root, 'other-repository');
  await mkdir(otherRepo);
  git(otherRepo, 'init', '-b', 'main');
  configureIdentity(otherRepo);
  await writeFile(path.join(otherRepo, 'README.md'), 'Other project\n');
  git(otherRepo, 'add', 'README.md');
  git(otherRepo, 'commit', '-m', 'Other fixture');
  const other = await f.success('GET', settingsPath(otherRepo));
  assert.equal(path.resolve(other.projectPath), path.resolve(otherRepo));
  assert.deepEqual(other.settings, defaultGitflowSettings);

  await f.restart();
  assert.deepEqual((await f.success('GET', settingsPath(f.repo))).settings, customGitflowSettings);
  assert.deepEqual((await f.success('GET', settingsPath(otherRepo))).settings, defaultGitflowSettings);
  assert.equal(gitRefs(f.repo), localRefs);
  assert.equal(gitRefs(f.origin), remoteRefs);
});

test('custom GitFlow branch names guide context and all new task types without rewriting existing tasks', async t => {
  const f = await fixture(t, { mainBranch: 'Main', developBranch: 'Develop' });
  await f.success('PUT', settingsPath(f.repo), { settings: customGitflowSettings });
  const context = await f.success('GET', `/tasks/context?path=${encodeURIComponent(f.repo)}`);
  assert.equal(context.mainSha, f.mainSha);
  assert.equal(context.developSha, f.developSha);
  assert.equal(context.mainInDevelop, true);
  const definitions = [
    { type: 'feature', title: 'Custom feature', base: 'Develop', target: 'Develop', prefix: 'Feature/', sha: f.developSha },
    { type: 'hotfix', title: 'Custom fix', base: 'Main', target: 'Main', prefix: 'Hotfix/', sha: f.mainSha },
    { type: 'release', title: '2.3.4', base: 'Develop', target: 'Main', prefix: 'Release/', sha: f.developSha },
  ];
  const snapshots = [];
  for (const definition of definitions) {
    const { task, session } = await f.createTask(definition.type, definition.title);
    assert.equal(task.baseBranch, definition.base);
    assert.equal(task.targetBranch, definition.target);
    assert.ok(task.branch.startsWith(definition.prefix), task.branch);
    if (definition.type === 'release') assert.equal(task.branch, 'Release/2.3.4');
    assert.equal(task.baseCommit, definition.sha);
    assert.equal(git(task.cwd, 'rev-parse', 'HEAD'), definition.sha);
    assert.equal(git(task.cwd, 'branch', '--show-current'), task.branch);
    assert.equal(path.resolve(session.cwd), path.resolve(task.cwd));
    snapshots.push({ id: task.id, branch: task.branch, baseBranch: task.baseBranch, targetBranch: task.targetBranch, baseCommit: task.baseCommit });
  }
  const changed = {
    main: 'NextMain', develop: 'NextDevelop',
    featurePrefix: 'NextFeature/', hotfixPrefix: 'NextHotfix/', releasePrefix: 'NextRelease/',
  };
  await f.success('PUT', settingsPath(f.repo), { settings: changed });
  await f.restart();
  assert.deepEqual((await f.success('GET', settingsPath(f.repo))).settings, changed);
  const tasks = await f.tasks();
  for (const snapshot of snapshots) {
    const task = tasks.find(item => item.id === snapshot.id);
    assert.ok(task);
    assert.deepEqual(Object.fromEntries(Object.keys(snapshot).map(key => [key, task[key]])), snapshot);
    assert.equal(git(task.cwd, 'branch', '--show-current'), snapshot.branch);
  }
  assert.equal(git(f.repo, 'branch', '--show-current'), 'Main');
  assert.equal(await readFile(path.join(f.repo, 'README.md'), 'utf8'), 'Task API fixture\n');
});

test('invalid GitFlow settings return 400 without changing saved settings or Git refs', async t => {
  const f = await fixture(t);
  const settings = { ...defaultGitflowSettings, featurePrefix: 'Feature/' };
  await f.success('PUT', settingsPath(f.repo), { settings });
  const localRefs = gitRefs(f.repo);
  const remoteRefs = gitRefs(f.origin);
  const invalid = [
    { ...settings, main: '../bad' },
    { ...settings, main: '' },
    { ...settings, develop: '' },
    { ...settings, main: settings.develop },
    { ...settings, featurePrefix: '../bad/' },
    { ...settings, hotfixPrefix: '' },
    { ...settings, releasePrefix: 'bad prefix/' },
  ];
  for (const value of invalid) {
    const response = await f.request('PUT', settingsPath(f.repo), { settings: value });
    assert.equal(response.status, 400, JSON.stringify({ value, response }));
    assert.deepEqual((await f.success('GET', settingsPath(f.repo))).settings, settings);
  }
  assert.equal(gitRefs(f.repo), localRefs);
  assert.equal(gitRefs(f.origin), remoteRefs);
  await f.restart();
  assert.deepEqual((await f.success('GET', settingsPath(f.repo))).settings, settings);
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

test('tasks can be created with a custom branch name and worktree folder name', async t => {
  const f = await fixture(t);
  const { task } = await f.success('POST', '/tasks', {
    projectPath: f.repo, title: 'Named task', type: 'feature', branchName: 'login-button', worktreeName: 'login-work',
    agent: 'codex', permission: 'workspace-write',
  });
  assert.equal(task.branch, 'feature/login-button');
  assert.equal(path.basename(task.cwd), 'login-work');
  assert.equal(git(task.cwd, 'branch', '--show-current'), 'feature/login-button');

  const duplicateFolder = await f.request('POST', '/tasks', {
    projectPath: f.repo, title: 'Same folder', type: 'feature', worktreeName: 'login-work', agent: 'codex', permission: 'workspace-write',
  });
  assert.equal(duplicateFolder.status, 409, JSON.stringify(duplicateFolder.body));
  const duplicateBranch = await f.request('POST', '/tasks', {
    projectPath: f.repo, title: 'Same branch', type: 'feature', branchName: 'login-button', agent: 'codex', permission: 'workspace-write',
  });
  assert.equal(duplicateBranch.status, 409, JSON.stringify(duplicateBranch.body));
  for (const body of [{ branchName: 'bad..name' }, { worktreeName: '../escape' }, { worktreeName: 'x', worktree: false }]) {
    const invalid = await f.request('POST', '/tasks', { projectPath: f.repo, title: 'Invalid', type: 'feature', agent: 'codex', permission: 'workspace-write', ...body });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  }
  assert.equal((await f.tasks()).length, 1);
});

test('deleting a task removes its sessions, worktree, record and optionally its local branch', async t => {
  const f = await fixture(t);
  const { task, session } = await f.createTask('feature', 'Delete me');
  await writeFile(path.join(task.cwd, 'unfinished.txt'), 'Uncommitted\n');
  const dirty = await f.request('DELETE', `/tasks/${task.id}`);
  assert.equal(dirty.status, 409, JSON.stringify(dirty.body));
  assert.equal(dirty.body.reason, 'task-dirty');
  assert.ok(existsSync(task.cwd));
  assert.ok((await f.success('GET', '/sessions')).some(item => item.id === session.id));

  const removed = await f.success('DELETE', `/tasks/${task.id}?force=1&branch=delete`);
  assert.deepEqual(removed.sessionIds, [session.id]);
  assert.equal(removed.worktreeRemoved, true);
  assert.equal(removed.branchRemoved, true);
  assert.equal(existsSync(task.cwd), false);
  assert.equal(git(f.repo, 'branch', '--list', task.branch), '');
  assert.equal((await f.success('GET', '/sessions')).some(item => item.id === session.id), false);
  assert.deepEqual(await f.tasks(), []);
  await f.restart();
  assert.deepEqual(await f.tasks(), []);

  const kept = (await f.createTask('feature', 'Keep branch')).task;
  await f.success('DELETE', `/tasks/${kept.id}`);
  assert.equal(existsSync(kept.cwd), false);
  assert.equal(git(f.repo, 'branch', '--list', kept.branch).replace(/^[*+ ]+/, ''), kept.branch);
  assert.equal((await f.request('DELETE', `/tasks/${kept.id}`)).status, 404);
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

test('tasks without a branch name get a tidy branch from the title and avoid existing branches', async t => {
  const f = await fixture(t);
  const first = (await f.createTask('feature', 'Login 버튼 수정!')).task;
  assert.equal(first.branch, 'feature/login-버튼-수정');
  const second = (await f.createTask('feature', 'login  버튼 -- 수정')).task;
  assert.equal(second.branch, 'feature/login-버튼-수정-2');
  // 원격에만 있는 같은 이름도 피한다.
  git(f.repo, 'push', 'origin', `${f.mainSha}:refs/heads/feature/remote-taken`);
  git(f.repo, 'fetch', 'origin');
  const third = (await f.createTask('feature', 'Remote taken')).task;
  assert.equal(third.branch, 'feature/remote-taken-2');
  assert.equal(git(third.cwd, 'branch', '--show-current'), 'feature/remote-taken-2');
  const hotfix = (await f.createTask('hotfix', '!!!')).task;
  assert.equal(hotfix.branch, 'hotfix/work');
});

test('abandoning a task removes its sessions, worktree, local branch, pushed remote branch and record', async t => {
  const f = await fixture(t);
  const { task, session } = await f.createTask('feature', 'Give up');
  await writeFile(path.join(task.cwd, 'work.txt'), 'Committed work\n');
  git(task.cwd, 'add', 'work.txt');
  configureIdentity(task.cwd);
  git(task.cwd, 'commit', '-m', 'Work in progress');
  git(task.cwd, 'push', 'origin', task.branch);
  assert.match(git(f.origin, 'branch', '--list', task.branch), /give-up/);

  await writeFile(path.join(task.cwd, 'unsaved.txt'), 'Uncommitted\n');
  const dirty = await f.request('POST', `/tasks/${task.id}/abandon`, {});
  assert.equal(dirty.status, 409, JSON.stringify(dirty.body));
  assert.equal(dirty.body.reason, 'task-dirty');
  assert.ok(existsSync(task.cwd));
  assert.match(git(f.origin, 'branch', '--list', task.branch), /give-up/, 'a refused abandon leaves the remote branch alone');

  const result = await f.success('POST', `/tasks/${task.id}/abandon`, { force: true });
  assert.equal(result.remoteBranchRemoved, true);
  assert.equal(result.branchRemoved, true);
  assert.equal(result.worktreeRemoved, true);
  assert.deepEqual(result.sessionIds, [session.id]);
  assert.equal(existsSync(task.cwd), false);
  assert.equal(git(f.repo, 'branch', '--list', task.branch), '');
  assert.equal(git(f.origin, 'branch', '--list', task.branch), '');
  assert.equal((await f.success('GET', '/sessions')).some(item => item.id === session.id), false);
  assert.deepEqual(await f.tasks(), []);

  // 게시하지 않은 작업도 그만둘 수 있고, 원격에는 아무것도 하지 않는다.
  const local = (await f.createTask('feature', 'Never pushed')).task;
  const quiet = await f.success('POST', `/tasks/${local.id}/abandon`, {});
  assert.equal(quiet.remoteBranchRemoved, false);
  assert.equal(git(f.repo, 'branch', '--list', local.branch), '');
  assert.equal((await f.request('POST', `/tasks/${local.id}/abandon`, {})).status, 404);
});

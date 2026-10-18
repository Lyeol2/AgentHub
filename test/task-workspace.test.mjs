import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskService } from "../server/application/tasks.mjs";
import { unityEditorCandidates, findUnityEditor, unityProject, copyFolder, REUSE_NAME } from "../server/task-workspace.mjs";
import { validTaskWorktreeName } from "../server/tasks.mjs";

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete gitEnv[key];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function temp(t, prefix = "agenthub-task-workspace-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

// unity면 ProjectVersion.txt와 Library/ 무시 규칙을 넣은 유니티 프로젝트 모양 저장소를 만든다.
function harness(t, { unity = false, tools = {} } = {}) {
  const root = temp(t);
  const repo = path.join(root, "repo"), remote = path.join(root, "origin.git");
  fs.mkdirSync(repo);
  git(root, "init", "--bare", "-q", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Workspace Test");
  git(repo, "config", "user.email", "workspace@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  if (unity) {
    fs.mkdirSync(path.join(repo, "ProjectSettings"));
    fs.writeFileSync(path.join(repo, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3.10f1\nm_EditorVersionWithRevision: 2022.3.10f1 (abc)\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), "/Library/\n");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "branch", "develop");
  git(repo, "push", "-q", "origin", "develop");
  const stored = new Map(); let serial = 0;
  const running = new Set();
  const store = { list: () => [...stored.values()], get: id => stored.get(id) };
  const sessions = { checkSessionOptions() {}, async createSession(body, internal) {
    const session = { id: `session-${++serial}`, projectPath: body.project.path, cwd: internal.worktree.dir, taskId: internal.taskId, worktree: internal.worktree };
    stored.set(session.id, session); return session;
  }, async remove(id) { stored.delete(id); } };
  const options = { dataDir: path.join(root, "data"), store, config: {}, runner: { isRunning: id => running.has(id) }, sessions,
    projects: { ensureProject: projectPath => ({ name: "repo", path: projectPath }) }, workspaceTools: tools };
  let service = createTaskService(options);
  return { root, repo, store: stored, running, worktrees: path.join(root, "repo.agenthub"),
    get service() { return service; }, restart() { service = createTaskService(options); return service; },
    create: (extra = {}) => service.create({ projectPath: repo, title: "작업", agent: "codex", session: false, ...extra }) };
}

const commitIn = (dir, file, text) => { fs.writeFileSync(path.join(dir, file), text); git(dir, "add", file); git(dir, "commit", "-qm", `edit ${file}`); return git(dir, "rev-parse", "HEAD"); };
async function until(check, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw Error("timed out"); await new Promise(resolve => setTimeout(resolve, 50)); }
}

test("preview: a worktree task's HEAD is shown in the original folder and the original branch comes back", async t => {
  const f = harness(t);
  git(f.repo, "switch", "-q", "develop");
  const { task } = await f.create({ title: "결과 확인" });
  const first = commitIn(task.cwd, "result.txt", "v1\n");
  // 커밋하지 않은 작업 폴더 변경은 포함되지 않고 그렇다고 알린다.
  fs.writeFileSync(path.join(task.cwd, "draft.txt"), "draft\n");
  const { preview } = await f.service.startPreview(task.id);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), first);
  assert.equal(fs.readFileSync(path.join(f.repo, "result.txt"), "utf8").trim(), "v1");
  assert.ok(!fs.existsSync(path.join(f.repo, "draft.txt")));
  assert.equal(preview.taskId, task.id);
  assert.equal(preview.originalBranch, "develop");
  assert.equal(preview.taskUncommitted, true);
  assert.equal(preview.outdated, false);
  // 확인하는 동안 원본 폴더에서 새 작업을 시작하지 않는다.
  assert.equal((await f.service.inPlaceStatus(f.repo)).available, false);
  // 서버를 다시 켜도 확인 상태를 기억한다.
  f.restart();
  const second = commitIn(task.cwd, "result.txt", "v2\n");
  let status = (await f.service.previewStatus(f.repo)).preview;
  assert.equal(status.head, first);
  assert.equal(status.outdated, true);
  assert.equal(status.taskHead, second);
  // 최신 결과로 다시 보기
  status = (await f.service.startPreview(task.id)).preview;
  assert.equal(git(f.repo, "rev-parse", "HEAD"), second);
  assert.equal(status.originalBranch, "develop");
  // 확인 중에 원본에 변경이 생기면 돌아가지 않고 알린다.
  fs.writeFileSync(path.join(f.repo, "README.md"), "changed by editor\n");
  await assert.rejects(f.service.endPreview(f.repo), error => error.reason === "task-preview-dirty" && /README\.md/.test(error.hint));
  await assert.rejects(f.service.startPreview(task.id), error => error.reason === "task-dirty");
  git(f.repo, "checkout", "--", "README.md");
  assert.deepEqual(await f.service.endPreview(f.repo), { preview: null });
  assert.equal(git(f.repo, "symbolic-ref", "--short", "HEAD"), "develop");
  assert.equal((await f.service.previewStatus(f.repo)).preview, null);
  assert.equal((await f.service.inPlaceStatus(f.repo)).available, true);
});

test("preview: blocked by uncommitted original changes, an in-place task or a running session there", async t => {
  const f = harness(t);
  const { task } = await f.create();
  fs.writeFileSync(path.join(f.repo, "README.md"), "dirty\n");
  await assert.rejects(f.service.startPreview(task.id), error => error.reason === "task-dirty");
  git(f.repo, "checkout", "--", "README.md");
  f.store.set("raw", { id: "raw", cwd: f.repo, projectPath: f.repo });
  f.running.add("raw");
  await assert.rejects(f.service.startPreview(task.id), error => error.reason === "running");
  f.running.clear();
  const { task: inPlace } = await f.create({ title: "원본 작업", worktree: false });
  await assert.rejects(f.service.startPreview(task.id), error => error.reason === "task-in-place");
  await assert.rejects(f.service.startPreview(inPlace.id), error => error.reason === "task-preview-in-place");
});

test("preview: ending after the user switched the original folder leaves it as is", async t => {
  const f = harness(t);
  const { task } = await f.create();
  await f.service.startPreview(task.id);
  git(f.repo, "switch", "-q", "main");
  const result = await f.service.endPreview(f.repo);
  assert.equal(result.preview, null);
  assert.match(result.note, /main/);
  assert.equal(git(f.repo, "symbolic-ref", "--short", "HEAD"), "main");
});

test("reuse: a Unity task folder is parked on delete and reused with its ignored Library for the next task", async t => {
  const f = harness(t, { unity: true });
  const { task } = await f.create({ title: "첫 작업", copyLibrary: false });
  fs.mkdirSync(path.join(task.cwd, "Library"));
  fs.writeFileSync(path.join(task.cwd, "Library", "imported.bin"), "cache");
  assert.equal((await f.service.workspace(f.repo)).settings.reuse, true);
  const removed = await f.service.remove(task.id, { deleteBranch: true });
  assert.ok(removed.parked && REUSE_NAME.test(path.basename(removed.parked)));
  assert.ok(!fs.existsSync(task.cwd));
  let info = await f.service.workspace(f.repo);
  assert.equal(info.pool.length, 1);
  assert.equal(info.pool[0].clean, true);
  assert.equal(validTaskWorktreeName(info.pool[0].name), false);
  const { task: next } = await f.create({ title: "다음 작업", worktreeName: "다음" });
  assert.equal(path.basename(next.cwd), "다음");
  assert.ok(next.reusedWorktree);
  assert.equal(fs.readFileSync(path.join(next.cwd, "Library", "imported.bin"), "utf8"), "cache");
  assert.equal(git(next.cwd, "symbolic-ref", "--short", "HEAD"), next.branch);
  assert.equal(git(next.cwd, "status", "--porcelain"), "");
  info = await f.service.workspace(f.repo);
  assert.equal(info.pool.length, 0);
});

test("reuse: dirty parked folders are skipped and can be deleted from the list; non-Unity projects delete folders", async t => {
  const f = harness(t, { unity: true });
  const { task } = await f.create({ copyLibrary: false });
  const { parked } = await f.service.remove(task.id, { deleteBranch: true });
  fs.writeFileSync(path.join(parked, "README.md"), "edited while parked\n");
  const { task: next } = await f.create({ title: "새로", copyLibrary: false });
  assert.equal(next.reusedWorktree, undefined);
  assert.equal((await f.service.workspace(f.repo)).pool[0].clean, false);
  await assert.rejects(f.service.removeReuse(f.repo, "../repo"), error => error.reason === "task-reuse-name");
  await f.service.removeReuse(f.repo, path.basename(parked));
  assert.ok(!fs.existsSync(parked));
  assert.equal((await f.service.workspace(f.repo)).pool.length, 0);

  const plain = harness(t);
  assert.equal((await plain.service.workspace(plain.repo)).settings.reuse, false);
  const { task: other } = await plain.create();
  const result = await plain.service.remove(other.id, {});
  assert.equal(result.parked, undefined);
  assert.equal((await plain.service.workspace(plain.repo)).pool.length, 0);
  await plain.service.updateWorkspace(plain.repo, { reuse: true });
  assert.equal((await plain.service.workspace(plain.repo)).settings.reuse, true);
  await assert.rejects(plain.service.updateWorkspace(plain.repo, { reuse: "yes" }), error => error.status === 400);
});

test("library copy: a new Unity worktree copies the original Library in the background unless turned off", async t => {
  const f = harness(t, { unity: true });
  fs.mkdirSync(path.join(f.repo, "Library", "Artifacts"), { recursive: true });
  fs.writeFileSync(path.join(f.repo, "Library", "Artifacts", "a.bin"), Buffer.alloc(4096, 1));
  const info = await f.service.workspace(f.repo, { library: true });
  assert.equal(info.library.bytes, 4096);
  const { task } = await f.create({ title: "복사" });
  await until(() => f.service.get(task.id).libraryCopy?.state === "done");
  assert.equal(fs.statSync(path.join(task.cwd, "Library", "Artifacts", "a.bin")).size, 4096);
  assert.equal(git(task.cwd, "status", "--porcelain"), "");
  const { task: skipped } = await f.create({ title: "복사 안 함", copyLibrary: false });
  assert.equal(skipped.libraryCopy, undefined);
  assert.ok(!fs.existsSync(path.join(skipped.cwd, "Library")));
});

test("library copy: copyFolder copies nested files without overwriting and reports progress", async t => {
  const root = temp(t);
  const from = path.join(root, "from"), to = path.join(root, "to");
  fs.mkdirSync(path.join(from, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(from, "a", "b", "x.bin"), Buffer.alloc(100));
  fs.writeFileSync(path.join(from, "y.bin"), Buffer.alloc(50));
  fs.mkdirSync(to); fs.writeFileSync(path.join(to, "y.bin"), "keep");
  for (const platform of [process.platform, "linux"]) {
    let seen = 0;
    await copyFolder(from, to, { platform, onProgress: bytes => { seen = bytes; } }).promise;
    assert.equal(fs.statSync(path.join(to, "a", "b", "x.bin")).size, 100);
    assert.equal(fs.readFileSync(path.join(to, "y.bin"), "utf8"), "keep");
    assert.ok(seen >= 0);
  }
});

test("open: folder and Unity editor launch only for the task folder; Unity is hidden without an editor", async t => {
  const calls = [];
  let editor = null;
  const f = harness(t, { unity: true, tools: {
    openFolder: async dir => { calls.push(["folder", dir]); },
    openUnity: async (exe, dir) => { calls.push(["unity", exe, dir]); },
    findUnityEditor: version => editor && `${editor}/${version}`,
  } });
  const { task } = await f.create({ copyLibrary: false });
  assert.deepEqual((await f.service.workspace(f.repo)).unity, { version: "2022.3.10f1", editor: false });
  await assert.rejects(f.service.openTask(task.id, "unity"), error => error.reason === "task-unity-missing");
  editor = "C:/Unity";
  assert.equal((await f.service.workspace(f.repo)).unity.editor, true);
  await f.service.openTask(task.id, "folder");
  await f.service.openTask(task.id, "unity");
  assert.ok(same(calls[0][1], task.cwd));
  assert.deepEqual(calls[1].slice(0, 2), ["unity", "C:/Unity/2022.3.10f1"]);
  await assert.rejects(f.service.openTask(task.id, "shell"), error => error.status === 400);
});

test("unity editor discovery reads Unity Hub locations", t => {
  const root = temp(t);
  const appData = path.join(root, "AppData"), hub = path.join(appData, "UnityHub");
  fs.mkdirSync(hub, { recursive: true });
  const listed = path.join(root, "Custom", "Unity.exe");
  fs.writeFileSync(path.join(hub, "editors-v2.json"), JSON.stringify({ data: [{ version: "6000.0.1f1", location: [listed] }] }));
  fs.writeFileSync(path.join(hub, "secondaryInstallPath.json"), JSON.stringify(path.join(root, "Editors")));
  const env = { APPDATA: appData, ProgramFiles: path.join(root, "PF") };
  const candidates = unityEditorCandidates("6000.0.1f1", { env, platform: "win32" });
  assert.equal(candidates[0], listed);
  assert.ok(candidates.includes(path.join(root, "Editors", "6000.0.1f1", "Editor", "Unity.exe")));
  assert.ok(candidates.includes(path.join(root, "PF", "Unity", "Hub", "Editor", "6000.0.1f1", "Editor", "Unity.exe")));
  assert.deepEqual(unityEditorCandidates("../x", { env, platform: "win32" }), []);
  assert.equal(findUnityEditor("6000.0.1f1", { env, platform: "win32", exists: file => file === listed }), listed);
  assert.equal(unityProject(root), null);
});

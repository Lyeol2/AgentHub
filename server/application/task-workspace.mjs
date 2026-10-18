import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.mjs";
import { readJsonFile, writeJsonAtomic } from "../infrastructure/persistence/json-file.mjs";
import { taskGit, taskRepo, taskRef, taskDirty, assertTaskWorktree, assertTaskGitIdle, taskWorktreeLocation, sameTaskPath, insideTaskPath, removeWorktreeDir } from "../tasks.mjs";
import { gitflowSettingsKey } from "../gitflow-settings.mjs";
import * as defaults from "../task-workspace.mjs";

const now = () => new Date().toISOString();
const MAX_REUSE = 3; // 저장소마다 남겨 둘 재사용 대기 폴더 수. 넘으면 정리하는 폴더는 지운다.
const SIZE_CACHE_MS = 10 * 60_000;
// 원본 폴더. <프로젝트>/.git을 쓰는 보통 저장소는 그 위 폴더, 아니면 Git이 알려 준 최상위 폴더다.
const sourceDir = (repo) => path.basename(repo.common).toLowerCase() === ".git" ? path.dirname(repo.common) : repo.top;
const repoKey = (common) => path.resolve(common).toLowerCase();
const symbolic = (dir) => taskGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim() || null, (error) => {
  if (error.reason === "git-timeout") throw error;
  return null;
});
async function changedFiles(dir) {
  const lines = (await taskGit(dir, ["status", "--porcelain=v1", "--untracked-files=all"])).split(/\r?\n/).filter(Boolean);
  return lines.slice(0, 10).map((line) => line.slice(3)).concat(lines.length > 10 ? [`외 ${lines.length - 10}개`] : []);
}

// 작업 폴더의 확인·재사용을 맡는다. 원본 폴더에서 작업 결과 확인(미리 보기), 재사용 대기 폴더, 유니티 Library 복사, 폴더·유니티 열기.
// records·get·save·locked는 작업 서비스의 것을 그대로 쓴다.
export function createTaskWorkspace({ dataDir, config, saveConfig = () => {}, store, runner, records, get, save, locked, notify = () => {}, tools = {} }) {
  const t = { ...defaults, ...tools };
  const previewFile = path.join(dataDir, "task-preview.json");
  const previews = new Map(Object.entries(readJsonFile(previewFile, { dataDir, fallback: () => ({}), valid: (value) => value !== null && typeof value === "object" })?.previews ?? {}));
  const savePreviews = () => writeJsonAtomic(previewFile, { previews: Object.fromEntries(previews) });
  const copies = new Map(); // 작업 ID → { state, total, copied, job, ... }
  const sizes = new Map(); // Library 경로 → { bytes, at, pending }
  // 서버가 꺼지면 복사도 멈춘다. 다시 켜졌을 때 복사 중으로 남은 작업은 중단으로 표시한다.
  for (const task of records.values()) {
    if (task.libraryCopy?.state !== "copying") continue;
    task.libraryCopy = { ...task.libraryCopy, state: "failed", error: "AgentHub가 다시 시작되어 Library 복사가 중단되었습니다. 유니티가 열 때 다시 임포트합니다.", finishedAt: now() };
    save(task);
  }

  function settingsFor(projectPath, unity = t.unityProject(projectPath)) {
    const saved = config.taskWorkspace?.[gitflowSettingsKey(projectPath)] ?? {};
    return { reuse: typeof saved.reuse === "boolean" ? saved.reuse : !!unity, copyLibrary: typeof saved.copyLibrary === "boolean" ? saved.copyLibrary : true };
  }
  async function updateSettings(projectPath, body = {}) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    for (const key of ["reuse", "copyLibrary"]) if (body[key] !== undefined && typeof body[key] !== "boolean") throw new HttpError(400, "작업 폴더 설정 값이 올바르지 않습니다.", "task-workspace-settings");
    const repo = await taskRepo(projectPath);
    return locked("gitflow-settings", async () => {
      const key = gitflowSettingsKey(repo.top), previous = config.taskWorkspace;
      const value = { ...settingsFor(repo.top), ...Object.fromEntries(["reuse", "copyLibrary"].filter((name) => body[name] !== undefined).map((name) => [name, body[name]])) };
      config.taskWorkspace = { ...previous, [key]: value };
      try { await saveConfig(config); }
      catch (error) { if (previous === undefined) delete config.taskWorkspace; else config.taskWorkspace = previous; throw error; }
      notify("tasks", { projectPath: repo.top });
      return { projectPath: repo.top, settings: value };
    });
  }

  // ── Library 크기와 복사 ──
  function librarySize(dir) {
    const cached = sizes.get(dir);
    if (cached?.pending) return cached.pending;
    if (cached && Date.now() - cached.at < SIZE_CACHE_MS) return Promise.resolve(cached.bytes);
    const pending = t.folderSize(dir).then((bytes) => { sizes.set(dir, { bytes, at: Date.now() }); return bytes; }, () => { sizes.delete(dir); return null; });
    sizes.set(dir, { ...cached, pending });
    return pending;
  }
  const copyView = (id) => { const copy = copies.get(id); return copy ? { state: copy.state, total: copy.total, copied: copy.copied, startedAt: copy.startedAt } : null; };
  // 새 작업 폴더에 원본의 Library를 백그라운드로 복사한다. 실패해도 작업은 그대로 쓸 수 있다(유니티가 다시 임포트한다).
  async function startLibraryCopy(task, source) {
    const from = path.join(source, "Library"), to = path.join(task.cwd, "Library");
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    // Library를 Git이 무시하지 않으면 복사한 파일이 작업 변경으로 잡히므로 복사하지 않는다.
    try { await taskGit(task.cwd, ["check-ignore", "-q", "Library/"]); }
    catch { task.libraryCopy = { state: "skipped", error: "Library 폴더가 .gitignore에 없어 복사하지 않았습니다.", finishedAt: now() }; save(task); return; }
    const copy = { state: "sizing", total: null, copied: 0, startedAt: now() };
    copies.set(task.id, copy);
    task.libraryCopy = { state: "copying", startedAt: copy.startedAt };
    save(task);
    copy.done = (async () => {
      try {
        copy.total = await librarySize(from);
        if (copy.cancelled) throw Object.assign(Error("복사를 멈췄습니다."), { cancelled: true });
        copy.state = "copying";
        copy.job = t.copyFolder(from, to, { onProgress: (bytes) => { copy.copied = bytes; } });
        await copy.job.promise;
        copy.state = "done";
      } catch (error) {
        copy.state = copy.cancelled || error.cancelled ? "cancelled" : "failed";
        copy.error = error.message;
        await fs.promises.rm(to, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      } finally {
        copies.delete(task.id);
        const current = records.get(task.id);
        if (current) {
          current.libraryCopy = { state: copy.state, total: copy.total, copied: copy.copied, startedAt: copy.startedAt, finishedAt: now(),
            ...(copy.state === "failed" ? { error: `Library를 복사하지 못했습니다. 유니티가 열 때 다시 임포트합니다: ${copy.error}` } : {}) };
          if (current.state !== "cleaned" || copy.state !== "cancelled") save(current);
        }
      }
    })();
  }
  // 작업 폴더를 옮기거나 지우기 전에 진행 중인 복사를 멈춘다.
  async function stopCopy(id) {
    const copy = copies.get(id);
    if (!copy) return;
    copy.cancelled = true;
    await copy.job?.cancel();
    await copy.done;
  }

  // ── 재사용 대기 폴더 ──
  const taskRoot = (task) => taskWorktreeLocation({ common: task.gitCommonDir, top: task.projectPath }, task.id, task.worktreeName).root;
  async function reuseFolders(projectPath, root) {
    const folders = await t.listReuseFolders(projectPath, root);
    return Promise.all(folders.map(async (folder) => ({ ...folder, clean: await t.reuseFolderClean(folder) })));
  }
  // 새 작업 폴더를 재사용 대기 폴더로 준비한다. 쓸 수 있는 폴더가 없거나 옮기지 못하면 false를 돌려준다(호출한 쪽이 새로 만든다).
  async function takeReuse(task, repo, location) {
    if (!settingsFor(repo.top).reuse) return false;
    let folders;
    try { folders = await reuseFolders(task.projectPath, location.root); } catch { return false; }
    for (const folder of folders.reverse().filter((item) => item.clean)) {
      try { await t.reuseWorktree(task.projectPath, folder, task.cwd, task.branch, task.baseCommit); task.reusedWorktree = { from: folder.name, at: now() }; return true; }
      catch (error) { if (error.outcomeUnknown) throw error; }
    }
    return false;
  }
  // 정리하는 작업 폴더를 지우지 않고 재사용 대기 폴더로 남긴다. 남겼으면 true.
  async function park(task) {
    if (task.inPlace || task.selectedWorkBranch || task.folderLeft || !fs.existsSync(task.cwd) || !settingsFor(task.projectPath).reuse) return false;
    await stopCopy(task.id);
    const root = taskRoot(task);
    if (!sameTaskPath(path.dirname(task.cwd), root)) return false;
    try { if ((await t.listReuseFolders(task.projectPath, root)).length >= MAX_REUSE) return false; } catch { return false; }
    const parked = await t.parkWorktree(task.projectPath, task.cwd, root, task.branch).catch(() => null);
    if (!parked) return false;
    task.parkedWorktree = parked;
    return true;
  }
  async function removeReuse(projectPath, name) {
    if (typeof name !== "string" || !t.REUSE_NAME.test(name)) throw new HttpError(400, "재사용 대기 폴더 이름이 올바르지 않습니다.", "task-reuse-name");
    const repo = await taskRepo(projectPath);
    const root = taskWorktreeLocation(repo, "x").root;
    return locked(repo.common, async () => {
      const dir = path.join(root, name);
      if (!fs.existsSync(dir)) return { removed: true };
      const result = await removeWorktreeDir(repo.top, dir, { force: true });
      if (!result.removed) throw new HttpError(409, `재사용 대기 폴더를 지우지 못했습니다. 그 폴더를 연 유니티·편집기·탐색기를 닫고 다시 시도하세요.\n${result.error?.message ?? ""}`.trim(), "task-worktree-locked");
      notify("tasks", { projectPath: repo.top });
      return { removed: true };
    });
  }

  // ── 원본 폴더에서 작업 결과 확인 ──
  const inPlaceTask = (common) => [...records.values()].find((task) => task.inPlace && task.state !== "cleaned" && sameTaskPath(task.gitCommonDir, common));
  const previewActive = (common) => previews.get(repoKey(common)) ?? null;
  async function describe(entry) {
    const task = records.get(entry.taskId);
    const [head, branch, dirty] = await Promise.all([taskRef(entry.projectPath, "HEAD"), symbolic(entry.projectPath), taskDirty({ cwd: entry.projectPath }).catch(() => null)]);
    const live = task && task.state !== "cleaned" && fs.existsSync(task.cwd);
    const [taskHead, taskUncommitted] = live ? await Promise.all([taskRef(task.cwd, "HEAD"), taskDirty(task).catch(() => null)]) : [null, null];
    const { key, ...rest } = entry;
    return { ...rest, current: { head, branch }, moved: !!branch || head !== entry.head, dirty, taskMissing: !live, taskHead,
      outdated: !!taskHead && taskHead !== entry.head, taskUncommitted: !!taskUncommitted };
  }
  async function previewStatus(projectPath) {
    const repo = await taskRepo(projectPath);
    const entry = previewActive(repo.common);
    return { preview: entry ? await describe(entry) : null };
  }
  // 작업 폴더의 지금 커밋을 원본 폴더에 브랜치 없이(detached) 꺼내 열려 있는 유니티·편집기에서 바로 보게 한다.
  // 다른 작업을 보는 중이면 그 작업에서 바꿔 보고, 같은 작업이면 최신 결과로 다시 본다. 원래 브랜치는 처음 시작할 때 한 번만 기억한다.
  async function startPreview(id) {
    const task = get(id);
    if (task.inPlace) throw new HttpError(400, "원본 폴더에서 하는 작업은 이미 원본 폴더에 결과가 있습니다.", "task-preview-in-place");
    if (task.state === "cleaned" || !fs.existsSync(task.cwd)) throw new HttpError(409, "작업 폴더가 없어 원본 폴더에서 확인할 수 없습니다.", "task-worktree");
    return locked(task.gitCommonDir, async () => {
      const head = await assertTaskWorktree(task);
      if (!head) throw new HttpError(409, "작업 폴더의 커밋을 확인할 수 없습니다.", "task-worktree");
      const repo = { common: task.gitCommonDir, top: task.projectPath };
      const source = sourceDir(repo), key = repoKey(task.gitCommonDir);
      const other = inPlaceTask(task.gitCommonDir);
      if (other) throw new HttpError(409, `원본 폴더는 "${other.title}" 작업에서 쓰고 있습니다. 그 작업을 정리한 뒤 확인하세요.`, "task-in-place");
      if (store.list().some((session) => runner.isRunning(session.id) && insideTaskPath(session.cwd, source)))
        throw new HttpError(409, "원본 폴더에서 실행 중인 세션이 있습니다. 세션이 끝난 뒤 확인하세요.", "running");
      await assertTaskGitIdle({ cwd: source });
      const [currentHead, currentBranch] = await Promise.all([taskRef(source, "HEAD"), symbolic(source)]);
      const previous = previews.get(key);
      const continuing = previous && !currentBranch && currentHead === previous.head;
      if (await taskDirty({ cwd: source })) throw new HttpError(409, continuing
        ? "확인하는 동안 원본 폴더에 변경이 생겼습니다. 변경을 커밋하거나 되돌린 뒤 다시 시도하세요."
        : "원본 폴더에 커밋하지 않은 변경이 있습니다. 커밋하거나 되돌린 뒤 확인하세요.", "task-dirty", { hint: `바뀐 파일:\n${(await changedFiles(source)).join("\n")}` });
      const entry = { ...(continuing ? previous : { originalBranch: currentBranch, originalHead: currentHead, startedAt: now() }),
        key, projectPath: source, taskId: task.id, title: task.title, branch: task.branch, head, updatedAt: now() };
      // 바꾸기 전에 원래 브랜치를 먼저 저장한다. 도중에 꺼져도 확인 끝내기로 돌아갈 수 있다.
      previews.set(key, entry);
      savePreviews();
      try { await taskGit(source, ["switch", "--detach", head], { write: true }); }
      catch (error) {
        if (!error.outcomeUnknown && await taskRef(source, "HEAD") === currentHead) {
          if (continuing) previews.set(key, previous); else previews.delete(key);
          savePreviews();
        }
        throw error;
      }
      notify("tasks", { projectPath: task.projectPath, taskId: task.id });
      return { preview: await describe(entry) };
    });
  }
  // 원본 폴더를 확인 전 브랜치로 되돌린다. 확인 중에 원본에 변경이 생겼으면 되돌리지 않고 알린다.
  async function endPreview(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const repo = await taskRepo(projectPath);
    return locked(repo.common, async () => {
      const key = repoKey(repo.common), entry = previews.get(key);
      if (!entry) return { preview: null };
      const source = entry.projectPath;
      const [head, branch] = await Promise.all([taskRef(source, "HEAD"), symbolic(source)]);
      const finish = (note) => { previews.delete(key); savePreviews(); notify("tasks", { projectPath: repo.top }); return { preview: null, ...(note ? { note } : {}) }; };
      if (branch || head !== entry.head) return finish(`원본 폴더가 이미 ${branch ? `${branch} 브랜치` : "다른 커밋"}로 바뀌어 있어 그대로 두었습니다.`);
      await assertTaskGitIdle({ cwd: source });
      if (await taskDirty({ cwd: source }))
        throw new HttpError(409, "확인하는 동안 원본 폴더에 변경이 생겨 원래 브랜치로 돌아가지 않았습니다. 유니티·편집기가 바꾼 파일일 수 있습니다. Git 탭에서 확인해 커밋하거나 되돌린 뒤 다시 누르세요.",
          "task-preview-dirty", { hint: `바뀐 파일:\n${(await changedFiles(source)).join("\n")}` });
      if (entry.originalBranch && await taskRef(source, `refs/heads/${entry.originalBranch}`)) {
        await taskGit(source, ["switch", "--no-guess", entry.originalBranch], { write: true });
        return finish();
      }
      if (entry.originalHead && await taskRef(source, `${entry.originalHead}^{commit}`)) {
        await taskGit(source, ["switch", "--detach", entry.originalHead], { write: true });
        return finish(entry.originalBranch ? `${entry.originalBranch} 브랜치가 없어져 확인 전 커밋으로 돌아갔습니다.` : null);
      }
      return finish("확인 전 브랜치를 찾을 수 없어 원본 폴더를 그대로 두었습니다.");
    });
  }

  // ── 폴더·유니티 열기 ──
  function unityInfo(dir) {
    const unity = t.unityProject(dir);
    return unity ? { version: unity.version, editor: !!(unity.version && t.findUnityEditor(unity.version)) } : null;
  }
  async function open(id, target) {
    const task = get(id);
    const dir = task.inPlace ? task.projectPath : task.cwd;
    if (task.state === "cleaned" || !fs.existsSync(dir)) throw new HttpError(409, "작업 폴더가 없습니다.", "task-worktree");
    if (target === "folder") { await t.openFolder(dir); return { ok: true }; }
    if (target !== "unity") throw new HttpError(400, "열 대상을 선택하세요.");
    const unity = t.unityProject(dir);
    if (!unity) throw new HttpError(409, "유니티 프로젝트가 아닙니다.", "task-unity-missing");
    const editor = unity.version && t.findUnityEditor(unity.version);
    if (!editor) throw new HttpError(409, `유니티 ${unity.version ?? ""} 에디터를 찾지 못했습니다. Unity Hub에서 설치했는지 확인하세요.`.replace("  ", " "), "task-unity-missing");
    await t.openUnity(editor, dir);
    return { ok: true };
  }

  async function info(projectPath, { library = false } = {}) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const repo = await taskRepo(projectPath);
    const source = sourceDir(repo);
    const unity = unityInfo(source);
    const root = taskWorktreeLocation(repo, "x").root;
    const entry = previewActive(repo.common);
    const libraryDir = path.join(source, "Library");
    const [pool, preview, bytes] = await Promise.all([reuseFolders(repo.top, root).catch(() => []), entry ? describe(entry).catch(() => null) : null,
      unity && library && fs.existsSync(libraryDir) ? librarySize(libraryDir) : null]);
    const copying = Object.fromEntries([...copies.keys()].filter((id) => sameTaskPath(records.get(id)?.gitCommonDir, repo.common)).map((id) => [id, copyView(id)]));
    return { projectPath: repo.top, source, unity, settings: settingsFor(repo.top, unity), pool, preview, copies: copying,
      ...(unity ? { library: { exists: fs.existsSync(libraryDir), bytes } } : {}) };
  }

  // 새 작업 폴더를 준비한다. 재사용 대기 폴더가 있으면 쓰고, 없으면 만든 뒤(create) 유니티면 Library 복사를 시작한다.
  async function provision(task, repo, location, create, { copyLibrary } = {}) {
    if (await takeReuse(task, repo, location)) return { reused: true };
    await create();
    const source = sourceDir(repo);
    const unity = t.unityProject(source);
    if (unity && (typeof copyLibrary === "boolean" ? copyLibrary : settingsFor(repo.top, unity).copyLibrary)) await startLibraryCopy(task, source).catch(() => {});
    return { reused: false };
  }

  return { info, updateSettings, provision, park, stopCopy, removeReuse, previewStatus, startPreview, endPreview, previewActive, open, copyView };
}

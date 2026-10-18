import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { taskGit, sameTaskPath, assertTaskGitIdle } from "./tasks.mjs";

// 작업 폴더를 원본 폴더에서 확인·재사용하고, 유니티 프로젝트의 Library를 옮겨 다시 임포트하는 시간을 줄이는 도구들.

// 유니티 프로젝트면 { version }을, 아니면 null을 돌려준다. ProjectSettings/ProjectVersion.txt로 알아본다.
export function unityProject(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), "utf8");
    return { version: text.match(/^m_EditorVersion:\s*(\S+)/m)?.[1] ?? null };
  } catch { return null; }
}

// 프로젝트 버전의 유니티 에디터 실행 파일 후보. Unity Hub 기본 설치 위치, Hub에서 바꾼 설치 위치, Hub가 기록한 에디터 목록을 본다.
export function unityEditorCandidates(version, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (!version || !/^[0-9][0-9A-Za-z.]*$/.test(version)) return [];
  const hub = platform === "win32" ? path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "UnityHub")
    : platform === "darwin" ? path.join(home, "Library", "Application Support", "UnityHub") : path.join(home, ".config", "UnityHub");
  const exe = platform === "win32" ? ["Editor", "Unity.exe"] : platform === "darwin" ? ["Unity.app", "Contents", "MacOS", "Unity"] : ["Editor", "Unity"];
  const roots = platform === "win32" ? [path.join(env.ProgramFiles ?? "C:\\Program Files", "Unity", "Hub", "Editor")]
    : platform === "darwin" ? ["/Applications/Unity/Hub/Editor"] : [path.join(home, "Unity", "Hub", "Editor")];
  try { const secondary = JSON.parse(fs.readFileSync(path.join(hub, "secondaryInstallPath.json"), "utf8")); if (typeof secondary === "string" && secondary.trim()) roots.push(secondary.trim()); } catch {}
  const listed = [];
  for (const file of ["editors-v2.json", "editors.json"]) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(hub, file), "utf8"));
      for (const item of Array.isArray(raw?.data) ? raw.data : Object.values(raw ?? {})) {
        if (item?.version !== version) continue;
        for (const location of [item.location].flat()) if (typeof location === "string" && path.isAbsolute(location)) listed.push(location);
      }
    } catch {}
  }
  return [...listed, ...roots.map((root) => path.join(root, version, ...exe))];
}

export function findUnityEditor(version, options = {}) {
  const exists = options.exists ?? fs.existsSync;
  return unityEditorCandidates(version, options).find((file) => exists(file)) ?? null;
}

function launch(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false, shell: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

// 폴더를 탐색기(맥은 Finder)로 연다.
export function openFolder(dir, { platform = process.platform, run = launch } = {}) {
  const [file, args] = platform === "win32" ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), [path.resolve(dir)]]
    : platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
  return run(file, args);
}

export function openUnity(editor, dir, { run = launch } = {}) { return run(editor, ["-projectPath", path.resolve(dir)]); }

// 폴더 크기(바이트). 정션·심볼릭 링크는 따라가지 않는다.
export async function folderSize(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) total += await fs.promises.stat(full).then((stat) => stat.size, () => 0);
    }));
  }
  return total;
}

const robocopyPath = (env = process.env) => path.join(env.SystemRoot ?? "C:\\Windows", "System32", "robocopy.exe");
const ROBOCOPY_LINE = /^\s*(\d+)\s+\S/;

// 큰 폴더를 복사한다. Windows는 robocopy 여러 스레드 복사(/MT)로, 그 밖에는 fs.cp로 복사한다.
// onProgress(복사한 바이트)를 부르고, cancel()로 멈출 수 있다. 이미 있는 파일은 덮어쓰지 않는다.
export function copyFolder(source, target, { onProgress = () => {}, platform = process.platform, robocopy = robocopyPath(), threads = 16 } = {}) {
  let copied = 0, cancelled = false, child = null;
  const report = (bytes) => { copied += bytes; onProgress(copied); };
  const viaRobocopy = () => new Promise((resolve, reject) => {
    child = spawn(robocopy, [source, target, "/E", `/MT:${threads}`, "/R:1", "/W:1", "/XJ", "/XO", "/XN", "/XC", "/NDL", "/NJH", "/NJS", "/NP", "/NC", "/BYTES"],
      { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let rest = "", errors = "";
    child.stdout.on("data", (chunk) => {
      const lines = (rest + chunk.toString("latin1")).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) { const match = ROBOCOPY_LINE.exec(line); if (match) report(Number(match[1])); }
    });
    child.stderr.on("data", (chunk) => { errors = (errors + chunk.toString("latin1")).slice(-2000); });
    child.once("error", reject);
    // robocopy는 0~7이 성공(복사함·건너뜀 등), 8 이상이 실패다.
    child.once("close", (code) => cancelled ? reject(Object.assign(Error("복사를 멈췄습니다."), { cancelled: true }))
      : code !== null && code < 8 ? resolve() : reject(Error(`robocopy가 실패했습니다(코드 ${code}). ${errors}`.trim())));
  });
  const viaCp = () => fs.promises.cp(source, target, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true,
    filter: async (file) => {
      if (cancelled) throw Object.assign(Error("복사를 멈췄습니다."), { cancelled: true });
      const stat = await fs.promises.lstat(file).catch(() => null);
      if (stat?.isFile()) report(stat.size);
      return !stat?.isSymbolicLink();
    } });
  const promise = platform === "win32" && fs.existsSync(robocopy) ? viaRobocopy() : viaCp();
  return {
    promise,
    cancel() {
      cancelled = true;
      if (child && child.exitCode === null && Number.isInteger(child.pid)) {
        if (platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
        else child.kill("SIGTERM");
      }
      return promise.catch(() => {});
    },
  };
}

// 재사용 대기 폴더는 <프로젝트>.agenthub/.reuse-<무작위>이다. 마침표로 시작해 작업 폴더 이름 규칙(validTaskWorktreeName)과 겹치지 않는다.
export const REUSE_NAME = /^\.reuse-[0-9a-f]{8,32}$/;
export const reuseDir = (root) => path.join(root, `.reuse-${randomBytes(6).toString("hex")}`);

// root 아래 재사용 대기 폴더 목록. Git 워크트리로 등록되지 않은 남은 폴더도 지울 수 있게 함께 보여 준다.
export async function listReuseFolders(projectPath, root, git = taskGit) {
  const output = await git(projectPath, ["worktree", "list", "--porcelain", "-z"]);
  const registered = [];
  let record = null;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) { record = { dir: path.resolve(field.slice(9)), head: null, branch: null, locked: false }; registered.push(record); }
    else if (record && field.startsWith("HEAD ")) record.head = field.slice(5);
    else if (record && field.startsWith("branch refs/heads/")) record.branch = field.slice(18);
    else if (record && (field === "locked" || field.startsWith("locked "))) record.locked = true;
  }
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && REUSE_NAME.test(entry.name)).map((entry) => entry.name); } catch {}
  const folders = names.map((name) => {
    const dir = path.join(root, name);
    const entry = registered.find((item) => sameTaskPath(item.dir, dir));
    return { name, dir, registered: !!entry, head: entry?.head ?? null, branch: entry?.branch ?? null, locked: !!entry?.locked,
      modifiedAt: (() => { try { return fs.statSync(dir).mtime.toISOString(); } catch { return null; } })() };
  });
  return folders.sort((a, b) => String(a.modifiedAt).localeCompare(String(b.modifiedAt)));
}

// 재사용해도 되는 폴더인지 본다. 추적 파일 변경·무시하지 않은 새 파일·진행 중인 병합이 없어야 한다.
export async function reuseFolderClean(folder, git = taskGit) {
  if (!folder.registered || folder.locked || folder.branch || !fs.existsSync(path.join(folder.dir, ".git"))) return false;
  try {
    await assertTaskGitIdle({ cwd: folder.dir });
    return !(await git(folder.dir, ["status", "--porcelain=v1", "--untracked-files=normal"])).trim();
  } catch { return false; }
}

// 정리하는 작업 폴더를 재사용 대기 폴더로 옮긴다. HEAD를 떼어 작업 브랜치를 지울 수 있게 한 뒤 이름만 바꾼다.
// 옮기지 못하면 원래 브랜치로 되돌리고 null을 돌려준다(호출한 쪽이 폴더를 지운다).
export async function parkWorktree(projectPath, cwd, root, branch, git = taskGit) {
  const target = reuseDir(root);
  await git(cwd, ["switch", "--detach", "HEAD"], { write: true });
  try { await git(projectPath, ["worktree", "move", cwd, target], { write: true, timeout: 5 * 60_000 }); return target; }
  catch {
    if (!fs.existsSync(target) && fs.existsSync(cwd)) await git(cwd, ["switch", "--no-guess", branch], { write: true }).catch(() => {});
    return null;
  }
}

// 재사용 대기 폴더를 새 작업 폴더 위치로 옮기고 새 작업 브랜치를 만든다. 무시 파일(Library 등)은 그대로 남는다.
// 브랜치를 만들지 못하면 폴더를 다시 재사용 대기 자리로 돌려놓고 오류를 던진다.
export async function reuseWorktree(projectPath, folder, cwd, branch, base, git = taskGit) {
  if (fs.existsSync(cwd)) { try { fs.rmdirSync(cwd); } catch { throw new Error("새 작업 폴더 자리에 이미 파일이 있습니다."); } }
  await git(projectPath, ["worktree", "move", folder.dir, cwd], { write: true, timeout: 5 * 60_000 });
  try { await git(cwd, ["switch", "--no-guess", "-c", branch, base], { write: true, timeout: 5 * 60_000 }); }
  catch (error) {
    await git(projectPath, ["worktree", "move", cwd, folder.dir], { write: true }).catch(() => {});
    throw error;
  }
}

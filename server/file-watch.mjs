import fs from "node:fs";
import path from "node:path";
import { checkWatchPaths } from "./flow-nodes.mjs";

const IGNORED = new Set([".git", "node_modules", "data"]);
const ignored = (relative) => relative.split(/[\\/]/).some((part) => IGNORED.has(part.toLowerCase()));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

// 저장된 노드가 있어도 자동 시작하지 않는다. run에서 명시적으로 만들고 stop/dispose에서 닫는다.
export function createFileWatch({ node, onChange = () => {}, onError = () => {} }) {
  const project = fs.realpathSync(node.projectPath);
  if (!fs.statSync(project).isDirectory()) throw new Error("프로젝트 폴더를 찾을 수 없습니다.");
  const paths = checkWatchPaths(node.watchPaths);
  const debounceMs = Number(node.debounceMs ?? 500);
  if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 60_000) throw new Error("변경 대기 시간은 100~60000 사이 정수로 입력하세요.");
  const pending = new Set();
  const watchers = [];
  let timer = null;
  let stopped = false;
  let checking = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    pending.clear();
    for (const watcher of watchers) watcher.close();
  }

  // 삭제/이름 변경은 가장 가까운 존재하는 부모까지 확인한다. 심볼릭 링크를 통한 외부 변경은 전달하지 않는다.
  async function safeEventPath(file) {
    if (!inside(project, file)) return false;
    let existing = file;
    while (true) {
      try { await fs.promises.lstat(existing); break; }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) return false;
        const parent = path.dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
    }
    try {
      const real = await fs.promises.realpath(existing);
      return inside(project, real) && !ignored(path.relative(project, real));
    }
    catch { return false; }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush().catch((error) => { if (!stopped) { stop(); onError(error); } });
    }, debounceMs);
    timer.unref?.();
  }

  async function flush() {
    if (stopped || checking || !pending.size) return;
    checking = true;
    const candidates = [...pending];
    pending.clear();
    const changedPaths = [];
    try {
      // Repeated fs.watch notifications for one path require one safety check.
      // Resolve symlinks after the debounce, including newly replaced paths.
      for (let offset = 0; offset < candidates.length && !stopped; offset += 8) {
        const batch = candidates.slice(offset, offset + 8);
        const safe = await Promise.all(batch.map(relative => safeEventPath(path.resolve(project, relative))));
        for (let i = 0; i < batch.length; i++) if (safe[i]) changedPaths.push(batch[i]);
      }
      if (!stopped && changedPaths.length) onChange({ paths: changedPaths.sort(), at: new Date().toISOString() });
    } finally {
      checking = false;
      if (!stopped && pending.size && !timer) schedule();
    }
  }

  function changed(file) {
    if (stopped || !inside(project, file)) return;
    const relative = path.relative(project, file).replaceAll(path.sep, "/") || ".";
    // Most install/build bursts are ignored without filesystem operations.
    if (ignored(relative)) return;
    pending.add(relative);
    schedule();
  }

  try {
    for (const relative of paths) {
      const file = path.resolve(project, relative);
      if (!inside(project, file)) throw new Error("프로젝트 밖의 파일은 감시할 수 없습니다.");
      let real;
      let info;
      try { real = fs.realpathSync(file); info = fs.statSync(real); }
      catch { throw new Error(`감시할 파일이나 폴더가 없습니다: ${relative}`); }
      if (!inside(project, real) || ignored(path.relative(project, real))) throw new Error(`감시 경로가 프로젝트 밖이나 제외 폴더를 가리킵니다: ${relative}`);
      if (!info.isFile() && !info.isDirectory()) throw new Error(`일반 파일이나 폴더만 감시할 수 있습니다: ${relative}`);
      const directory = info.isDirectory() ? file : path.dirname(file);
      const watcher = fs.watch(directory, { recursive: info.isDirectory(), persistent: false }, (_, name) => {
        const eventFile = name ? path.resolve(directory, String(name)) : file;
        const matchesFile = process.platform === "win32" ? eventFile.toLowerCase() === file.toLowerCase() : eventFile === file;
        if (info.isFile() && !matchesFile) return;
        changed(eventFile);
      });
      watcher.on("error", (error) => {
        if (stopped) return;
        stop();
        onError(error);
      });
      watchers.push(watcher);
    }
  } catch (error) {
    stop();
    throw error;
  }
  return { stop };
}

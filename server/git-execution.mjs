import path from "node:path";
import { execFile } from "node:child_process";

// One budget per process, shared by the panel, tasks and GitHub's local Git reads.
// Writes keep their repository lock and never wait behind read-only work.
export function createReadQueue(limit = 8) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Read concurrency must be a positive integer");
  let active = 0;
  const waiting = [];
  const drain = () => {
    while (active < limit && waiting.length) {
      const { action, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve().then(action).then(resolve, reject).finally(() => { active--; drain(); });
    }
  };
  return (action) => new Promise((resolve, reject) => { waiting.push({ action, resolve, reject }); drain(); });
}

const reads = createReadQueue();
const sharedReads = new Map();
export function invalidateGitReads() { sharedReads.clear(); }

// Only coalesce work in progress. A finished request is never a freshness cache.
export function shareGitRead(key, action) {
  if (sharedReads.has(key)) return sharedReads.get(key);
  const pending = Promise.resolve().then(action);
  sharedReads.set(key, pending);
  pending.finally(() => { if (sharedReads.get(key) === pending) sharedReads.delete(key); }).catch(() => {});
  return pending;
}

export function isGitRead(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    const option = args[index++];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) index++;
  }
  const command = args[index++], rest = args.slice(index);
  if (["status", "log", "show", "rev-parse", "for-each-ref", "rev-list", "check-ref-format", "merge-base", "ls-tree", "ls-files", "diff", "diff-tree", "ls-remote"].includes(command)) return true;
  if (command === "worktree") return rest[0] === "list";
  if (command === "remote") return !rest.length || rest[0] === "get-url";
  if (command === "symbolic-ref") return !rest.includes("--delete") && !rest.includes("-d") && rest.filter(value => !value.startsWith("-")).length === 1;
  if (command === "config") return rest.some(value => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(value));
  if (command === "branch") return rest.includes("--list");
  return false;
}

export function scheduleGit(file, args, action) {
  if (!/^git(?:\.exe)?$/i.test(path.basename(file))) return action();
  if (isGitRead(args)) return reads(action);
  invalidateGitReads();
  return Promise.resolve().then(action).finally(invalidateGitReads);
}

export function gitEnvironment(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...extra };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[name];
  return env;
}

export function execGit(cwd, args, options = {}) {
  const argv = ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", "-c", "core.longpaths=true", "-C", cwd, ...args];
  return scheduleGit("git", argv, () => new Promise((resolve, reject) => {
    execFile("git", argv, { windowsHide: true, timeout: 30_000, maxBuffer: 20 * 1024 * 1024, env: gitEnvironment(), ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
  }));
}

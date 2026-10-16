// Repository mutations share a queue across worktrees and Git entry points.
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const queues = new Map();
const owners = new AsyncLocalStorage();

export async function withGitRepoLock(commonDir, action, { signal, deadline } = {}) {
  const real = fs.realpathSync(commonDir);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  if (owners.getStore()?.has(key)) return action();
  const previous = queues.get(key) ?? Promise.resolve();
  let cancelled, timer, abort;
  const current = previous.catch(() => {}).then(() => {
    if (cancelled) throw cancelled;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    const held = new Set(owners.getStore() ?? []);
    held.add(key);
    return owners.run(held, action);
  });
  queues.set(key, current);
  // An interrupted waiter keeps its queue position until its predecessor finishes.
  current.finally(() => { if (queues.get(key) === current) queues.delete(key); }).catch(() => {});
  const interrupted = new Promise((resolve, reject) => {
    const cancel = (stopped) => {
      cancelled = Object.assign(new Error(stopped ? "작업을 중지했습니다." : "Git 작업 시간이 초과되었습니다."),
        { reason: stopped ? "stopped" : "git-timeout", stopped, timedOut: !stopped });
      reject(cancelled);
    };
    abort = () => cancel(true);
    signal?.addEventListener("abort", abort, { once: true });
    if (Number.isFinite(deadline)) timer = setTimeout(() => cancel(false), Math.max(0, deadline - Date.now()));
    if (signal?.aborted) abort();
  });
  try { return await Promise.race([current, interrupted]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

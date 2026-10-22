import { Worker } from "node:worker_threads";

export class JournalWriter {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.counter = 0;
    this.failure = null;
  }

  append(file, value) {
    if (this.fatal) throw this.failure;
    if (!this.worker) {
      this.worker = new Worker(new URL("./journal-worker.mjs", import.meta.url), { execArgv: [] });
      this.worker.on("message", ({ id, error }) => {
        const task = this.pending.get(id);
        if (!task) return;
        this.pending.delete(id);
        if (error) {
          this.failure ??= Object.assign(new Error(error.message), { code: error.code });
          task.reject(this.failure);
        } else task.resolve();
        if (!this.pending.size) this.worker?.unref();
      });
      this.worker.on("error", error => this.fail(error));
      this.worker.on("exit", code => {
        if (this.pending.size) this.fail(new Error(`Journal writer stopped (${code})`));
      });
    }
    const id = ++this.counter;
    const signal = new SharedArrayBuffer(4);
    const promise = new Promise((resolve, reject) => this.pending.set(id, { signal, resolve, reject }));
    this.pending.get(id).promise = promise;
    this.worker.ref();
    try { this.worker.postMessage({ id, file, value, signal }); }
    catch (error) { this.fail(error); }
    return promise;
  }

  fail(error) {
    this.fatal = true;
    this.failure ??= error;
    for (const task of this.pending.values()) {
      Atomics.store(new Int32Array(task.signal), 0, 2);
      Atomics.notify(new Int32Array(task.signal), 0);
      task.reject(error);
    }
    this.pending.clear();
    this.worker?.unref();
  }

  // Explicit checkpoints/removals retain their synchronous durability contract.
  // Hot-path timer writes never wait on the application thread.
  drainSync({ ignoreFailure = false } = {}) {
    let failed = false;
    for (const task of this.pending.values()) {
      const state = new Int32Array(task.signal);
      while (Atomics.load(state, 0) === 0) {
        if (Atomics.wait(state, 0, 0, 30_000) === "timed-out") throw new Error("Journal writer did not finish within 30 seconds");
      }
      if (Atomics.load(state, 0) === 2) failed = true;
    }
    if (!ignoreFailure && (failed || this.failure)) throw this.failure ?? new Error("Could not save the session journal");
  }

  async close() {
    await Promise.allSettled([...this.pending.values()].map(task => task.promise));
    if (this.worker) { const worker = this.worker; this.worker = null; await worker.terminate(); }
    if (this.failure) throw this.failure;
  }
}

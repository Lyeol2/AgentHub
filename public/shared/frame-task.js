/** Coalesce replaceable visual work, with an explicit final flush for pointer-up. */
export function createFrameTask(run, { request = (fn) => requestAnimationFrame(fn), cancel = (id) => cancelAnimationFrame(id) } = {}) {
  let handle = null, pending = false, latest;
  const flush = () => {
    if (!pending) return;
    if (handle !== null) cancel(handle);
    handle = null; pending = false;
    run(latest);
  };
  return {
    schedule(value) { latest = value; pending = true; if (handle === null) handle = request(() => { handle = null; flush(); }); },
    flush,
    cancel() { if (handle !== null) cancel(handle); handle = null; pending = false; },
  };
}

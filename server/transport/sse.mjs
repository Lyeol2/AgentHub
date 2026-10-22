// Each hub owns its own subscribers and heartbeat; importing this module opens nothing.
export function createEventStream({ pingInterval = 25000, maxBufferedBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) throw new Error("Invalid SSE buffer limit");
  const streams = new Set();
  let timer = null;

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = Buffer.byteLength(payload);
    for (const res of streams) {
      if (res.destroyed) streams.delete(res);
      else if ((res.writableLength ?? 0) + bytes > maxBufferedBytes) {
        // A slow window must not retain every session's output indefinitely.
        // EventSource reconnects; the open handler reloads current snapshots.
        streams.delete(res);
        res.destroy();
      } else res.write(payload);
    }
  }

  function connect(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => broadcast("ping", {}), pingInterval);
    timer.unref();
  }

  function close() {
    clearInterval(timer);
    timer = null;
    for (const res of streams) { res.end(); res.destroy?.(); }
    streams.clear();
  }

  return { broadcast, connect, start, close };
}


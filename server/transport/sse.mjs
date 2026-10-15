// Each hub owns its own subscribers and heartbeat; importing this module opens nothing.
export function createEventStream({ pingInterval = 25000 } = {}) {
  const streams = new Set();
  let timer = null;

  function broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) {
      if (res.destroyed) streams.delete(res);
      else res.write(payload);
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
    for (const res of streams) res.end();
    streams.clear();
  }

  return { broadcast, connect, start, close };
}


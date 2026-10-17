// Codex 설정에 등록된 URL 방식 MCP 서버(Unity MCP 등) 중 지금 꺼져 있는 것을 확인해 둔다.
// 세션 실행은 동기로 인자를 만들므로 주기적으로 미리 확인하고, 실행할 때는 마지막 결과를 쓴다.
import net from "node:net";
import { configMcpUrls } from "./agents/codex.mjs";

const INTERVAL_MS = 10_000;
const TIMEOUT_MS = 500;

// HTTP 요청 없이 TCP 연결만 해 본다. 서버가 떠 있는지만 알면 된다.
export function tcpReachable(value, timeoutMs = TIMEOUT_MS) {
  let url;
  try { url = new URL(value); } catch { return Promise.resolve(true); }
  if (!["http:", "https:"].includes(url.protocol)) return Promise.resolve(true);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export class CodexMcpProbe {
  constructor({ read = () => configMcpUrls(), reachable = tcpReachable, intervalMs = INTERVAL_MS } = {}) {
    Object.assign(this, { read, reachable, intervalMs });
    this.down = [];
    this.running = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      let servers = [];
      try { servers = this.read(); } catch {}
      const results = await Promise.all(servers.map(async (server) => ((await this.reachable(server.url)) ? null : server.name)));
      this.down = results.filter(Boolean);
    })().catch(() => {}).finally(() => { this.running = null; });
    return this.running;
  }

  // 마지막으로 확인했을 때 연결할 수 없던 서버 이름.
  unreachable() {
    return [...this.down];
  }
}

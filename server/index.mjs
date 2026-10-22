// CLI entry point. Embedders and tests can import bootstrap.mjs without starting a server.
import { createHub } from "./bootstrap.mjs";
export { createHub } from "./bootstrap.mjs";

export const hub = createHub();
export let port = hub.port;
export const listening = hub.start().then(() => { port = hub.port; });
export const setUpdater = (next) => hub.setUpdater(next);
export function shutdown() { return hub.shutdown(); }

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown().then(() => process.exit(0), error => {
      console.error("[agenthub] 종료 중 기록 저장에 실패했습니다:", error);
      process.exit(1);
    });
  });
}

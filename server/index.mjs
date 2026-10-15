// CLI entry point. Embedders and tests can import bootstrap.mjs without starting a server.
import { createHub } from "./bootstrap.mjs";
export { createHub } from "./bootstrap.mjs";

export const hub = createHub();
export let port = hub.port;
export const listening = hub.start().then(() => { port = hub.port; });
export const setUpdater = (next) => hub.setUpdater(next);
export function shutdown() { return hub.shutdown(); }

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { shutdown().finally(() => process.exit(0)); });
}

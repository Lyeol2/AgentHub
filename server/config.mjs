import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.AGENTHUB_DATA ?? path.join(ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const DEFAULTS = {
  port: 4517,
  // CLI 경로를 직접 지정할 때만 채운다. 비워 두면 자동 탐색한다.
  cli: { claude: "", codex: "" },
  projects: [],
};

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULTS);
    return structuredClone(DEFAULTS);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return { ...DEFAULTS, ...raw, cli: { ...DEFAULTS.cli, ...raw.cli } };
}

export function saveConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.AGENTHUB_DATA ?? path.join(ROOT, "data");
// 일반 채팅 세션의 작업 폴더. 프로젝트 감지에서는 뺀다.
export const CHAT_DIR = path.join(DATA_DIR, "chat");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const DEFAULTS = {
  port: 4517,
  // CLI 경로를 직접 지정할 때만 채운다. 비워 두면 자동 탐색한다.
  cli: { claude: "", codex: "" },
  projects: [],
  // 프로젝트 화면의 Claude Code·Codex 기록 목록에서 숨긴 세션 ID. 기록 파일은 지우지 않는다.
  hiddenSessions: [],
  // 흐름 그래프에서 옮긴 스킬 노드 위치. 프로젝트 경로(소문자) → 스킬 이름 → { x, y }
  skillLayout: {},
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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.AGENTHUB_DATA ?? path.join(ROOT, "data");
// 일반 채팅 세션의 작업 폴더. 프로젝트 감지에서는 뺀다.
export const CHAT_DIR = path.join(DATA_DIR, "chat");

const DEFAULTS = {
  port: 4517,
  // CLI 경로를 직접 지정할 때만 채운다. 비워 두면 자동 탐색한다.
  cli: { claude: "", codex: "" },
  projects: [],
  // 프로젝트 화면의 Claude Code·Codex 기록 목록에서 숨긴 세션 ID. 기록 파일은 지우지 않는다.
  hiddenSessions: [],
  // 제거한 프로젝트 경로. Claude Code·Codex 기록에서 다시 감지돼도 목록에 보이지 않는다(다시 추가하면 빠진다).
  hiddenProjects: [],
  // 흐름 그래프에서 옮긴 스킬 노드 위치. 프로젝트 경로(소문자) → 스킬 이름 → { x, y }
  skillLayout: {},
  // Git 저장소 경로(소문자) → GitFlow 브랜치 이름과 작업 브랜치 접두어.
  gitflow: {},
};

export function loadConfig(dataDir = DATA_DIR) {
  const configPath = path.join(dataDir, "config.json");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULTS, dataDir);
    return structuredClone(DEFAULTS);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const defaults = structuredClone(DEFAULTS);
  return { ...defaults, ...raw, cli: { ...defaults.cli, ...raw.cli } };
}

export function saveConfig(config, dataDir = DATA_DIR) {
  const configPath = path.join(dataDir, "config.json");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

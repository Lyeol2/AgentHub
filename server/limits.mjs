// 구독 한도 서비스의 기본 파일·CLI 기록·OAuth 어댑터 조립과 기존 함수 API.
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./config.mjs";
import { createLimitsService as createLimitsApplication } from "./application/limits.mjs";
import { FileLimitsRepository, FileClaudeCredentials, FileCodexRollouts } from "./infrastructure/persistence/limits.mjs";
import { createClaudeUsageReader } from "./infrastructure/usage/claude.mjs";

export { sameWindow } from "./policies/limits.mjs";

export function createLimitsService({
  dataDir = DATA_DIR,
  claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  codexDir = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  fetch = globalThis.fetch,
  now = Date.now,
} = {}) {
  return createLimitsApplication({
    repository: new FileLimitsRepository({ dataDir }),
    credentials: new FileClaudeCredentials({ claudeDir }),
    rollouts: new FileCodexRollouts({ codexDir }),
    fetchUsage: createClaudeUsageReader({ fetch }),
    now,
  });
}

let defaultLimits;
const limits = () => defaultLimits ??= createLimitsService();
export const recordClaudeLimit = (info) => limits().recordClaudeLimit(info);
export const refreshClaudeUsage = (options) => limits().refreshClaudeUsage(options);
export const readLimits = () => limits().readLimits();

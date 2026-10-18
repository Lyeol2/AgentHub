// 프로젝트 설정 "유니티 사용"에 맞춰 CLI에 넘길 도구 제한을 만든다. 지침 문구가 아니라 도구 권한·설정으로만 막거나 묻는다.
// AgentHub에는 유니티를 여는 코드가 없다. 세션이 사용자 전역 설정(Claude 스킬 unity-cli의 `unity` 명령, Codex의 unityMCP 서버 등)을 이어받아 AI가 직접 실행한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configMcpServers, configMcpTools } from "./agents/codex.mjs";

const UNITY = /unity/i;
// 흔히 쓰는 Unity MCP 서버 이름. 설정 파일에서 찾지 못해도 함께 막거나 묻는다.
const KNOWN_MCP = ["unity", "unityMCP", "UnityMCP", "unity-mcp", "mcp-unity"];
const MCP_NAME = /^[A-Za-z0-9_-]+$/;

const unique = (list) => [...new Set(list)];
const samePath = (a, b) => { try { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); } catch { return false; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const claudeJson = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), ".claude.json");

// Claude Code에 등록된 MCP 서버 이름: 사용자 설정(~/.claude.json)의 전역·프로젝트 항목과 프로젝트의 .mcp.json.
export function claudeMcpServers(dirs = [], { user = readJson(claudeJson()), project = (dir) => readJson(path.join(dir, ".mcp.json")) } = {}) {
  const names = Object.keys(user?.mcpServers ?? {});
  for (const [key, value] of Object.entries(user?.projects ?? {})) if (dirs.some((dir) => dir && samePath(key, dir))) names.push(...Object.keys(value?.mcpServers ?? {}));
  for (const dir of dirs) if (dir) names.push(...Object.keys(project(dir)?.mcpServers ?? {}));
  return unique(names);
}

// Claude 권한 규칙. 명령은 Bash·PowerShell 도구 모두, MCP는 서버 단위(mcp__<서버>)로 쓴다.
export function claudeUnityRules(mode, servers = []) {
  if (mode !== "ask" && mode !== "off") return { ask: [], deny: [] };
  const commands = ["Bash", "PowerShell"].flatMap((tool) => [`${tool}(unity:*)`, `${tool}(unity open:*)`]);
  const mcp = unique([...KNOWN_MCP, ...servers.filter((name) => UNITY.test(name) && MCP_NAME.test(name))]).map((name) => `mcp__${name}`);
  // 끄면 유니티 CLI 스킬도 불러오지 못하게 한다. 실행 전 확인에서는 스킬 안내는 읽되 실제 실행만 묻는다.
  return mode === "off" ? { ask: [], deny: [...commands, ...mcp, "Skill(unity-cli)"] } : { ask: [...commands, ...mcp], deny: [] };
}

// Codex: config.toml의 MCP 서버 중 이름에 unity가 들어간 서버와 그 서버에 따로 적힌 도구 이름.
export function codexUnityServers(text) {
  const tools = configMcpTools(text);
  return configMcpServers(text).filter((name) => UNITY.test(name) && name !== "agenthub").map((name) => ({ name, tools: tools[name] ?? [] }));
}

// Codex -c 설정. 끄면 서버를 끄고, 실행 전 확인이면 서버 기본값과 도구별 승인 방식을 모두 prompt로 덮어쓴다.
export function codexUnitySettings(mode, servers = []) {
  const settings = {};
  for (const { name, tools = [] } of servers) {
    if (!MCP_NAME.test(name)) continue;
    if (mode === "off") settings[`mcp_servers.${name}.enabled`] = false;
    else if (mode === "ask") {
      settings[`mcp_servers.${name}.default_tools_approval_mode`] = "prompt";
      for (const tool of tools) if (MCP_NAME.test(tool)) settings[`mcp_servers.${name}.tools.${tool}.approval_mode`] = "prompt";
    }
  }
  return settings;
}

// 명령 맨 앞(또는 ; & | 뒤, PowerShell -Command 안)에서 unity·Unity.exe를 실행하는지.
const UNITY_COMMAND = /(?:^|[;&|(]\s*|-Command\s+["']?\s*(?:&\s*)?)(?:(["'])[^"']*[\\/]unity(?:\.exe)?\1|["']?(?:[^\s"';&|]*[\\/])?unity(?:\.exe)?["']?(?=\s|$|["';&|)]))/i;
export const isUnityCommand = (command) => UNITY_COMMAND.test(String(command ?? ""));

// 세션 실행에 쓸 유니티 통제 정보. allow(또는 일반 채팅)면 null이라 아무것도 바꾸지 않는다.
// Claude: { mode, ask, deny } 권한 규칙 / Codex: { mode, settings } -c 설정
export function unityControl(mode, session, { claudeServers = claudeMcpServers, codexServers = codexUnityServers } = {}) {
  if (!mode || mode === "allow" || session.chat) return null;
  if (session.agent === "claude") return { mode, ...claudeUnityRules(mode, claudeServers([session.cwd, session.projectPath])) };
  return { mode, settings: codexUnitySettings(mode, codexServers()) };
}

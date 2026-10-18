import { AGENTS, KEEP_ALIVE_DEFAULTS } from "../runner.mjs";
import { locateCli, cliVersion, cliAuth, openLogin, refreshPath, normalizeCliPath, isCliFile } from "../cli.mjs";
import { CONDITION_LABELS } from "../chain.mjs";
import { TOOLS } from "../setup.mjs";
import { HttpError } from "./errors.mjs";

const keepAliveSettings = (config) => ({ ...KEEP_ALIVE_DEFAULTS, ...config.cliKeepAlive });

export function createSystemService({ config, setup, cliPaths, saveConfig, version, getUpdater, limits }) {
  function agentStatus(agent, cliPath, version) {
    const a = AGENTS[agent];
    // autoPath: 직접 지정한 경로와 상관없이 자동으로 찾은 경로(설정 화면에 읽기 전용으로 보여 준다)
    // defaultModel: 모델을 고르지 않았을 때 실제로 쓸 모델(Codex는 설정의 기본 모델을 쓸 수 없으면 바꿔 실행한다)
    return {
      path: cliPath, autoPath: locateCli(agent, ""), version,
      permissions: a.PERMISSION_MODES, models: a.models(), efforts: a.efforts(),
      defaultModel: a.defaultModel?.() ?? null,
    };
  }

  async function status(fresh = false) {
    if (fresh) refreshPath();
    const paths = cliPaths();
    const [claudeVersion, codexVersion] = await Promise.all([cliVersion(paths.claude), cliVersion(paths.codex)]);
    return {
      agents: {
        claude: agentStatus("claude", paths.claude, claudeVersion),
        codex: agentStatus("codex", paths.codex, codexVersion),
      },
      cliOverrides: config.cli,
      cliAutoUpdate: config.cliAutoUpdate !== false,
      cliKeepAlive: keepAliveSettings(config),
      projects: config.projects,
      linkConditions: Object.entries(CONDITION_LABELS).map(([id, label]) => ({ id, label })),
    };
  }

  async function auth(fresh) {
    if (fresh) refreshPath();
    const paths = cliPaths();
    const [claude, codex] = await Promise.all([
      cliAuth("claude", paths.claude, { fresh }),
      cliAuth("codex", paths.codex, { fresh }),
    ]);
    return { claude, codex };
  }

  function login(agent) {
    if (!AGENTS[agent]) throw new HttpError(400, "agent는 claude 또는 codex입니다.");
    const file = cliPaths()[agent];
    if (!file) throw new HttpError(400, "CLI를 찾지 못했습니다. 설정에서 경로를 지정하세요.");
    try { openLogin(agent, file); }
    catch (error) { throw new HttpError(400, error.message); }
    return { ok: true };
  }

  function setupAction(tool, action, body = {}) {
    if (!Object.hasOwn(TOOLS, tool) && tool !== "winget") throw new HttpError(404, "없는 설치 도구입니다.");
    try {
      if (action === "install") return setup.install(tool);
      if (tool === "winget" && action !== "cancel") throw new HttpError(404, "winget은 설치·복구와 취소만 지원합니다.");
      if (action === "update") {
        if (!["claude", "codex"].includes(tool)) throw new HttpError(400, "Claude Code와 Codex만 업데이트할 수 있습니다.");
        return setup.update(tool);
      }
      if (action === "login") return setup.login(tool);
      if (action === "input") {
        setup.input(tool, String(body.text ?? "").slice(0, 2000));
        return { ok: true };
      }
      if (action === "cancel") return { canceled: setup.cancel(tool) };
      throw new HttpError(404, "없는 API입니다.");
    } catch (error) {
      throw new HttpError(error.status ?? 409, error.message);
    }
  }

  async function usageLimits(fresh) {
    await limits.refreshClaudeUsage({ fresh });
    return limits.readLimits();
  }

  function updateState() {
    return getUpdater()?.state ?? { supported: false, desktop: false, current: version, status: "idle" };
  }

  async function update(action) {
    const updater = getUpdater();
    if (!updater) throw new HttpError(400, "데스크톱 앱에서만 업데이트할 수 있습니다.");
    try { return await updater[action](); }
    catch (error) { throw new HttpError(409, error.message); }
  }

  // CLI 띄워 두기: 쉬는 시간(분, 0~1440. 0이면 백그라운드 작업이 없을 때 바로 닫음)과 동시 유지 수(1~64)
  function checkKeepAlive(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "CLI 띄워 두기 설정이 올바르지 않습니다.");
    const result = {};
    if (value.idleMinutes !== undefined) {
      if (!Number.isInteger(value.idleMinutes) || value.idleMinutes < 0 || value.idleMinutes > 1440) throw new HttpError(400, "CLI를 띄워 두는 시간은 0~1440분 사이의 정수여야 합니다.");
      result.idleMinutes = value.idleMinutes;
    }
    if (value.maxProcesses !== undefined) {
      if (!Number.isInteger(value.maxProcesses) || value.maxProcesses < 1 || value.maxProcesses > 64) throw new HttpError(400, "동시에 띄워 두는 CLI 수는 1~64 사이의 정수여야 합니다.");
      result.maxProcesses = value.maxProcesses;
    }
    return result;
  }

  function settings(body) {
    if (body.cliAutoUpdate !== undefined && typeof body.cliAutoUpdate !== "boolean") throw new HttpError(400, "CLI 자동 업데이트 설정은 참 또는 거짓이어야 합니다.");
    const next = {};
    if (body.cli !== undefined) {
      for (const agent of ["claude", "codex"]) {
        const value = normalizeCliPath(body.cli?.[agent] ?? "");
        if (value && !isCliFile(value)) throw new HttpError(400, agent + " CLI 실행 파일을 선택하세요. 폴더나 바로가기 대신 .exe, .cmd, .bat 등의 실행 파일 경로가 필요합니다: " + value);
        next[agent] = value;
      }
    }
    const keepAlive = body.cliKeepAlive === undefined ? null : checkKeepAlive(body.cliKeepAlive);
    Object.assign(config.cli, next);
    if (body.cliAutoUpdate !== undefined) config.cliAutoUpdate = body.cliAutoUpdate;
    if (keepAlive) config.cliKeepAlive = { ...keepAliveSettings(config), ...keepAlive };
    refreshPath();
    saveConfig(config);
    return { ok: true };
  }

  return { status, auth, login, setupStatus: (fresh = false) => setup.status({ fresh }), setupAction, limits: usageLimits, updateState, update, settings };
}

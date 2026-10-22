import { randomUUID } from "node:crypto";
import { CodexAppServer } from "./codex-app-server.mjs";
import { claudeMcpServers, unityControl } from "./unity-control.mjs";

const CLOSED = "CLI 연결이 끝났습니다. 다시 조회하세요.";
const FAILED = "MCP 상태를 조회하지 못했습니다. CLI 연결과 MCP 설정을 확인하세요.";
const IDLE = "대화를 시작하지 않고 별도 연결로 점검한 결과입니다. 다음 요청 때 새로 연결됩니다.";
const STATUS = { connected: "connected", failed: "failed", "needs-auth": "needs-auth", authenticationRequired: "needs-auth", pending: "pending", starting: "pending", disabled: "disabled", notStarted: "disconnected", cancelled: "disconnected", disconnected: "disconnected" };
const AUTH = new Set(["unknown", "unsupported", "notLoggedIn", "bearerToken", "oAuth"]);
const open = (child) => !!child && !child.retired && !child.closed && !child.stdin?.destroyed && !child.stdin?.writableEnded && !child.appServer?.closed && !child.appServer?.stopping;
const safeName = (name) => typeof name === "string" && name.length > 0 && name.length <= 200 && !/[\u0000-\u001f\u007f]|:\/\//.test(name);
const text = (value, max = 1000) => typeof value === "string" ? value
  .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, "[주소 숨김]")
  .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [숨김]")
  .replace(/\b(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[숨김]")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "";

// CLI 응답에는 env·인증 헤더·세션 토큰 URL도 들어온다. 화면용 필드만 새 객체로 만든다.
export function normalizeMcpServers(agent, values) {
  if (!Array.isArray(values)) throw new Error(FAILED);
  return values.filter((server) => safeName(server?.name)).slice(0, 1000).map((server) => {
    const entries = Array.isArray(server.tools) ? server.tools : server.tools && typeof server.tools === "object" ? Object.values(server.tools) : [];
    const tools = entries.filter((tool) => safeName(tool?.name)).slice(0, 5000).map((tool) => ({ name: tool.name, ...(tool.description ? { description: text(tool.description) } : {}) }));
    const state = agent === "codex" ? server.runtimeStatus : server.status;
    return {
      name: server.name, status: STATUS[state] ?? "unknown", tools,
      ...(AUTH.has(server.authStatus) ? { authStatus: server.authStatus } : {}),
      ...(server.error || server.toolsError ? { error: "서버 연결 또는 도구 목록 조회에 실패했습니다." } : {}),
    };
  });
}

function ready(target, event, check, timeoutMs) {
  if (target.closed || target.stopping || target.retired) return Promise.reject(new Error(CLOSED));
  if (check()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      target.off(event, changed); target.off("close", closed);
      error ? reject(error) : resolve();
    };
    const closed = () => finish(new Error(CLOSED));
    const changed = () => {
      if (target.claudeInitializationFailed) finish(new Error(FAILED));
      else if (check()) finish();
    };
    const timer = setTimeout(() => finish(new Error("CLI 초기화가 끝나지 않았습니다. 잠시 뒤 다시 조회하세요.")), timeoutMs);
    target.on(event, changed); target.once("close", closed);
    changed();
  });
}

// Runner의 기존 controlReply/close 처리가 완료·실패를 모두 돌려준다.
function claudeRequest(child, request, timeoutMs) {
  if (!open(child)) return Promise.reject(new Error(CLOSED));
  const id = `mcp-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const finish = (response) => {
      clearTimeout(timer); child.controls.delete(id);
      if (response?.subtype === "success") resolve(response.response ?? {});
      else reject(new Error(FAILED));
    };
    const timer = setTimeout(() => finish({ subtype: "error" }), timeoutMs);
    child.controls.set(id, finish);
    try { child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n"); }
    catch { finish({ subtype: "error" }); }
  });
}

async function codexStatus(protocol, threadId, timeoutMs = 15000) {
  const data = [], cursors = new Set();
  const deadline = Date.now() + timeoutMs;
  let cursor;
  for (let page = 0; page < 20; page++) {
    if (Date.now() >= deadline) throw new Error(FAILED);
    const result = await protocol.request("mcpServerStatus/list", { ...(threadId ? { threadId } : {}), detail: "toolsAndAuthOnly", limit: 100, ...(cursor ? { cursor } : {}) }, { timeoutMs: Math.max(1, deadline - Date.now()) });
    if (!Array.isArray(result?.data)) throw new Error(FAILED);
    data.push(...result.data);
    if (!result.nextCursor) return data;
    if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error(FAILED);
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw new Error(FAILED);
}

export class McpStatusService {
  constructor(runner, agents, { timeoutMs = 15000, settleMs = 250, settleBudgetMs = 3000 } = {}) {
    this.runner = runner;
    this.agents = agents;
    this.timeoutMs = timeoutMs;
    this.settleMs = settleMs;
    this.settleBudgetMs = settleBudgetMs;
    this.inflight = new Map();
    this.probes = new Map();
  }

  stopAll() {
    for (const abort of this.probes.values()) abort();
  }

  liveChild(session) {
    const child = this.runner.procs.get(session.id) ?? this.runner.running.get(session.id);
    return open(child) && child.agentName === session.agent ? child : null;
  }

  options(session) {
    return {
      mcp: session.chat ? null : this.runner.mcp(session),
      unity: session.chat ? null : unityControl(this.runner.unityMode(session), session),
      disabledMcp: session.agent === "codex" ? this.runner.unreachableMcp() : [],
    };
  }

  fallback(session, options) {
    if (session.chat && session.agent === "claude") return [];
    let names = [];
    try { names = session.agent === "claude" ? claudeMcpServers([session.cwd, session.projectPath]) : this.agents.codex.configMcpServers(); } catch { /* 설정 읽기 오류의 원문도 공개하지 않는다. */ }
    if (options.mcp) names.push("agenthub");
    return [...new Set(names)].filter(safeName).map((name) => ({ name, tools: [], status: options.disabledMcp.includes(name) || (options.unity?.mode === "off" && /unity/i.test(name)) ? "disabled" : "unknown" }));
  }

  status(session, cliPath) {
    const child = this.liveChild(session);
    const existing = this.inflight.get(session.id);
    if (existing && existing.child === child && existing.agent === session.agent && existing.cwd === session.cwd && existing.cliPath === cliPath) return existing.promise;
    const entry = { child, agent: session.agent, cwd: session.cwd, cliPath };
    entry.promise = this.inspect({ ...session }, cliPath, child).finally(() => { if (this.inflight.get(session.id) === entry) this.inflight.delete(session.id); });
    this.inflight.set(session.id, entry);
    return entry.promise;
  }

  async liveStatus(session, child) {
    if (session.agent === "claude") {
      await ready(child, "cliInitialized", () => child.claudeInitialized || !!child.conversation, this.timeoutMs);
      return (await claudeRequest(child, { subtype: "mcp_status" }, this.timeoutMs)).mcpServers;
    }
    await ready(child.appServer, "initialized", () => child.appServer.initialized, this.timeoutMs);
    await ready(child.appServer, "threadReady", () => !!child.appServer.threadId, this.timeoutMs);
    return codexStatus(child.appServer, child.appServer.threadId, this.timeoutMs);
  }

  async inspect(session, cliPath, child) {
    let options;
    try { options = this.options(session); }
    catch { throw new Error(FAILED); }
    const base = { agent: session.agent, live: !!child, checkedAt: null, servers: [], actions: { reconnect: false, reload: false } };
    try {
      if (!child && !cliPath) throw new Error(FAILED);
      const values = child ? await this.liveStatus(session, child) : await this.probe(session, cliPath, options);
      base.servers = normalizeMcpServers(session.agent, values);
      if (child && this.liveChild(session) !== child) throw new Error(CLOSED);
      if (child) base.actions = { reconnect: session.agent === "claude", reload: session.agent === "codex" };
      else base.message = IDLE;
      // 처음 초기화할 때 아직 MCP가 검색되지 않았으면 설정 이름도 알려 주되 연결 성공으로 보이지 않는다.
      if (!child && base.servers.length === 0) {
        base.servers = this.fallback(session, options);
        if (base.servers.length) base.message = "아직 연결 상태를 확인하지 못해 설정에 등록된 서버를 표시합니다. " + IDLE;
      }
    } catch {
      if (child) throw new Error(FAILED);
      base.servers = this.fallback(session, options);
      base.message = "별도 연결 점검을 완료하지 못해 설정에 등록된 서버만 표시합니다. 다음 요청 때 새로 연결됩니다.";
    }
    base.checkedAt = new Date().toISOString();
    return base;
  }

  async reconnect(session, serverName) {
    const child = this.liveChild(session);
    if (session.agent !== "claude" || !child) throw new Error("재연결할 실행 중인 Claude 연결이 없습니다. 다음 요청 때 새로 연결됩니다.");
    if (!safeName(serverName)) throw new Error("MCP 서버 이름이 올바르지 않습니다.");
    try {
      const servers = await this.liveStatus(session, child);
      if (!Array.isArray(servers) || !servers.some((server) => server?.name === serverName)) throw new Error(FAILED);
      if (this.liveChild(session) !== child) throw new Error(CLOSED);
      await claudeRequest(child, { subtype: "mcp_reconnect", serverName }, this.timeoutMs);
      return { message: "Claude가 MCP 재연결 요청을 처리했습니다. 새로고침하여 연결 상태를 확인하세요." };
    } catch { throw new Error("MCP 서버를 재연결하지 못했습니다. 서버 이름과 연결 상태를 확인하세요."); }
  }

  async reload(session) {
    const child = this.liveChild(session);
    if (session.agent !== "codex" || !child) throw new Error("설정을 다시 읽을 실행 중인 Codex 연결이 없습니다. 다음 요청 때 새로 연결됩니다.");
    try {
      await ready(child.appServer, "initialized", () => child.appServer.initialized, this.timeoutMs);
      if (this.liveChild(session) !== child) throw new Error(CLOSED);
      await child.appServer.request("config/mcpServer/reload", null, { timeoutMs: this.timeoutMs });
      return { message: "Codex에 MCP 설정 갱신을 요청했습니다. 현재 작업에 즉시 재연결된다는 뜻은 아니며, 연결 상태는 새로고침하여 확인하세요." };
    } catch { throw new Error("Codex MCP 설정 갱신을 요청하지 못했습니다. 연결 상태를 확인하세요."); }
  }

  async probe(session, cliPath, options) {
    if (this.runner.isUpdating(session.agent)) throw new Error(FAILED);
    const agent = this.agents[session.agent];
    const probeSession = { ...session, agentSessionId: null };
    const args = agent.buildArgs(probeSession, options);
    if (session.agent === "claude") {
      const index = args.indexOf("--session-id");
      if (index >= 0) args.splice(index, 2);
      args.push("--no-session-persistence");
    }
    const child = this.runner.spawn(cliPath, args, { cwd: session.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, NO_COLOR: "1" } });
    child.controls = new Map();
    const protocol = session.agent === "codex" ? new CodexAppServer(child, probeSession, { timeoutMs: this.timeoutMs }) : null;
    let rejectAbort, timer, settleTimer, settleResolve, buffer = "", outputSize = 0, finished = false;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const cleanup = () => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(settleTimer); settleResolve?.();
      protocol?.close();
      for (const reply of child.controls.values()) reply({ subtype: "error" });
      child.controls.clear();
      // 점검 전용 프로세스 트리를 끊는다. 작업 중인 세션 프로세스는 이 경로에 들어오지 않는다.
      try {
        if (child.pid) {
          if (process.platform === "win32") this.runner.kill(child);
          else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill?.("SIGKILL"); } }
        } else child.kill?.("SIGKILL");
      } catch { /* 이미 끝난 프로세스여도 스트림과 대기 중인 요청을 정리한다. */ }
      finally {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        this.probes.delete(child);
      }
    };
    const abort = () => { if (!finished) { rejectAbort(new Error(FAILED)); cleanup(); } };
    this.probes.set(child, abort);
    child.once("error", abort); child.once("close", abort);
    child.stdin.on("error", abort);
    child.stderr.on("data", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (finished) return;
      outputSize += chunk.length; buffer += chunk;
      if (outputSize > 16_000_000 || buffer.length > 4_000_000) return abort();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (protocol) { protocol.handleLine(line); continue; }
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "control_response") child.controls.get(msg.response?.request_id)?.(msg.response);
        else if (msg.type === "control_request") {
          // 점검 전용 연결에서는 권한·대화 요청을 자동 승인하지 않는다.
          const response = msg.request?.subtype === "can_use_tool"
            ? { subtype: "success", request_id: msg.request_id, response: { behavior: "deny", message: "MCP 상태 점검에서는 도구를 실행하지 않습니다." } }
            : { subtype: "error", request_id: msg.request_id, error: "MCP status probe does not support this request" };
          try { child.stdin.write(JSON.stringify({ type: "control_response", response }) + "\n"); } catch { abort(); }
        }
      }
    });
    timer = setTimeout(abort, this.timeoutMs);
    const deadline = Date.now() + this.timeoutMs;
    const run = async () => {
      if (protocol) { await protocol.initialize(); return codexStatus(protocol, null, this.timeoutMs); }
      await claudeRequest(child, JSON.parse(agent.initLine()).request, this.timeoutMs);
      let result = await claudeRequest(child, { subtype: "mcp_status" }, this.timeoutMs);
      const settleDeadline = Math.min(Date.now() + this.settleBudgetMs, deadline - this.settleMs);
      for (let attempt = 0; attempt < 12; attempt++) {
        if (!Array.isArray(result.mcpServers)) throw new Error(FAILED);
        if (!result.mcpServers.some((server) => server.status === "pending") && (result.mcpServers.length || attempt > 0)) break;
        if (Date.now() >= settleDeadline) break;
        await new Promise((resolve) => {
          settleResolve = resolve;
          settleTimer = setTimeout(resolve, Math.min(this.settleMs, settleDeadline - Date.now()));
        });
        settleResolve = null;
        if (finished) throw new Error(CLOSED);
        result = await claudeRequest(child, { subtype: "mcp_status" }, this.timeoutMs);
      }
      return result.mcpServers;
    };
    try { return await Promise.race([run(), aborted]); }
    finally { cleanup(); }
  }
}

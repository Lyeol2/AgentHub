import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as codex from "./agents/codex.mjs";
import { isImageAttachment } from "./attachments.mjs";
import { attachmentInputText } from "./attachment-input.mjs";
import { codexToolLabel } from "./tool-labels.mjs";

const ACTIVE_WRITER = /\bthread\b[^\r\n]*\balready has an active writer\b/i;
const MISSING_THREAD = /no (?:conversation|thread|rollout)(?: found)?|thread[^\r\n]*(?:not found|does not exist)|unable to (?:find|load)[^\r\n]*(?:thread|rollout)/i;
const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"]);
const snippet = (value, max = 4000) => { const text = typeof value === "string" ? value : JSON.stringify(value ?? ""); return text.length > max ? text.slice(0, max) + "\n…" : text; };
export const codexInput = (text, attachments = []) => [{ type: "text", text }, ...attachments.map((attachment) => isImageAttachment(attachment)
  ? { type: "localImage", path: attachment.path }
  : { type: "text", text: attachmentInputText(attachment) })];

// 한 CLI 프로세스의 요청·응답·승인 수명만 담당한다. 세션 상태와 기록은 Runner가 관리한다.
export class CodexAppServer extends EventEmitter {
  constructor(child, session, { resolved = codex.resolveModel(session), timeoutMs = 60000, resumeRetryMs = 300 } = {}) {
    super();
    this.child = child;
    this.session = session;
    this.resolved = resolved;
    this.timeoutMs = timeoutMs;
    this.resumeRetryMs = resumeRetryMs;
    this.resumeWait = null;
    this.missingConversation = false;
    this.requests = new Map();
    this.approvals = new Map();
    this.items = new Map();
    this.completedTurns = new Set();
    this.threadId = null;
    this.turnId = null;
    this.closed = false;
    this.stopping = false;
    this.counter = 0;
  }

  write(message) {
    if (this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) throw new Error("Codex 연결이 끝났습니다.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error("Codex 연결이 끝났습니다."));
    const id = "agenthub-" + ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error("Codex 응답 시간 초과: " + method)); }, timeoutMs);
      timer.unref?.();
      this.requests.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (err) { clearTimeout(timer); this.requests.delete(id); reject(err); }
    });
  }

  // MCP 점검은 프로토콜만 초기화한다. 대화 생성·재개나 모델 턴은 시작하지 않는다.
  initialize() {
    return this.initialization ??= this.request("initialize", { clientInfo: { name: "agenthub", title: "AgentHub", version: "0.2.0" }, capabilities: {} })
      .then(() => {
        if (this.closed || this.stopping) throw new Error("Codex 연결이 끝났습니다.");
        this.write({ method: "initialized", params: {} });
        this.initialized = true;
        this.emit("initialized");
      });
  }

  async start(text, attachments = []) {
    try {
      await this.initialize();
      if (this.stopping || this.closed) return this.shutdown();
      const params = { cwd: this.session.cwd, ...codex.permissionSettings(this.session) };
      if (this.resolved.model) params.model = this.resolved.model;
      let result;
      if (this.session.agentSessionId) result = await this.resumeThread(params);
      else result = await this.request("thread/start", params);
      if (this.stopping || this.closed) return this.shutdown();
      this.threadId = result.thread?.id;
      if (!this.threadId) throw new Error("Codex가 대화 ID를 반환하지 않았습니다.");
      this.emit("threadReady");
      this.emit("event", { kind: "status", text: "세션 시작", agentSessionId: this.threadId });
      const turn = { threadId: this.threadId, input: codexInput(text, attachments) };
      if (this.resolved.effort) turn.effort = this.resolved.effort;
      const started = await this.request("turn/start", turn);
      if (!this.stopping && !this.closed && started.turn?.status === "inProgress" && !this.completedTurns.has(started.turn.id)) this.turnId = started.turn.id;
      if (this.stopping && this.turnId) this.interrupt();
    } catch (err) {
      if (!this.closed && !this.stopping) this.emit("event", { kind: "error", text: "Codex 연결 실패: " + err.message });
      // 대화를 찾지 못한 경우 Runner가 stderr를 보고 새 대화로 한 번 다시 시작한다.
      if (err.missingConversation) { this.missingConversation = true; this.child.stderr.emit("data", err.message); }
      this.shutdown();
    }
  }

  async resumeThread(params) {
    const threadId = this.session.agentSessionId;
    const resume = () => this.request("thread/resume", { ...params, threadId });
    try { return await resume(); }
    catch (err) {
      if (!ACTIVE_WRITER.test(err.message)) {
        // 없는 대화만 Runner의 기존 복구를 사용한다. 미지원 RPC·인증 오류는 대화를 버리지 않는다.
        if (err.code !== -32601 && !/method[^\r\n]*not found/i.test(err.message) && MISSING_THREAD.test(err.message)) {
          err.missingConversation = true;
          err.message = "No conversation found with session ID: " + err.message;
        }
        throw err;
      }
    }
    if (this.stopping || this.closed) return null;
    this.emit("event", { kind: "status", text: "다른 Codex 연결이 이 대화를 사용 중입니다. 잠시 후 다시 연결합니다." });
    if (this.stopping || this.closed) return null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.resumeWait = null; resolve(); }, this.resumeRetryMs);
      this.resumeWait = { timer, resolve };
    });
    if (this.stopping || this.closed) return null;
    try { return await resume(); }
    catch (err) { if (!ACTIVE_WRITER.test(err.message)) throw err; }
    if (this.stopping || this.closed) return null;
    // 원래 연결을 끊거나 빈 대화로 바꾸지 않고 저장된 기록을 이어받는다.
    const result = await this.request("thread/fork", { ...params, threadId });
    if (!this.stopping && !this.closed) this.emit("event", { kind: "status", text: "기존 대화가 다른 Codex 연결에서 열려 있어, 저장된 기록을 복사한 새 대화로 이어갑니다. 원래 대화는 그대로 남습니다." });
    return result;
  }

  cancelResumeWait() {
    if (!this.resumeWait) return;
    const { timer, resolve } = this.resumeWait;
    this.resumeWait = null;
    clearTimeout(timer);
    resolve();
  }

  handleLine(line) {
    if (this.closed) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.emit("event", { kind: "log", text: line }); return; }
    if (msg.method && msg.id !== undefined) return this.serverRequest(msg);
    if (msg.id !== undefined) {
      const pending = this.requests.get(msg.id);
      if (!pending) return;
      this.requests.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || "Codex RPC 오류"), { code: msg.error.code }));
      else pending.resolve(msg.result ?? {});
      return;
    }
    const p = msg.params ?? {};
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (msg.method === "serverRequest/resolved") {
      for (const [id, approval] of this.approvals) if (approval.rpcId === p.requestId) { this.approvals.delete(id); this.emit("cancel", id); }
      return;
    }
    if (msg.method === "turn/started") {
      if (this.completedTurns.has(p.turn?.id)) return;
      this.turnId = p.turn?.id ?? null; this.items.clear();
      if (this.stopping) this.interrupt();
      return;
    }
    if (msg.method === "turn/completed") {
      if (this.turnId && p.turn?.id !== this.turnId) return;
      if (p.turn?.id) this.completedTurns.add(p.turn.id);
      this.turnId = null;
      this.clearApprovals(false);
      const turn = p.turn ?? {};
      this.emit("event", turn.status === "completed"
        ? { kind: "result", text: "턴 완료", final: true }
        : { kind: turn.status === "interrupted" ? "log" : "error", text: turn.error?.message || (turn.status === "interrupted" ? "턴을 중단했습니다." : "턴 실패"), final: true });
      return;
    }
    if (msg.method === "error") return this.emit("event", { kind: p.willRetry ? "log" : "error", text: p.error?.message || "Codex 오류" });
    if (msg.method === "configWarning" || msg.method === "warning") return this.emit("event", { kind: "log", text: p.message || [p.summary, p.details].filter(Boolean).join("\n") });
    if (msg.method === "thread/tokenUsage/updated") {
      const usage = p.tokenUsage;
      if (usage) this.emit("event", { kind: "usage", context: { used: usage.last?.totalTokens ?? usage.total?.totalTokens, window: usage.modelContextWindow } });
      return;
    }
    if (msg.method === "turn/plan/updated") return this.emit("event", { kind: "status", text: (p.plan ?? []).map((item) => (item.status === "completed" ? "☑ " : "☐ ") + item.step).join("\n") });
    if (msg.method === "item/started" || msg.method === "item/completed") this.item(msg.method === "item/completed", p.item ?? {});
  }

  item(completed, item) {
    if (item.id) this.items.set(item.id, item);
    const event = (kind, text, extra = {}) => this.emit("event", { kind, text, ...extra });
    // 도구 줄에는 한국어 동작 이름을 붙인다(결과 줄에는 붙이지 않는다).
    const label = codexToolLabel(item);
    const tool = (text) => event("tool", text, label ? { label } : {});
    switch (item.type) {
      case "agentMessage": if (completed && item.text) event("text", item.text); break;
      case "reasoning": if (completed && item.summary?.length) event("thinking", item.summary.join("\n")); break;
      case "commandExecution":
        // 긴 명령은 첫 줄만 보이고 전체는 펼쳐 볼 수 있게 한다. 앞에는 한국어 동작 이름을 붙인다.
        if (!completed) { const { text, detail } = codex.commandEvent(item.command); event("tool", text, { ...(label ? { label } : {}), ...(detail ? { detail } : {}) }); }
        else event("tool_result", snippet((item.aggregatedOutput ?? "") + (item.exitCode != null && item.exitCode !== 0 ? "\n(종료 코드 " + item.exitCode + ")" : "")), { isError: item.status === "failed" || item.status === "declined" || (item.exitCode != null && item.exitCode !== 0) });
        break;
      case "fileChange":
        if (completed) {
          const failed = item.status === "declined" || item.status === "failed";
          const prefix = item.status === "declined" ? "파일 변경 거절: " : failed ? "파일 변경 실패: " : "파일 변경: ";
          const summary = prefix + (item.changes ?? []).map((change) => (change.kind?.type ?? change.kind) + " " + change.path).join(", ");
          if (failed) event("tool_result", summary, { isError: true }); else tool(summary);
        }
        break;
      case "mcpToolCall":
        if (!completed) tool("MCP " + item.server + "." + item.tool);
        else event("tool_result", snippet(item.error?.message ?? item.error ?? (item.result?.content ?? []).map((content) => content.type === "text" ? content.text : "[" + content.type + "]").join("\n")), { isError: !!item.error });
        break;
      case "webSearch": if (!completed) tool("웹 검색: " + (item.query ?? "")); break;
      case "imageView": if (!completed) tool("이미지 보기: " + item.path); break;
      case "contextCompaction": if (completed) event("status", "컨텍스트를 압축했습니다.", { compact: true }); break;
      case "plan": if (completed && item.text) event("text", item.text); break;
    }
  }

  serverRequest(msg) {
    if (this.closed || this.child.stdin.writableEnded || this.child.stdin.destroyed) return;
    const params = msg.params ?? {};
    // MCP 도구 승인(elicitation)은 권한 카드로 묻는다. 그 밖의 elicitation은 지원하지 않아 거절한다.
    const mcpApproval = codex.isMcpApproval(msg.method, params);
    if (!APPROVALS.has(msg.method) && !mcpApproval) {
      // 지원하지 않는 승인을 빈 성공으로 처리하지 않는다.
      const response = msg.method === "mcpServer/elicitation/request"
        ? { id: msg.id, result: { action: "decline", content: null } }
        : { id: msg.id, error: { code: -32601, message: "AgentHub does not support this server request" } };
      this.write(response);
      this.emit("event", { kind: "status", text: "지원하지 않는 Codex 요청을 거절했습니다: " + msg.method });
      return;
    }
    // elicitation은 턴 ID를 모를 수 있어(null) 같은 대화인지만 본다.
    if (this.stopping || !this.threadId || params.threadId !== this.threadId || !this.turnId || (params.turnId !== this.turnId && !(mcpApproval && params.turnId == null))) {
      this.write({ id: msg.id, result: this.denial(msg.method) });
      return;
    }
    const item = this.items.get(params.itemId);
    const displayParams = { ...params };
    if (item?.type === "fileChange") displayParams.changes = item.changes;
    if (item?.type === "commandExecution") {
      displayParams.command ??= item.command;
      displayParams.cwd ??= item.cwd;
    }
    const id = "codex-" + randomUUID();
    this.approvals.set(id, { rpcId: msg.id, method: msg.method });
    this.emit("control", { request_id: id, request: { method: msg.method, params: displayParams } });
  }

  denial(method) {
    return method === codex.MCP_APPROVAL ? { action: "decline", content: null }
      : method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
      : method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "cancel" };
  }

  respond(id, result) {
    const approval = this.approvals.get(id);
    if (!approval || this.stopping || this.closed) throw new Error("이미 답했거나 끝난 요청입니다.");
    this.write({ id: approval.rpcId, result });
    this.approvals.delete(id);
  }

  clearApprovals(reply = true) {
    for (const [id, approval] of this.approvals) {
      if (reply && !this.closed) { try { this.write({ id: approval.rpcId, result: this.denial(approval.method) }); } catch {} }
      this.emit("cancel", id);
    }
    this.approvals.clear();
  }

  canInject() { return !!this.turnId && !this.stopping && !this.closed; }
  // turn/steer 응답으로 실제 반영 여부를 알린다. { applied: true } 또는 { applied: false, error }로 끝나며 거부하지 않는다.
  // 반영하지 못한 요청은 Runner가 대기열로 되돌린다.
  inject(text, attachments = []) {
    if (!this.canInject()) throw new Error("Codex가 요청을 준비 중이거나 이미 턴을 마쳤습니다. 대기열에 넣으세요.");
    return this.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: codexInput(text, attachments) })
      .then(() => ({ applied: true }), (err) => ({ applied: false, error: err.message }));
  }

  interrupt() {
    if (this.closed || this.ending) return;
    this.stopping = true;
    this.clearApprovals();
    if (this.turnId && !this.closed) this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => this.shutdown());
    else this.shutdown();
  }

  shutdown() {
    if (this.closed || this.ending) return;
    this.ending = true;
    this.stopping = true;
    this.cancelResumeWait();
    this.clearApprovals();
    this.child.stdin.end();
    this.emit("shutdown");
  }

  close() {
    this.cancelResumeWait();
    this.clearApprovals(false);
    this.closed = true;
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex 연결이 끝났습니다.")); }
    this.requests.clear();
    this.emit("close");
  }
}

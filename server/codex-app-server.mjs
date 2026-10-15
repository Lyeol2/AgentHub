import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as codex from "./agents/codex.mjs";

const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"]);
const snippet = (value, max = 4000) => { const text = typeof value === "string" ? value : JSON.stringify(value ?? ""); return text.length > max ? text.slice(0, max) + "\n…" : text; };
export const codexInput = (text, attachments = []) => [{ type: "text", text }, ...attachments.map(({ path }) => ({ type: "localImage", path }))];

// 한 CLI 프로세스의 요청·응답·승인 수명만 담당한다. 세션 상태와 기록은 Runner가 관리한다.
export class CodexAppServer extends EventEmitter {
  constructor(child, session, { resolved = codex.resolveModel(session), timeoutMs = 60000 } = {}) {
    super();
    this.child = child;
    this.session = session;
    this.resolved = resolved;
    this.timeoutMs = timeoutMs;
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

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("Codex 연결이 끝났습니다."));
    const id = "agenthub-" + ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error("Codex 응답 시간 초과: " + method)); }, this.timeoutMs);
      timer.unref?.();
      this.requests.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (err) { clearTimeout(timer); this.requests.delete(id); reject(err); }
    });
  }

  async start(text, attachments = []) {
    try {
      await this.request("initialize", { clientInfo: { name: "agenthub", title: "AgentHub", version: "0.2.0" }, capabilities: {} });
      if (this.stopping || this.closed) return this.shutdown();
      this.write({ method: "initialized", params: {} });
      const params = { cwd: this.session.cwd, sandbox: this.session.permission ?? "workspace-write", approvalPolicy: this.session.chat ? "never" : "on-request", approvalsReviewer: "user" };
      if (this.resolved.model) params.model = this.resolved.model;
      let result;
      if (this.session.agentSessionId) {
        try { result = await this.request("thread/resume", { ...params, threadId: this.session.agentSessionId }); }
        catch (err) {
          // 기존 Runner의 대화 복구 재시도를 그대로 사용한다.
          if (/not found|no (?:conversation|thread|rollout)|unable to (?:find|load)|does not exist/i.test(err.message)) err.message = "No conversation found with session ID: " + err.message;
          throw err;
        }
      } else result = await this.request("thread/start", params);
      if (this.stopping || this.closed) return this.shutdown();
      this.threadId = result.thread?.id;
      if (!this.threadId) throw new Error("Codex가 대화 ID를 반환하지 않았습니다.");
      this.emit("event", { kind: "status", text: "세션 시작", agentSessionId: this.threadId });
      const turn = { threadId: this.threadId, input: codexInput(text, attachments) };
      if (this.resolved.effort) turn.effort = this.resolved.effort;
      const started = await this.request("turn/start", turn);
      if (!this.stopping && !this.closed && started.turn?.status === "inProgress" && !this.completedTurns.has(started.turn.id)) this.turnId = started.turn.id;
      if (this.stopping && this.turnId) this.interrupt();
    } catch (err) {
      if (!this.closed && !this.stopping) this.emit("event", { kind: "error", text: "Codex 연결 실패: " + err.message });
      // 대화를 찾지 못한 경우 Runner가 stderr를 보고 새 대화로 한 번 다시 시작한다.
      if (/No conversation found with session ID/.test(err.message)) this.child.stderr.emit("data", err.message);
      this.shutdown();
    }
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
      if (msg.error) pending.reject(new Error(msg.error.message || "Codex RPC 오류"));
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
    switch (item.type) {
      case "agentMessage": if (completed && item.text) event("text", item.text); break;
      case "reasoning": if (completed && item.summary?.length) event("thinking", item.summary.join("\n")); break;
      case "commandExecution":
        if (!completed) event("tool", "$ " + (item.command ?? ""));
        else event("tool_result", snippet((item.aggregatedOutput ?? "") + "\n(종료 코드 " + (item.exitCode ?? "?") + ")"), { isError: item.status === "failed" || item.status === "declined" || (item.exitCode != null && item.exitCode !== 0) });
        break;
      case "fileChange":
        if (completed) {
          const failed = item.status === "declined" || item.status === "failed";
          const label = item.status === "declined" ? "파일 변경 거절: " : failed ? "파일 변경 실패: " : "파일 변경: ";
          event(failed ? "tool_result" : "tool", label + (item.changes ?? []).map((change) => (change.kind?.type ?? change.kind) + " " + change.path).join(", "), failed ? { isError: true } : {});
        }
        break;
      case "mcpToolCall":
        if (!completed) event("tool", "MCP " + item.server + "." + item.tool);
        else event("tool_result", snippet(item.error?.message ?? item.error ?? (item.result?.content ?? []).map((content) => content.type === "text" ? content.text : "[" + content.type + "]").join("\n")), { isError: !!item.error });
        break;
      case "webSearch": if (!completed) event("tool", "웹 검색: " + (item.query ?? "")); break;
      case "imageView": if (!completed) event("tool", "이미지 보기: " + item.path); break;
      case "contextCompaction": if (completed) event("status", "컨텍스트를 압축했습니다.", { compact: true }); break;
      case "plan": if (completed && item.text) event("text", item.text); break;
    }
  }

  serverRequest(msg) {
    if (this.closed || this.child.stdin.writableEnded || this.child.stdin.destroyed) return;
    const params = msg.params ?? {};
    if (!APPROVALS.has(msg.method)) {
      // 지원하지 않는 승인을 빈 성공으로 처리하지 않는다.
      const response = msg.method === "mcpServer/elicitation/request"
        ? { id: msg.id, result: { action: "decline", content: null } }
        : { id: msg.id, error: { code: -32601, message: "AgentHub does not support this server request" } };
      this.write(response);
      this.emit("event", { kind: "status", text: "지원하지 않는 Codex 요청을 거절했습니다: " + msg.method });
      return;
    }
    if (this.stopping || !this.threadId || params.threadId !== this.threadId || !this.turnId || params.turnId !== this.turnId) {
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
    return method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
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
  inject(text, attachments = []) {
    if (!this.canInject()) throw new Error("Codex가 요청을 준비 중이거나 이미 턴을 마쳤습니다. 대기열에 넣으세요.");
    this.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: codexInput(text, attachments) })
      .catch((err) => { if (!this.closed && !this.stopping) this.emit("event", { kind: "error", text: "추가 요청 전달 실패: " + err.message }); });
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
    this.clearApprovals();
    this.child.stdin.end();
    this.emit("shutdown");
  }

  close() {
    this.clearApprovals(false);
    this.closed = true;
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex 연결이 끝났습니다.")); }
    this.requests.clear();
  }
}

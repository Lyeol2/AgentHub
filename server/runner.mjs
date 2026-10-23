import { assertSessionGitContext } from "./git-context.mjs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as claude from "./agents/claude.mjs";
import * as codex from "./agents/codex.mjs";
import { spawnCli, killProcessTree, missingFolder } from "./cli.mjs";
import { CodexAppServer } from "./codex-app-server.mjs";
import { unityControl, isUnityCommand } from "./unity-control.mjs";
import { stopwatch } from "./timing.mjs";
import { applySubtask, addSubtaskActivity, settleSubtasks, activeSubtasks } from "./subtasks.mjs";
import { McpStatusService } from "./mcp-status.mjs";
import { recordCompletion } from "./session-read.mjs";

const publicMeta = (meta) => ({ ...meta, ...(meta.attachments ? { attachments: meta.attachments.map(({ id, name, mimeType, size, url }) => ({ id, name, mimeType, size, url })) } : {}) });

export const AGENTS = { claude, codex };

const MISSING_CONVERSATION = /No conversation found with session ID/i;
// CLI가 실행할 때마다 stderr에 남기는 경고. 종료 원인이 아니므로 오류 본문에 붙이지 않는다.
const STDERR_NOISE = [
  /unrecognized configuration setting/i,
  /^\s*user \(.*config\.toml\): .* is ignored\.?\s*$/i,
  /rmcp::transport::worker: worker quit/i,
];
// stderr에서 알려진 경고 줄을 뺀 끝부분
export function stderrSummary(text, lines = 15) {
  return String(text ?? "").split(/\r?\n/).filter((line) => line.trim() && !STDERR_NOISE.some((noise) => noise.test(line))).slice(-lines).join("\n");
}
// stderr 요약에서 원인을 말하는 한 줄. 스택 추적·버전 줄보다 오류 문장을 고른다.
export function stderrCause(summary) {
  const lines = String(summary ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.findLast((line) => !/^at\s/.test(line) && /\berror\b|failed|panicked|not found|cannot|denied/i.test(line)) ?? lines.at(-1) ?? "";
}
const INJECT_GRACE_MS = 4000;
export const INTERRUPT_GRACE_MS = 10000;
const STOP_TASK_TIMEOUT_MS = 10000;
const PERMISSION_MODE_TIMEOUT_MS = 10000;
// 하위 작업이 모두 끝나면 CLI가 곧바로 결과를 정리하는 턴을 시작하는 경우가 많다. 그동안 대기로 깜빡이지 않게 잠시 기다린다.
const BACKGROUND_SETTLE_MS = 2000;
// 턴을 마친 CLI를 띄워 두는 기본값. 서버 설정(config.cliKeepAlive)으로 바꾼다. idleMinutes가 0이면 백그라운드 작업이 없을 때 바로 닫는다.
export const KEEP_ALIVE_DEFAULTS = { idleMinutes: 15, maxProcesses: 8 };
// 마지막 출력 시각은 출력마다 알리지 않고 이 간격에 한 번만 화면에 알린다(화면은 실시간 이벤트의 시각도 함께 쓴다).
export const ACTIVITY_NOTIFY_MS = 3000;
// 답을 쓰는 중인 글자 조각은 모아서 이 간격으로 보낸다.
const DRAFT_FLUSH_MS = 120;
// 이 종류의 이벤트가 기록에 남으면 쓰는 중이던 글은 끝난 것이다.
const DRAFT_END = new Set(["text", "thinking", "tool", "result", "error"]);
const inputClosed = (child) => !!(child.stdin?.writableEnded || child.stdin?.destroyed);
// 중지·일시중지는 오래 기다리지 않는다. 턴이 정상으로 끝나기를 잠깐 기다린 뒤 강제로 멈춘다.
export const STOP_GRACE_MS = 1500; // Codex 중지: turn/interrupt의 응답을 기다리는 시간
export const PAUSE_GRACE_MS = 4000; // 일시중지: 대화 기록이 온전히 남도록 턴이 끝나기를 기다리는 시간
export const EXIT_GRACE_MS = 1000; // 멈춘 턴이 끝난 뒤 CLI가 스스로 종료하기를 기다리는 시간

// 세션 하나에 한 번에 한 턴만 실행한다. 다른 세션은 동시에 실행할 수 있다.
// 세션 상태: idle | running | background(턴은 끝났고 하위 작업이 CLI에서 도는 중. 새 요청은 같은 CLI에 바로 쓴다) | paused | error | interrupted
export class Runner extends EventEmitter {
  constructor(store, { spawn = spawnCli, isUpdating = () => false, keepAlive = () => KEEP_ALIVE_DEFAULTS } = {}) {
    super();
    this.store = store;
    this.spawn = spawn;
    this.isUpdating = isUpdating;
    this.running = new Map(); // 세션 ID → 지금 턴을 실행 중인 CLI
    this.procs = new Map(); // 세션 ID → 떠 있는 CLI(턴 사이에 쉬는 프로세스·백그라운드 작업 중인 프로세스 포함)
    this.closing = new Set(); // 닫으라고 했지만 아직 끝나지 않은 CLI(실행 파일을 잡고 있다)
    // 띄워 두기 설정({ idleMinutes, maxProcesses }). 서버가 정한다.
    this.keepAlive = keepAlive;
    this.prompts = new Map(); // CLI가 실행 중에 물은 요청 ID → { session, child, agent, control, event }
    // 세션에 붙일 AgentHub MCP 서버 정보를 돌려주는 함수(session → { url, configFile } | null). 서버가 정한다.
    this.mcp = () => null;
    // 지금 연결할 수 없는 사용자 Codex MCP 서버 이름(() → string[]). 서버가 정한다.
    this.unreachableMcp = () => [];
    this.mcpNotes = new Map(); // 세션 ID → 마지막으로 알린 꺼진 MCP 목록
    // 세션 프로젝트의 "유니티 사용" 설정(session → "ask" | "allow" | "off"). 서버가 정한다.
    this.unityMode = () => "allow";
    this.activitySent = new Map(); // 세션 ID → 진행 상태를 마지막으로 알린 시각
    this.draftSeq = 0;
    this.mcpInspector = new McpStatusService(this, AGENTS);
  }

  mcpStatus(session, cliPath) { return this.mcpInspector.status(session, cliPath); }
  reconnectMcp(session, serverName) { return this.mcpInspector.reconnect(session, serverName); }
  reloadMcp(session) { return this.mcpInspector.reload(session); }

  // ── 진행 상태 ───────────────────────────────────────────────────
  // runPhase: starting(CLI를 띄우고 첫 출력을 기다림) | working(출력이 오기 시작함). lastOutputAt: CLI의 마지막 출력 시각.
  // waiting: 권한·질문 답을 기다림(출력이 없어도 멈춘 것이 아니다).
  activity(session, now = Date.now()) {
    this.activitySent.set(session.id, now);
    this.emit("activity", session.id, { runPhase: session.runPhase ?? null, lastOutputAt: session.lastOutputAt ?? null, waiting: !!session.waiting });
  }

  markOutput(session, clock = null) {
    const now = Date.now();
    session.lastOutputAt = new Date(now).toISOString();
    const first = session.runPhase === "starting";
    if (first) {
      session.runPhase = "working";
      clock?.step("첫 출력까지");
    }
    if (first || now - (this.activitySent.get(session.id) ?? 0) >= ACTIVITY_NOTIFY_MS) this.activity(session, now);
  }

  // 이미 남긴 이벤트의 일부를 바꾸고 화면에 알린다(추가 요청의 반영 상태 등).
  updateEvent(session, event, patch) {
    Object.assign(event, patch);
    this.store.touch(session, { event });
    this.emit("eventUpdate", session.id, event.seq, patch);
  }

  // 답을 쓰는 중인 글(Claude stream_event). 기록에는 남기지 않고 모아서 화면에만 보낸다.
  draft(session, child, event) {
    if (event.reset || !child.draft) {
      clearTimeout(child.draft?.timer);
      child.draft = { id: `${session.id}-${++this.draftSeq}`, pending: "", timer: null };
    }
    if (!event.text) return;
    child.draft.pending += event.text;
    if (child.draft.timer) return;
    const draft = child.draft;
    draft.timer = setTimeout(() => {
      draft.timer = null;
      if (child.draft !== draft || !draft.pending) return;
      this.emit("draft", session.id, { draftId: draft.id, text: draft.pending });
      draft.pending = "";
    }, DRAFT_FLUSH_MS);
  }

  endDraft(child) {
    clearTimeout(child.draft?.timer);
    child.draft = null;
  }

  // 지금 작업에 반영하지 못한 추가 요청. 사용자가 중지한 경우가 아니면 대기열 앞으로 되돌려 지금 작업이 끝난 뒤 보낸다.
  returnInjected(session, records, reason) {
    if (!records.length) return;
    const dropped = this.shuttingDown || (session.stopRequested && !session.paused);
    for (const record of records) this.updateEvent(session, record.event, { delivery: dropped ? "dropped" : "requeued" });
    if (dropped) {
      this.append(session, { kind: "status", text: `중지해서 지금 작업에 반영하지 못한 추가 요청 ${records.length}개는 보내지 않았습니다.` });
      return;
    }
    this.append(session, { kind: "status", text: `${reason} 반영하지 못한 추가 요청 ${records.length}개를 대기열로 되돌렸습니다. 지금 작업이 끝나면 차례로 보냅니다.` });
    this.emit("requeue", session, records.map(({ text, meta }) => ({ text, meta })));
  }

  // ── 실행 중 질문·권한 요청 ──────────────────────────────────────
  // CLI는 답을 받을 때까지 기다린다. 화면에는 질문 카드나 권한 요청 카드로 보인다.
  ask(session, child, agent, msg) {
    const control = agent.parseControl(msg, session);
    if (!control) {
      // 화면에 물을 필요가 없는 요청에는 빈 성공으로 답해 CLI가 멈추지 않게 한다.
      child.stdin.write(`${agent.controlResponse(msg.request_id, {})}\n`);
      return;
    }
    // 이 세션에서 계속 허용한 요청은 묻지 않고 허용하고, 유니티를 끈 프로젝트의 유니티 명령은 거절한다.
    const auto = this.autoDecision(session, agent, control);
    if (auto) {
      const response = agent.permissionResponse(control, auto, auto === "deny" ? "프로젝트 설정에서 유니티 사용을 꺼 두었습니다." : undefined);
      if (child.appServer) child.appServer.respond(msg.request_id, response);
      else child.stdin.write(`${agent.controlResponse(msg.request_id, response)}\n`);
      this.append(session, { kind: "status", text: auto === "deny" ? `유니티 사용을 끈 프로젝트라 거절했습니다: ${control.text}` : `이 세션에서 계속 허용한 요청이라 허용했습니다: ${control.text}` });
      return;
    }
    const id = msg.request_id;
    const event = control.kind === "question"
      ? { kind: "question", questionId: id, status: "pending", text: "질문", questions: control.questions, live: true }
      : { kind: "permission", requestId: id, status: "pending", tool: control.tool, text: control.text, detail: control.detail, reason: control.reason, canRemember: (control.suggestions?.length ?? 0) > 0, promptId: id, ...(control.planApproval ? { planApproval: true } : {}), ...(control.rememberLabel ? { rememberLabel: control.rememberLabel, rememberDescription: control.rememberDescription } : {}) };
    session.waiting = true;
    const full = this.append(session, event);
    this.prompts.set(id, { session, child, agent, control, event: full });
    this.activity(session);
  }

  // 저장한 허용 규칙(agent.ruleMatches가 있는 CLI)과 유니티 통제로 화면에 묻지 않고 답할 결정. 없으면 null.
  // Claude는 규칙을 실행 설정(--settings)으로 넘겨 CLI가 직접 판단하므로 여기서는 Codex만 해당한다.
  autoDecision(session, agent, control) {
    if (control.kind !== "permission" || !agent.ruleMatches) return null;
    const unity = session.chat ? "allow" : this.unityMode(session);
    // 실행 전 확인이면 저장한 규칙이 있어도 유니티 명령은 매번 묻는다.
    if (unity !== "allow" && isUnityCommand(control.input?.command)) return unity === "off" ? "deny" : null;
    return (session.allowRules ?? []).some((rule) => rule.agent === session.agent && agent.ruleMatches(rule, control)) ? "allow" : null;
  }

  // "이 세션에서 계속 허용"한 결정을 세션에 남긴다. 다음 실행에서 CLI를 새로 띄워도 다시 적용한다.
  remember(session, agent, control) {
    const { rules = [], mode = null } = agent.rememberedRules?.(control) ?? {};
    const saved = [...(session.allowRules ?? [])];
    const createdAt = new Date().toISOString();
    for (const rule of rules) if (!saved.some((r) => r.agent === session.agent && r.key === rule.key)) saved.push({ ...rule, agent: session.agent, createdAt });
    if (saved.length !== (session.allowRules ?? []).length) session.allowRules = saved;
    // 띄워 둔 CLI에는 같은 규칙이 이미 적용됐다(범위 session). 다음 요청에서 다시 띄우지 않게 맞춘다.
    const child = this.procs.get(session.id);
    if (child) child.rules = ruleKey(session);
    // 권한 모드를 바꾸자는 제안(예: 파일 수정 허용)은 세션 권한에도 남긴다.
    if (mode && mode !== "plan" && agent.PERMISSION_MODES.includes(mode)) session.permission = mode;
  }

  // 세션 설정에서 바꾼 권한을 CLI에 요청한다. true는 전송했음을 뜻하며, 적용 결과는 CLI 응답으로 알린다.
  // 쉬고 있거나 백그라운드 작업 중인 CLI에도 적용한다(하위 작업의 권한 요청에 쓰인다).
  setPermissionMode(session) {
    const child = this.running.get(session.id) ?? this.procs.get(session.id);
    const agent = AGENTS[session.agent];
    if (!child || child.retired || child.appServer || !agent.permissionModeLine || session.planTurn || inputClosed(child)) return false;
    return this.requestPermissionMode(session, child, agent, session.permission, { notifySuccess: true });
  }

  requestPermissionMode(session, child, agent, mode, { notifySuccess = false } = {}) {
    const id = `mode-${randomUUID()}`;
    child.permissionRequestId = id;
    // 시작할 때 선택하지 않은 bypass는 실행 중에 켤 수 없다. 다음 실행에서 사용자가 고른 설정을 적용한다.
    if (mode === "bypassPermissions" && !child.canBypassPermissions) {
      child.permissionRestart = true;
      return false;
    }
    const finish = (response) => {
      clearTimeout(timer);
      child.controls.delete(id);
      // 더 최근의 변경이 있거나 이미 교체한 CLI의 응답은 현재 설정의 결과로 알리지 않는다.
      if (child.retired || child.permissionRequestId !== id) return;
      const confirmed = response?.subtype === "success";
      child.permissionRestart = !confirmed;
      if (confirmed) {
        if (notifySuccess) this.append(session, { kind: "status", text: `Claude가 권한 ${mode} 적용을 확인했습니다. 이후 도구 요청부터 적용됩니다.` });
      } else {
        this.append(session, { kind: "status", text: `Claude 권한 ${mode} 적용을 확인하지 못했습니다: ${response?.error ?? "알 수 없는 오류"}. 현재 CLI의 권한은 변경 전 상태일 수 있습니다. 진행 중인 작업이 끝난 뒤 다음 요청에서 CLI를 다시 실행합니다.` });
      }
    };
    const timer = setTimeout(() => finish({ subtype: "error", error: "CLI가 10초 안에 응답하지 않았습니다" }), PERMISSION_MODE_TIMEOUT_MS);
    timer.unref?.();
    child.controls.set(id, finish);
    child.stdin.write(`${agent.permissionModeLine(mode, id)}\n`);
    return true;
  }

  // 실행 중인 턴에 요청을 붙인다. CLI가 같은 작업에 반영할 수 있을 때만 허용한다.
  // 입력을 이미 닫은 CLI(턴을 마치고 끝나는 중)에는 붙일 수 없다. 써도 CLI가 읽지 못해 요청이 사라진다.
  canInject(session) {
    if (this.shuttingDown) return false;
    const child = this.running.get(session.id);
    return !!child && !child.retired && (child.appServer ? child.appServer.canInject() : !!AGENTS[session.agent].interactive && !inputClosed(child));
  }

  // meta: 요청 이벤트에 덧붙일 값(보낸 세션 등)
  // input: CLI에 실제로 넘길 내용(@참조를 풀어 쓴 요청 등). 화면에는 text만 남긴다.
  inject(session, text, meta = {}, input = text) {
    if (this.shuttingDown) throw new Error("서버가 종료 중입니다.");
    const child = this.running.get(session.id);
    const agent = AGENTS[session.agent];
    if (!child) throw new Error("실행 중이 아닙니다.");
    if (!agent.interactive && !child.appServer) throw new Error(`${session.agent}는 실행 중인 작업에 요청을 붙일 수 없습니다. 대기열에 넣으세요.`);
    if (!child.appServer && inputClosed(child)) throw new Error("지금 작업이 끝나는 중이라 붙일 수 없습니다. 대기열에 넣으세요.");
    const reply = child.appServer ? child.appServer.inject(input, meta.attachments) : null;
    if (!child.appServer) child.stdin.write(`${agent.userLine(input, meta.attachments)}\n`);
    child.injected = (child.injected ?? 0) + 1;
    child.emit?.("injected");
    // delivery: sent(CLI에 보냄) → applied(CLI가 받아 반영함) | requeued(반영하지 못해 대기열로 되돌림) | dropped(중지해서 보내지 않음)
    const event = this.append(session, { kind: "user", text, ...publicMeta(meta), injected: true, delivery: "sent" });
    const record = { event, text, meta, input };
    // Claude는 CLI가 요청을 돌려주면(--replay-user-messages) 반영한 것으로 본다. Codex는 turn/steer 응답으로 안다.
    if (!child.appServer) (child.pendingInputs ??= []).push(record);
    else if (reply?.then) {
      const pending = Promise.resolve(reply).then(result => {
        if (result?.applied) this.updateEvent(session, event, { delivery: "applied" });
        else this.returnInjected(session, [record], `Codex가 지금 작업에 받지 않아(${result?.error ?? "응답 없음"})`);
      }).finally(() => child.pendingInjections.delete(pending));
      (child.pendingInjections ??= new Set()).add(pending);
    }
  }

  // CLI가 돌려준 사용자 요청을 보낸 요청과 맞춘다. 처음 보낸 요청(event 없음)도 같은 목록에 있다.
  confirmInput(session, child, text) {
    child.sawReplay = true;
    const pending = child.pendingInputs ?? [];
    const index = pending.findIndex((record) => record.input === text);
    if (index < 0) return;
    const [record] = pending.splice(index, 1);
    if (record.event?.delivery === "sent") this.updateEvent(session, record.event, { delivery: "applied" });
  }

  hasPrompt(id, sessionId) {
    return this.prompts.get(id)?.session.id === sessionId;
  }

  // 질문의 답(answers) 또는 권한 결정(decision)을 CLI에 돌려준다.
  answer(id, { answers, decision, message }) {
    const pending = this.prompts.get(id);
    if (!pending) throw new Error("이미 답했거나 끝난 요청입니다.");
    const { session, child, agent, control, event } = pending;
    const response = control.kind === "question"
      ? agent.questionResponse(control.input, answers)
      : agent.permissionResponse(control, decision, message);
    if (child.appServer) child.appServer.respond(id, response);
    else child.stdin.write(`${agent.controlResponse(id, response)}\n`);
    this.prompts.delete(id);
    if (control.kind === "question") {
      event.status = "answered";
      event.answers = answers;
    } else {
      event.status = decision === "deny" ? "denied" : "allowed";
      event.decision = decision;
      if (decision === "always") this.remember(session, agent, control);
    }
    session.waiting = this.waitingFor(session.id);
    this.store.touch(session, { event });
    this.activity(session);
    return event;
  }

  waitingFor(sessionId) {
    return [...this.prompts.values()].some((p) => p.session.id === sessionId);
  }

  // CLI가 끝나거나 요청을 거두면 답을 기다리던 카드를 지나간 것으로 바꾼다.
  dropPrompts(sessionId, onlyId = null) {
    for (const [id, p] of this.prompts) {
      if (p.session.id !== sessionId || (onlyId && id !== onlyId)) continue;
      p.event.status = "skipped";
      this.store.touch(p.session, { event: p.event });
      this.prompts.delete(id);
    }
    const session = this.store.get(sessionId);
    if (!session) return;
    const waiting = this.waitingFor(sessionId);
    const changed = !!session.waiting !== waiting;
    session.waiting = waiting;
    if (changed) this.activity(session);
  }

  append(session, event) {
    const full = { seq: session.events.length, ts: new Date().toISOString(), ...event };
    if (event.kind === "result") recordCompletion(session);
    session.events.push(full);
    this.store.touch(session, { appendOnly: true });
    this.emit("event", session.id, full);
    return full;
  }

  setState(session, state) {
    // 대기로 돌려도 CLI에서 하위 작업이 도는 중이면 백그라운드 작업 중으로 둔다.
    if (state === "idle" && this.procs.has(session.id) && activeSubtasks(session).length) state = "background";
    // 출력·추가 요청·CLI 재시도에도 현재 작업의 시작 시각은 유지한다.
    if (state === "running") {
      if (session.state !== "running" || !Number.isFinite(Date.parse(session.runningStartedAt))) {
        session.runningStartedAt = new Date().toISOString();
      }
    } else {
      session.runningStartedAt = null;
      // 진행 표시는 실행 중에만 쓴다.
      if ("runPhase" in session) delete session.runPhase;
      if ("lastOutputAt" in session) delete session.lastOutputAt;
    }
    session.state = state;
    this.store.touch(session, { metadataOnly: true });
    this.emit("state", session.id, state, session.runningStartedAt);
  }

  isRunning(id) {
    return this.running.has(id);
  }

  // 턴을 실행 중이거나 하위 작업(백그라운드 서브에이전트 등)이 도는 중이다. 작업 폴더를 지우거나 Git으로 바꾸면 안 되는 때다.
  isBusy(id) {
    return this.running.has(id) || (this.procs.has(id) && activeSubtasks(this.store.get(id)).length > 0);
  }

  // 턴 사이에도 CLI 프로세스가 떠 있다(쉬는 중 포함).
  hasProcess(id) {
    return this.procs.has(id);
  }

  keepAliveLimits() {
    const { idleMinutes, maxProcesses } = { ...KEEP_ALIVE_DEFAULTS, ...this.keepAlive() };
    return { idleMs: Math.max(0, Number(idleMinutes) || 0) * 60000, max: Math.max(1, Math.floor(Number(maxProcesses) || KEEP_ALIVE_DEFAULTS.maxProcesses)) };
  }

  // input은 CLI에 실제로 넘길 내용이다. 화면에는 prompt만 남긴다. meta는 요청 이벤트에 덧붙인다(넘어온 세션 등).
  // retry는 이어 갈 대화가 없어 새 대화로 다시 보낼 때 쓴다. 요청은 이미 화면에 있으므로 다시 남기지 않는다.
  // Claude는 턴을 마친 CLI를 띄워 둔다. 실행 조건이 같으면 새로 띄우지 않고 열린 입력에 요청을 쓴다.
  send(session, prompt, cliPath, input = prompt, meta = {}, retry = false) {
    if (this.shuttingDown) throw new Error("서버가 종료 중입니다.");
    if (this.running.has(session.id)) throw new Error("이 세션은 이미 실행 중입니다.");
    if (this.isUpdating(session.agent)) throw new Error(`${session.agent} CLI 업데이트 중입니다. 완료한 뒤 다시 시도하세요.`);
    // 단계별 소요 시간(AGENTHUB_DEBUG=timing일 때만 로그에 남는다)
    const clock = stopwatch("session.send", `${session.agent} ${session.id}`);
    assertSessionGitContext(session);
    clock.step("Git 작업 폴더 확인");
    if (!cliPath) throw new Error(`${session.agent} CLI를 찾지 못했습니다. 설정에서 경로를 지정하세요.`);

    const agent = AGENTS[session.agent];
    const disabledMcp = agent.transport === "app-server" ? this.unreachableMcp() : [];
    const unity = session.chat ? null : unityControl(this.unityMode(session), session);
    const options = { mcp: session.chat ? null : this.mcp(session), disabledMcp, unity };
    const args = agent.buildArgs(session, options);
    const key = agent.keepAlive ? processKey(agent, session, cliPath, options) : null;
    const userInput = agent.interactive ? agent.userLine(input, meta.attachments) : null;
    if (!retry) {
      // 답하지 않은 질문은 새 요청이 들어오면 지나간 것으로 본다.
      for (const e of session.events) if (e.kind === "question" && e.status === "pending") {
        e.status = "skipped";
        this.store.touch(session, { event: e });
      }
      session.waiting = false;
      this.append(session, { kind: "user", text: prompt, ...publicMeta(meta) });
      // 설정의 기본 모델을 쓸 수 없어 다른 모델로 실행하면 새 대화를 시작할 때 한 번 알린다.
      const note = !session.agentSessionId && agent.modelNote?.(session);
      if (note) this.append(session, { kind: "status", text: note });
      // 꺼진 MCP 목록이 바뀔 때만 알린다. 서버를 켜면 다음 요청부터 다시 쓴다.
      const mcpKey = disabledMcp.join(",");
      if (mcpKey !== (this.mcpNotes.get(session.id) ?? "")) {
        this.append(session, { kind: "status", text: mcpKey
          ? `Codex MCP 서버(${disabledMcp.join(", ")})에 연결할 수 없어 이번 요청에서는 끄고 실행합니다. 서버를 켜면 다음 요청부터 다시 씁니다.`
          : "Codex MCP 서버에 다시 연결할 수 있어 함께 실행합니다." });
        if (mcpKey) this.mcpNotes.set(session.id, mcpKey); else this.mcpNotes.delete(session.id);
      }
    }
    let child = this.reusable(session, agent, key);
    this.setState(session, "running");
    session.runPhase = "starting";
    session.lastOutputAt = null;
    this.activity(session);
    clock.step("요청 준비");

    const fresh = !child;
    if (fresh) {
      child = this.launch(session, agent, cliPath, args, key);
      clock.step("CLI 띄우기");
    }
    this.running.set(session.id, child);
    this.holdOpen(child);
    child.injected = 0;
    child.turn = { prompt, input, meta, retry, cliPath, clock, resuming: !!session.agentSessionId, completed: false, started: false, sawError: false, lastErrorText: null, endTimer: null };

    if (child.appServer) {
      child.appServer.start(input, meta.attachments);
    } else if (agent.interactive) {
      child.pendingInputs.push({ event: null, input });
      // 띄워 둔 CLI에는 이번 요청의 권한 모드(/plan이면 계획 모드)를 먼저 맞춘다.
      if (fresh) {
        const initialization = agent.initLine();
        const { request_id: id } = JSON.parse(initialization);
        child.initializationRequestId = id;
        child.controls.set(id, (response) => {
          child.initializationRequestId = null;
          child.claudeInitialized = response?.subtype === "success";
          child.claudeInitializationFailed = !child.claudeInitialized;
          child.emit("cliInitialized");
        });
        child.stdin.write(`${initialization}\n`);
      }
      else if (!this.requestPermissionMode(session, child, agent, session.planTurn ? "plan" : session.permission ?? "acceptEdits")) {
        this.append(session, { kind: "status", text: "현재 Claude CLI는 모든 권한 허용으로 전환할 수 없습니다. 백그라운드 작업을 유지하며 현재 권한으로 진행하고, 작업 종료 뒤 다음 요청에서 선택한 권한으로 다시 실행합니다." });
      }
      child.stdin.write(`${userInput}\n`);
    } else {
      child.stdin.end(input);
    }
  }

  // 띄워 둔 프로세스를 이번 요청에 쓸 수 있으면 돌려준다. 실행 조건(인자 지문·허용 규칙·대화)이 바뀌었으면 닫고 null.
  reusable(session, agent, key) {
    const child = this.procs.get(session.id);
    if (!child) return null;
    const open = !child.retired && !inputClosed(child) && child.agentName === session.agent && !!child.conversation && child.conversation === session.agentSessionId;
    if (open && agent.keepAlive && !child.permissionRestart && child.key === key && child.rules === ruleKey(session)) return child;
    // 백그라운드 작업이 도는 중에 닫으면 작업이 함께 끝나므로 그대로 쓰고, 바뀐 설정은 작업이 끝난 뒤 다음 요청부터 적용한다.
    if (open && agent.keepAlive && activeSubtasks(session).length) {
      this.append(session, { kind: "status", text: "백그라운드 작업이 진행 중이라 다시 실행해야 하는 설정(모델·추론 강도·MCP·작업 폴더·권한·허용 규칙 등)은 작업이 끝난 뒤의 요청부터 적용합니다." });
      return child;
    }
    this.retire(child);
    return null;
  }

  // CLI를 띄우고 출력 처리기를 붙인다. 프로세스는 세션의 여러 턴에 걸쳐 쓸 수 있다.
  launch(session, agent, cliPath, args, key) {
    const child = this.spawn(cliPath, args, {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // ask_session은 상대의 답을 몇 분까지 기다리므로 Claude의 MCP 도구 제한 시간을 늘린다.
      env: { ...process.env, NO_COLOR: "1", MCP_TOOL_TIMEOUT: "660000" },
    });
    Object.assign(child, { sessionId: session.id, agentName: session.agent, key, rules: ruleKey(session), conversation: null, turn: null, stderrTail: [], pendingInputs: [], controls: new Map(), idleTimer: null, idleSince: null });
    child.canBypassPermissions = args.includes("--allow-dangerously-skip-permissions") || args[args.indexOf("--permission-mode") + 1] === "bypassPermissions";
    this.procs.set(session.id, child);
    if (agent.transport === "app-server") child.appServer = new CodexAppServer(child, session);
    // 새로 붙인 요청이 있으면 턴을 마치려던 대기를 취소한다.
    child.on("injected", () => {
      clearTimeout(child.turn?.endTimer);
      if (child.turn) child.turn.endTimer = null;
    });

    if (child.appServer) {
      child.appServer.on("event", (event) => this.handleLine(session, child, agent, JSON.stringify({ type: "agenthub_event", event }), true));
      child.appServer.on("control", (msg) => this.ask(session, child, agent, msg));
      child.appServer.on("cancel", (id) => { this.dropPrompts(session.id, id); this.store.touch(session, { metadataOnly: true }); });
      child.appServer.on("shutdown", () => this.killLater(session, child, session.stopRequested ? EXIT_GRACE_MS : INTERRUPT_GRACE_MS, "shutdown"));
    }

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.running.get(session.id) === child) this.markOutput(session, child.turn?.clock);
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        this.handleLine(session, child, agent, buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      child.stderrTail.push(chunk);
      if (child.stderrTail.length > 50) child.stderrTail.shift();
    });

    child.on("error", (err) => {
      if (child.retired) return;
      if (child.turn) child.turn.sawError = true;
      this.append(session, { kind: "error", text: `실행 실패: ${missingFolder(err, session.cwd) ?? err.message}` });
    });

    // 멈춘 CLI가 남긴 하위 프로세스가 출력 파이프를 잡고 있으면 close가 오지 않는다. 종료 뒤 잠시 기다려 파이프를 닫는다.
    child.on("exit", () => {
      if (!session.stopRequested) return;
      const timer = setTimeout(() => { child.stdout?.destroy?.(); child.stderr?.destroy?.(); }, 500);
      timer.unref?.();
    });

    child.on("close", (code, signal) => {
      if (buffer) this.handleLine(session, child, agent, buffer);
      buffer = "";
      child.closed = true;
      this.closing.delete(child);
      this.holdOpen(child);
      this.endDraft(child);
      child.appServer?.close();
      for (const reply of child.controls.values()) reply({ subtype: "error", error: "CLI가 끝났습니다." });
      child.controls.clear();
      // 바꿔 띄웠거나 쉬다가 닫은 프로세스는 세션 상태를 건드리지 않는다.
      if (child.retired) return;
      if (this.procs.get(session.id) === child) this.procs.delete(session.id);
      this.closed(session, child, { code, signal });
    });

    // stdin이 먼저 닫혀도(실행 실패 등) 서버가 죽지 않게 한다.
    child.stdin.on("error", () => {});
    this.enforceLimit();
    return child;
  }

  // CLI 출력 한 줄. common: Codex app-server가 공통 이벤트로 바꿔 넘긴 줄
  handleLine(session, child, agent, line, common = false) {
    // 닫는 중인 이전 프로세스(설정이 바뀌어 새로 띄움)의 남은 출력은 버린다.
    if (child.retired) return;
    if (child.appServer && !common) return child.appServer.handleLine(line);
    if (!line.trim()) return;
    if (agent.interactive) {
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        // 아래에서 일반 줄로 처리한다.
      }
      if (msg?.type === "system" && msg.subtype === "init") {
        child.controls.delete(child.initializationRequestId);
        child.initializationRequestId = null;
        child.claudeInitialized = true;
        child.claudeInitializationFailed = false;
        child.emit("cliInitialized");
      }
      // 하위 작업 안의 메시지(parent_tool_use_id·agent_id)는 본 턴의 진행이 아니다.
      const main = !msg?.parent_tool_use_id && !msg?.request?.agent_id;
      // 실제 다음 작업이 시작될 때만 완료 대기를 취소한다. 한도·초기화 등 부가 알림은 종료를 막지 않는다.
      const active = main && (msg?.type === "assistant"
        || (msg?.type === "user" && Array.isArray(msg.message?.content) && msg.message.content.some((block) => block?.type === "tool_result"))
        || (msg?.type === "stream_event" && msg.event?.type === "message_start")
        || (msg?.type === "control_request" && msg.request?.subtype === "can_use_tool"));
      if (active && child.turn) {
        clearTimeout(child.turn.endTimer);
        child.turn.endTimer = null;
      }
      // 턴 사이에 CLI가 스스로 다음 턴을 시작했다(백그라운드 작업 완료 알림, 턴 사이에 남은 추가 요청 등).
      const starting = main && (msg?.type === "assistant" || (msg?.type === "stream_event" && msg.event?.type === "message_start") || (msg?.type === "system" && msg.subtype === "init"));
      if (starting && !child.turn && agent.keepAlive && !this.shuttingDown) this.beginAutoTurn(session, child);
      if (msg?.type === "control_request") return this.ask(session, child, agent, msg);
      if (msg?.type === "control_cancel_request") return this.dropPrompts(session.id, msg.request_id);
      if (msg?.type === "control_response") return this.controlReply(session, child, msg.response); // initialize·권한 모드·작업 중지 응답
      const echoed = agent.replayedUserText?.(msg);
      if (echoed != null) this.confirmInput(session, child, echoed);
    }
    const turn = child.turn;
    for (const event of agent.parseLine(line)) {
      if (event.kind === "delta") {
        if (turn) this.draft(session, child, event);
        continue;
      }
      if (event.kind === "subtask" || event.kind === "subtask_activity") {
        this.subtask(session, child, event);
        continue;
      }
      if (DRAFT_END.has(event.kind)) this.endDraft(child);
      // 사용자가 멈춰서 CLI가 오류로 끝낸 턴은 오류로 보이지 않게 로그로만 남긴다.
      if (session.stopRequested && event.final && event.kind === "error") event.kind = "log";
      if (event.agentSessionId) {
        if (turn) turn.started = true;
        child.conversation = event.agentSessionId;
        const previousId = session.agentSessionId;
        session.agentSessionId = event.agentSessionId;
        // 다시 시작하거나 새 대화로 바뀌어도 이 세션이 쓴 CLI 대화를 모두 기억한다(기록 목록 연결·삭제에 쓴다).
        session.cliSessionIds = [...new Set([...(session.cliSessionIds ?? []), previousId, event.agentSessionId].filter(Boolean))];
        delete event.agentSessionId;
        // 띄워 둔 CLI가 턴마다 다시 알리는 같은 대화의 시작은 기록에 남기지 않는다.
        if (previousId === session.agentSessionId && child.announced) continue;
        child.announced = true;
      }
      if (event.rateLimit) {
        this.emit("limit", session.agent, event.rateLimit);
        continue;
      }
      // 세션 수명: 컨텍스트 압축 횟수와 지금 컨텍스트 크기
      if (event.compact) {
        session.compactions = (session.compactions ?? 0) + 1;
        // 첫 요청에 붙인 스킬 안내가 요약되며 빠질 수 있으므로 다음 요청에 다시 붙인다.
        if (session.skills?.length) session.skillsChanged = true;
        delete event.compact;
      }
      if (event.context) {
        session.context = { ...session.context, ...event.context };
        delete event.context;
        if (event.kind === "usage") continue;
      }
      const duplicateError = event.kind === "error" && turn && event.text === turn.lastErrorText;
      if (event.kind === "error" && turn) {
        // 같은 오류는 한 번만 표시하되, 뒤에 온 최종 이벤트의 종료 처리는 항상 실행한다.
        turn.lastErrorText = event.text;
        turn.sawError = true;
      }
      if (event.kind === "result" && turn) turn.completed = true;
      // 턴의 마지막 줄(성공·실패 모두).
      const final = event.final;
      delete event.final;
      if (!duplicateError) this.append(session, event);
      if (final && child.appServer) child.appServer.shutdown();
      else if (final && agent.interactive) this.finishResult(session, child, agent);
    }
  }

  // 턴의 결과(result)가 왔다. 실행 중에 붙인 요청이 있으면 CLI가 이어서 처리할 수 있으므로 잠시 기다렸다가 턴을 마친다.
  // Claude는 프로세스를 닫지 않고 턴만 마친다(백그라운드 작업이 계속 돌고, 다음 요청을 같은 프로세스에 쓴다).
  finishResult(session, child, agent) {
    const turn = child.turn;
    if (!turn) return;
    clearTimeout(turn.endTimer);
    const done = () => agent.keepAlive ? this.endTurn(session, child) : child.stdin.end();
    // 중지·일시중지로 끝난 턴은 이어서 처리할 것이 없으므로 추가 요청을 기다리지 않고 바로 마친다.
    if (!child.injected || session.stopRequested) return done();
    turn.endTimer = setTimeout(() => {
      turn.endTimer = null;
      if (child.turn === turn && !child.retired) done();
    }, INJECT_GRACE_MS);
  }

  // 턴을 마친다. 띄워 두는 CLI는 결과마다, 그 밖에는 프로세스가 끝날 때 부른다. exit: 프로세스가 끝났으면 { code, signal }
  endTurn(session, child, exit = null) {
    const turn = child.turn;
    if (!turn) return;
    child.turn = null;
    clearTimeout(turn.endTimer);
    this.endDraft(child);
    if (this.running.get(session.id) === child) this.running.delete(session.id);
    if (exit) this.dropPrompts(session.id);
    turn.clock?.total("턴 전체");
    // CLI가 받았다고 돌려주지 않은 추가 요청은 턴 종료와 겹쳐 반영되지 못한 것이다. 돌려주는 CLI일 때만 판단한다.
    // 프로세스가 살아 있으면 CLI가 남은 요청을 다음 턴에 처리하므로 되돌리지 않는다.
    if (exit && child.sawReplay) this.returnInjected(session, child.pendingInputs.filter((record) => record.event?.delivery === "sent"), "작업이 끝나며");
    // 첫 턴이 끝까지 가지 못했으면 CLI 쪽에 이어 갈 대화가 없을 수 있으므로 다음 턴은 새로 시작한다.
    // 단, 대화가 시작된 뒤(init) 사용자가 멈춘 턴은 기록이 남아 있으므로 이어 간다(일시중지 후 재개).
    if (!turn.resuming && !turn.completed && !(turn.started && session.stopRequested)) session.agentSessionId = null;
    // CLI 쪽 대화가 지워졌으면(다른 앱에서 삭제 등) 이어 갈 수 없으므로 새 대화로 한 번 다시 보낸다.
    if (exit && !turn.auto && turn.resuming && !turn.completed && !turn.retry && !session.stopRequested && (child.appServer ? child.appServer.missingConversation : MISSING_CONVERSATION.test(child.stderrTail.join("")))) {
      session.agentSessionId = null;
      this.append(session, { kind: "status", text: "CLI에서 원래 대화를 찾지 못해 새 대화로 다시 보냅니다. 이전 대화 내용은 이어지지 않습니다." });
      try {
        this.send(session, turn.prompt, turn.cliPath, turn.input, turn.meta, true);
        return;
      } catch (err) {
        turn.sawError = true;
        this.append(session, { kind: "error", text: `다시 보내기 실패: ${err.message}` });
      }
    }
    if (session.stopRequested) {
      delete session.stopRequested;
      // 일시중지는 대화를 그대로 두고 멈춘다. 재개하면 같은 대화로 이어서 진행한다.
      this.append(session, { kind: "status", text: session.paused ? "일시중지했습니다. 재개하면 멈춘 곳부터 이어서 진행합니다." : "사용자가 중지했습니다." });
      this.setState(session, session.paused ? "paused" : "idle");
      this.emit("turnEnd", session, null);
      if (!exit) this.park(session, child);
      return;
    }
    const finishedBeforeExit = !!exit && !!child.appServer && turn.completed && !turn.sawError;
    if (exit) {
      const summary = stderrSummary(child.stderrTail.join(""));
      if (child.appServer && !turn.completed && !turn.sawError) {
        turn.sawError = true;
        // 설치 손상·메모리 부족처럼 Codex가 시작하자마자 죽은 원인을 오류 문구에 바로 보인다. 전체 내용은 아래 로그에 남는다.
        const cause = stderrCause(summary);
        this.append(session, { kind: "error", text: `Codex 연결이 턴을 완료하기 전에 끝났습니다.${cause ? `\n${cause}` : ""}` });
      }
      // Codex가 턴을 마쳤다고 알린 뒤의 종료는 AgentHub가 입력을 닫아 끝낸 것이라 대화에 남기지 않는다.
      // 제때 끝나지 않아 AgentHub가 강제로 닫아 종료 코드가 0이 아니어도 결과는 바뀌지 않는다.
      if (finishedBeforeExit) {
        // 정상 종료로 본다.
      } else if (exit.code !== 0 && !turn.sawError) {
        const cause = child.killedBy === "shutdown" ? `\n턴을 마치기 전에 Codex가 ${INTERRUPT_GRACE_MS / 1000}초 동안 응답하지 않아 AgentHub가 닫았습니다.` : "";
        this.append(session, { kind: "error", text: `CLI가 종료 코드 ${exit.code ?? exit.signal}로 끝났습니다.${cause}${summary ? `\n${summary}` : ""}` });
      } else if (child.stderrTail.length) {
        this.append(session, { kind: "log", text: child.stderrTail.join("").trim().slice(-4000) });
      }
    }
    const ok = (!exit || exit.code === 0 || finishedBeforeExit) && !turn.sawError;
    // 실패한 턴이라도 백그라운드 작업이 남아 있으면 그 작업이 진행 중임을 보인다(오류는 기록에 남는다).
    this.setState(session, ok || (!exit && activeSubtasks(session).length) ? "idle" : "error");
    this.emit("turnEnd", session, ok);
    if (!exit) this.park(session, child);
  }

  // 턴 밖(대기·백그라운드)에서 CLI가 스스로 다음 턴을 시작했다. 실행 중으로 바꾸고 결과가 오면 평소처럼 마친다.
  beginAutoTurn(session, child) {
    this.holdOpen(child);
    child.injected = 0;
    child.turn = { auto: true, clock: stopwatch("session.autoTurn", `${session.agent} ${session.id}`), resuming: true, completed: false, started: true, sawError: false, lastErrorText: null, endTimer: null };
    this.running.set(session.id, child);
    this.setState(session, "running");
    session.runPhase = "working";
    session.lastOutputAt = new Date().toISOString();
    this.activity(session);
    // 일시중지 중이면 턴만 멈춘다(작업 결과는 대화에 남고, 재개하면 이어서 판단한다).
    if (session.paused) {
      session.pausedMidTurn = true;
      this.interrupt(session);
    }
  }

  // 프로세스가 끝났다. 남은 하위 작업은 함께 끝난다.
  closed(session, child, exit) {
    const stopping = !!session.stopRequested;
    const cut = settleSubtasks(session, stopping ? "stopped" : "interrupted");
    if (cut.length) {
      this.store.touch(session, { metadataOnly: true });
      this.emit("subtasks", session.id, { tasks: cut, removed: [] });
      if (!stopping) this.append(session, { kind: "status", text: `CLI가 끝나 진행 중이던 하위 작업 ${cut.length}개가 중단됐습니다.` });
    }
    if (child.turn) return this.endTurn(session, child, exit);
    this.dropPrompts(session.id);
    const background = session.state === "background";
    if (stopping) {
      delete session.stopRequested;
      if (cut.length || background) this.append(session, { kind: "status", text: "사용자가 중지했습니다. 진행 중이던 하위 작업도 멈췄습니다." });
    } else if (exit.code !== 0 && (cut.length || background) && child.stderrTail.length) {
      this.append(session, { kind: "log", text: child.stderrTail.join("").trim().slice(-4000) });
    }
    if (background) this.setState(session, cut.length && !stopping ? "interrupted" : "idle");
  }

  // ── 띄워 둔 프로세스 관리 ───────────────────────────────────────
  // 턴을 마친 프로세스를 다음 요청까지 띄워 둔다. 백그라운드 작업이 있으면 끝날 때까지 닫지 않는다.
  park(session, child) {
    if (child.turn || child.retired || this.procs.get(session.id) !== child) return;
    this.holdOpen(child);
    if (activeSubtasks(session).length) return;
    const { idleMs } = this.keepAliveLimits();
    if (!idleMs) return this.retire(child);
    child.idleSince = Date.now();
    child.idleTimer = setTimeout(() => this.retire(child), idleMs);
    child.idleTimer.unref?.();
    this.enforceLimit();
  }

  holdOpen(child) {
    clearTimeout(child.settleTimer);
    child.settleTimer = null;
    clearTimeout(child.idleTimer);
    child.idleTimer = null;
    child.idleSince = null;
  }

  // 동시에 띄워 두는 프로세스 수를 넘으면 가장 오래 쉰 프로세스부터 닫는다. 실행 중·백그라운드 작업 중인 프로세스는 닫지 않는다.
  enforceLimit() {
    const { max } = this.keepAliveLimits();
    const idle = [...this.procs.values()].filter((child) => child.idleSince && !child.turn).sort((a, b) => a.idleSince - b.idleSince);
    for (let extra = this.procs.size - max; extra > 0 && idle.length; extra--) this.retire(idle.shift());
  }

  // 띄워 둔 프로세스를 닫는다. 입력을 닫으면 CLI가 스스로 끝나고, 끝나지 않으면 잠시 뒤 강제로 끝낸다.
  retire(child, { kill = false } = {}) {
    if (this.procs.get(child.sessionId) === child) this.procs.delete(child.sessionId);
    if (child.retired) return;
    child.retired = true;
    this.holdOpen(child);
    if (this.running.get(child.sessionId) === child) this.running.delete(child.sessionId);
    // CLI가 아직 받지 않은 추가 요청은 닫으면 사라지므로 대기열로 되돌린다. 지금 보내는 요청이 먼저 시작되도록 조금 뒤에 되돌린다.
    const session = this.store.get(child.sessionId);
    const unconfirmed = child.sawReplay ? (child.pendingInputs ?? []).filter((record) => record.event?.delivery === "sent") : [];
    if (session && unconfirmed.length) queueMicrotask(() => this.returnInjected(session, unconfirmed, "CLI를 닫아"));
    if (child.closed) return;
    this.closing.add(child);
    if (kill) return this.kill(child);
    if (child.appServer) child.appServer.shutdown();
    else if (!inputClosed(child)) child.stdin.end();
    const timer = setTimeout(() => { if (!child.closed) this.kill(child); }, INTERRUPT_GRACE_MS);
    timer.unref?.();
  }

  // 세션 삭제·다시 시작·AI 변경·작업 폴더 정리 전에 띄워 둔 프로세스를 닫는다. 실행 중이거나 작업이 남아 있으면 멈춘다.
  release(session, { kill = false } = {}) {
    const child = this.procs.get(session.id);
    if (!child) return false;
    if (child.turn || activeSubtasks(session).length) return this.stop(session);
    this.retire(child, { kill });
    return true;
  }

  // 쉬고 있는 프로세스를 모두 닫는다(CLI 업데이트 전 등). agent를 주면 그 CLI만.
  releaseIdle(agent = null) {
    let count = 0;
    for (const child of [...this.procs.values()]) {
      if (child.turn || (agent && child.agentName !== agent) || activeSubtasks(this.store.get(child.sessionId)).length) continue;
      this.retire(child);
      count++;
    }
    return count;
  }

  // ── 하위 작업 ───────────────────────────────────────────────────
  subtask(session, child, event) {
    const changed = event.kind === "subtask" ? applySubtask(session, event) : addSubtaskActivity(session, event.toolUseId, event.items);
    if (!changed) return;
    this.store.touch(session, { metadataOnly: true });
    this.emit("subtasks", session.id, { tasks: [changed.task], removed: changed.removed });
    // 턴 밖에서 작업이 모두 끝나면 대기로 돌리고 쉬는 프로세스로 둔다.
    if (child.turn || child.retired || activeSubtasks(session).length) return;
    clearTimeout(child.settleTimer);
    child.settleTimer = setTimeout(() => {
      child.settleTimer = null;
      if (child.turn || child.retired || activeSubtasks(session).length) return;
      if (session.state === "background") this.setState(session, "idle");
      this.park(session, child);
    }, BACKGROUND_SETTLE_MS);
    child.settleTimer.unref?.();
  }

  // 하위 작업 하나를 멈춘다(Claude stop_task). CLI의 답을 기다려 { confirmed }를 돌려준다.
  async stopSubtask(session, taskId) {
    const task = (session.subtasks ?? []).find((item) => item.id === taskId);
    if (!task) throw new Error("하위 작업이 없습니다.");
    if (task.status !== "running") throw new Error("이미 끝난 하위 작업입니다.");
    const child = this.procs.get(session.id);
    const agent = AGENTS[session.agent];
    if (!child || child.retired || inputClosed(child) || !agent.stopTaskLine) throw new Error("이 작업을 멈출 수 있는 실행 중인 CLI가 없습니다.");
    const id = `stop-task-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.controls.delete(id); resolve({ confirmed: false }); }, STOP_TASK_TIMEOUT_MS);
      timer.unref?.();
      child.controls.set(id, (response) => {
        clearTimeout(timer);
        if (response?.subtype === "error") reject(new Error(`하위 작업을 멈추지 못했습니다: ${response.error ?? "알 수 없는 오류"}`));
        else resolve({ confirmed: true });
      });
      child.stdin.write(`${agent.stopTaskLine(taskId, id)}\n`);
    });
  }

  controlReply(session, child, response) {
    const reply = child.controls.get(response?.request_id);
    // 기다리는 곳이 없는 요청(초기화 등)이 거절되면 기록에만 남긴다.
    if (!reply) {
      // 시간이 지난 MCP 조회 응답에는 연결 주소나 인증 오류가 포함될 수 있다.
      if (response?.request_id?.startsWith("mcp-")) return;
      if (response?.subtype === "error" && response.error) this.append(session, { kind: "log", text: `CLI가 요청을 거절했습니다: ${response.error}` });
      return;
    }
    child.controls.delete(response.request_id);
    reply(response);
  }

  // CLI 쪽 대화를 버리고 다음 요청부터 새 대화로 시작한다. AgentHub의 기록·역할·연결은 그대로 둔다.
  restart(session) {
    if (this.running.has(session.id)) throw new Error("실행 중인 세션은 다시 시작할 수 없습니다. 먼저 중지하세요.");
    if (this.isBusy(session.id)) throw new Error("백그라운드 작업이 진행 중인 세션은 다시 시작할 수 없습니다. 먼저 중지하세요.");
    this.release(session);
    session.agentSessionId = null;
    session.waiting = false;
    session.compactions = 0;
    session.context = null;
    delete session.roleChanged; // 새 대화의 첫 요청에 역할을 통째로 다시 붙인다.
    this.append(session, { kind: "status", text: "세션을 다시 시작했습니다. 다음 요청부터 새 대화로 이어지며 이전 대화 내용은 CLI에 남지 않습니다." });
    this.setState(session, "idle");
  }

  // 일시중지: Claude는 Esc처럼 interrupt 요청을 보내 턴을 정상으로 끝낸다. 대화 기록이 온전히 남아 재개할 때 이어진다.
  // 강제로 끝내면 도구를 실행하던 중의 기록이 깨져 이어지지 않는다. 잠시 기다려도 안 끝나면 강제로 멈춘다.
  // 작업별 중지를 쓰는 CLI(perTaskStopAffordance)는 백그라운드 작업을 살려 두고 턴만 멈춘다.
  interrupt(session) {
    const child = this.running.get(session.id);
    if (!child) return false;
    const agent = AGENTS[session.agent];
    if (child.appServer) return this.stop(session);
    if (!agent.interruptLine) return this.stop(session);
    session.stopRequested = true;
    child.stdin.write(`${agent.interruptLine()}\n`);
    const turn = child.turn;
    const timer = setTimeout(() => {
      if (this.running.get(session.id) === child && child.turn === turn) this.kill(child);
    }, PAUSE_GRACE_MS);
    timer.unref?.();
    return true;
  }

  // 턴과 하위 작업을 모두 멈추고 프로세스를 끝낸다. 쉬고 있는 프로세스는 조용히 닫고 false를 돌려준다.
  stop(session) {
    const child = this.running.get(session.id) ?? this.procs.get(session.id);
    if (!child) return false;
    if (!child.turn && !activeSubtasks(session).length) {
      this.retire(child);
      return false;
    }
    session.stopRequested = true;
    this.dropPrompts(session.id);
    if (child.appServer) {
      // 일시중지는 재개할 수 있게 조금 더 기다리고, 중지는 응답이 늦으면 바로 멈춘다.
      child.appServer.interrupt();
      this.killLater(session, child, session.paused ? PAUSE_GRACE_MS : STOP_GRACE_MS);
    } else this.kill(child);
    return true;
  }

  // ms 뒤에도 같은 프로세스가 실행 중이면 강제로 멈춘다. reason은 종료 안내에 쓴다.
  killLater(session, child, ms, reason = "stop") {
    const timer = setTimeout(() => {
      if (this.running.get(session.id) !== child) return;
      child.killedBy = reason;
      this.kill(child);
    }, ms);
    timer.unref?.();
  }

  kill(child) {
    if (process.platform === "win32") {
      // cmd.exe를 거친 경우 자식 프로세스까지 종료해야 한다.
      killProcessTree(child.pid);
    } else {
      child.kill("SIGINT");
    }
  }

  stopAll() {
    this.mcpInspector.stopAll();
    for (const id of new Set([...this.running.keys(), ...this.procs.keys()])) {
      const session = this.store.get(id);
      if (session) this.release(session);
      else if (this.procs.has(id)) this.retire(this.procs.get(id));
    }
  }

  shutdown({ timeout = 5000 } = {}) {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.shuttingDown = true;
    const children = new Set([...this.running.values(), ...this.procs.values(), ...this.closing]);
    const pending = [...children].filter(child => !child.closed).map(child => new Promise(resolve => {
      const done = () => { clearTimeout(timer); child.off("close", done); resolve(); };
      const timer = setTimeout(() => {
        // A CLI may leave its pipes open indefinitely. Finalize its state before
        // saving, then ignore late output from the retired process.
        child.appServer?.close();
        if (!child.retired) {
          const session = this.store.get(child.sessionId);
          if (session) {
            session.stopRequested = true;
            this.closed(session, child, { code: null, signal: "SIGTERM" });
          }
          this.retire(child, { kill: true });
        } else this.kill(child);
        for (const reply of child.controls?.values() ?? []) reply({ subtype: "error", error: "서버가 종료 중입니다." });
        child.controls?.clear();
        done();
      }, timeout);
      child.once("close", done);
    }));
    this.stoppingPromise = Promise.all(pending).then(() => Promise.all([...children].flatMap(child => [...(child.pendingInjections ?? [])])));
    this.stopAll();
    return this.stoppingPromise;
  }
}

// 프로세스를 다시 띄워야 하는 실행 조건(CLI 경로·인자·작업 폴더·MCP 주소). 권한 모드는 바로 바꿀 수 있고,
// 대화 ID와 "이 세션에서 계속 허용" 규칙은 따로 비교하므로 뺀다. 단, 모든 권한 허용(bypassPermissions)은
// 시작할 때 사용자가 선택한 세션만 전환을 허용하므로 켜고 끌 때 다시 띄운다.
function processKey(agent, session, cliPath, options) {
  const args = agent.buildArgs({ ...session, allowRules: [], agentSessionId: null, planTurn: false }, options);
  const skip = new Set(["--permission-mode", "--session-id", "--resume"]);
  const kept = args.filter((arg, i) => !skip.has(arg) && !skip.has(args[i - 1]));
  return JSON.stringify([cliPath, session.cwd, kept, options.mcp?.url ?? null, session.permission === "bypassPermissions"]);
}

// 띄운 프로세스가 아는 허용 규칙. 실행 중에 "계속 허용"한 규칙은 CLI에도 바로 적용되므로 함께 늘리고, 지운 규칙이 있으면 다시 띄운다.
const ruleKey = (session) => (session.allowRules ?? []).filter((rule) => rule.agent === session.agent).map((rule) => rule.key).sort().join("\n");

import { assertSessionGitContext } from "./git-context.mjs";
import { EventEmitter } from "node:events";
import * as claude from "./agents/claude.mjs";
import * as codex from "./agents/codex.mjs";
import { spawnCli, killProcessTree, missingFolder } from "./cli.mjs";
import { CodexAppServer } from "./codex-app-server.mjs";

const publicMeta = (meta) => ({ ...meta, ...(meta.attachments ? { attachments: meta.attachments.map(({ id, name, mimeType, size, url }) => ({ id, name, mimeType, size, url })) } : {}) });

export const AGENTS = { claude, codex };

const MISSING_CONVERSATION = /No conversation found with session ID/i;
const INJECT_GRACE_MS = 4000;
const INTERRUPT_GRACE_MS = 10000;

// 세션 하나에 한 번에 한 턴만 실행한다. 다른 세션은 동시에 실행할 수 있다.
export class Runner extends EventEmitter {
  constructor(store, { spawn = spawnCli, isUpdating = () => false } = {}) {
    super();
    this.store = store;
    this.spawn = spawn;
    this.isUpdating = isUpdating;
    this.running = new Map();
    this.prompts = new Map(); // CLI가 실행 중에 물은 요청 ID → { session, child, agent, control, event }
    // 세션에 붙일 AgentHub MCP 서버 정보를 돌려주는 함수(session → { url, configFile } | null). 서버가 정한다.
    this.mcp = () => null;
    // 지금 연결할 수 없는 사용자 Codex MCP 서버 이름(() → string[]). 서버가 정한다.
    this.unreachableMcp = () => [];
    this.mcpNotes = new Map(); // 세션 ID → 마지막으로 알린 꺼진 MCP 목록
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
    const id = msg.request_id;
    const event = control.kind === "question"
      ? { kind: "question", questionId: id, status: "pending", text: "질문", questions: control.questions, live: true }
      : { kind: "permission", requestId: id, status: "pending", tool: control.tool, text: control.text, detail: control.detail, reason: control.reason, canRemember: (control.suggestions?.length ?? 0) > 0, promptId: id, ...(control.planApproval ? { planApproval: true } : {}), ...(control.rememberLabel ? { rememberLabel: control.rememberLabel, rememberDescription: control.rememberDescription } : {}) };
    session.waiting = true;
    const full = this.append(session, event);
    this.prompts.set(id, { session, child, agent, control, event: full });
  }

  // 실행 중인 턴에 요청을 붙인다. CLI가 같은 작업에 반영할 수 있을 때만 허용한다.
  canInject(session) {
    const child = this.running.get(session.id);
    return !!child && (child.appServer ? child.appServer.canInject() : !!AGENTS[session.agent].interactive);
  }

  // meta: 요청 이벤트에 덧붙일 값(보낸 세션 등)
  // input: CLI에 실제로 넘길 내용(@참조를 풀어 쓴 요청 등). 화면에는 text만 남긴다.
  inject(session, text, meta = {}, input = text) {
    const child = this.running.get(session.id);
    const agent = AGENTS[session.agent];
    if (!child) throw new Error("실행 중이 아닙니다.");
    if (!agent.interactive && !child.appServer) throw new Error(`${session.agent}는 실행 중인 작업에 요청을 붙일 수 없습니다. 대기열에 넣으세요.`);
    if (child.appServer) child.appServer.inject(input, meta.attachments);
    else child.stdin.write(`${agent.userLine(input, meta.attachments)}\n`);
    child.injected = (child.injected ?? 0) + 1;
    child.emit?.("injected");
    this.append(session, { kind: "user", text, ...publicMeta(meta), injected: true });
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
    }
    session.waiting = this.waitingFor(session.id);
    this.store.touch(session);
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
      this.prompts.delete(id);
    }
    const session = this.store.get(sessionId);
    if (session) session.waiting = this.waitingFor(sessionId);
  }

  append(session, event) {
    const full = { seq: session.events.length, ts: new Date().toISOString(), ...event };
    session.events.push(full);
    this.store.touch(session);
    this.emit("event", session.id, full);
    return full;
  }

  setState(session, state) {
    // 출력·추가 요청·CLI 재시도에도 현재 작업의 시작 시각은 유지한다.
    if (state === "running") {
      if (session.state !== "running" || !Number.isFinite(Date.parse(session.runningStartedAt))) {
        session.runningStartedAt = new Date().toISOString();
      }
    } else {
      session.runningStartedAt = null;
    }
    session.state = state;
    this.store.touch(session);
    this.emit("state", session.id, state, session.runningStartedAt);
  }

  isRunning(id) {
    return this.running.has(id);
  }

  // input은 CLI에 실제로 넘길 내용이다. 화면에는 prompt만 남긴다. meta는 요청 이벤트에 덧붙인다(넘어온 세션 등).
  // retry는 이어 갈 대화가 없어 새 대화로 다시 보낼 때 쓴다. 요청은 이미 화면에 있으므로 다시 남기지 않는다.
  send(session, prompt, cliPath, input = prompt, meta = {}, retry = false) {
    if (this.running.has(session.id)) throw new Error("이 세션은 이미 실행 중입니다.");
    if (this.isUpdating(session.agent)) throw new Error(`${session.agent} CLI 업데이트 중입니다. 완료한 뒤 다시 시도하세요.`);
    assertSessionGitContext(session);
    if (!cliPath) throw new Error(`${session.agent} CLI를 찾지 못했습니다. 설정에서 경로를 지정하세요.`);

    const agent = AGENTS[session.agent];
    const disabledMcp = agent.transport === "app-server" ? this.unreachableMcp() : [];
    const args = agent.buildArgs(session, { mcp: session.chat ? null : this.mcp(session), disabledMcp });
    const userInput = agent.interactive ? agent.userLine(input, meta.attachments) : null;
    if (!retry) {
      // 답하지 않은 질문은 새 요청이 들어오면 지나간 것으로 본다.
      for (const e of session.events) if (e.kind === "question" && e.status === "pending") e.status = "skipped";
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
    this.setState(session, "running");

    const child = this.spawn(cliPath, args, {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // ask_session은 상대의 답을 몇 분까지 기다리므로 Claude의 MCP 도구 제한 시간을 늘린다.
      env: { ...process.env, NO_COLOR: "1", MCP_TOOL_TIMEOUT: "660000" },
    });
    this.running.set(session.id, child);
    if (agent.transport === "app-server") child.appServer = new CodexAppServer(child, session);

    const stderrTail = [];
    const resuming = !!session.agentSessionId;
    let completedTurn = false;
    let startedConversation = false; // 이번 실행에서 CLI 대화가 시작됐는지(init)
    let sawError = false;
    let lastErrorText = null;

    let endTimer = null;
    const cancelEndTimer = () => {
      clearTimeout(endTimer);
      endTimer = null;
    };
    child.on("injected", cancelEndTimer);
    const handleLine = (line, common = false) => {
      if (child.appServer && !common) return child.appServer.handleLine(line);
      if (!line.trim()) return;
      if (agent.interactive) {
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          // 아래에서 일반 줄로 처리한다.
        }
        // 실제 다음 작업이 시작될 때만 완료 대기를 취소한다. 한도·초기화 등 부가 알림은 종료를 막지 않는다.
        const active = msg?.type === "assistant"
          || (msg?.type === "user" && Array.isArray(msg.message?.content) && msg.message.content.some((block) => block?.type === "tool_result"))
          || (msg?.type === "stream_event" && msg.event?.type === "message_start")
          || (msg?.type === "control_request" && msg.request?.subtype === "can_use_tool");
        if (active) cancelEndTimer();
        if (msg?.type === "control_request") return this.ask(session, child, agent, msg);
        if (msg?.type === "control_cancel_request") return this.dropPrompts(session.id, msg.request_id);
        if (msg?.type === "control_response") return; // initialize 응답
      }
      for (const event of agent.parseLine(line)) {
        // 사용자가 멈춰서 CLI가 오류로 끝낸 턴은 오류로 보이지 않게 로그로만 남긴다.
        if (session.stopRequested && event.final && event.kind === "error") event.kind = "log";
        if (event.agentSessionId) {
          startedConversation = true;
          const previousId = session.agentSessionId;
          session.agentSessionId = event.agentSessionId;
          // 다시 시작하거나 새 대화로 바뀌어도 이 세션이 쓴 CLI 대화를 모두 기억한다(기록 목록 연결·삭제에 쓴다).
          session.cliSessionIds = [...new Set([...(session.cliSessionIds ?? []), previousId, event.agentSessionId].filter(Boolean))];
          delete event.agentSessionId;
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
        const duplicateError = event.kind === "error" && event.text === lastErrorText;
        if (event.kind === "error") {
          // 같은 오류는 한 번만 표시하되, 뒤에 온 최종 이벤트의 종료 처리는 항상 실행한다.
          lastErrorText = event.text;
          sawError = true;
        }
        if (event.kind === "result") completedTurn = true;
        // 턴의 마지막 줄(성공·실패 모두). 대화형 실행은 stdin을 닫아야 CLI가 끝난다.
        const final = event.final;
        delete event.final;
        if (!duplicateError) this.append(session, event);
        if (final && child.appServer) child.appServer.shutdown();
        else if (final && agent.interactive) {
          // 실행 중에 붙인 요청이 있으면 CLI가 이어서 처리할 수 있으므로 잠시 기다렸다가 닫는다.
          cancelEndTimer();
          if (child.injected) endTimer = setTimeout(() => {
            endTimer = null;
            child.stdin.end();
          }, INJECT_GRACE_MS);
          else child.stdin.end();
        }
      }
    };

    if (child.appServer) {
      child.appServer.on("event", (event) => handleLine(JSON.stringify({ type: "agenthub_event", event }), true));
      child.appServer.on("control", (msg) => this.ask(session, child, agent, msg));
      child.appServer.on("cancel", (id) => { this.dropPrompts(session.id, id); this.store.touch(session); });
      child.appServer.on("shutdown", () => {
        const timer = setTimeout(() => { if (this.running.get(session.id) === child) this.kill(child); }, INTERRUPT_GRACE_MS);
        timer.unref?.();
      });
    }

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail.push(chunk);
      if (stderrTail.length > 50) stderrTail.shift();
    });

    child.on("error", (err) => {
      sawError = true;
      this.append(session, { kind: "error", text: `실행 실패: ${missingFolder(err, session.cwd) ?? err.message}` });
    });

    child.on("close", (code, signal) => {
      if (buffer) handleLine(buffer);
      cancelEndTimer();
      child.removeListener("injected", cancelEndTimer);
      child.appServer?.close();
      this.running.delete(session.id);
      this.dropPrompts(session.id);
      // 첫 턴이 끝까지 가지 못했으면 CLI 쪽에 이어 갈 대화가 없을 수 있으므로 다음 턴은 새로 시작한다.
      // 단, 대화가 시작된 뒤(init) 사용자가 멈춘 턴은 기록이 남아 있으므로 이어 간다(일시중지 후 재개).
      if (!resuming && !completedTurn && !(startedConversation && session.stopRequested)) session.agentSessionId = null;
      // CLI 쪽 대화가 지워졌으면(다른 앱에서 삭제 등) 이어 갈 수 없으므로 새 대화로 한 번 다시 보낸다.
      if (resuming && !completedTurn && !retry && !session.stopRequested && (child.appServer ? child.appServer.missingConversation : MISSING_CONVERSATION.test(stderrTail.join("")))) {
        session.agentSessionId = null;
        this.append(session, { kind: "status", text: "CLI에서 원래 대화를 찾지 못해 새 대화로 다시 보냅니다. 이전 대화 내용은 이어지지 않습니다." });
        try {
          this.send(session, prompt, cliPath, input, meta, true);
          return;
        } catch (err) {
          sawError = true;
          this.append(session, { kind: "error", text: `다시 보내기 실패: ${err.message}` });
        }
      }
      if (session.stopRequested) {
        delete session.stopRequested;
        // 일시중지는 대화를 그대로 두고 멈춘다. 재개하면 같은 대화로 이어서 진행한다.
        this.append(session, { kind: "status", text: session.paused ? "일시중지했습니다. 재개하면 멈춘 곳부터 이어서 진행합니다." : "사용자가 중지했습니다." });
        this.setState(session, session.paused ? "paused" : "idle");
        this.emit("turnEnd", session, null);
        return;
      }
      if (child.appServer && !completedTurn && !sawError) {
        sawError = true;
        this.append(session, { kind: "error", text: "Codex 연결이 턴을 완료하기 전에 끝났습니다." });
      }
      if (code !== 0 && !sawError) {
        const tail = stderrTail.join("").trim().split(/\r?\n/).slice(-15).join("\n");
        this.append(session, { kind: "error", text: `CLI가 종료 코드 ${code ?? signal}로 끝났습니다.\n${tail}` });
      } else if (stderrTail.length) {
        this.append(session, { kind: "log", text: stderrTail.join("").trim().slice(-4000) });
      }
      const ok = code === 0 && !sawError;
      this.setState(session, ok ? "idle" : "error");
      this.emit("turnEnd", session, ok);
    });

    // stdin이 먼저 닫혀도(실행 실패 등) 서버가 죽지 않게 한다.
    child.stdin.on("error", () => {});
    if (child.appServer) {
      child.appServer.start(input, meta.attachments);
    } else if (agent.interactive) {
      child.stdin.write(`${agent.initLine()}\n${userInput}\n`);
    } else {
      child.stdin.end(input);
    }
  }

  // CLI 쪽 대화를 버리고 다음 요청부터 새 대화로 시작한다. AgentHub의 기록·역할·연결은 그대로 둔다.
  restart(session) {
    if (this.running.has(session.id)) throw new Error("실행 중인 세션은 다시 시작할 수 없습니다. 먼저 중지하세요.");
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
  interrupt(session) {
    const child = this.running.get(session.id);
    if (!child) return false;
    const agent = AGENTS[session.agent];
    if (child.appServer) return this.stop(session);
    if (!agent.interruptLine) return this.stop(session);
    session.stopRequested = true;
    child.stdin.write(`${agent.interruptLine()}\n`);
    setTimeout(() => {
      if (this.running.get(session.id) === child) this.kill(child);
    }, INTERRUPT_GRACE_MS);
    return true;
  }

  stop(session) {
    const child = this.running.get(session.id);
    if (!child) return false;
    session.stopRequested = true;
    this.dropPrompts(session.id);
    if (child.appServer) {
      child.appServer.interrupt();
      const timer = setTimeout(() => { if (this.running.get(session.id) === child) this.kill(child); }, INTERRUPT_GRACE_MS);
      timer.unref?.();
    } else this.kill(child);
    return true;
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
    for (const id of this.running.keys()) this.stop(this.store.get(id));
  }
}

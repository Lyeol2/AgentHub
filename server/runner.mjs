import { EventEmitter } from "node:events";
import * as claude from "./agents/claude.mjs";
import * as codex from "./agents/codex.mjs";
import { spawnCli } from "./cli.mjs";

export const AGENTS = { claude, codex };

const MISSING_CONVERSATION = /No conversation found with session ID/i;

// 세션 하나에 한 번에 한 턴만 실행한다. 다른 세션은 동시에 실행할 수 있다.
export class Runner extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.running = new Map();
  }

  append(session, event) {
    const full = { seq: session.events.length, ts: new Date().toISOString(), ...event };
    session.events.push(full);
    this.store.touch(session);
    this.emit("event", session.id, full);
  }

  setState(session, state) {
    session.state = state;
    this.store.touch(session);
    this.emit("state", session.id, state);
  }

  isRunning(id) {
    return this.running.has(id);
  }

  // input은 CLI에 실제로 넘길 내용이다. 화면에는 prompt만 남긴다. meta는 요청 이벤트에 덧붙인다(넘어온 세션 등).
  // retry는 이어 갈 대화가 없어 새 대화로 다시 보낼 때 쓴다. 요청은 이미 화면에 있으므로 다시 남기지 않는다.
  send(session, prompt, cliPath, input = prompt, meta = {}, retry = false) {
    if (this.running.has(session.id)) throw new Error("이 세션은 이미 실행 중입니다.");
    if (!cliPath) throw new Error(`${session.agent} CLI를 찾지 못했습니다. 설정에서 경로를 지정하세요.`);

    const agent = AGENTS[session.agent];
    const args = agent.buildArgs(session);
    if (!retry) this.append(session, { kind: "user", text: prompt, ...meta });
    this.setState(session, "running");

    const child = spawnCli(cliPath, args, {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    this.running.set(session.id, child);

    const stderrTail = [];
    const resuming = !!session.agentSessionId;
    let completedTurn = false;
    let sawError = false;
    let lastErrorText = null;

    const handleLine = (line) => {
      if (!line.trim()) return;
      for (const event of agent.parseLine(line)) {
        if (event.agentSessionId) {
          session.agentSessionId = event.agentSessionId;
          delete event.agentSessionId;
        }
        if (event.rateLimit) {
          this.emit("limit", session.agent, event.rateLimit);
          continue;
        }
        if (event.kind === "error") {
          // Codex는 같은 오류를 error와 turn.failed로 두 번 보낸다.
          if (event.text === lastErrorText) continue;
          lastErrorText = event.text;
          sawError = true;
        }
        if (event.kind === "result") completedTurn = true;
        this.append(session, event);
      }
    };

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
      this.append(session, { kind: "error", text: `실행 실패: ${err.message}` });
    });

    child.on("close", (code, signal) => {
      if (buffer) handleLine(buffer);
      this.running.delete(session.id);
      // 첫 턴이 끝까지 가지 못했으면 CLI 쪽에 이어 갈 대화가 없을 수 있으므로 다음 턴은 새로 시작한다.
      if (!resuming && !completedTurn) session.agentSessionId = null;
      // CLI 쪽 대화가 지워졌으면(다른 앱에서 삭제 등) 이어 갈 수 없으므로 새 대화로 한 번 다시 보낸다.
      if (resuming && !completedTurn && !retry && !session.stopRequested && MISSING_CONVERSATION.test(stderrTail.join(""))) {
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
        this.append(session, { kind: "status", text: "사용자가 중지했습니다." });
        this.setState(session, "idle");
        this.emit("turnEnd", session, null);
        return;
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

    child.stdin.end(input);
  }

  stop(session) {
    const child = this.running.get(session.id);
    if (!child) return false;
    session.stopRequested = true;
    if (process.platform === "win32") {
      // cmd.exe를 거친 경우 자식 프로세스까지 종료해야 한다.
      spawnCli("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else {
      child.kill("SIGINT");
    }
    return true;
  }

  stopAll() {
    for (const id of this.running.keys()) this.stop(this.store.get(id));
  }
}

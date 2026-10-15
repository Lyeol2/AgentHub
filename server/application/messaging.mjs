// 세션 메시지의 업무 처리. 실행·대기열·기록 저장은 주입받은 포트로 수행한다.
import { randomBytes } from "node:crypto";
import { ASK_TIMEOUT_SEC, ASK_TIMEOUT_MAX, MESSAGE_MAX, TURN_MAX, LOG_MAX, BOARD_MAX, boundedText, sameProject, canContact, findTarget, messageText, directoryText, extractMessages } from "../policies/messaging.mjs";
import { MAX_HOPS, lastAnswer } from "../policies/workflows.mjs";
import { HttpError } from "./errors.mjs";

export class Mailbox {
  // sessions(projectPath): 같은 프로젝트의 세션 목록. links가 없으면 연락을 허용하지 않는다.
  // notify("messages", { projectPath }): 기록 변경을 외부에 알린다.
  constructor({ runner, chain, links, sessions, notify = () => {}, messageLog, autoTurnEnd = true }) {
    this.runner = runner;
    this.chain = chain;
    this.links = links;
    this.sessions = sessions;
    this.notify = notify;
    this.asks = new Map(); // 답을 기다리는 세션 ID → { targetId, resolve, timer }
    this.sentThisTurn = new Map(); // 세션 ID → 이번 턴에 보낸 메시지 수
    this.messageLog = messageLog;
    this.log = messageLog.list();
    this.turnEndListener = (session) => this.onTurnEnd(session);
    if (autoTurnEnd) runner.on("turnEnd", this.turnEndListener);
  }

  onTurnEnd(session) {
    this.sentThisTurn.delete(session.id);
    this.settleAsk(session.id, null);
  }

  dispose() {
    this.runner.off("turnEnd", this.turnEndListener);
    for (const id of this.asks.keys()) this.settleAsk(id, null);
  }

  // 같은 프로젝트에서 활성 연결선으로 직접 연결된 상대만 찾는다. 답장을 위해 연결 방향은 구분하지 않는다.
  contacts(session) {
    if (session.chat) return [];
    const links = this.links?.list() ?? [];
    return this.sessions(session.projectPath).filter((other) => canContact(links, session, other));
  }

  target(from, to) {
    if (from.chat) throw new Error("일반 채팅 세션은 메시지를 보낼 수 없습니다.");
    try {
      return findTarget(this.contacts(from), from, to);
    } catch (err) {
      throw new Error(`${err.message} 활성화된 연결선으로 직접 연결된 세션끼리만 연락할 수 있습니다.`);
    }
  }

  // from이 to에게 메시지를 보낸다. 돌려주는 값: { target, via: "answer" | "live" | "queue" }
  send(from, to, text, { ask = false } = {}) {
    if (from.chat) throw new Error("일반 채팅 세션은 메시지를 보낼 수 없습니다.");
    const body = boundedText(text, MESSAGE_MAX);
    if (!body) throw new Error("메시지 내용이 없습니다.");
    const count = (this.sentThisTurn.get(from.id) ?? 0) + 1;
    if (count > TURN_MAX) throw new Error(`한 턴에 메시지는 ${TURN_MAX}개까지 보낼 수 있습니다.`);
    const target = this.target(from, to);

    // 메시지 블록(wait)으로 답을 기다리며 턴을 끝낸 세션에 온 답은 하던 일을 잇는 요청이다. 끝나면 연결로도 넘긴다.
    const reply = target.awaitingReply === from.id;
    if (reply) delete target.awaitingReply;
    const meta = { from: from.id, fromTitle: from.title, ...(reply ? { reply: true } : { message: true }) };

    let via;
    const waiting = this.asks.get(target.id);
    if (waiting?.targetId === from.id && !ask) {
      // 상대가 ask_session으로 이 세션의 답을 기다리고 있으면 그 도구 호출의 결과로 돌려준다.
      this.settleAsk(target.id, body);
      this.runner.append(target, { kind: "user", text: messageText(from, body), from: from.id, fromTitle: from.title, message: true, injected: true });
      via = "answer";
    } else if (this.runner.canInject(target)) {
      // 실행 중인 Claude 세션은 작업 중인 턴에 바로 붙인다.
      this.runner.inject(target, messageText(from, body, { ask }), meta);
      via = "live";
    } else {
      const depth = (from.chainDepth ?? 0) + 1;
      if (depth > MAX_HOPS) throw new Error(`메시지로 이어진 단계가 ${MAX_HOPS}단계를 넘었습니다. 사용자에게 알리고 멈춘다.`);
      this.chain.enqueue(target, messageText(from, body, { ask }), meta, depth);
      via = "queue";
    }
    this.sentThisTurn.set(from.id, count); // 실제로 보낸 것만 센다.
    this.runner.append(from, { kind: "message", to: target.id, toTitle: target.title, text: body, via });
    this.record(from, target, body, via);
    return { target, via };
  }

  // from이 to에게 묻고 답을 기다린다. 제한 시간 안에 답이 없으면 null로 끝나고, 늦은 답은 다음 요청으로 받는다.
  ask(from, to, question, timeoutSec = ASK_TIMEOUT_SEC) {
    const target = this.target(from, to);
    if (this.asks.get(target.id)?.targetId === from.id) {
      throw new Error(`"${target.title}" 세션도 이 세션의 답을 기다리고 있습니다. 먼저 send_message로 답하세요.`);
    }
    if (this.asks.has(from.id)) throw new Error("이미 다른 세션의 답을 기다리고 있습니다.");
    const result = new Promise((resolve) => {
      const seconds = Math.min(Math.max(Number(timeoutSec) || ASK_TIMEOUT_SEC, 10), ASK_TIMEOUT_MAX);
      const timer = setTimeout(() => this.settleAsk(from.id, null), seconds * 1000);
      this.asks.set(from.id, { targetId: target.id, resolve, timer });
    });
    try {
      this.send(from, target.id, question, { ask: true });
    } catch (err) {
      this.settleAsk(from.id, null);
      throw err;
    }
    return result.then((answer) => ({ target, answer }));
  }

  settleAsk(sessionId, answer) {
    const pending = this.asks.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.asks.delete(sessionId);
    pending.resolve(answer);
  }

  // 대기열에 쌓인 메시지를 꺼낸다(작업 중에 check_messages로 확인할 때). 꺼낸 것은 다음 요청으로 다시 가지 않는다.
  inbox(session) {
    const items = this.chain.takeWhere(session.id, (item) => item.meta.message || item.meta.reply);
    const allowed = new Set(this.contacts(session).map((other) => other.id));
    // 보낸 뒤 연결이 끊기거나 보낸 세션이 지워진 메시지는 전달하지 않고 버린다.
    const deliverable = items.filter((item) => allowed.has(item.meta.from));
    for (const item of deliverable) this.runner.append(session, { kind: "user", text: item.text, ...item.meta, injected: true });
    return deliverable.map((item) => item.text);
  }

  // 직접 연결되어 연락할 수 있는 세션 목록(도구가 돌려줄 글)
  directory(session) {
    return directoryText(this.contacts(session));
  }

  record(from, target, text, via) {
    this.log.push({ id: randomBytes(4).toString("hex"), projectPath: from.projectPath, from: from.id, to: target.id, text: text.slice(0, 300), via, at: new Date().toISOString() });
    if (this.log.length > LOG_MAX) this.log = this.log.slice(-LOG_MAX);
    this.messageLog.save(this.log);
    this.notify("messages", { projectPath: from.projectPath });
  }

  list(projectPath, same) {
    return this.log.filter((m) => same(m.projectPath, projectPath));
  }

  // 지운 세션의 메시지 기록도 지운다.
  removeForSession(sessionId) {
    const before = this.log.length;
    this.log = this.log.filter((m) => m.from !== sessionId && m.to !== sessionId);
    this.settleAsk(sessionId, null);
    if (this.log.length !== before) this.messageLog.save(this.log);
  }
}

// 노트의 입력·크기·기록 형식은 업무 규칙이며 저장소는 문자열만 읽고 쓴다.
export class ProjectBoard {
  constructor({ repository, now = () => new Date() }) {
    this.repository = repository;
    this.now = now;
  }

  read(projectPath) { return this.repository.read(projectPath); }

  post(projectPath, author, text) {
    const body = boundedText(text, MESSAGE_MAX);
    if (!body) throw new Error("노트에 남길 내용이 없습니다.");
    const entry = `## ${author} · ${this.now().toLocaleString("ko-KR", { hour12: false })}\n\n${body}\n`;
    const before = this.read(projectPath);
    let board = before ? `${before}\n${entry}` : entry;
    if (board.length > BOARD_MAX) {
      const cut = board.indexOf("\n## ", board.length - BOARD_MAX);
      board = cut >= 0 ? board.slice(cut + 1) : board.slice(-BOARD_MAX);
    }
    this.repository.write(projectPath, board);
    return board;
  }

  write(projectPath, text) { this.repository.write(projectPath, String(text).slice(-BOARD_MAX)); }

  clear(projectPath) { this.repository.clear(projectPath); }
}

// MCP가 없는 에이전트의 답변 블록도 같은 서비스의 발신 정책을 거친다.
export function processMessageBlocks(session, ok, { mailbox, runner }) {
  if (session.chat || ok === null) return;
  const found = extractMessages(lastAnswer(session));
  if (!found) return;
  if (found.error) {
    runner.append(session, { kind: "error", text: found.error });
    return;
  }
  for (const message of found.messages) {
    try {
      const { target } = mailbox.send(session, message.to, message.text);
      if (message.wait && !session.awaitingReply) {
        session.awaitingReply = target.id;
        session.waiting = true;
        runner.append(session, { kind: "status", text: `"${target.title}"의 답을 기다립니다` });
      }
    } catch (err) {
      runner.append(session, { kind: "error", text: `메시지를 보내지 못했습니다: ${err.message}` });
    }
  }
}

// HTTP와 같은 외부 진입점이 공유하는 프로젝트 메시지·노트 작업.
export function createMessagingService({ mailbox, board, projects, notify = () => {} }) {
  const requireProject = (projectPath) => {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
  };
  return {
    list(projectPath) {
      requireProject(projectPath);
      return mailbox.list(projectPath, sameProject);
    },
    readBoard(projectPath) {
      requireProject(projectPath);
      return { text: board.read(projectPath) };
    },
    writeBoard({ path: projectPath, text: value }) {
      const project = projects.ensureProject(projectPath);
      const text = String(value ?? "").trim();
      if (text.length > BOARD_MAX) throw new HttpError(400, "공유 노트는 60000자까지 쓸 수 있습니다.");
      if (text) board.write(project.path, text + "\n");
      else board.clear(project.path);
      notify("board", { projectPath: project.path });
      return { text: board.read(project.path) };
    },
  };
}

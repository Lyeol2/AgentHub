// 세션끼리 주고받는 메시지와 프로젝트 공유 노트.
// 에이전트는 AgentHub MCP 도구(작업 중)나 답변 끝의 메시지 블록(턴이 끝날 때)으로 다른 세션에 말을 건다.
// 받는 세션이 실행 중인 Claude면 작업 중인 턴에 바로 붙이고, 아니면 대기열에 넣어 다음 요청으로 보낸다.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.mjs";
import { MAX_HOPS } from "./chain.mjs";

export const MESSAGE_FENCE = "agenthub-message";
export const MESSAGE_MAX = 8000;
const BLOCK_MAX = 4; // 블록 하나에 담을 수 있는 메시지 수
const TURN_MAX = 12; // 한 턴에 보낼 수 있는 메시지 수. 세션끼리 끝없이 떠드는 것을 막는다.
const LOG_MAX = 300;
const BOARD_MAX = 60000;
export const ASK_TIMEOUT_SEC = 300;
export const ASK_TIMEOUT_MAX = 600;

const LOG_PATH = path.join(DATA_DIR, "messages.json");
const BOARD_DIR = path.join(DATA_DIR, "boards");

export const MESSAGE_GUIDE = `[AgentHub 세션 간 소통]
이 프로젝트에는 다른 AI 세션들이 함께 일한다. 다른 세션의 도움이나 합의가 필요할 때 agenthub MCP 도구로 소통한다.
- list_sessions: 다른 세션의 이름·역할·상태를 본다.
- send_message(to, text): 다른 세션에 메시지를 보낸다. 상대가 작업 중이면 작업 중에, 아니면 다음 요청으로 받는다.
- ask_session(to, question): 묻고 답이 올 때까지 기다린다. 답 없이는 진행할 수 없을 때만 쓴다.
- check_messages: 작업 중에 나에게 온 메시지를 확인한다. 오래 걸리는 작업 중간에 확인한다.
- board_read / board_post(text): 프로젝트 공유 노트. API 약속, 정한 사항, 진행 상황처럼 모두가 알아야 할 것을 남긴다.
다른 세션에서 온 메시지에 답할 때는 send_message로 보낸 세션에게 보낸다. 자기 일은 스스로 끝내고 꼭 필요할 때만 말을 건다.
MCP 도구를 쓸 수 없으면 답변 끝에 아래 블록을 쓴다. wait가 true면 답이 올 때까지 다음 단계로 넘기지 않는다.
\`\`\`${MESSAGE_FENCE}
{"to": "받는 세션 이름이나 역할", "text": "메시지", "wait": false}
\`\`\``;

const str = (value, max) => String(value ?? "").trim().slice(0, max);
const MESSAGE_BLOCK = new RegExp("```" + MESSAGE_FENCE + "\\s*\\n([\\s\\S]*?)```", "g");

// 답변에서 메시지 블록을 모두 꺼낸다. 없으면 null, 형식이 틀리면 { error }.
// 블록 하나에 메시지 하나({to, text}) 또는 여러 개({messages: [...]}, 배열)를 쓸 수 있다.
export function extractMessages(text) {
  const blocks = [...String(text ?? "").matchAll(MESSAGE_BLOCK)];
  if (!blocks.length) return null;
  const messages = [];
  for (const block of blocks) {
    let raw;
    try {
      raw = JSON.parse(block[1]);
    } catch (err) {
      return { error: `메시지 블록이 JSON 형식이 아닙니다: ${err.message}` };
    }
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [raw];
    for (const item of items.slice(0, BLOCK_MAX)) {
      const message = { to: str(item?.to, 200), text: str(item?.text, MESSAGE_MAX), wait: !!item?.wait };
      if (message.to && message.text) messages.push(message);
    }
  }
  if (!messages.length) return { error: "메시지 블록에 받는 세션(to)과 내용(text)이 없습니다." };
  return { messages };
}

// 화면에서 답변 본문의 메시지 블록을 뺄 때 쓴다.
export const stripMessages = (text) => String(text ?? "").replace(MESSAGE_BLOCK, "").trim();

// 같은 프로젝트에서 이름(id, 제목, 역할 이름)으로 받는 세션을 찾는다. 못 찾거나 여럿이면 Error.
export function findTarget(sessions, from, to) {
  const key = str(to, 200).toLowerCase();
  const others = sessions.filter((s) => s.id !== from.id && !s.chat);
  const byId = others.find((s) => s.id.toLowerCase() === key);
  if (byId) return byId;
  const exact = others.filter((s) => s.title?.toLowerCase() === key || s.roleName?.toLowerCase() === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`"${to}"인 세션이 여럿입니다. 세션 id로 보내세요: ${exact.map((s) => `${s.id}(${s.title})`).join(", ")}`);
  }
  // "작업 · 리뷰"처럼 흐름 이름이 붙은 제목은 뒷부분만으로도 찾는다.
  const partial = others.filter((s) => s.title?.toLowerCase().split(/\s*·\s*/).includes(key));
  if (partial.length === 1) return partial[0];
  const names = others.map((s) => s.title).join(", ") || "없음";
  throw new Error(`"${to}" 세션을 찾지 못했습니다. 보낼 수 있는 세션: ${names}`);
}

// 받는 세션에 들어갈 요청 글
export function messageText(from, text, { ask = false } = {}) {
  const role = from.roleName ? ` · 역할 ${from.roleName}` : "";
  const reply = ask
    ? `"${from.title}" 세션이 답을 기다리고 있다. send_message(to: "${from.title}")로 답한다.`
    : `답이 필요하면 send_message(to: "${from.title}")로 보낸다.`;
  return [`[세션 메시지] 보낸 세션: ${from.title} (${from.agent}${role}, id ${from.id})`, "", text, "", reply].join("\n");
}

// 사람이 읽는 상태 이름
const STATE_TEXT = { idle: "대기", running: "실행 중", error: "오류", interrupted: "중단됨" };

export class Mailbox {
  // sessions(projectPath): 같은 프로젝트의 세션 목록
  // notify(kind, data): kind "messages" | "board"
  constructor({ store, runner, chain, sessions, notify = () => {} }) {
    this.store = store;
    this.runner = runner;
    this.chain = chain;
    this.sessions = sessions;
    this.notify = notify;
    this.asks = new Map(); // 답을 기다리는 세션 ID → { targetId, resolve, timer }
    this.sentThisTurn = new Map(); // 세션 ID → 이번 턴에 보낸 메시지 수
    this.log = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, "utf8")) : [];
    runner.on("turnEnd", (session) => {
      this.sentThisTurn.delete(session.id);
      // 턴이 끝났는데 아직 답을 기다리던 도구 호출은 거둔다.
      this.settleAsk(session.id, null);
    });
  }

  // from이 to에게 메시지를 보낸다. 돌려주는 값: { target, via: "answer" | "live" | "queue" }
  send(from, to, text, { ask = false } = {}) {
    if (from.chat) throw new Error("일반 채팅 세션은 메시지를 보낼 수 없습니다.");
    const body = str(text, MESSAGE_MAX);
    if (!body) throw new Error("메시지 내용이 없습니다.");
    const count = (this.sentThisTurn.get(from.id) ?? 0) + 1;
    if (count > TURN_MAX) throw new Error(`한 턴에 메시지는 ${TURN_MAX}개까지 보낼 수 있습니다.`);
    const target = findTarget(this.sessions(from.projectPath), from, to);

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
    const target = findTarget(this.sessions(from.projectPath), from, to);
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
    for (const item of items) this.runner.append(session, { kind: "user", text: item.text, ...item.meta, injected: true });
    return items.map((item) => item.text);
  }

  // 같은 프로젝트의 다른 세션 목록(도구가 돌려줄 글)
  directory(session) {
    const others = this.sessions(session.projectPath).filter((s) => s.id !== session.id && !s.chat);
    if (!others.length) return "다른 세션이 없습니다.";
    return others.map((s) => {
      const role = s.roleName ? ` · 역할 ${s.roleName}` : "";
      const first = s.role?.split(/\r?\n/).find((l) => l.trim())?.slice(0, 120);
      return `- ${s.title} (id ${s.id}, ${s.agent}${role}, ${STATE_TEXT[s.state] ?? s.state})${first ? `\n  ${first}` : ""}`;
    }).join("\n");
  }

  record(from, target, text, via) {
    this.log.push({ id: randomBytes(4).toString("hex"), projectPath: from.projectPath, from: from.id, to: target.id, text: text.slice(0, 300), via, at: new Date().toISOString() });
    if (this.log.length > LOG_MAX) this.log = this.log.slice(-LOG_MAX);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOG_PATH, JSON.stringify(this.log, null, 2));
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
    if (this.log.length !== before) fs.writeFileSync(LOG_PATH, JSON.stringify(this.log, null, 2));
  }
}

// ── 공유 노트 ───────────────────────────────────────────────────
// 프로젝트마다 마크다운 파일 하나. 세션은 MCP 도구로 읽고 덧붙이고, 화면에서 보고 지울 수 있다.
const boardPath = (projectPath) =>
  path.join(BOARD_DIR, `${createHash("sha1").update(path.resolve(projectPath).toLowerCase()).digest("hex").slice(0, 16)}.md`);

export function readBoard(projectPath) {
  try {
    return fs.readFileSync(boardPath(projectPath), "utf8");
  } catch {
    return "";
  }
}

// 글 하나를 덧붙인다. 너무 길어지면 오래된 글부터 버린다.
export function postBoard(projectPath, author, text) {
  const body = str(text, MESSAGE_MAX);
  if (!body) throw new Error("노트에 남길 내용이 없습니다.");
  const entry = `## ${author} · ${new Date().toLocaleString("ko-KR", { hour12: false })}\n\n${body}\n`;
  const before = readBoard(projectPath);
  let board = before ? `${before}\n${entry}` : entry;
  if (board.length > BOARD_MAX) {
    const cut = board.indexOf("\n## ", board.length - BOARD_MAX);
    board = cut >= 0 ? board.slice(cut + 1) : board.slice(-BOARD_MAX);
  }
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  fs.writeFileSync(boardPath(projectPath), board);
  return board;
}

// 화면에서 고친 노트로 통째로 바꾼다.
export function writeBoard(projectPath, text) {
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  fs.writeFileSync(boardPath(projectPath), String(text).slice(-BOARD_MAX));
}

export function clearBoard(projectPath) {
  fs.rmSync(boardPath(projectPath), { force: true });
}

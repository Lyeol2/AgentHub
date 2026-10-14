// 연결 조건에 따라 한 세션의 결과를 다음 세션의 요청으로 넘긴다.
import { changedFiles } from "./git.mjs";
import { withRole } from "./role.mjs";

export const CONDITIONS = ["success", "keyword", "error", "always", "manual"];
// 자동으로 이어지는 최대 단계. 서로를 가리키는 연결이 끝없이 돌지 않게 막는다.
export const MAX_HOPS = 8;
const ANSWER_MAX = 8000;

// 마지막 요청 이후 에이전트가 쓴 답변
export function lastAnswer(session) {
  let start = 0;
  for (let i = session.events.length - 1; i >= 0; i--) {
    if (session.events[i].kind === "user") {
      start = i + 1;
      break;
    }
  }
  const text = session.events.slice(start).filter((e) => e.kind === "text").map((e) => e.text).join("\n\n").trim();
  return text.length > ANSWER_MAX ? `… (앞부분 생략)\n${text.slice(-ANSWER_MAX)}` : text;
}

// ok: 턴 성공 여부. 사용자가 중지한 턴(null)은 넘기지 않는다.
export function matches(link, ok, answer) {
  if (!link.enabled || ok === null) return false;
  switch (link.when) {
    case "success": return ok;
    case "error": return !ok;
    case "always": return true;
    case "keyword": return ok && !!link.keyword && answer.toLowerCase().includes(link.keyword.toLowerCase());
    default: return false;
  }
}

export function handoffText(source, link, answer, files) {
  const role = source.role ? `\n보낸 세션의 역할: ${source.role.split(/\r?\n/)[0]}` : "";
  const branch = source.worktree ? ` (브랜치 ${source.worktree.branch})` : "";
  return [
    `[연결된 세션에서 넘어온 작업]`,
    `보낸 세션: ${source.title} (${source.agent})${role}`,
    `작업 폴더: ${source.cwd}${branch}`,
    "",
    "변경 파일:",
    files.trim() || "(없음)",
    "",
    "마지막 답변:",
    answer || "(답변 없음)",
    "",
    link.note?.trim() || "이 결과를 이어받아 네 역할에 맞게 처리하라.",
  ].join("\n");
}

export class Chain {
  // compose: CLI에 실제로 넘길 내용을 만든다(역할·공통 지침·오케스트레이터 맥락).
  constructor({ store, runner, links, cliPaths, compose = withRole }) {
    this.store = store;
    this.runner = runner;
    this.links = links;
    this.cliPaths = cliPaths;
    this.compose = compose;
    this.queue = new Map(); // 받는 세션 ID → 실행 중이라 밀린 작업
    runner.on("turnEnd", (session, ok) => this.onTurnEnd(session, ok).catch((err) => console.error(err)));
  }

  pending(sessionId) {
    return this.queue.get(sessionId)?.length ?? 0;
  }

  async onTurnEnd(session, ok) {
    if (ok === null) {
      // 사용자가 멈춘 세션은 밀린 작업도 버린다.
      this.queue.delete(session.id);
    } else {
      const answer = lastAnswer(session);
      for (const link of this.links.from(session.id)) {
        if (matches(link, ok, answer)) await this.deliver(link, session.chainDepth ?? 0);
      }
    }
    this.flush(session);
  }

  // depth: 보내는 세션이 흐름에서 몇 번째 단계인지
  async deliver(link, depth) {
    const source = this.store.get(link.from);
    const target = this.store.get(link.to);
    if (!source || !target) return;
    if (depth >= MAX_HOPS) {
      this.runner.append(source, { kind: "status", text: `자동 연결이 ${MAX_HOPS}단계를 넘어 "${target.title}"(으)로 넘기지 않았습니다.` });
      return;
    }
    // Claude는 작업 폴더 밖을 읽으려면 허락이 필요하므로 보낸 세션의 폴더를 실행 인자로 열어 준다.
    if (target.agent === "claude" && source.cwd.toLowerCase() !== target.cwd.toLowerCase()) {
      target.addDirs = [...new Set([...(target.addDirs ?? []), source.cwd])];
    }
    const files = source.baseCommit ? await changedFiles(source.cwd, source.baseCommit).catch(() => "") : "";
    const waiting = this.runner.isRunning(target.id);
    this.runner.append(source, { kind: "status", text: `"${target.title}"(으)로 넘김${waiting ? " · 실행이 끝나면 시작" : ""}` });
    this.enqueue(target, handoffText(source, link, lastAnswer(source), files), { from: source.id, fromTitle: source.title }, depth + 1);
  }

  // 세션에 요청을 넣는다. 실행 중이면 끝난 뒤 차례로 보낸다.
  enqueue(target, text, meta, depth) {
    const queue = this.queue.get(target.id) ?? [];
    queue.push({ text, meta, depth });
    this.queue.set(target.id, queue);
    this.flush(target);
  }

  flush(session) {
    const queue = this.queue.get(session.id);
    if (!queue?.length || this.runner.isRunning(session.id)) return;
    const item = queue.shift();
    if (!queue.length) this.queue.delete(session.id);
    session.chainDepth = item.depth;
    try {
      this.runner.send(session, item.text, this.cliPaths()[session.agent], this.compose(session, item.text), item.meta);
    } catch (err) {
      this.runner.append(session, { kind: "error", text: `넘어온 작업을 시작하지 못했습니다: ${err.message}` });
    }
  }
}

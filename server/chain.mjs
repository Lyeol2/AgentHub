// 연결 조건에 따라 한 세션의 결과를 다음 세션의 요청으로 넘긴다.
import { randomBytes } from "node:crypto";
import { changedFiles } from "./git.mjs";
import { withRole } from "./role.mjs";
import { isCommandId, runShell, outputTail, commandHandoffText } from "./commands.mjs";

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
  // notify: 연결(승인 대기)이나 대기열이 바뀌면 화면에 알린다. (kind: "links" | "queue", sessionId)
  // commands: 명령 노드 저장소(없으면 명령 노드를 쓰지 않는다). notify("commands")로 명령 상태 변화를 알린다.
  constructor({ store, runner, links, cliPaths, compose = withRole, notify = () => {}, commands = null }) {
    this.store = store;
    this.commands = commands;
    this.runs = new Map(); // 실행 중인 명령 노드 ID → { stop }
    this.runner = runner;
    this.links = links;
    this.cliPaths = cliPaths;
    this.compose = compose;
    this.notify = notify;
    this.queue = new Map(); // 받는 세션 ID → 실행 중이라 밀린 작업(넘어온 작업과 사용자가 대기열에 넣은 요청)
    runner.on("turnEnd", (session, ok) => this.onTurnEnd(session, ok).catch((err) => console.error(err)));
  }

  pending(sessionId) {
    return this.queue.get(sessionId)?.length ?? 0;
  }

  async onTurnEnd(session, ok) {
    if (ok === null) {
      // 사용자가 멈춘 세션은 넘어온 작업을 버린다. 사용자가 대기열에 넣은 요청은 남겨 두고, 직접 보낼 때까지 시작하지 않는다.
      const kept = (this.queue.get(session.id) ?? []).filter((item) => item.meta.user);
      if (kept.length) this.queue.set(session.id, kept);
      else this.queue.delete(session.id);
      this.notify("queue", session.id);
      return;
    }
    if (!session.waiting) {
      // 사용자에게 질문하고 답을 기다리는 턴은 끝난 작업이 아니므로 넘기지 않는다.
      const answer = lastAnswer(session);
      for (const link of this.links.from(session.id)) {
        if (!matches(link, ok, answer)) continue;
        if (link.approve) this.hold(link, session, answer, session.chainDepth ?? 0);
        else await this.deliver(link, session.chainDepth ?? 0);
      }
    }
    this.flush(session);
  }

  // 승인을 받아야 넘기는 연결은 연결선 위에 승인 대기로 올려 둔다. 같은 연결에 다시 쌓이면 마지막 것만 남긴다.
  hold(link, source, answer, depth) {
    const target = this.node(link.to);
    if (!target) return;
    const preview = answer.split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) ?? "";
    this.links.update(link, { pending: { depth, preview, at: new Date().toISOString() } });
    this.note(source, `"${target.title}"(으)로 넘기기 전에 승인을 기다립니다`);
    this.notify("links");
  }

  // 연결 끝은 세션이거나 명령 노드다.
  node(id) {
    return isCommandId(id) ? this.commands?.get(id) : this.store.get(id);
  }

  // 세션이면 기록에 상태 줄을 남긴다(명령 노드에는 기록이 없다).
  note(source, text) {
    if (source?.events) this.runner.append(source, { kind: "status", text });
  }

  // 승인 대기 중인 연결을 넘기거나 버린다.
  async decide(link, approve) {
    const pending = link.pending;
    if (!pending) throw new Error("승인을 기다리는 넘기기가 없습니다.");
    this.links.update(link, { pending: null });
    this.notify("links");
    const source = this.node(link.from);
    const target = this.node(link.to);
    if (approve) return this.deliver(link, pending.depth);
    if (source && target) this.note(source, `"${target.title}"(으)로 넘기지 않았습니다(거절)`);
  }

  // depth: 보내는 세션이 흐름에서 몇 번째 단계인지
  async deliver(link, depth) {
    const source = this.node(link.from);
    const target = this.node(link.to);
    if (!source || !target) return;
    if (depth >= MAX_HOPS) {
      this.note(source, `자동 연결이 ${MAX_HOPS}단계를 넘어 "${target.title}"(으)로 넘기지 않았습니다.`);
      return;
    }
    // 명령 노드로 넘기면 명령을 실행한다. 실행 폴더는 명령을 처음 실행시킨 세션을 따른다.
    if (isCommandId(target.id)) {
      const origin = isCommandId(source.id) ? this.store.get(source.lastRun?.originId) : source;
      this.note(source, `명령 "${target.title}" 실행`);
      this.runCommand(target, { origin, depth: depth + 1 });
      return;
    }
    // 명령 노드에서 세션으로: 명령 결과(종료 코드·출력)를 넘긴다.
    if (isCommandId(source.id)) {
      const origin = this.store.get(source.lastRun?.originId);
      this.enqueue(target, commandHandoffText(source, source.lastRun, link, origin), { from: source.id, fromTitle: source.title }, depth + 1);
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

  // ── 명령 노드 실행 ────────────────────────────────────────────
  // 실행 중에 또 넘어오면 끝난 뒤 마지막 것만 한 번 더 실행한다. 실행이 끝나면 resolve되는 Promise를 돌려준다.
  runCommand(cmd, { origin = null, depth = 0 } = {}) {
    if (this.runs.has(cmd.id)) {
      this.commands.update(cmd, { queued: { originId: origin?.id ?? null, depth } });
      this.notify("commands");
      return null;
    }
    const cwd = cmd.cwdMode === "source" && origin?.cwd ? origin.cwd : cmd.projectPath;
    const startedAt = new Date().toISOString();
    this.commands.update(cmd, { state: "running", queued: null, live: { startedAt, cwd, tail: "" } });
    this.notify("commands");
    let lastNotify = 0;
    const run = runShell({
      shell: cmd.shell, command: cmd.command, cwd, timeoutSec: cmd.timeoutSec,
      onOutput: (output) => {
        // 출력은 1초에 한 번만 화면에 알린다.
        if (Date.now() - lastNotify < 1000) return;
        lastNotify = Date.now();
        cmd.live = { startedAt, cwd, tail: outputTail(output, 12, 2000) };
        this.notify("commands");
      },
    });
    this.runs.set(cmd.id, run);
    return run.done.then((result) => this.afterCommand(cmd, result, { origin, depth, cwd, startedAt }));
  }

  async afterCommand(cmd, result, { origin, depth, cwd, startedAt }) {
    this.runs.delete(cmd.id);
    if (!this.commands.get(cmd.id)) return; // 실행 중에 지운 명령 노드
    const ok = result.exitCode === 0;
    const lastRun = {
      exitCode: result.exitCode, ok, timedOut: result.timedOut, stopped: result.stopped,
      durationMs: result.durationMs, startedAt, cwd, tail: outputTail(result.output),
      originId: origin?.id ?? null, originTitle: origin?.title ?? null,
    };
    this.commands.update(cmd, { state: result.stopped ? "idle" : ok ? "success" : "error", lastRun, live: null });
    this.notify("commands");
    // 사용자가 멈춘 실행은 다음으로 넘기지 않는다.
    if (!result.stopped) {
      for (const link of this.links.from(cmd.id)) {
        if (!matches(link, ok, result.output)) continue;
        if (link.approve) this.hold(link, cmd, lastRun.tail, depth);
        else await this.deliver(link, depth);
      }
    }
    const queued = cmd.queued;
    if (queued) await this.runCommand(cmd, { origin: this.store.get(queued.originId), depth: queued.depth });
  }

  stopCommand(cmd) {
    const run = this.runs.get(cmd.id);
    if (!run) return false;
    this.commands.update(cmd, { queued: null });
    run.stop();
    return true;
  }

  // 세션에 요청을 넣는다. 실행 중이면 끝난 뒤 차례로 보낸다.
  // meta.user: 사용자가 실행 중에 대기열에 넣은 요청
  enqueue(target, text, meta, depth) {
    const queue = this.queue.get(target.id) ?? [];
    const item = { id: randomBytes(4).toString("hex"), text, meta, depth };
    queue.push(item);
    this.queue.set(target.id, queue);
    this.flush(target);
    this.notify("queue", target.id);
    return item;
  }

  // 화면에 보여 줄 대기열
  list(sessionId) {
    return (this.queue.get(sessionId) ?? []).map(({ id, text, meta }) => ({ id, text, user: !!meta.user, fromTitle: meta.fromTitle ?? null }));
  }

  // 대기열에서 꺼낸다(지우기, 지금 붙이기, 바로 보내기).
  take(sessionId, id) {
    const queue = this.queue.get(sessionId) ?? [];
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [item] = queue.splice(index, 1);
    if (!queue.length) this.queue.delete(sessionId);
    this.notify("queue", sessionId);
    return item;
  }

  flush(session) {
    const queue = this.queue.get(session.id);
    if (!queue?.length || this.runner.isRunning(session.id)) return;
    const item = queue.shift();
    if (!queue.length) this.queue.delete(session.id);
    this.notify("queue", session.id);
    session.chainDepth = item.depth;
    try {
      this.runner.send(session, item.text, this.cliPaths()[session.agent], this.compose(session, item.text), item.meta);
    } catch (err) {
      this.runner.append(session, { kind: "error", text: `넘어온 작업을 시작하지 못했습니다: ${err.message}` });
    }
  }
}

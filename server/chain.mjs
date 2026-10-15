// 연결 조건에 따라 한 세션의 결과를 다음 세션의 요청으로 넘긴다.
import { randomBytes } from "node:crypto";
import { changedFiles } from "./git.mjs";
import { withRole } from "./role.mjs";
import { isCommandId, runShell, outputTail, commandHandoffText } from "./commands.mjs";

export const CONDITIONS = ["success", "keyword", "error", "always", "otherwise", "manual"];
// 화면의 조건 선택지(보이는 순서). 서버가 내려 주고 같은 목록으로 검사한다.
export const CONDITION_LABELS = {
  keyword: "답변 마지막 줄에 키워드가 있으면",
  success: "턴이 성공하면",
  error: "턴이 실패하면",
  otherwise: "다른 연결이 모두 안 맞으면 (그 외)",
  always: "턴이 끝날 때마다",
  manual: "수동으로만",
};
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

// 판정 줄: 답변의 마지막 글 줄. 마크다운 꾸밈(#, >, -, **, `)과 감싼 따옴표는 걷어 낸다.
export function verdictLine(answer) {
  const lines = String(answer ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(```|~~~)/.test(l));
  return (lines.at(-1) ?? "")
    .replace(/^(?:[#>*+-]+\s*)+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/^["'“‘](.*)["'”’]$/, "$1")
    .trim();
}

// 키워드는 쉼표로 여러 개를 적을 수 있고 하나라도 있으면 맞는다.
export const keywordList = (keyword) => String(keyword ?? "").split(/[,，]/).map((k) => k.trim()).filter(Boolean);

// 키워드 바로 뒤에 부정이 오면("수정 필요 없음", "검토 요청 아님") 맞지 않은 것으로 본다.
const NEGATION = /^\s*(?:은|는|이|가)?\s*(?:없|아니|아님|않|안\s|불필요|no\b|not\b|none\b)/i;

export function hasKeyword(text, keyword) {
  const hay = String(text ?? "").toLowerCase();
  return keywordList(keyword).some((k) => {
    const needle = k.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
      if (!NEGATION.test(hay.slice(i + needle.length))) return true;
    }
    return false;
  });
}

// 연결 하나만 볼 때의 조건. "그 외"는 다른 연결과 함께 봐야 하므로 pickLinks에서 정한다.
// ok: 턴 성공 여부. 사용자가 중지한 턴(null)은 넘기지 않는다.
// verdict: 키워드를 찾을 글(세션은 답변 마지막 줄, 명령 노드는 출력 전체).
export function matches(link, ok, verdict) {
  if (!link.enabled || ok === null) return false;
  switch (link.when) {
    case "success": return ok;
    case "error": return !ok;
    case "always": return true;
    // 키워드는 에이전트가 직접 쓴 판정이므로 턴이 실패로 끝났어도 따른다.
    case "keyword": return hasKeyword(verdict, link.keyword);
    default: return false;
  }
}

// 한 노드에서 나가는 연결 중 이번에 따라갈 것을 고른다. if / else-if / else처럼 동작한다.
// 1. 키워드가 맞은 연결이 있으면 그것만 따라간다(성공·실패 연결은 건너뛴다).
// 2. 없으면 맞은 성공·실패 연결을 따라간다.
// 3. 그것도 없으면 "그 외" 연결을 따라간다.
// "항상" 연결은 이와 상관없이 함께 따라간다.
export function pickLinks(links, ok, verdict) {
  if (ok === null) return [];
  const on = links.filter((l) => l.enabled);
  const always = on.filter((l) => l.when === "always");
  const keyword = on.filter((l) => l.when === "keyword" && matches(l, ok, verdict));
  if (keyword.length) return [...keyword, ...always];
  const plain = on.filter((l) => (l.when === "success" || l.when === "error") && matches(l, ok, verdict));
  if (plain.length) return [...plain, ...always];
  return [...on.filter((l) => l.when === "otherwise"), ...always];
}

// 조건을 따지는 연결이 있는데 하나도 맞지 않았을 때 기록에 남길 설명. 남길 것이 없으면 null
export function noMatchNote(links, verdict) {
  if (!links.some((l) => l.enabled && ["keyword", "success", "error"].includes(l.when))) return null;
  return `조건에 맞는 연결이 없어 넘기지 않았습니다 (마지막 줄: "${verdict.slice(0, 80) || "없음"}")`;
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
      // 일시중지한 세션은 대기열을 그대로 두고 재개할 때 이어서 보낸다.
      if (session.paused) return;
      // 사용자가 멈춘 세션은 넘어온 작업을 버린다. 사용자가 대기열에 넣은 요청은 남겨 두고, 직접 보낼 때까지 시작하지 않는다.
      const kept = (this.queue.get(session.id) ?? []).filter((item) => item.meta.user);
      if (kept.length) this.queue.set(session.id, kept);
      else this.queue.delete(session.id);
      this.notify("queue", session.id);
      return;
    }
    // 다른 세션의 메시지로 시작한 턴은 곁가지 대화이므로 연결로 넘기지 않는다(대화가 흐름을 건드리지 않게).
    const started = session.events.findLast((e) => e.kind === "user" && !e.injected);
    if (!session.waiting && !started?.message) {
      // 사용자에게 질문하고 답을 기다리는 턴은 끝난 작업이 아니므로 넘기지 않는다.
      const answer = lastAnswer(session);
      const verdict = verdictLine(answer);
      const outgoing = this.links.from(session.id);
      const picked = pickLinks(outgoing, ok, verdict);
      if (!picked.length) {
        const text = noMatchNote(outgoing, verdict);
        if (text) this.note(session, text);
      }
      for (const link of picked) {
        if (link.approve) this.hold(link, session, answer, session.chainDepth ?? 0);
        else await this.deliver(link, session.chainDepth ?? 0, answer);
      }
    }
    this.flush(session);
  }

  // 승인을 받아야 넘기는 연결은 연결선 위에 승인 대기로 올려 둔다. 같은 연결에 다시 쌓이면 마지막 것만 남긴다.
  hold(link, source, answer, depth) {
    const target = this.node(link.to);
    if (!target) return;
    const preview = answer.split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) ?? "";
    // 승인하기 전에 보낸 세션이 다음 턴을 돌아도 조건이 맞았던 그 답변을 넘긴다.
    this.links.update(link, { pending: { depth, preview, answer, at: new Date().toISOString() } });
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
    if (approve) return this.deliver(link, pending.depth, pending.answer);
    if (source && target) this.note(source, `"${target.title}"(으)로 넘기지 않았습니다(거절)`);
  }

  // depth: 보내는 세션이 흐름에서 몇 번째 단계인지
  // answer: 넘길 답변. 없으면 보낸 세션의 지금 마지막 답변을 넘긴다.
  async deliver(link, depth, answer = null) {
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
    this.enqueue(target, handoffText(source, link, answer ?? lastAnswer(source), files), { from: source.id, fromTitle: source.title }, depth + 1);
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
      for (const link of pickLinks(this.links.from(cmd.id), ok, result.output)) {
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

  // 조건에 맞는 것을 모두 꺼낸다(작업 중에 메시지를 확인할 때).
  takeWhere(sessionId, predicate) {
    const queue = this.queue.get(sessionId) ?? [];
    const taken = queue.filter(predicate);
    if (!taken.length) return [];
    const kept = queue.filter((item) => !predicate(item));
    if (kept.length) this.queue.set(sessionId, kept);
    else this.queue.delete(sessionId);
    this.notify("queue", sessionId);
    return taken;
  }

  // 일시중지한 세션은 재개할 때까지 쌓아 두기만 한다.
  flush(session) {
    const queue = this.queue.get(session.id);
    if (!queue?.length || this.runner.isRunning(session.id) || session.paused) return;
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

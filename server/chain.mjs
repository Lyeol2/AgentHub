// 연결 조건에 따라 한 세션의 결과를 다음 세션의 요청으로 넘긴다.
import { randomBytes } from "node:crypto";
import { changedFiles } from "./git.mjs";
import { withRole } from "./role.mjs";
import { isCommandId, commandKind, runShell, outputTail, commandHandoffText } from "./commands.mjs";
import { finalAnswer, writeMessageOutput } from "./utility-output.mjs";

import { canContact } from "./policies/messaging.mjs";
import { MAX_HOPS, lastAnswer, verdictLine, pickLinks, noMatchNote, handoffText, groupOutcome, groupHandoffText } from "./policies/workflows.mjs";
export { CONDITIONS, CONDITION_LABELS, MAX_HOPS, lastAnswer, verdictLine, keywordList, hasKeyword, matches, pickLinks, noMatchNote, handoffText, groupOutcome, groupHandoffText } from "./policies/workflows.mjs";

export class Chain {
  // compose: CLI에 실제로 넘길 내용을 만든다(역할·공통 지침·오케스트레이터 맥락).
  // notify: 연결(승인 대기)이나 대기열이 바뀌면 화면에 알린다. (kind: "links" | "queue", sessionId)
  // commands: 명령 노드 저장소(없으면 명령 노드를 쓰지 않는다). notify("commands")로 명령 상태 변화를 알린다.
  constructor({ store, runner, links, cliPaths, compose = withRole, notify = () => {}, commands = null, autoTurnEnd = true }) {
    this.store = store;
    this.commands = commands;
    this.disposed = false;
    this.runs = new Map(); // 실행 중인 명령 노드 ID → { stop }
    this.runner = runner;
    this.links = links;
    this.cliPaths = cliPaths;
    this.compose = compose;
    this.notify = notify;
    this.queue = new Map(); // 받는 세션 ID → 실행 중이라 밀린 작업(넘어온 작업과 사용자가 대기열에 넣은 요청)
    this.turnEndListener = (session, ok) => this.onTurnEnd(session, ok).catch((err) => console.error(err));
    if (autoTurnEnd) runner.on("turnEnd", this.turnEndListener);
  }

  dispose() {
    this.disposed = true;
    this.runner.off("turnEnd", this.turnEndListener);
    this.queue.clear();
    for (const [id, run] of this.runs) {
      const command = this.commands?.get(id);
      if (command) this.commands.update(command, { queued: null });
      run.stop();
    }
  }

  pending(sessionId) {
    return this.queue.get(sessionId)?.length ?? 0;
  }

  async onTurnEnd(session, ok) {
    if (this.disposed) return;
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
    const settled = !session.waiting && !started?.message;
    if (settled) {
      // 사용자에게 질문하고 답을 기다리는 턴은 끝난 작업이 아니므로 넘기지 않는다.
      const answer = lastAnswer(session);
      const completion = finalAnswer(session);
      const verdict = verdictLine(answer);
      const outgoing = this.links.from(session.id);
      const picked = pickLinks(outgoing, ok, verdict);
      if (!picked.length) {
        const text = noMatchNote(outgoing, verdict);
        if (text) this.note(session, text);
      }
      for (const link of picked) {
        const message = commandKind(this.node(link.to)) === "markdown" ? completion : answer;
        if (link.approve) this.hold(link, session, message, session.chainDepth ?? 0);
        else await this.deliver(link, session.chainDepth ?? 0, message);
      }
    }
    this.flush(session);
    // 넘긴 작업과 대기열을 시작한 뒤에 확인해야 아직 이어지는 세션을 끝난 것으로 보지 않는다.
    if (settled) await this.checkGroups(session);
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
    if (this.disposed) return;
    const source = this.node(link.from);
    const target = this.node(link.to);
    if (!source || !target) return;
    const sourceKind = isCommandId(source.id) ? commandKind(source) : "session";
    const targetKind = isCommandId(target.id) ? commandKind(target) : "session";
    // Utility nodes keep their direction even when an old or hand-edited link bypasses API validation.
    if (sourceKind === "markdown" || targetKind === "button") return;
    if (sourceKind === "button" && !["session", "group"].includes(targetKind)) return;
    if (targetKind === "markdown" && !["session", "group"].includes(sourceKind)) return;
    // Saving a terminal message does not launch another turn, so it must still work at the hop limit.
    if (targetKind === "markdown") {
      if (sourceKind === "group") this.printMessage(target, this.groupOrigin(source), answer ?? this.groupFinal(source));
      else this.printMessage(target, source, answer ?? finalAnswer(source));
      return;
    }
    if (depth >= MAX_HOPS) {
      this.note(source, `자동 연결이 ${MAX_HOPS}단계를 넘어 "${target.title}"(으)로 넘기지 않았습니다.`);
      return;
    }
    // 세션 묶음으로 넘기면 묶은 세션 모두에 같은 내용을 보낸다.
    if (targetKind === "group") {
      const members = this.groupMembers(target);
      if (!members.length) return this.note(source, `세션 묶음 "${target.title}"에 세션이 없어 넘기지 않았습니다.`);
      if (sourceKind === "group" && answer === null) answer = await this.groupText(source, link);
      for (const member of members) await this.sendSession(link, source, sourceKind, member, depth, answer);
      return;
    }
    // 명령 노드로 넘기면 명령을 실행한다. 실행 폴더는 명령을 처음 실행시킨 세션을 따른다.
    if (targetKind === "command") {
      const origin = sourceKind === "group" ? this.groupMembers(source)[0] ?? null
        : isCommandId(source.id) ? this.store.get(source.lastRun?.originId) : source;
      this.note(source, `명령 "${target.title}" 실행`);
      this.runCommand(target, { origin, depth: depth + 1 });
      return;
    }
    await this.sendSession(link, source, sourceKind, target, depth, answer);
  }

  // 세션 하나에 넘어온 작업을 넣는다. 보낸 쪽 종류에 따라 넘기는 내용이 다르다.
  async sendSession(link, source, sourceKind, target, depth, answer) {
    const from = { from: source.id, fromTitle: source.title };
    if (sourceKind === "button") {
      const prompt = answer ?? source.prompt;
      this.enqueue(target, [prompt, link.note?.trim()].filter(Boolean).join("\n\n"), from, depth + 1);
      return;
    }
    // 명령 노드에서 세션으로: 명령 결과(종료 코드·출력)를 넘긴다.
    if (sourceKind === "command") {
      const origin = this.store.get(source.lastRun?.originId);
      this.enqueue(target, commandHandoffText(source, source.lastRun, link, origin), from, depth + 1);
      return;
    }
    if (sourceKind === "group") {
      const members = this.groupMembers(source);
      for (const member of members) this.openDir(target, member);
      const text = answer ?? await this.groupText(source, link, members);
      if (this.disposed) return;
      this.enqueue(target, text, from, depth + 1);
      return;
    }
    this.openDir(target, source);
    const files = source.baseCommit ? await changedFiles(source.cwd, source.baseCommit).catch(() => "") : "";
    if (this.disposed) return;
    const waiting = this.runner.isRunning(target.id);
    this.runner.append(source, { kind: "status", text: `"${target.title}"(으)로 넘김${waiting ? " · 실행이 끝나면 시작" : ""}` });
    this.enqueue(target, handoffText(source, link, answer ?? lastAnswer(source), files), from, depth + 1);
  }

  // Claude는 작업 폴더 밖을 읽으려면 허락이 필요하므로 보낸 세션의 폴더를 실행 인자로 열어 준다.
  openDir(target, source) {
    if (target.agent === "claude" && source.cwd && source.cwd.toLowerCase() !== target.cwd.toLowerCase()) {
      target.addDirs = [...new Set([...(target.addDirs ?? []), source.cwd])];
    }
  }

  // ── 세션 묶음 ─────────────────────────────────────────────────
  // 묶은 세션이 모두 진행 중이 아닐 때(실행·일시중지·답 대기·대기열이 없을 때) 다음 노드로 넘어간다.
  groupMembers(group) {
    return (group.members ?? []).map((id) => this.store.get(id)).filter(Boolean);
  }

  groupsOf(sessionId) {
    return (this.commands?.list?.() ?? []).filter((c) => commandKind(c) === "group" && c.members?.includes(sessionId));
  }

  busy(session) {
    return this.runner.isRunning(session.id) || !!session.paused || !!session.waiting || this.pending(session.id) > 0;
  }

  groupBusy(group) {
    return this.groupMembers(group).filter((s) => this.busy(s));
  }

  async groupText(group, link, members = this.groupMembers(group)) {
    const items = await Promise.all(members.map(async (session) => ({
      session,
      answer: lastAnswer(session),
      files: session.baseCommit ? await changedFiles(session.cwd, session.baseCommit).catch(() => "") : "",
    })));
    return groupHandoffText(group, items, link);
  }

  // MD 출력으로 넘길 때는 각 세션의 마지막 완료 메시지 원문을 차례로 붙인다.
  groupFinal(group) {
    return this.groupMembers(group)
      .map((s) => ({ title: s.title, text: finalAnswer(s) }))
      .filter((m) => m.text.trim())
      .map((m) => `## ${m.title}\n\n${m.text}`)
      .join("\n\n");
  }

  groupOrigin(group) {
    return { id: group.id, title: group.title, cwd: this.groupMembers(group)[0]?.cwd ?? group.projectPath };
  }

  // 세션의 턴이 끝날 때 그 세션이 든 묶음을 확인한다.
  async checkGroups(session) {
    for (const group of this.groupsOf(session.id)) {
      if (this.groupBusy(group).length) {
        this.notify("commands");
        continue;
      }
      await this.fireGroup(group);
    }
  }

  // 묶음에서 나가는 연결을 따라 넘긴다. 진행 중인 세션이 있으면 넘기지 않고 그 세션 목록을 돌려준다.
  async fireGroup(group) {
    if (this.disposed) return { busy: [] };
    const busy = this.groupBusy(group);
    if (busy.length) return { busy };
    const members = this.groupMembers(group);
    const { ok, verdict } = groupOutcome(members);
    const depth = Math.max(0, ...members.map((s) => s.chainDepth ?? 0));
    const picked = pickLinks(this.links.from(group.id), ok, verdict);
    const startedAt = new Date().toISOString();
    this.commands.update(group, { state: ok ? "success" : "error", live: null, queued: null, lastRun: {
      ok, exitCode: ok ? 0 : 1, stopped: false, timedOut: false, startedAt, durationMs: 0,
      cwd: group.projectPath, originId: null, originTitle: null,
      tail: picked.length ? `세션 ${members.length}개 완료 · 연결 ${picked.length}개로 넘김` : `세션 ${members.length}개 완료 · 조건에 맞는 연결 없음`,
    } });
    this.notify("commands");
    for (const link of picked) {
      const text = commandKind(this.node(link.to)) === "markdown" ? this.groupFinal(group) : await this.groupText(group, link, members);
      if (this.disposed) break;
      if (link.approve) this.hold(link, group, text, depth);
      else await this.deliver(link, depth, text);
    }
    return { busy: [], picked: picked.length };
  }

  // ── 명령 노드 실행 ────────────────────────────────────────────
  // 실행 중에 또 넘어오면 끝난 뒤 마지막 것만 한 번 더 실행한다. 실행이 끝나면 resolve되는 Promise를 돌려준다.
  runCommand(cmd, { origin = null, depth = 0 } = {}) {
    if (this.disposed) return null;
    if (commandKind(cmd) === "button") return this.runButton(cmd, depth);
    if (commandKind(cmd) === "group") return this.fireGroup(cmd);
    if (commandKind(cmd) === "markdown") throw new Error("MD 출력 노드는 연결된 세션의 완료 메시지를 받아 실행합니다.");
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

  // A button is only a manual graph source; it never starts a shell or an AI of its own.
  async runButton(cmd, depth = 0) {
    if (this.disposed || this.runs.has(cmd.id)) return null;
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const prompt = cmd.prompt;
    let stopped = false;
    this.runs.set(cmd.id, { stop: () => { stopped = true; } });
    this.commands.update(cmd, { state: "running", live: { startedAt, tail: "" }, queued: null });
    this.notify("commands");
    const picked = pickLinks(this.links.from(cmd.id), true, verdictLine(prompt));
    let error = null;
    try {
      for (const link of picked) {
        if (stopped || this.disposed) break;
        if (link.approve) this.hold(link, cmd, prompt, depth);
        else await this.deliver(link, depth, prompt);
      }
    } catch (caught) {
      error = caught.message;
    } finally {
      this.runs.delete(cmd.id);
      if (this.commands.get(cmd.id)) {
        this.commands.update(cmd, { state: stopped ? "idle" : error ? "error" : "success", live: null, lastRun: {
          ok: !error && !stopped, exitCode: error || stopped ? 1 : 0, stopped, timedOut: false,
          startedAt, durationMs: Date.now() - started, cwd: cmd.projectPath,
          originId: null, originTitle: null, tail: error || `연결 ${picked.length}개에 실행 요청을 보냈습니다.`,
          ...(error ? { error } : {}),
        } });
        this.notify("commands");
      }
    }
  }

  printMessage(cmd, source, text) {
    const started = Date.now();
    const cwd = cmd.cwdMode === "project" ? cmd.projectPath : source.cwd;
    const lastRun = { startedAt: new Date(started).toISOString(), cwd, originId: source.id, originTitle: source.title, stopped: false, timedOut: false };
    try {
      lastRun.output = writeMessageOutput({ cwd, title: cmd.title, text });
      Object.assign(lastRun, { ok: true, exitCode: 0, tail: outputTail(text) });
      this.note(source, `완료 메시지를 ${lastRun.output.relativePath}에 저장했습니다.`);
    } catch (error) {
      Object.assign(lastRun, { ok: false, exitCode: 1, error: error.message, tail: error.message });
      this.note(source, `MD 출력 "${cmd.title}" 실패: ${error.message}`);
    }
    lastRun.durationMs = Date.now() - started;
    this.commands.update(cmd, { state: lastRun.ok ? "success" : "error", lastRun, live: null, queued: null });
    this.notify("commands");
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
    if (this.disposed) return;
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
    if (this.disposed) return null;
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
    return (this.queue.get(sessionId) ?? []).map(({ id, text, meta }) => ({ id, text, user: !!meta.user, fromTitle: meta.fromTitle ?? null, ...(meta.attachments?.length ? { attachments: meta.attachments.map(({ id, name, mimeType, size, url }) => ({ id, name, mimeType, size, url })) } : {}) }));
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

  // 메시지를 보낸 뒤 연결이 지워지거나 꺼졌으면 대기열에서도 전달하지 않는다.
  canDeliver(session, item) {
    if (!item.meta.message && !item.meta.reply) return true;
    const source = this.store.get(item.meta.from);
    return canContact(this.links.list?.() ?? [], source, session);
  }

  // 일시중지한 세션은 재개할 때까지 쌓아 두기만 한다.
  flush(session) {
    if (this.disposed) return;
    const queue = this.queue.get(session.id);
    if (!queue?.length || this.runner.isRunning(session.id) || session.paused) return;
    while (queue.length) {
      const item = queue.shift();
      if (!queue.length) this.queue.delete(session.id);
      this.notify("queue", session.id);
      if (!this.canDeliver(session, item)) continue;
      session.chainDepth = item.depth;
      try {
        // 사용자가 대기열에 넣은 요청과 버튼 프롬프트는 /스킬·@참조를 풀어 쓴다.
        const expand = !!item.meta.user || commandKind(this.commands?.get(item.meta.from)) === "button";
        this.runner.send(session, item.text, this.cliPaths()[session.agent], this.compose(session, item.text, { expand }), item.meta);
      } catch (err) {
        this.runner.append(session, { kind: "error", text: `넘어온 작업을 시작하지 못했습니다: ${err.message}` });
      }
      return;
    }
  }
}

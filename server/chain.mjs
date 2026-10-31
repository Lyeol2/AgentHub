// 연결 조건에 따라 한 세션의 결과를 다음 세션의 요청으로 넘긴다.
import { randomBytes } from "node:crypto";
import { runGitNode } from "./git-nodes.mjs";
import { runTaskNode, taskResultText } from "./task-nodes.mjs";
import { verifyGitContext, assertSessionGitContext } from "./git-context.mjs";
import { sameTaskPath } from "./tasks.mjs";
import { changedFiles } from "./git.mjs";
import { withRole } from "./role.mjs";
import { isCommandId, commandKind, runShell, outputTail, commandHandoffText } from "./commands.mjs";
import { finalAnswer, writeMessageOutput } from "./utility-output.mjs";
import { WorkflowRuntime } from "./workflow-runtime.mjs";
import { RunControls } from "./run-controls.mjs";
import { renderTemplate } from "./flow-nodes.mjs";

import { canContact, canCall } from "./policies/messaging.mjs";
import { MAX_HOPS, lastAnswer, verdictLine, pickLinks, noMatchNote, handoffText, groupOutcome, groupHandoffText } from "./policies/workflows.mjs";
export { CONDITIONS, CONDITION_LABELS, MAX_HOPS, lastAnswer, verdictLine, keywordList, hasKeyword, matches, pickLinks, noMatchNote, handoffText, groupOutcome, groupHandoffText } from "./policies/workflows.mjs";

// 명령 노드 실행 기록에 남기는 시작 세션 정보. 작업 마무리 노드가 taskId로 마무리할 작업을 찾는다.
const originRecord = (origin) => origin ? { id: origin.id, title: origin.title, cwd: origin.cwd, ...(origin.gitContext ? { gitContext: origin.gitContext } : {}), ...(origin.taskId ? { taskId: origin.taskId } : {}) } : null;

export class Chain {
  // compose: CLI에 실제로 넘길 내용을 만든다(역할·오케스트레이터 맥락).
  // notify: 연결(승인 대기)이나 대기열이 바뀌면 화면에 알린다. (kind: "links" | "queue", sessionId)
  // commands: 명령 노드 저장소(없으면 명령 노드를 쓰지 않는다). notify("commands")로 명령 상태 변화를 알린다.
  // tasks: 작업 서비스나 그것을 돌려주는 함수(작업 노드가 쓴다)
  constructor({ store, runner, links, cliPaths, compose = withRole, notify = () => {}, commands = null, autoTurnEnd = true, runGit = runGitNode, runCommandShell = runShell, createWatch = undefined, history = null, tasks = null, gen3d = null, figcraft = null }) {
    this.store = store;
    // 3D 생성 노드: { keys, fetch?, sleep? }. 없으면 실행할 때 키가 없다고 알린다.
    this.gen3d = gen3d;
    // FigCraft 노드: CLI 위치 설정(FigcraftSettings)
    this.figcraft = figcraft;
    this.taskService = typeof tasks === "function" ? tasks : () => tasks;
    this.runGit = runGit;
    this.runCommandShell = runCommandShell;
    this.workflow = new WorkflowRuntime(this, createWatch);
    this.controls = new RunControls(this, history);
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
    this.workflow.dispose();
    for (const [id, run] of this.runs) {
      const command = this.commands?.get(id);
      if (command) this.commands.update(command, { queued: null });
      run.stop();
    }
  }

  stopRun(id) { return this.controls.stopRun(id); }
  resumeRun(id, stepId) { return this.controls.resumeRun(id, stepId); }
  beginSession(node, text, options = {}) { return this.controls.begin(node, this.flowFor(node), text, options); }
  newFlow(variables = {}) { return this.workflow.create(variables); }
  flowFor(node) { return this.workflow.get(node); }
  setFlow(node, flow) { return this.workflow.set(node, flow); }
  pickFlowLinks(node, ok, text) { return pickLinks(this.links.from(node.id), ok, verdictLine(text)); }

  pending(sessionId) {
    return this.queue.get(sessionId)?.length ?? 0;
  }

  async onTurnEnd(session, ok) {
    if (this.disposed) return;
    const flow = this.flowFor(session);
    if (ok === null) {
      // 일시중지한 세션은 대기열을 그대로 두고 재개할 때 이어서 보낸다.
      if (session.paused && !this.controls.stopped.has(flow?.id)) { this.controls.wait(session, flow, lastAnswer(session)); this.workflow.settle(); return; }
      this.controls.finish(session, flow, { ok: false, stopped: true, output: lastAnswer(session) });
      if (flow) this.workflow.cancel(flow);
      if (this.controls.stopped.has(flow?.id)) { this.flush(session); this.workflow.settle(); return; }
      // 사용자가 멈춘 세션은 넘어온 작업을 버린다. 사용자가 대기열에 넣은 요청은 남겨 두고, 직접 보낼 때까지 시작하지 않는다.
      const kept = (this.queue.get(session.id) ?? []).filter((item) => item.meta.user);
      if (kept.length) this.queue.set(session.id, kept);
      else this.queue.delete(session.id);
      this.notify("queue", session.id);
      this.workflow.settle();
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
      this.workflow.record(session, ok, completion || answer, flow);
      const outgoing = this.links.from(session.id);
      const picked = pickLinks(outgoing, ok, verdict);
      if (!picked.length) {
        const text = noMatchNote(outgoing, verdict);
        if (text) this.note(session, text);
      }
      for (const link of picked) {
        const message = commandKind(this.node(link.to)) === "markdown" ? completion : answer;
        if (link.approve) this.hold(link, session, message, session.chainDepth ?? 0, flow);
        else await this.deliver(link, session.chainDepth ?? 0, message, null, flow);
      }
    }
    if (!settled) {
      if (session.waiting) this.controls.wait(session, flow, lastAnswer(session));
      else this.controls.finish(session, flow, { ok, output: lastAnswer(session) });
    }
    this.flush(session);
    // 넘긴 작업과 대기열을 시작한 뒤에 확인해야 아직 이어지는 세션을 끝난 것으로 보지 않는다.
    if (settled) await this.checkGroups(session, flow);
    this.workflow.settle();
  }

  // 승인을 받아야 넘기는 연결은 연결선 위에 승인 대기로 올려 둔다. 같은 연결에 다시 쌓이면 마지막 것만 남긴다.
  hold(link, source, answer, depth, flow = this.flowFor(source)) {
    const target = this.node(link.to);
    if (!target) return;
    const previous = link.pending;
    if (previous?.historyStepId && previous.flow) this.controls.history?.finishStep(previous.flow.id, previous.historyStepId, { ok: false, output: "새 승인 요청으로 대체되었습니다.", error: "새 승인 요청으로 대체되었습니다." });
    const historyStepId = flow ? this.controls.queue(target, flow, answer, { approval: true, linkId: link.id, sourceId: source.id, sourceRun: isCommandId(source.id) ? source.lastRun : null, depth: depth + 1 }) : null;
    const preview = answer.split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) ?? "";
    // 승인하기 전에 보낸 세션이 다음 턴을 돌아도 조건이 맞았던 그 답변을 넘긴다.
    this.links.update(link, { pending: { depth, preview, answer, ...(historyStepId ? { historyStepId } : {}), ...(flow ? { flow: structuredClone(flow) } : {}), ...(isCommandId(source.id) && source.lastRun ? { sourceRun: structuredClone(source.lastRun) } : {}), at: new Date().toISOString() } });
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
    if (pending.historyStepId && pending.flow) this.controls.history?.finishStep(pending.flow.id, pending.historyStepId, { ok: approve, stopped: !approve, output: approve ? "승인했습니다." : "승인을 거절했습니다." });
    if (approve) {
      try { await this.deliver(link, pending.depth, pending.answer, pending.sourceRun, pending.flow); }
      catch (error) { if (target) this.controls.fail(target, pending.flow, error); this.workflow.settle(); throw error; }
    }
    else if (source && target) this.note(source, `"${target.title}"(으)로 넘기지 않았습니다(거절)`);
    this.workflow.settle();
  }

  // depth: 보내는 세션이 흐름에서 몇 번째 단계인지
  // answer: 넘길 답변. 없으면 보낸 세션의 지금 마지막 답변을 넘긴다.
  async deliver(link, depth, answer = null, sourceRun = null, flow = null) {
    if (this.disposed) return;
    const storedSource = this.node(link.from);
    const source = sourceRun && isCommandId(storedSource?.id) ? { ...storedSource, lastRun: sourceRun } : storedSource;
    const target = this.node(link.to);
    if (!source || !target) return;
    flow ??= this.flowFor(source);
    if (flow) this.workflow.entry(flow);
    if (flow?.cancelled) return;
    if (flow) {
      const input = answer ?? (isCommandId(source.id) ? source.lastRun?.outputText ?? source.lastRun?.tail ?? source.prompt ?? "" : lastAnswer(source));
      link = { ...link, note: renderTemplate(link.note ?? "", { ...flow.variables, input, output: input }) };
    }
    const sourceKind = isCommandId(source.id) ? commandKind(source) : "session";
    const targetKind = isCommandId(target.id) ? commandKind(target) : "session";
    // Utility nodes keep their direction even when an old or hand-edited link bypasses API validation.
    if (sourceKind === "markdown" || ["button", "input", "watch", "schedule", "webhook-in"].includes(targetKind)) return;
    // Saving a terminal message does not launch another turn, so it must still work at the hop limit.
    if (targetKind === "markdown") {
      this.setFlow(target, flow);
      if (sourceKind === "group") this.printMessage(target, this.groupOrigin(source), answer ?? this.groupFinal(source, flow));
      else this.printMessage(target, { ...source, cwd: source.cwd ?? source.lastRun?.cwd ?? source.projectPath }, answer ?? (sourceKind === "session" ? finalAnswer(source) : source.lastRun?.outputText ?? source.lastRun?.tail ?? ""));
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
      if (members.some((member) => member.id === source.id)) { await this.checkGroups(source, flow); return; }
      flow ??= this.newFlow();
      if (sourceKind === "group" && answer === null) answer = await this.groupText(source, link, undefined, flow);
      for (const member of members) {
        if (isCommandId(member.id)) this.startLinkedCommand(member, { origin: this.commandOrigin(source, sourceKind, link), depth: depth + 1, prompt: answer ?? source.lastRun?.outputText ?? source.lastRun?.tail ?? "", flow });
        else await this.sendSession({ ...link, to: member.id }, source, sourceKind, member, depth, answer, flow);
      }
      return;
    }
    // 명령 노드로 넘기면 명령을 실행한다. 실행 폴더는 명령을 처음 실행시킨 세션을 따른다.
    if (["command", "git", "task", "repeat", "transform", "notify", "webhook", "gen3d", "figcraft"].includes(targetKind)) {
      const origin = this.commandOrigin(source, sourceKind, link);
      this.note(source, `명령 "${target.title}" 실행`);
      this.startLinkedCommand(target, { origin, depth: depth + 1, prompt: answer ?? (sourceKind === "session" ? lastAnswer(source) : source.lastRun?.outputText ?? source.lastRun?.tail ?? source.prompt ?? ""), flow });
      return;
    }
    await this.sendSession(link, source, sourceKind, target, depth, answer, flow);
  }

  // Branches start concurrently; every async failure is captured on its node.
  startLinkedCommand(node, options) {
    const flow = options.flow;
    try {
      if (this.runs.has(node.id) && !["command", "repeat", "transform", "notify", "webhook", "gen3d", "figcraft"].includes(commandKind(node))) {
        this.failFlowDelivery(node, new Error("이미 실행 중인 노드입니다. 앞선 실행이 끝난 뒤 다시 시작하세요."), flow, options);
        return;
      }
      Promise.resolve(this.runCommand(node, options)).catch((error) => this.failFlowDelivery(node, error, flow, options));
    } catch (error) { this.failFlowDelivery(node, error, flow, options); }
  }

  async failFlowDelivery(node, error, flow = this.flowFor(node), options = {}) {
    if (this.disposed || !this.commands?.get(node.id)) return;
    const message = error.message ?? String(error);
    this.controls.fail(node, flow, error, options);
    if (!flow || this.flowFor(node)?.id === flow.id) {
      const lastRun = { ...node.lastRun, ok: false, exitCode: 1, tail: message,
        deliveryErrors: [...(node.lastRun?.deliveryErrors ?? []), message] };
      this.commands.update(node, { state: "error", live: null, lastRun });
      this.notify("commands");
    }
    this.workflow.record(node, false, message, flow);
    try { await this.checkGroups(node, flow); } catch (failure) {
      if (node.lastRun) node.lastRun.deliveryErrors = [...(node.lastRun.deliveryErrors ?? []), failure.message];
    }
    this.workflow.settle();
  }

  // 세션 하나에 넘어온 작업을 넣는다. 보낸 쪽 종류에 따라 넘기는 내용이 다르다.
  async sendSession(link, source, sourceKind, target, depth, answer, flow = this.flowFor(source)) {
    const from = { from: source.id, fromTitle: source.title, ...(flow ? { flow } : {}) };
    if (["input", "repeat", "transform", "watch", "schedule", "notify", "webhook", "webhook-in", "gen3d", "figcraft"].includes(sourceKind)) {
      const text = answer ?? source.lastRun?.outputText ?? source.lastRun?.tail ?? "";
      this.enqueue(target, [text, link.note?.trim()].filter(Boolean).join("\n\n"), from, depth + 1);
      return;
    }
    if (sourceKind === "button") {
      const prompt = answer ?? source.prompt;
      this.enqueue(target, [prompt, link.note?.trim()].filter(Boolean).join("\n\n"), from, depth + 1);
      return;
    }
    if (sourceKind === "task") {
      const run = source.lastRun;
      if (!run?.taskResult) throw new Error("먼저 작업 노드를 실행하세요.");
      if (link.useGitWorktree) this.bindTaskSession(target, run.taskResult);
      this.enqueue(target, answer ?? [run.outputText ?? run.tail, link.note?.trim()].filter(Boolean).join("\n\n"), from, depth + 1);
      return;
    }
    if (sourceKind === "git") {
      const run = source.lastRun;
      if (!run?.gitResult) throw new Error("먼저 Git 노드를 실행하세요.");
      if (link.useGitWorktree) {
        if (!run.gitResult.ok || !run.gitResult.context) throw new Error("성공한 Git 작업 폴더가 없습니다.");
        this.bindGitSession(target, run.gitResult.context);
      }
      this.enqueue(target, answer ?? this.gitHandoffText(source, run, link), from, depth + 1);
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
      for (const member of members) this.openDir(target, { ...member, cwd: member.cwd ?? member.lastRun?.cwd ?? member.projectPath });
      const text = answer ?? await this.groupText(source, link, members, flow);
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
    return (group.members ?? []).map((id) => this.node(id)).filter(Boolean);
  }

  groupsOf(nodeId) {
    return (this.commands?.list?.() ?? []).filter((c) => commandKind(c) === "group" && c.members?.includes(nodeId));
  }

  busy(node) {
    if (isCommandId(node.id)) return this.runs.has(node.id) || !!node.queued;
    return this.runner.isRunning(node.id) || !!node.paused || !!node.waiting || this.pending(node.id) > 0;
  }

  groupBusy(group, flow = null) {
    return this.groupMembers(group).filter((node) => {
      if (!flow) return this.busy(node);
      if (isCommandId(node.id)) return (this.flowFor(node)?.id === flow.id && this.runs.has(node.id)) || node.queued?.flow?.id === flow.id || this.workflow.hasQueued(node.id, flow.id);
      return this.flowFor(node)?.id === flow.id && this.busy(node);
    });
  }

  nodeOutput(node) {
    return isCommandId(node.id) ? node.lastRun?.outputText ?? node.lastRun?.tail ?? "" : lastAnswer(node);
  }

  groupSnapshots(group, flow) {
    if (!flow) return null;
    const entry = this.workflow.entry(flow);
    const results = this.groupMembers(group).map((node) => entry.results.get(node.id));
    return results.every(Boolean) ? results : null;
  }

  async groupText(group, link, members = this.groupMembers(group), flow = null, snapshots = this.groupSnapshots(group, flow)) {
    const items = snapshots
      ? snapshots.map((result) => ({ session: { ...result, state: result.ok ? "idle" : "error" }, answer: result.text, files: "" }))
      : await Promise.all(members.map(async (node) => ({
        session: { ...node, cwd: node.cwd ?? node.lastRun?.cwd ?? node.projectPath, agent: node.agent ?? commandKind(node) },
        answer: this.nodeOutput(node),
        files: node.baseCommit ? await changedFiles(node.cwd, node.baseCommit).catch(() => "") : "",
      })));
    const input = items.map((item) => item.answer).join("\n\n");
    const routedLink = flow ? { ...link, note: renderTemplate(link.note ?? "", { ...flow.variables, input, output: input }) } : link;
    return groupHandoffText(group, items, routedLink);
  }

  groupFinal(group, flow = null, snapshots = this.groupSnapshots(group, flow)) {
    return (snapshots ? snapshots.map((result) => ({ title: result.title, text: result.text }))
      : this.groupMembers(group).map((node) => ({ title: node.title, text: isCommandId(node.id) ? this.nodeOutput(node) : finalAnswer(node) })))
      .filter((item) => item.text.trim()).map((item) => "## " + item.title + "\n\n" + item.text).join("\n\n");
  }

  groupOrigin(group) {
    const member = this.groupMembers(group)[0];
    return { id: group.id, title: group.title, cwd: member?.cwd ?? member?.lastRun?.cwd ?? group.projectPath };
  }

  async checkGroups(node, flow = this.flowFor(node)) {
    for (const group of this.groupsOf(node.id)) {
      if (this.groupBusy(group, flow).length) { this.notify("commands"); continue; }
      if (flow && !this.workflow.groupResults(group, flow)) continue;
      await this.fireGroup(group, flow);
    }
  }

  async fireGroup(group, flow = null) {
    if (this.disposed || flow?.cancelled) return { busy: [] };
    const busy = this.groupBusy(group, flow);
    if (busy.length) return { busy };
    const members = this.groupMembers(group);
    if (!flow) {
      flow = this.newFlow();
      for (const member of members) this.workflow.record(member, isCommandId(member.id) ? member.lastRun?.ok === true : member.state !== "error", isCommandId(member.id) ? this.nodeOutput(member) : finalAnswer(member) || lastAnswer(member), flow);
    }
    const snapshots = this.workflow.groupResults(group, flow);
    if (flow && !snapshots) return { busy: members, picked: 0 };
    if (!members.length) return { busy: [], picked: 0 };
    const ok = snapshots ? snapshots.every((result) => result.ok)
      : members.every((node) => isCommandId(node.id) ? node.lastRun?.ok === true || !!node.lastRun?.cleared : node.state !== "error");
    const verdict = snapshots ? snapshots.map((result) => verdictLine(result.text)).join("\n")
      : members.map((node) => verdictLine(this.nodeOutput(node))).join("\n");
    const depth = Math.max(0, ...members.map((node) => node.chainDepth ?? 0));
    if (flow) { this.workflow.consume(group, flow, snapshots); this.setFlow(group, flow); }
    const picked = pickLinks(this.links.from(group.id), ok, verdict);
    const startedAt = new Date().toISOString();
    const text = await this.groupText(group, { note: "" }, members, flow, snapshots);
    this.controls.begin(group, flow, text, { depth, cwd: group.projectPath });
    this.commands.update(group, { state: ok ? "success" : "error", live: null, queued: null, lastRun: {
      ok, exitCode: ok ? 0 : 1, stopped: false, timedOut: false, startedAt, durationMs: 0,
      cwd: group.projectPath, originId: null, originTitle: null, ...(flow ? { runId: flow.id } : {}),
      outputText: text, tail: picked.length ? "세션 " + members.length + "개 완료 · 연결 " + picked.length + "개로 넘김" : "세션 " + members.length + "개 완료 · 조건에 맞는 연결 없음",
    } });
    this.notify("commands");
    this.workflow.record(group, ok, text, flow);
    for (const link of picked) {
      const message = commandKind(this.node(link.to)) === "markdown" ? this.groupFinal(group, flow, snapshots) : await this.groupText(group, link, members, flow, snapshots);
      if (this.disposed || flow?.cancelled) break;
      if (link.approve) this.hold(link, group, message, depth, flow);
      else await this.deliver(link, depth, message, null, flow);
    }
    this.workflow.settle();
    return { busy: [], picked: picked.length };
  }

  // ── 명령 노드 실행 ────────────────────────────────────────────
  // 실행 중에 또 넘어온 요청은 실행별 입력을 보존해 차례로 실행한다. 실행이 끝나면 resolve되는 Promise를 돌려준다.
  runCommand(cmd, { origin = null, depth = 0, prompt = null, values = undefined, flow = null, historyStepId = null, resume = false, edit = null } = {}) {
    if (this.disposed || flow?.cancelled) return null;
    const kind = commandKind(cmd);
    if (kind === "artref") throw new Error("아트 레퍼런스 노드는 실행하지 않습니다. 세션에 참고 연결로 이어 두면 세션이 요청을 받을 때 함께 읽습니다.");
    if (["input", "repeat", "transform", "watch", "schedule", "notify", "webhook", "webhook-in", "gen3d", "figcraft"].includes(kind)) {
      if (this.runs.has(cmd.id)) {
        if (["repeat", "transform", "webhook", "gen3d", "figcraft"].includes(kind)) return this.workflow.enqueue(cmd, { origin, depth, prompt, values, flow, historyStepId });
        return null;
      }
      return this.workflow.run(cmd, { origin, depth, prompt, values, flow, historyStepId, resume, edit });
    }
    flow ??= this.newFlow();
    if (++flow.steps > 1000) throw new Error("한 흐름에서 실행할 수 있는 노드 횟수를 초과했습니다.");
    if (kind === "git") return this.runGitCommand(cmd, { origin, depth, prompt, flow });
    if (kind === "task") return this.runTaskCommand(cmd, { origin, depth, prompt, flow });
    if (kind === "button") return this.runButton(cmd, depth, flow).catch((error) => this.failFlowDelivery(cmd, error, flow));
    if (commandKind(cmd) === "group") return this.fireGroup(cmd);
    if (commandKind(cmd) === "markdown") throw new Error("MD 출력 노드는 연결된 세션의 완료 메시지를 받아 실행합니다.");
    if (this.runs.has(cmd.id)) {
      return this.workflow.enqueue(cmd, { origin, depth, prompt, flow });
    }
    this.setFlow(cmd, flow);
    const cwd = cmd.cwdMode === "source" && origin?.cwd ? origin.cwd : cmd.projectPath;
    if (cmd.cwdMode === "source" && origin?.gitContext) verifyGitContext(origin.gitContext, cmd.projectPath);
    this.assertGitAvailable({ projectPath: cmd.projectPath });
    const startedAt = new Date().toISOString();
    this.controls.begin(cmd, flow, prompt ?? cmd.command, { origin, depth, prompt, cwd, historyStepId });
    this.commands.update(cmd, { state: "running", queued: null, live: { startedAt, cwd, tail: "" } });
    this.notify("commands");
    let lastNotify = 0;
    const run = this.runCommandShell({
      shell: cmd.shell, command: cmd.command, cwd, timeoutSec: cmd.timeoutSec,
      env: { ...Object.fromEntries(Object.entries(flow.variables).map(([key, value]) => ["AGENTHUB_" + key.toUpperCase(), String(value)])), AGENTHUB_INPUT_JSON: JSON.stringify(flow.variables) },
      onOutput: (output) => {
        // 출력은 1초에 한 번만 화면에 알린다.
        if (Date.now() - lastNotify < 1000) return;
        lastNotify = Date.now();
        cmd.live = { startedAt, cwd, tail: outputTail(output, 12, 2000) };
        this.notify("commands");
      },
    });
    this.runs.set(cmd.id, run);
    return run.done.then((result) => this.afterCommand(cmd, result, { origin, depth, cwd, startedAt, flow })).catch((error) => this.failFlowDelivery(cmd, error, flow));
  }

  // Git nodes run once per trigger; interrupted writes are never queued for automatic retry.
  runGitCommand(cmd, { origin = null, depth = 0, prompt = null, flow = null } = {}) {
    if (this.disposed || this.runs.has(cmd.id)) return null;
    flow = this.setFlow(cmd, flow ?? this.newFlow());
    const startedAt = new Date().toISOString();
    this.controls.begin(cmd, flow, prompt ?? cmd.title, { origin, depth, prompt, cwd: cmd.projectPath });
    const controller = new AbortController();
    const command = { ...cmd };
    this.commands.update(cmd, { state: "running", queued: null, live: { startedAt, cwd: cmd.projectPath, tail: "Git 상태 확인 중" } });
    this.notify("commands");
    const run = { kind: "git", projectPath: cmd.projectPath, stop: () => controller.abort() };
    this.runs.set(cmd.id, run);
    run.done = Promise.resolve().then(() => this.runGit({ command, signal: controller.signal,
      sessions: [...this.store.list(), ...(this.commands?.list?.() ?? []).filter((node) => commandKind(node) === "command" && this.runs.has(node.id)).map((node) => ({ id: node.id, commandNode: true, projectPath: node.projectPath, cwd: node.live?.cwd, state: "running" }))],
      isSessionBusy: (session) => session.commandNode || this.busy(session),
      onOutput: (output) => {
        if (!this.commands.get(cmd.id)) return;
        cmd.live = { startedAt, cwd: cmd.projectPath, tail: outputTail(output, 12, 2000) };
        this.notify("commands");
      },
    })).catch((error) => ({ ok: false, reason: "git-error", output: error.message, exitCode: 1, stopped: controller.signal.aborted }))
      .then(async (result) => {
        this.runs.delete(cmd.id);
        this.notify("git", command.projectPath);
        for (const sessionId of this.queue.keys()) {
          const session = this.store.get(sessionId);
          if (session) this.flush(session);
        }
        if (!this.commands.get(cmd.id)) { this.controls.finish(cmd, flow, { ok: false, stopped: true, output: result.output ?? "" }); this.workflow.settle(); return; }
        const stopped = controller.signal.aborted || !!result.stopped;
        const lastRun = { ok: !!result.ok && !stopped, exitCode: result.ok && !stopped ? 0 : result.exitCode || 1,
          stopped, timedOut: !!result.timedOut, startedAt, durationMs: result.durationMs ?? 0,
          cwd: result.cwd ?? cmd.projectPath, tail: outputTail(result.output || result.reason || ""),
          originId: origin?.id ?? null, originTitle: origin?.title ?? null, prompt, runId: flow.id,
          gitResult: { ...result, ok: !!result.ok && !stopped, stopped },
        };
        this.commands.update(cmd, { state: stopped ? "idle" : result.ok ? "success" : "error", lastRun, live: null, queued: null });
        this.notify("commands");
        this.controls.finish(cmd, flow, { ok: lastRun.ok, output: lastRun.tail, stopped });
        if (this.disposed || stopped || flow.cancelled) return;
        this.workflow.record(cmd, lastRun.ok, lastRun.tail, flow);
        const outgoing = this.links.from(cmd.id).filter((link) => ["success", "error", "always", "manual"].includes(link.when));
        for (const link of pickLinks(outgoing, !!result.ok, "")) {
          if (this.disposed || !this.commands.get(cmd.id)) break;
          try {
            if (link.approve) this.hold(link, cmd, this.gitHandoffText(cmd, lastRun, link), depth, flow);
            else await this.deliver(link, depth, null, lastRun, flow);
          } catch (error) {
            lastRun.deliveryErrors = [...(lastRun.deliveryErrors ?? []), error.message];
            const target = this.node(link.to);
            this.note(target, "Git 결과를 넘기지 못했습니다: " + error.message);
            this.commands.update(cmd, { lastRun });
            this.notify("commands");
          }
        }
        await this.checkGroups(cmd, flow);
        this.workflow.settle();
      });
    return run.done.catch((error) => this.failFlowDelivery(cmd, error, flow));
  }

  // Git 쓰기는 중간에 멈출 수 없으므로 중지하면 결과를 다음 노드로 넘기지만 않는다. 실패한 원격 쓰기는 다시 시도하지 않는다.
  runTaskCommand(cmd, { origin = null, depth = 0, prompt = null, flow = null } = {}) {
    if (this.disposed || this.runs.has(cmd.id)) return null;
    flow = this.setFlow(cmd, flow ?? this.newFlow());
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const input = prompt ?? "";
    this.controls.begin(cmd, flow, prompt ?? cmd.title, { origin, depth, prompt, cwd: cmd.projectPath });
    this.commands.update(cmd, { state: "running", queued: null, live: { startedAt, cwd: cmd.projectPath, tail: cmd.taskAction === "finish" ? (cmd.finishMode === "local" ? "커밋하고 대상 브랜치에 반영하는 중" : "커밋하고 반영하는 중") : "작업 브랜치와 폴더 만드는 중" } });
    this.notify("commands");
    let stopped = false;
    const run = { kind: "task", projectPath: cmd.projectPath, stop: () => { stopped = true; } };
    this.runs.set(cmd.id, run);
    run.done = Promise.resolve().then(() => runTaskNode({ command: { ...cmd }, tasks: this.taskService(), origin, input, flow }))
      .catch((error) => ({ ok: false, action: cmd.taskAction, reason: error.reason ?? "task-error", message: error.message, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) }))
      .then(async (result) => {
        this.runs.delete(cmd.id);
        const text = taskResultText(result, input);
        if (!this.commands.get(cmd.id)) { this.controls.finish(cmd, flow, { ok: false, stopped: true, output: text }); this.workflow.settle(); return; }
        stopped ||= !!flow.cancelled;
        const lastRun = { ok: result.ok && !stopped, exitCode: result.ok && !stopped ? 0 : 1, stopped, timedOut: false, startedAt,
          durationMs: Date.now() - started, cwd: result.cwd ?? cmd.projectPath, tail: outputTail(text), outputText: text,
          originId: origin?.id ?? null, originTitle: origin?.title ?? null, origin: originRecord(origin), prompt, runId: flow.id, taskResult: result };
        this.commands.update(cmd, { state: stopped ? "idle" : result.ok ? "success" : "error", lastRun, live: null, queued: null });
        this.notify("commands");
        this.controls.finish(cmd, flow, { ok: lastRun.ok, output: text, stopped });
        if (this.disposed || stopped) { this.workflow.settle(); return; }
        this.workflow.record(cmd, lastRun.ok, text, flow);
        const outgoing = this.links.from(cmd.id).filter((link) => ["success", "error", "always", "manual"].includes(link.when));
        for (const link of pickLinks(outgoing, lastRun.ok, "")) {
          if (this.disposed || !this.commands.get(cmd.id)) break;
          try {
            if (link.approve) this.hold(link, cmd, text, depth, flow);
            else await this.deliver(link, depth, null, lastRun, flow);
          } catch (error) {
            lastRun.deliveryErrors = [...(lastRun.deliveryErrors ?? []), error.message];
            this.note(this.node(link.to), "작업 결과를 넘기지 못했습니다: " + error.message);
            this.commands.update(cmd, { lastRun });
            this.notify("commands");
          }
        }
        await this.checkGroups(cmd, flow);
        this.workflow.settle();
      });
    return run.done.catch((error) => this.failFlowDelivery(cmd, error, flow));
  }

  gitHandoffText(source, run, link) {
    const result = run?.gitResult ?? {};
    return ["[Git 노드에서 넘어온 결과]", "작업: " + source.title,
      "브랜치: " + (result.branch ?? source.branch) + (result.targetBranch ? " → " + result.targetBranch : ""),
      "결과: " + (result.ok ? "성공" : "실패") + " (" + (result.reason ?? "unknown") + ")",
      "작업 폴더: " + (result.cwd ?? run?.cwd ?? source.projectPath),
      result.beforeHead ? "변경 전 커밋: " + result.beforeHead : null,
      result.afterHead ? "변경 후 커밋: " + result.afterHead : null,
      result.output || run?.tail || "", run?.prompt ? "원래 요청:\n" + run.prompt : null,
      link.note?.trim() || "이 결과를 이어받아 네 역할에 맞게 처리하라.",
    ].filter((line) => line !== null).join("\n");
  }

  bindGitSession(target, context) {
    if (target.gitContext) assertSessionGitContext(target);
    const actual = verifyGitContext(context, target.projectPath);
    if (target.worktree?.branch && target.worktree.branch !== actual.branch) throw new Error("세션에 연결된 브랜치가 달라졌습니다. 기존 대화는 새 브랜치로 옮기지 않습니다.");
    const same = sameTaskPath(target.cwd, actual.cwd);
    if (!same) this.assertMovable(target);
    target.cwd = actual.cwd;
    target.gitContext = actual;
    target.baseCommit ??= actual.head;
    if (!same) target.baseCommit = actual.head;
    if (!sameTaskPath(actual.cwd, target.projectPath) && !target.worktree) {
      target.worktree = { dir: actual.cwd, branch: actual.branch, shared: true, managed: false, commonDir: actual.repoCommonDir };
    }
    this.store.touch?.(target);
    this.store.flush?.(target.id);
    this.notify("sessions", target.id);
  }

  // 대화를 시작한 세션을 다른 폴더로 옮기면 이어 가던 대화가 엉키므로 옮기지 않는다.
  assertMovable(target) {
    if (this.busy(target) || target.taskId || target.worktree || target.gitContext || target.agentSessionId || target.cliSessionIds?.length || target.handover || (target.events ?? []).some((event) => ["user", "text", "tool", "result", "question", "permission"].includes(event.kind))) {
      throw new Error("기존 대화나 작업 폴더가 있는 세션은 다른 브랜치로 옮길 수 없습니다. 새 세션을 연결하거나 같은 브랜치의 세션을 사용하세요.");
    }
  }

  // 새 작업 노드가 만든 작업 폴더로 세션을 옮기고 작업에 연결한다.
  bindTaskSession(target, result) {
    if (!result?.ok || result.action !== "start" || !result.taskId || !result.context) throw new Error("성공한 새 작업이 없습니다. 작업 노드를 다시 실행하세요.");
    if (target.taskId === result.taskId) return;
    const service = this.taskService();
    if (!service) throw new Error("작업 기능을 사용할 수 없습니다.");
    const context = verifyGitContext(result.context, target.projectPath);
    this.assertMovable(target);
    service.adoptSession(result.taskId, target);
    target.baseCommit = context.head;
    this.store.touch?.(target);
    this.store.flush?.(target.id);
    this.notify("sessions", target.id);
  }

  commandOrigin(source, sourceKind, link) {
    if (sourceKind === "task" && source.lastRun?.taskResult?.ok && source.lastRun.taskResult.action === "start") {
      const result = source.lastRun.taskResult;
      if (!link.useGitWorktree) return { ...(source.lastRun.origin ?? { id: source.id, title: source.title, cwd: source.projectPath }), taskId: result.taskId };
      const context = verifyGitContext(result.context, source.projectPath);
      return { id: source.id, title: source.title, cwd: context.cwd, gitContext: context, taskId: result.taskId };
    }
    if (sourceKind === "git" && link.useGitWorktree) {
      const result = source.lastRun?.gitResult;
      if (!result?.ok || !result.context) throw new Error("성공한 Git 작업 폴더가 없습니다. Git 노드를 다시 실행하세요.");
      const context = verifyGitContext(result.context, source.projectPath);
      return { id: source.id, title: source.title, cwd: context.cwd, gitContext: context };
    }
    if (sourceKind === "group") return this.groupMembers(source)[0] ?? null;
    if (isCommandId(source.id)) return source.lastRun?.origin ?? this.store.get(source.lastRun?.originId) ?? null;
    return source;
  }

  gitBusy(session) {
    return [...this.runs.entries()].some(([id, run]) => {
      const command = this.commands?.get(id);
      return (run.kind ?? commandKind(command)) === "git" && sameTaskPath(run.projectPath ?? command?.projectPath, session.projectPath);
    });
  }

  assertGitAvailable(session) {
    if (this.gitBusy(session)) throw new Error("이 프로젝트에서 Git 노드가 실행 중입니다. 완료한 뒤 세션을 시작하세요.");
  }

  // A button is only a manual graph source; it never starts a shell or an AI of its own.
  async runButton(cmd, depth = 0, flow = null) {
    if (this.disposed || this.runs.has(cmd.id)) return null;
    flow = this.setFlow(cmd, flow ?? this.newFlow());
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    this.controls.begin(cmd, flow, cmd.prompt, { depth, cwd: cmd.projectPath });
    const prompt = renderTemplate(cmd.prompt, flow.variables);
    let stopped = false;
    this.runs.set(cmd.id, { stop: () => { stopped = true; } });
    this.commands.update(cmd, { state: "running", live: { startedAt, tail: "" }, queued: null });
    this.notify("commands");
    const picked = pickLinks(this.links.from(cmd.id), true, verdictLine(prompt));
    let error = null;
    try {
      for (const link of picked) {
        if (stopped || this.disposed) break;
        if (link.approve) this.hold(link, cmd, prompt, depth, flow);
        else await this.deliver(link, depth, prompt, null, flow);
      }
    } catch (caught) {
      error = caught.message;
    } finally {
      this.runs.delete(cmd.id);
      if (this.commands.get(cmd.id)) {
        this.commands.update(cmd, { state: stopped ? "idle" : error ? "error" : "success", live: null, lastRun: {
          ok: !error && !stopped, exitCode: error || stopped ? 1 : 0, stopped, timedOut: false,
          startedAt, durationMs: Date.now() - started, cwd: cmd.projectPath,
          originId: null, originTitle: null, runId: flow.id, outputText: prompt, tail: error || `연결 ${picked.length}개에 실행 요청을 보냈습니다.`,
          ...(error ? { error } : {}),
        } });
        this.controls.finish(cmd, flow, { ok: !error && !stopped, output: prompt, stopped, error });
        if (!stopped) this.workflow.record(cmd, !error, error || prompt, flow);
        this.notify("commands");
      } else this.controls.finish(cmd, flow, { ok: false, output: prompt, stopped: true });
      this.workflow.settle();
    }
  }

  printMessage(cmd, source, text) {
    const started = Date.now();
    const flow = this.flowFor(cmd);
    this.controls.begin(cmd, flow, text, { source: { id: source.id, title: source.title, cwd: source.cwd }, cwd: source.cwd });
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
    this.workflow.record(cmd, lastRun.ok, lastRun.ok ? text : lastRun.error, flow);
    this.notify("commands");
  }

  async afterCommand(cmd, result, { origin, depth, cwd, startedAt, flow }) {
    this.runs.delete(cmd.id);
    if (!this.commands.get(cmd.id)) { this.controls.finish(cmd, flow, { ok: false, stopped: true, output: result.output }); this.workflow.settle(); return; } // 실행 중에 지운 명령 노드
    const ok = result.exitCode === 0;
    const lastRun = {
      exitCode: result.exitCode, ok, timedOut: result.timedOut, stopped: result.stopped,
      durationMs: result.durationMs, startedAt, cwd, tail: outputTail(result.output), outputText: result.output.slice(0, 200_000), runId: flow?.id,
      originId: origin?.id ?? null, originTitle: origin?.title ?? null,
      origin: originRecord(origin),
    };
    this.commands.update(cmd, { state: result.stopped ? "idle" : ok ? "success" : "error", lastRun, live: null });
    this.notify("commands");
    this.controls.finish(cmd, flow, { ok, output: result.output, stopped: result.stopped });
    if (this.disposed) return;
    // 사용자가 멈춘 실행은 다음으로 넘기지 않는다.
    if (!result.stopped && !flow?.cancelled) {
      this.workflow.record(cmd, ok, result.output, flow);
      for (const link of pickLinks(this.links.from(cmd.id), ok, result.output)) {
        if (link.approve) this.hold(link, cmd, lastRun.tail, depth, flow);
        else await this.deliver(link, depth, null, lastRun, flow);
      }
    }
    if (!result.stopped) await this.checkGroups(cmd, flow);
    this.workflow.drain(cmd);
    this.workflow.settle();
  }

  stopCommand(cmd) {
    const run = this.runs.get(cmd.id);
    if (!run) return false;
    this.commands.update(cmd, { queued: null });
    this.workflow.clearQueue(cmd);
    const flow = this.flowFor(cmd);
    if (flow && !["watch", "schedule"].includes(commandKind(cmd))) this.workflow.cancel(flow);
    run.stop();
    return true;
  }

  // 세션에 요청을 넣는다. 실행 중이면 끝난 뒤 차례로 보낸다.
  // meta.user: 사용자가 실행 중에 대기열에 넣은 요청
  enqueue(target, text, meta, depth) {
    if (this.disposed) return null;
    const queue = this.queue.get(target.id) ?? [];
    const { flow: inheritedFlow, ...publicMeta } = meta ?? {};
    const flow = inheritedFlow ?? this.newFlow();
    const historyStepId = this.controls.queue(target, flow, text, { meta: publicMeta, depth });
    const item = { id: randomBytes(4).toString("hex"), text, meta: publicMeta, depth, flow, historyStepId };
    queue.push(item);
    this.queue.set(target.id, queue);
    this.flush(target);
    this.notify("queue", target.id);
    return item;
  }

  // 턴 종료와 겹쳐 지금 작업에 반영하지 못한 추가 요청을 대기열 앞에 되돌린다.
  // 턴을 마무리하는 중(상태가 아직 실행 중)이면 턴이 끝난 뒤의 flush가 차례로 보낸다. 이미 끝났으면(Codex의 늦은 응답) 바로 보낸다.
  requeue(target, items) {
    if (this.disposed || !items.length) return [];
    const queue = this.queue.get(target.id) ?? [];
    const depth = target.chainDepth ?? 0;
    const added = items.map(({ text, meta }) => {
      const { flow: inheritedFlow, ...publicMeta } = meta ?? {};
      const flow = inheritedFlow ?? this.newFlow();
      return { id: randomBytes(4).toString("hex"), text, meta: publicMeta, depth, flow, historyStepId: this.controls.queue(target, flow, text, { meta: publicMeta, depth }) };
    });
    queue.unshift(...added);
    this.queue.set(target.id, queue);
    if (target.state !== "running") this.flush(target);
    this.notify("queue", target.id);
    return added;
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
    if (!item.meta.message && !item.meta.reply && !item.meta.call) return true;
    const source = this.store.get(item.meta.from);
    return (item.meta.call ? canCall : canContact)(this.links.list?.() ?? [], source, session);
  }

  // 일시중지한 세션은 재개할 때까지 쌓아 두기만 한다.
  flush(session) {
    if (this.disposed) return;
    const queue = this.queue.get(session.id);
    if (!queue?.length || this.runner.isRunning(session.id) || session.paused || this.gitBusy(session)) return;
    // 업데이트가 끝날 때까지 요청과 실행 기록의 대기 단계를 그대로 둔다.
    if (this.runner.isUpdating?.(session.agent)) return;
    while (queue.length) {
      const item = queue.shift();
      if (!queue.length) this.queue.delete(session.id);
      this.notify("queue", session.id);
      if (!this.canDeliver(session, item) || item.flow?.cancelled) continue;
      this.setFlow(session, item.flow);
      session.chainDepth = item.depth;
      try {
        this.assertGitAvailable(session);
        assertSessionGitContext(session);
        // 사용자가 대기열에 넣은 요청과 버튼 프롬프트는 /스킬·@참조를 풀어 쓴다.
        const expand = !!item.meta.user || commandKind(this.commands?.get(item.meta.from)) === "button";
        this.beginSession(session, item.text, { meta: item.meta, depth: item.depth, historyStepId: item.historyStepId });
        this.runner.send(session, item.text, this.cliPaths()[session.agent], this.compose(session, item.text, { expand }), item.meta);
      } catch (err) {
        this.runner.append(session, { kind: "error", text: `넘어온 작업을 시작하지 못했습니다: ${err.message}` });
        this.workflow.record(session, false, err.message, item.flow);
        this.checkGroups(session, item.flow).catch(() => {});
        this.workflow.settle();
      }
      return;
    }
  }
}

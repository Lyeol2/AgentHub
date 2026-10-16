import { randomBytes } from "node:crypto";
import { commandKind, isCommandId } from "./commands.mjs";
import { lastAnswer } from "./policies/workflows.mjs";

const RESUMABLE = new Set(["error", "stopped", "interrupted"]);
const terminal = (status) => !["running", "waiting"].includes(status);

export class RunControls {
  constructor(chain, history = null) {
    this.chain = chain;
    this.history = history;
    this.steps = new Map();
    this.stopped = new Set();
  }

  ensure(node, flow) {
    if (!this.history || !node || !flow) return null;
    return this.history.start(flow, { projectPath: node.projectPath ?? node.cwd,
      sourceId: node.id, sourceTitle: node.title ?? "실행" });
  }

  changed(flow) {
    if (!this.history || !flow) return;
    this.chain.notify("runs", { id: flow.id });
  }

  cleanOptions(options) {
    const { flow, historyStepId, ...saved } = options;
    if (saved.origin) saved.origin = { id: saved.origin.id, title: saved.origin.title, cwd: saved.origin.cwd, ...(saved.origin.gitContext ? { gitContext: saved.origin.gitContext } : {}) };
    return saved;
  }

  queue(node, flow, input, options = {}) {
    if (!this.ensure(node, flow) || flow.cancelled) return null;
    const step = this.history.beginStep(flow.id, { nodeId: node.id, title: (node.title ?? "") + (options.approval ? " · 승인 대기" : " · 대기"),
      kind: isCommandId(node.id) ? commandKind(node) : "session", input, variables: flow.variables,
      depth: options.depth ?? 0, cwd: options.origin?.cwd ?? node.cwd ?? node.projectPath, options: { ...this.cleanOptions(options), queued: true } });
    this.history.waitStep(flow.id, step.id, { output: options.approval ? "실행 승인을 기다립니다." : "실행 순서를 기다립니다." });
    this.changed(flow);
    return step.id;
  }

  begin(node, flow, input = "", options = {}) {
    if (!this.ensure(node, flow) || flow.cancelled) return null;
    if (options.historyStepId) this.history.finishStep(flow.id, options.historyStepId, { ok: true, output: "대기열에서 실행을 시작했습니다." });
    const previous = this.steps.get(node.id);
    if (previous) {
      this.history.finishStep(previous.flow.id, previous.stepId, { ok: true,
        output: this.history.get(previous.flow.id)?.steps.find((step) => step.id === previous.stepId)?.output ?? "" });
    }
    const step = this.history.beginStep(flow.id, {
      nodeId: node.id, title: node.title, kind: isCommandId(node.id) ? commandKind(node) : "session",
      input, variables: flow.variables, depth: options.depth ?? node.chainDepth ?? 0,
      cwd: options.cwd ?? options.origin?.cwd ?? node.cwd ?? node.projectPath, options: this.cleanOptions(options),
    });
    if (step) this.steps.set(node.id, { flow, stepId: step.id });
    this.changed(flow);
    return step;
  }

  finish(node, flow, { ok, output = "", stopped = false, error, result } = {}) {
    if (!this.history || !flow) return;
    const active = this.steps.get(node.id);
    if (!active || active.flow.id !== flow.id) return;
    this.history.finishStep(flow.id, active.stepId, { ok, output, stopped: stopped || flow.cancelled,
      error, result: result ?? (isCommandId(node.id) ? node.lastRun : { cwd: node.cwd }) });
    this.steps.delete(node.id);
    this.history.update(flow.id, { repeats: flow.repeats, variables: flow.variables });
    this.changed(flow);
  }

  wait(node, flow, output = "") {
    const active = this.steps.get(node?.id);
    if (!this.history || !flow || active?.flow.id !== flow.id) return;
    this.history.waitStep(flow.id, active.stepId, { output });
    this.changed(flow);
  }

  continue(node) {
    if (!this.history || node.waiting) return;
    const active = this.steps.get(node.id);
    const run = active ? this.history.get(active.flow.id) : null;
    const step = run?.steps.find((item) => item.id === active.stepId);
    if (step?.status === "waiting") {
      step.status = "running";
      this.history.update(run.id, { status: "running", endedAt: null });
      this.changed(active.flow);
    }
  }

  fail(node, flow, error, options = {}) {
    if (!this.history || !flow || flow.cancelled) return;
    const previous = this.history.get(flow.id)?.steps.filter((step) => step.nodeId === node.id).at(-1);
    const active = this.steps.get(node.id);
    if (active && active.flow.id !== flow.id) {
      this.ensure(node, flow);
      const failed = this.history.beginStep(flow.id, { nodeId: node.id, title: node.title,
        kind: isCommandId(node.id) ? commandKind(node) : "session", input: options.prompt ?? previous?.input ?? node.command ?? "",
        variables: flow.variables, depth: options.depth ?? 0, cwd: options.origin?.cwd ?? node.cwd ?? node.projectPath,
        options: this.cleanOptions(options) });
      this.history.finishStep(flow.id, failed.id, { ok: false, output: error.message ?? String(error), error: error.message ?? String(error) });
      this.changed(flow);
      return;
    }
    if (!active) this.begin(node, flow, options.prompt ?? previous?.input ?? "", previous?.options ?? options);
    this.finish(node, flow, { ok: false, output: error.message ?? String(error), error: error.message ?? String(error) });
  }

  refresh() {
    if (!this.history) return;
    for (const entry of this.chain.workflow.flows.values()) {
      const flow = entry.flow;
      const run = this.history.get(flow.id);
      if (!run) continue;
      let status;
      if (flow.cancelled) {
        const stillRunning = [...this.chain.workflow.nodes].some(([nodeId, current]) => current.id === flow.id && (this.chain.runner.isRunning(nodeId) || (this.chain.runs.has(nodeId) && !this.chain.workflow.watchers.has(nodeId) && this.chain.runs.get(nodeId).kind !== "schedule")));
        status = stillRunning && !this.stopped.has(flow.id) ? "running" : "stopped";
        for (const step of run.steps) if (step.status === "waiting" && this.steps.get(step.nodeId)?.stepId !== step.id) this.history.finishStep(flow.id, step.id, { ok: false, stopped: true });
      }
      else if (this.chain.workflow.active(flow)) {
        const waitingStep = run.steps.some((step) => step.status === "waiting");
        const approval = (this.chain.links.list?.() ?? []).some((link) => link.pending?.flow?.id === flow.id);
        status = waitingStep || approval ? "waiting" : "running";
      } else if (run.steps.some((step) => step.status === "running" || step.status === "waiting")) {
        status = "running";
      } else {
        status = [...entry.results.values()].some((result) => !result.ok) || run.steps.some((step) => step.status === "error" && !entry.results.has(step.nodeId)) ? "error" : "success";
      }
      if (run.status !== status) {
        this.history.update(flow.id, { status, endedAt: terminal(status) ? new Date().toISOString() : null,
          variables: flow.variables, repeats: flow.repeats });
        this.changed(flow);
      }
    }
  }

  stopRun(id) {
    const run = this.history?.get(id);
    if (!run) throw new Error("실행 기록이 없습니다.");
    const c = this.chain;
    this.stopped.add(id);
    const entry = c.workflow.flows.get(id);
    if (entry) c.workflow.cancel(entry.flow);
    for (const [nodeId, current] of c.workflow.nodes) {
      if (current.id !== id) continue;
      c.workflow.cancel(current);
      const node = c.node(nodeId);
      if (!node) continue;
      if (c.workflow.watchers.has(nodeId)) c.workflow.watchers.get(nodeId).stop();
      else if (isCommandId(nodeId)) c.runs.get(nodeId)?.stop();
      else {
        node.paused = false;
        if (c.runner.isRunning(nodeId)) c.runner.stop(node);
        else if (node.paused || node.waiting) {
          node.paused = false;
          node.waiting = false;
          c.runner.dropPrompts?.(nodeId);
          c.runner.setState?.(node, "idle");
          c.store.touch?.(node);
        }
      }
    }
    for (const [nodeId, items] of c.queue) {
      const kept = items.filter((item) => item.flow?.id !== id);
      if (kept.length) c.queue.set(nodeId, kept); else c.queue.delete(nodeId);
      c.notify("queue", nodeId);
    }
    for (const [nodeId, items] of c.workflow.queues) {
      const kept = [];
      for (const item of items) {
        if (item.options.flow?.id === id) item.resolve();
        else kept.push(item);
      }
      if (kept.length) c.workflow.queues.set(nodeId, kept); else c.workflow.queues.delete(nodeId);
      const node = c.commands?.get(nodeId);
      if (node) c.commands.update(node, { queued: c.workflow.queueInfo(nodeId) });
    }
    for (const node of c.commands?.list?.() ?? []) {
      if (node.queued?.flow?.id === id) c.commands.update(node, { queued: null });
    }
    for (const link of c.links.list?.() ?? []) {
      if (link.pending?.flow?.id !== id) continue;
      c.links.update(link, { pending: null });
      c.notify("links");
    }
    for (const [nodeId, active] of this.steps) {
      if (active.flow.id !== id) continue;
      this.history.finishStep(id, active.stepId, { ok: false, stopped: true });
      this.steps.delete(nodeId);
    }
    for (const step of run.steps) if (!terminal(step.status)) this.history.finishStep(id, step.id, { ok: false, stopped: true });
    this.history.update(id, { status: "stopped" });
    this.changed({ id });
    c.notify("commands");
    c.workflow.settle();
    return this.history.get(id);
  }

  descendants(nodeId) {
    const c = this.chain;
    const found = new Set([nodeId]);
    const pending = [nodeId];
    while (pending.length) {
      const id = pending.shift();
      const targets = [...c.links.from(id).filter((link) => link.enabled !== false).map((link) => link.to),
        ...c.groupsOf(id).map((group) => group.id)];
      for (const target of targets) if (!found.has(target)) { found.add(target); pending.push(target); }
    }
    return found;
  }

  async resumeRun(id, stepId) {
    const old = this.history?.get(id);
    if (!old) throw new Error("실행 기록이 없습니다.");
    const c = this.chain;
    if ([...c.workflow.nodes].some(([nodeId, flow]) => flow.id === id &&
      (c.runner.isRunning(nodeId) || (c.runs.has(nodeId) && !c.workflow.watchers.has(nodeId) && c.runs.get(nodeId).kind !== "schedule")))) {
      throw new Error("이전 실행이 아직 종료 중입니다. 종료한 뒤 다시 시도하세요.");
    }
    const step = stepId ? old.steps.find((item) => item.id === stepId)
      : old.steps.filter((item) => RESUMABLE.has(item.status) && item.kind !== "group").at(-1);
    if (!step || !RESUMABLE.has(step.status)) throw new Error("재개할 실패·중지 단계가 없습니다.");
    const node = c.node(step.nodeId);
    if (!node) throw new Error("재개할 노드가 삭제되었습니다.");
    if ((node.projectPath ?? node.cwd).toLowerCase() !== old.projectPath.toLowerCase()) throw new Error("노드의 프로젝트가 바뀌어 재개할 수 없습니다.");
    const kind = isCommandId(node.id) ? commandKind(node) : "session";
    if (kind !== step.kind) throw new Error("노드 종류가 바뀌어 재개할 수 없습니다.");
    if (kind === "group" && !step.options?.approval) throw new Error("결과 모으기의 실패한 구성원부터 재개하세요.");
    const stalePause = kind === "session" && !c.runner.isRunning(node.id) && !c.pending(node.id) && (!c.flowFor(node) || c.flowFor(node).id === id);
    if (c.busy(node) && !stalePause) throw new Error("재개할 노드가 다른 작업을 실행 중입니다.");
    if (kind === "session" && step.cwd && node.cwd.toLowerCase() !== step.cwd.toLowerCase()) throw new Error("세션의 작업 폴더가 바뀌어 재개할 수 없습니다.");
    const approvalLink = step.options?.approval ? c.links.list().find((item) => item.id === step.options.linkId && item.to === node.id && item.enabled !== false) : null;
    const approvalSource = approvalLink ? c.node(approvalLink.from) : null;
    if (step.options?.approval && (!approvalLink || !approvalSource)) throw new Error("승인을 기다리던 연결이 없거나 꺼져 있습니다.");
    const flow = c.newFlow(step.variables ?? old.variables ?? {});
    flow.repeats = { ...(old.repeats ?? {}) };
    if (kind === "repeat") flow.repeats[node.id] = 0;
    const run = this.ensure(node, flow);
    this.history.update(flow.id, { resumedFrom: { runId: old.id, stepId: step.id } });
    const excluded = this.descendants(node.id);
    const latest = new Map(old.steps.map((item) => [item.nodeId, item]));
    for (const preserved of latest.values()) {
      if (preserved.status !== "success" || excluded.has(preserved.nodeId)) continue;
      const member = c.node(preserved.nodeId);
      if (!member) continue;
      const entry = c.workflow.entry(flow);
      entry.results.set(member.id, { id: member.id, title: preserved.title, agent: preserved.kind, cwd: preserved.cwd,
        ok: true, text: preserved.output, revision: ++entry.revision });
      const copy = this.history.beginStep(flow.id, { ...preserved,
        options: { ...preserved.options, reused: true, sourceRunId: old.id }, variables: flow.variables });
      this.history.finishStep(flow.id, copy.id, { ok: true, output: preserved.output, durationMs: 0, result: preserved.result });
    }
    if (step.options?.approval) {
      c.hold(approvalLink, step.options.sourceRun ? { ...approvalSource, lastRun: step.options.sourceRun } : approvalSource, step.input, Math.max(0, step.depth - 1), flow);
    } else if (kind === "session") {
      node.paused = false;
      node.waiting = false;
      c.enqueue(node, step.input, { ...(step.options?.meta ?? {}), flow }, 0);
    } else if (kind === "markdown") {
      c.setFlow(node, flow);
      c.printMessage(node, step.options?.source ?? { id: node.id, title: node.title, cwd: step.cwd ?? node.projectPath }, step.input);
    } else if (["watch", "schedule", "webhook-in"].includes(kind)) {
      c.setFlow(node, flow);
      this.begin(node, flow, step.input, step.options);
      c.workflow.record(node, true, step.input, flow);
      for (const link of c.pickFlowLinks(node, true, step.input)) {
        if (link.approve) c.hold(link, node, step.input, 0, flow);
        else await c.deliver(link, 0, step.input, null, flow);
      }
    } else {
      const options = { ...step.options, flow, depth: 0, prompt: step.input,
        ...(kind === "input" ? { values: flow.variables } : {}) };
      c.startLinkedCommand(node, options);
    }
    c.workflow.settle();
    this.changed(flow);
    return run;
  }

  notification(node, flow, input) {
    const event = { id: "notice-" + randomBytes(10).toString("hex"), runId: flow.id, nodeId: node.id,
      title: node.notificationTitle || node.title || "AgentHub", message: input, level: node.level ?? "info", sound: !!node.sound };
    this.chain.notify("notification", event);
    return event;
  }
}

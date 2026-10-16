import { outputTail } from "./commands.mjs";
import { renderTemplate } from "./flow-nodes.mjs";
import { MAX_SCHEDULE_TIMEOUT_MS, nextScheduleAt } from "./schedule.mjs";

// Timers belong to the armed node; each occurrence owns a separate workflow.
// An occupied workflow skips occurrences instead of building a catch-up queue.
export class ScheduledNodes {
  constructor(runtime, { now = () => Date.now(), setTimer = (...args) => setTimeout(...args), clearTimer = (timer) => clearTimeout(timer) } = {}) {
    this.runtime = runtime;
    this.chain = runtime.chain;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.states = new Map();
    this.deliveries = new Set();
  }

  current(state) {
    return !state.stopped && !this.chain.disposed && this.states.get(state.node.id) === state && this.chain.commands?.get(state.node.id) === state.node;
  }

  start(node, { restore = false } = {}) {
    if (this.chain.disposed) throw new Error("앱이 종료 중이라 예약을 시작할 수 없습니다.");
    if (this.states.has(node.id)) return node;
    const now = this.now();
    const next = nextScheduleAt(node, now, restore ? node.nextRunAt : null);
    renderTemplate(node.prompt ?? "예약된 작업을 시작하세요.", { scheduledAt: next, triggeredAt: new Date(now).toISOString() });
    const state = { node, stopped: false, delivering: false, timer: null, next, flow: this.runtime.get(node) };
    state.stop = () => this.stop(state);
    this.states.set(node.id, state);
    this.chain.runs.set(node.id, { kind: "schedule", stop: state.stop });
    this.chain.commands.update(node, { scheduleEnabled: true, nextRunAt: next, state: "scheduled", queued: null,
      live: { startedAt: new Date(now).toISOString(), cwd: node.projectPath, tail: "예약 시간을 기다립니다." } });
    this.chain.notify("commands");
    this.arm(state);
    return node;
  }

  arm(state) {
    if (!this.current(state)) { this.stop(state, { preserve: true }); return; }
    this.clearTimer(state.timer);
    const remaining = Math.max(0, Date.parse(state.next) - this.now());
    state.timer = this.setTimer(() => {
      state.timer = null;
      if (!this.current(state)) { this.stop(state, { preserve: true }); return; }
      // Long waits are split so Node never turns an overflowing timeout into 1 ms.
      if (this.now() < Date.parse(state.next)) { this.arm(state); return; }
      this.tick(state).catch((error) => this.fail(state, error));
    }, Math.min(remaining, MAX_SCHEDULE_TIMEOUT_MS));
    state.timer?.unref?.();
  }

  async tick(state) {
    if (!this.current(state)) return;
    const c = this.chain, runtime = this.runtime, node = state.node;
    const scheduledAt = state.next;
    const triggeredAt = new Date(this.now()).toISOString();
    const once = (node.scheduleMode ?? "once") === "once";
    if (!once) {
      state.next = nextScheduleAt(node, this.now(), scheduledAt);
      c.commands.update(node, { nextRunAt: state.next });
      this.arm(state);
      c.notify("commands");
    }
    if ([...this.deliveries].some((current) => current.node.id === node.id) || runtime.active(state.flow)) {
      if (once) this.fail(state, new Error("이전 예약 실행이 아직 진행 중이라 이번 예약을 실행하지 못했습니다."));
      return;
    }
    state.delivering = true;
    this.deliveries.add(state);
    let flow = null;
    try {
      const variables = { scheduledAt, triggeredAt };
      const text = renderTemplate(node.prompt ?? "예약된 작업을 시작하세요.", variables);
      flow = runtime.create(variables);
      state.flow = flow;
      runtime.set(node, flow);
      c.controls?.begin(node, flow, text, { cwd: node.projectPath });
      const lastRun = { ok: true, exitCode: 0, stopped: false, timedOut: false, runId: flow.id,
        startedAt: triggeredAt, scheduledAt, triggeredAt, durationMs: 0, cwd: node.projectPath,
        tail: outputTail(text), outputText: text.slice(0, 200_000) };
      c.commands.update(node, { state: once ? "success" : "scheduled", lastRun,
        ...(once ? { scheduleEnabled: false, nextRunAt: null, live: null } : {}) });
      runtime.record(node, true, text, flow);
      c.notify("commands");
      for (const link of c.pickFlowLinks(node, true, text)) {
        if (!this.current(state) || flow.cancelled) break;
        if (link.approve) c.hold(link, node, text, 0, flow);
        else await c.deliver(link, 0, text, null, flow);
      }
      if (this.current(state) && !flow.cancelled) await c.checkGroups(node, flow);
    } catch (error) {
      this.fail(state, error, flow);
    } finally {
      state.delivering = false;
      this.deliveries.delete(state);
      // A one-shot handle remains through delivery so a stop/remove can suppress it.
      if (once) this.stop(state, { preserve: true });
      runtime.settle();
    }
  }

  stop(state, { preserve = false } = {}) {
    if (state.stopped) return;
    state.stopped = true;
    this.clearTimer(state.timer);
    state.timer = null;
    if (this.states.get(state.node.id) !== state) return;
    this.states.delete(state.node.id);
    this.chain.runs.delete(state.node.id);
    if (!preserve && this.chain.commands?.get(state.node.id) === state.node) {
      this.chain.commands.update(state.node, { scheduleEnabled: false, nextRunAt: null, state: "idle", live: null, queued: null });
      this.chain.notify("commands");
    }
  }

  fail(state, error, flow = null) {
    const node = state.node;
    if (state.stopped || this.chain.disposed || this.chain.commands?.get(node.id) !== node ||
      (this.states.has(node.id) && this.states.get(node.id) !== state)) return;
    this.stop(state, { preserve: true });
    const message = `예약을 중지했습니다: ${error.message ?? String(error)} 예약 설정을 확인하고 다시 시작하세요.`;
    this.chain.commands.update(node, { scheduleEnabled: false, nextRunAt: null, state: "error", live: null, queued: null,
      lastRun: { ok: false, exitCode: 1, stopped: false, timedOut: false, durationMs: 0,
        ...(flow ? { runId: flow.id, scheduledAt: flow.variables.scheduledAt, triggeredAt: flow.variables.triggeredAt } : {}),
        startedAt: new Date(this.now()).toISOString(), cwd: node.projectPath, tail: message } });
    if (flow) {
      this.chain.controls?.fail(node, flow, error);
      this.runtime.record(node, false, message, flow);
    }
    this.chain.notify("commands");
  }

  restore() {
    for (const node of this.chain.commands?.list?.() ?? []) {
      if (node.kind !== "schedule" || node.scheduleEnabled !== true || this.states.has(node.id)) continue;
      try { this.start(node, { restore: true }); }
      catch (error) { this.fail({ node, stopped: false, flow: null }, error); }
    }
  }

  dispose() {
    for (const state of this.states.values()) this.stop(state, { preserve: true });
  }
}

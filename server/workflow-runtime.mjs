import { randomBytes } from "node:crypto";
import { commandKind, outputTail } from "./commands.mjs";
import { inputValues, renderTemplate, transformResult } from "./flow-nodes.mjs";
import { createFileWatch } from "./file-watch.mjs";
import { hookVariables, sendWebhook } from "./webhooks.mjs";
import { ScheduledNodes } from "./scheduled-nodes.mjs";
import { runGen3d, GEN3D_STEPS } from "./gen3d.mjs";

const GEN3D_HISTORY_MAX = 20;

// A flow is one invocation, shared by all of its branches. Results are immutable
// snapshots so another invocation of a member cannot replace a join's inputs.
export class WorkflowRuntime {
  constructor(chain, watch = createFileWatch) {
    this.chain = chain;
    this.watch = watch;
    this.nodes = new Map();
    this.flows = new Map();
    this.watchers = new Map();
    this.schedules = new ScheduledNodes(this);
    this.queues = new Map();
  }

  create(variables = {}) {
    const flow = { id: randomBytes(12).toString("hex"), variables: { ...variables }, repeats: {}, steps: 0 };
    this.entry(flow);
    this.prune();
    return flow;
  }

  entry(flow) {
    if (!flow?.id) return null;
    let entry = this.flows.get(flow.id);
    if (!entry) {
      entry = { flow, control: { cancelled: !!flow.cancelled, repeats: flow.repeats ?? {}, steps: flow.steps ?? 0 }, results: new Map(), consumed: new Map(), revision: 0 };
      this.flows.set(flow.id, entry);
    }
    // Approval snapshots retain their variables while sharing cancellation and loop limits.
    for (const key of ["cancelled", "repeats", "steps"]) Object.defineProperty(flow, key, {
      configurable: true, enumerable: true, get: () => entry.control[key], set: (value) => { entry.control[key] = value; },
    });
    return entry;
  }

  cancel(flow) {
    if (!flow) return;
    this.entry(flow).control.cancelled = true;
    for (const link of this.chain.links.list?.() ?? []) {
      if (link.pending?.flow?.id !== flow.id) continue;
      this.chain.links.update(link, { pending: { ...link.pending, flow: { ...link.pending.flow, cancelled: true } } });
      this.chain.notify("links");
    }
  }

  set(node, flow) {
    if (!node || !flow) return null;
    this.entry(flow);
    this.nodes.set(node.id, flow);
    this.chain.controls?.ensure(node, flow);
    return flow;
  }

  get(node) { return node ? this.nodes.get(node.id) ?? null : null; }

  forgetNode(id) {
    this.nodes.delete(id);
    this.chain.controls?.steps?.delete(id);
  }

  record(node, ok, text, flow = this.get(node)) {
    if (!flow) return;
    this.chain.controls?.finish(node, flow, { ok, output: text });
    if (flow.cancelled) return;
    const entry = this.entry(flow);
    entry.results.set(node.id, {
      id: node.id, title: node.title, agent: node.agent ?? commandKind(node),
      cwd: node.cwd ?? node.lastRun?.cwd ?? node.projectPath,
      ok, text: String(text ?? "").slice(0, 200_000), revision: ++entry.revision,
    });
  }

  groupResults(group, flow) {
    const entry = this.entry(flow);
    if (!entry || flow.cancelled) return null;
    const members = this.chain.groupMembers(group);
    if (!members.length || members.length !== (group.members ?? []).length) return null;
    const consumed = entry.consumed.get(group.id) ?? {};
    const results = members.map((member) => entry.results.get(member.id));
    if (results.some((result) => !result || result.revision <= (consumed[result.id] ?? 0))) return null;
    return results;
  }

  consume(group, flow, results) {
    this.entry(flow).consumed.set(group.id, Object.fromEntries(results.map((result) => [result.id, result.revision])));
  }

  active(flow) {
    if (!flow || flow.cancelled) return false;
    const c = this.chain;
    if ([...this.schedules.deliveries].some((state) => state.flow?.id === flow.id)) return true;
    for (const [id, current] of this.nodes) {
      if (current.id !== flow.id || this.watchers.has(id) || this.schedules.states.has(id)) continue;
      if (c.runner.isRunning(id) || c.runs.has(id)) return true;
      const node = c.node(id);
      if (node?.paused || node?.waiting) return true;
    }
    for (const items of c.queue.values()) if (items.some((item) => item.flow?.id === flow.id)) return true;
    for (const items of this.queues.values()) if (items.some((item) => item.options.flow?.id === flow.id)) return true;
    return (c.links.list?.() ?? []).some((link) => link.pending?.flow?.id === flow.id);
  }

  prune() {
    if (this.flows.size <= 256) return;
    for (const [id, entry] of this.flows) {
      if (this.flows.size <= 256) break;
      if (!this.active(entry.flow)) {
        this.flows.delete(id);
        for (const [nodeId, flow] of this.nodes) if (flow.id === id) this.forgetNode(nodeId);
        this.chain.controls?.stopped?.delete(id);
      }
    }
  }

  settle() {
    this.chain.controls?.refresh();
    for (const state of this.watchers.values()) {
      if (!state.pending || this.active(state.flow) || state.stopped) continue;
      const change = state.pending;
      state.pending = null;
      const flow = this.create({ paths: change.paths.join("\n"), changedFiles: change.paths.join("\n"), changedAt: change.at });
      state.flow = flow;
      const c = this.chain;
      this.set(state.node, flow);
      const text = renderTemplate(state.node.prompt || "변경된 파일:\n{{changedFiles}}", flow.variables);
      this.chain.controls?.begin(state.node, flow, text, { cwd: state.node.projectPath });
      this.record(state.node, true, text, flow);
      const picked = c.pickFlowLinks(state.node, true, text);
      c.commands.update(state.node, { lastRun: { ok: true, exitCode: 0, stopped: false, timedOut: false, runId: flow.id,
        startedAt: change.at, durationMs: 0, cwd: state.node.projectPath, tail: text, outputText: text } });
      c.notify("commands");
      Promise.resolve().then(async () => {
        for (const link of picked) {
          if (state.stopped || c.disposed) break;
          if (link.approve) c.hold(link, state.node, text, 0, flow);
          else await c.deliver(link, 0, text, null, flow);
        }
      }).catch((error) => {
        if (state.stopped || c.disposed) return;
        this.chain.controls?.fail(state.node, flow, error);
        state.stop();
        c.commands.update(state.node, { state: "error", lastRun: { ...state.node.lastRun, ok: false, exitCode: 1, tail: error.message } });
        c.notify("commands");
      });
    }
    this.chain.controls?.refresh();
  }

  startWatch(node) {
    const c = this.chain;
    renderTemplate(node.prompt ?? "", { paths: "", changedFiles: "", changedAt: "" });
    const state = { node, stopped: false, pending: null, flow: null };
    const handle = this.watch({
      node,
      onChange: (change) => {
        if (state.stopped || c.disposed || !c.commands.get(node.id)) return;
        state.pending = { ...change, paths: [...new Set([...(state.pending?.paths ?? []), ...change.paths])] };
        this.settle();
      },
      onError: (error) => {
        if (state.stopped) return;
        state.stop();
        if (c.commands.get(node.id)) c.commands.update(node, { state: "error", live: null,
          lastRun: { ok: false, exitCode: 1, stopped: false, timedOut: false, cwd: node.projectPath, tail: error.message } });
        c.notify("commands");
      },
    });
    state.stop = () => {
      state.stopped = true;
      state.pending = null;
      handle.stop();
      this.watchers.delete(node.id);
      c.runs.delete(node.id);
      if (c.commands.get(node.id)) c.commands.update(node, { state: "idle", live: null, queued: null });
      c.notify("commands");
    };
    this.watchers.set(node.id, state);
    c.runs.set(node.id, { kind: "watch", stop: state.stop });
    c.commands.update(node, { state: "watching", queued: null, live: { startedAt: new Date().toISOString(), cwd: node.projectPath, tail: "파일 변경을 기다립니다." } });
    c.notify("commands");
    return node;
  }

  startSchedule(node, options = {}) { return this.schedules.start(node, options); }

  restoreSchedules() { this.schedules.restore(); }

  // 웹훅 받기: 요청 하나가 새 흐름 하나를 시작한다. 요청 템플릿이 틀리면 흐름을 만들지 않고 오류를 던진다.
  trigger(node, variables) {
    const c = this.chain;
    const startedAt = new Date().toISOString();
    let text;
    try { text = renderTemplate(node.prompt || "{{body}}", variables); }
    catch (error) {
      c.commands.update(node, { state: "error", lastRun: { ok: false, exitCode: 1, stopped: false, timedOut: false, startedAt, durationMs: 0,
        cwd: node.projectPath, tail: `받은 요청으로 보낼 내용을 만들지 못했습니다: ${error.message}` } });
      c.notify("commands");
      throw error;
    }
    const flow = this.create(variables);
    this.set(node, flow);
    c.controls?.begin(node, flow, text, { cwd: node.projectPath });
    this.record(node, true, text, flow);
    const picked = c.pickFlowLinks(node, true, text);
    c.commands.update(node, { state: "success", lastRun: { ok: true, exitCode: 0, stopped: false, timedOut: false, runId: flow.id,
      startedAt, durationMs: 0, cwd: node.projectPath, method: variables.method, tail: outputTail(text), outputText: text.slice(0, 200_000) } });
    c.notify("commands");
    Promise.resolve().then(async () => {
      for (const link of picked) {
        if (flow.cancelled || c.disposed || !c.commands.get(node.id)) break;
        if (link.approve) c.hold(link, node, text, 0, flow);
        else await c.deliver(link, 0, text, null, flow);
      }
    }).catch((error) => {
      if (c.disposed || !c.commands.get(node.id)) return;
      c.controls?.fail(node, flow, error);
      c.commands.update(node, { state: "error", lastRun: { ...node.lastRun, ok: false, exitCode: 1, tail: error.message } });
      c.notify("commands");
    }).finally(() => this.settle());
    return flow;
  }

  queueInfo(nodeId) {
    const queue = this.queues.get(nodeId);
    return queue?.length ? { count: queue.length, flow: queue[0].options.flow ? { id: queue[0].options.flow.id } : null } : null;
  }

  hasQueued(nodeId, flowId) { return (this.queues.get(nodeId) ?? []).some((item) => item.options.flow?.id === flowId); }

  enqueue(node, options) {
    const queue = this.queues.get(node.id) ?? [];
    if (queue.length >= 100) return Promise.reject(new Error("노드 대기열은 100개까지입니다."));
    options = { ...options, historyStepId: this.chain.controls?.queue(node, options.flow, options.prompt ?? node.command ?? "", options) };
    const pending = new Promise((resolve, reject) => queue.push({ options, resolve, reject }));
    this.queues.set(node.id, queue);
    this.chain.commands.update(node, { queued: { count: queue.length, flow: options.flow ? { id: options.flow.id } : null } });
    this.chain.notify("commands");
    return pending;
  }

  clearQueue(node) {
    for (const item of this.queues.get(node.id) ?? []) {
      this.cancel(item.options.flow);
      item.resolve();
    }
    this.queues.delete(node.id);
  }

  drain(node) {
    if (this.chain.disposed || this.chain.runs.has(node.id)) return;
    const queue = this.queues.get(node.id);
    if (!queue?.length) return;
    const item = queue.shift();
    if (!queue.length) this.queues.delete(node.id);
    if (!this.chain.commands.get(node.id)) { item.resolve(); this.drain(node); return; }
    this.chain.commands.update(node, { queued: queue.length ? { count: queue.length, flow: queue[0].options.flow ? { id: queue[0].options.flow.id } : null } : null });
    Promise.resolve(this.chain.runCommand(node, item.options)).then(item.resolve, item.reject).finally(() => this.drain(node)).catch(() => {});
  }

  dispose() {
    this.schedules.dispose();
    for (const nodeId of this.queues.keys()) this.clearQueue({ id: nodeId });
  }

  run(node, options = {}) {
    return this.execute(node, options).finally(() => this.drain(node));
  }

  async execute(node, options = {}) {
    const c = this.chain;
    const kind = commandKind(node);
    if (kind === "watch") return this.startWatch(node);
    if (kind === "schedule") return this.startSchedule(node);
    // 카드의 실행 버튼은 빈 요청을 받은 것처럼 흐름을 시험한다.
    if (kind === "webhook-in") { this.trigger(node, hookVariables({ method: "TEST" })); return node.lastRun; }
    // Bad form input is rejected before starting a run or mutating stored state.
    const variables = kind === "input" ? inputValues(node, options.values) : null;
    const flow = this.set(node, options.flow ?? this.create(variables ?? {}));
    if (flow.cancelled) return;
    const started = Date.now();
    let stopped = false;
    let timer = null;
    let resume = null;
    let request = null;
    let httpStatus = null;
    let gen3d = null;
    c.controls?.begin(node, flow, kind === "input" ? JSON.stringify(flow.variables, null, 2) : options.prompt ?? "", options);
    c.runs.set(node.id, { stop: () => { stopped = true; this.cancel(flow); clearTimeout(timer); resume?.(); request?.abort(); } });
    c.commands.update(node, { state: "running", queued: this.queueInfo(node.id), live: { startedAt: new Date(started).toISOString(), cwd: node.projectPath, tail: "" } });
    c.notify("commands");
    let text = "";
    let ok = true;
    let exhausted = false;
    try {
      if (++flow.steps > 1000) throw new Error("한 흐름에서 실행할 수 있는 노드 횟수를 초과했습니다.");
      if (kind === "input") text = renderTemplate(node.prompt || "{{request}}", flow.variables);
      else if (kind === "transform") text = transformResult(node, options.prompt ?? "", flow.variables);
      else if (kind === "notify") {
        text = renderTemplate(node.message ?? "{{input}}", { ...flow.variables, input: options.prompt ?? "", output: options.prompt ?? "" });
        c.controls.notification({ ...node, notificationTitle: renderTemplate(node.notificationTitle || node.title || "AgentHub", { ...flow.variables, input: options.prompt ?? "", output: options.prompt ?? "" }) }, flow, text);
      }
      else if (kind === "webhook") {
        const input = options.prompt ?? "";
        request = new AbortController();
        const response = await sendWebhook(node, { ...flow.variables, input, output: input }, { signal: request.signal });
        httpStatus = response.status;
        ok = response.ok;
        // 성공하면 응답 본문을, 실패하면 상태 코드와 본문을 다음 노드에 넘긴다.
        text = ok ? response.text || `HTTP ${response.status} ${response.statusText}`.trim()
          : `HTTP ${response.status} ${response.statusText}`.trim() + (response.text ? `\n${response.text}` : "");
      }
      else if (kind === "gen3d") {
        const input = options.prompt ?? "";
        request = new AbortController();
        // 실패한 실행을 이어 하면 성공한 단계는 다시 만들지 않는다(크레딧 절약).
        const previous = options.resume && node.lastRun?.gen3d && !node.lastRun.ok ? node.lastRun.gen3d : null;
        try {
          const result = await runGen3d(node, {
            input, projectPath: node.projectPath, keys: c.gen3d?.keys ?? { get: () => ({}) }, fetch: c.gen3d?.fetch, sleep: c.gen3d?.sleep, signal: request.signal, resume: previous, runId: flow.id,
            render: (template) => renderTemplate(template, { ...flow.variables, input, output: input }),
            onProgress: ({ step, progress, reused }) => {
              const label = `${GEN3D_STEPS[step]} ${reused ? "· 앞선 결과 사용" : progress === null ? "진행 중" : `${Math.round(progress)}%`}`;
              c.commands.update(node, { live: { ...(node.live ?? {}), tail: label, gen3d: { step, progress } } });
              c.notify("commands");
            },
          });
          text = result.text;
          gen3d = result.record;
        } catch (error) {
          gen3d = error.record ?? null;
          throw error;
        }
      }
      else if (kind === "repeat") {
        const iteration = (flow.repeats[node.id] ?? 0) + 1;
        flow.repeats[node.id] = iteration;
        exhausted = iteration > (node.maxIterations ?? 3);
        ok = !exhausted;
        text = exhausted ? "최대 반복 횟수 " + node.maxIterations + "회를 모두 사용했습니다.\n" + (options.prompt ?? "")
          : options.prompt || "반복 " + iteration + "/" + node.maxIterations;
        if (!exhausted && node.delayMs) await new Promise((resolve) => { resume = resolve; timer = setTimeout(resolve, node.delayMs); });
      }
    } catch (error) { ok = false; text = error.message; }
    finally { clearTimeout(timer); c.runs.delete(node.id); }
    if (!c.commands.get(node.id)) { c.controls?.finish(node, flow, { ok: false, output: text, stopped: true }); this.settle(); return; }
    const lastRun = { ok: ok && !stopped, exitCode: ok && !stopped ? 0 : 1, stopped, timedOut: false,
      startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, cwd: options.origin?.cwd ?? node.projectPath,
      originId: options.origin?.id ?? null, originTitle: options.origin?.title ?? null,
      runId: flow.id, tail: outputTail(text), outputText: text.slice(0, 200_000),
      ...(kind === "repeat" ? { iteration: Math.min(flow.repeats[node.id], node.maxIterations), exhausted } : {}),
      ...(kind === "webhook" ? { httpStatus } : {}),
      ...(kind === "gen3d" && gen3d ? { gen3d } : {}) };
    c.commands.update(node, { state: stopped ? "idle" : ok ? "success" : "error", live: null, lastRun,
      // 3D 생성 노드는 실행마다 결과(단계별 파일·썸네일)를 기록에 쌓는다.
      ...(kind === "gen3d" && gen3d ? { history: [{ ...gen3d, ok: ok && !stopped, stopped }, ...(node.history ?? [])].slice(0, GEN3D_HISTORY_MAX) } : {}) });
    c.notify("commands");
    c.controls?.finish(node, flow, { ok, output: text, stopped });
    if (stopped || flow.cancelled || c.disposed) return;
    this.record(node, ok, text, flow);
    const depth = kind === "repeat" && !exhausted ? 0 : options.depth ?? 0;
    for (const link of c.pickFlowLinks(node, ok, text)) {
      if (flow.cancelled || c.disposed) break;
      if (link.approve) c.hold(link, node, text, depth, flow);
      else await c.deliver(link, depth, text, null, flow);
    }
    await c.checkGroups(node, flow);
    this.settle();
    return lastRun;
  }
}

import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.mjs";
import { readJsonFile, writeJsonAtomic } from "./infrastructure/persistence/json-file.mjs";

export const RUN_HISTORY_TEXT_MAX = 200_000;
const ACTIVE = new Set(["running", "waiting"]);
const STATUSES = new Set(["running", "waiting", "success", "error", "stopped", "interrupted"]);
const sameProject = (a, b) => typeof a === "string" && typeof b === "string" && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const timestamp = () => new Date().toISOString();
const limitedText = (value) => String(value ?? "").slice(0, RUN_HISTORY_TEXT_MAX);

// History must stay JSON-only: process handles, cycles and mutable options never
// leak into persisted snapshots. A shared budget bounds nested variables/results.
function snapshot(value) {
  let remaining = RUN_HISTORY_TEXT_MAX;
  const ancestors = new Set();
  function visit(item, depth = 0) {
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "string") {
      const text = item.slice(0, Math.max(0, remaining));
      remaining -= text.length;
      return text;
    }
    if (!item || typeof item !== "object" || ancestors.has(item) || depth > 20 || remaining <= 0) return null;
    if (item instanceof Date) return Number.isFinite(item.getTime()) ? item.toISOString() : null;
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) return null;
    ancestors.add(item);
    const result = Array.isArray(item) ? [] : {};
    const entries = Array.isArray(item) ? item.slice(0, 2000).entries() : Object.entries(item).slice(0, 2000);
    for (const [key, child] of entries) {
      if (remaining <= 0) break;
      if (["__proto__", "prototype", "constructor"].includes(String(key))) continue;
      if (["function", "symbol", "undefined", "bigint"].includes(typeof child)) continue;
      remaining -= String(key).length + 4;
      result[key] = visit(child, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value);
}

function validRuns(value) {
  return Array.isArray(value) && value.every((run) => run && typeof run.id === "string" && typeof run.projectPath === "string"
    && STATUSES.has(run.status) && Array.isArray(run.steps) && run.steps.every((step) => step && typeof step.id === "string" && typeof step.nodeId === "string" && STATUSES.has(step.status)));
}

export class RunHistoryStore {
  constructor({ dataDir = DATA_DIR, maxRuns = 200 } = {}) {
    if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error("실행 기록 보관 개수가 올바르지 않습니다.");
    this.file = path.join(dataDir, "run-history.json");
    this.maxRuns = maxRuns;
    this.runs = readJsonFile(this.file, { dataDir, fallback: () => [], valid: validRuns });
    let changed = false;
    const now = timestamp();
    for (const run of this.runs) {
      if (ACTIVE.has(run.status)) {
        run.status = "interrupted";
        run.endedAt = now;
        run.updatedAt = now;
        changed = true;
      }
      for (const step of run.steps) {
        if (!ACTIVE.has(step.status)) continue;
        step.status = "interrupted";
        step.endedAt = now;
        step.durationMs = Math.max(0, Date.parse(now) - (Date.parse(step.startedAt) || Date.parse(now)));
        changed = true;
      }
    }
    if (this.trim()) changed = true;
    if (changed) this.save();
  }

  get(id) { return this.runs.find((run) => run.id === id); }
  list(projectPath) {
    return this.runs.filter((run) => !projectPath || sameProject(run.projectPath, projectPath)).slice().reverse();
  }

  start(flow, { projectPath, sourceId = null, sourceTitle = "" } = {}) {
    if (!flow || typeof flow.id !== "string" || !flow.id || typeof projectPath !== "string" || !projectPath) throw new Error("실행 기록의 흐름과 프로젝트가 필요합니다.");
    const existing = this.get(flow.id);
    if (existing) return existing;
    const now = timestamp();
    const run = { id: flow.id, projectPath, sourceId, sourceTitle: String(sourceTitle ?? "").slice(0, 200),
      variables: snapshot(flow.variables ?? {}), repeats: snapshot(flow.repeats ?? {}),
      startedAt: now, updatedAt: now, endedAt: null, status: "running", steps: [] };
    this.runs.push(run);
    this.save();
    return run;
  }

  beginStep(runId, { nodeId, title = "", kind = "session", input = "", depth = 0, options, variables, cwd } = {}) {
    const run = this.get(runId);
    if (!run) return null;
    if (typeof nodeId !== "string" || !nodeId) throw new Error("실행할 노드가 필요합니다.");
    const now = timestamp();
    const step = { id: "step-" + randomBytes(8).toString("hex"), nodeId, title: String(title ?? "").slice(0, 200),
      kind: String(kind), input: limitedText(input), variables: snapshot(variables ?? run.variables ?? {}),
      depth: Number.isFinite(depth) ? depth : 0, options: snapshot(options ?? {}), cwd: typeof cwd === "string" ? cwd : null,
      status: "running", startedAt: now, endedAt: null, durationMs: null, output: "" };
    run.steps.push(step);
    run.status = "running";
    run.endedAt = null;
    run.updatedAt = now;
    this.save();
    return step;
  }

  waitStep(runId, stepId, { output } = {}) {
    const run = this.get(runId);
    const step = run?.steps.find((item) => item.id === stepId);
    if (!step || !ACTIVE.has(step.status)) return step ?? null;
    step.status = "waiting";
    if (output !== undefined) step.output = limitedText(output);
    run.status = "waiting";
    run.endedAt = null;
    run.updatedAt = timestamp();
    this.save();
    return step;
  }

  finishStep(runId, stepId, { ok, output = "", error, durationMs, stopped = false, result } = {}) {
    const run = this.get(runId);
    const step = run?.steps.find((item) => item.id === stepId);
    if (!step) return null;
    // Late process events cannot replace a step already stopped/interrupted.
    if (!ACTIVE.has(step.status)) return step;
    const now = timestamp();
    Object.assign(step, { status: stopped ? "stopped" : ok ? "success" : "error", endedAt: now,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : Math.max(0, Date.parse(now) - Date.parse(step.startedAt)),
      output: limitedText(output) });
    if (error !== undefined) step.error = limitedText(error instanceof Error ? error.message : error);
    if (result !== undefined) step.result = snapshot(result);
    run.updatedAt = now;
    this.save();
    return step;
  }

  update(id, changes = {}) {
    const run = this.get(typeof id === "string" ? id : id?.id);
    if (!run) return null;
    if (changes.status !== undefined && !STATUSES.has(changes.status)) throw new Error("실행 상태가 올바르지 않습니다.");
    const immutable = new Set(["id", "steps", "projectPath", "startedAt", "__proto__", "prototype", "constructor"]);
    for (const [key, value] of Object.entries(changes)) {
      if (!immutable.has(key)) run[key] = snapshot(value);
    }
    run.updatedAt = timestamp();
    if (changes.status && !ACTIVE.has(changes.status) && !Object.hasOwn(changes, "endedAt")) run.endedAt = run.updatedAt;
    this.save();
    return run;
  }

  trim() {
    let changed = false;
    while (this.runs.length > this.maxRuns) {
      const completed = this.runs.findIndex((run) => !ACTIVE.has(run.status));
      // Active runs must remain addressable by stop/resume APIs.
      if (completed < 0) break;
      this.runs.splice(completed, 1);
      changed = true;
    }
    return changed;
  }

  save() { this.trim(); writeJsonAtomic(this.file, this.runs); }
}

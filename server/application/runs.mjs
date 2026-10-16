import { HttpError } from "./errors.mjs";

const ACTIVE = new Set(["running", "waiting"]);
const RESUMABLE = new Set(["error", "stopped", "interrupted"]);
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function createRunService({ history, chain, projects, notify = () => {} }) {
  function get(id) {
    if (!validId(id)) throw new HttpError(400, "실행 ID가 올바르지 않습니다.");
    const run = history.get(id);
    if (!run) throw new HttpError(404, "실행 기록이 없습니다.");
    return run;
  }
  function list(projectPath) {
    if (typeof projectPath !== "string" || !projectPath.trim()) throw new HttpError(400, "프로젝트를 선택하세요.");
    const project = projects.ensureProject(projectPath);
    return { runs: history.list(project.path) };
  }
  async function invoke(method, run, ...args) {
    try {
      const result = await chain[method](run.id, ...args);
      if (result === false) throw new HttpError(409, method === "stopRun" ? "중지할 실행이 없습니다." : "이 실행을 재개할 수 없습니다.");
      notify("runs", { id: run.id, projectPath: run.projectPath });
      return result && typeof result === "object" ? result : history.get(run.id);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(Number.isInteger(error.status) ? error.status : 409, error.message ?? "실행 상태를 바꿀 수 없습니다.");
    }
  }
  async function stop(id) {
    const run = get(id);
    if (!ACTIVE.has(run.status)) throw new HttpError(409, "실행 중이거나 대기 중인 흐름만 중지할 수 있습니다.");
    return invoke("stopRun", run);
  }
  async function resume(id, body = {}) {
    const run = get(id);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "재개 요청 형식이 올바르지 않습니다.");
    if (!RESUMABLE.has(run.status)) throw new HttpError(409, "실패하거나 중지된 흐름만 재개할 수 있습니다.");
    if (body.stepId !== undefined) {
      if (!validId(body.stepId)) throw new HttpError(400, "재개할 단계 ID가 올바르지 않습니다.");
      const step = run.steps.find((item) => item.id === body.stepId);
      if (!step) throw new HttpError(404, "재개할 단계가 없습니다.");
      if (!RESUMABLE.has(step.status)) throw new HttpError(409, "실패하거나 중지된 단계부터 재개할 수 있습니다.");
    }
    return invoke("resumeRun", run, body.stepId);
  }
  return { list, get, stop, resume };
}

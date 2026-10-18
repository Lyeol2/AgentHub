import { seconds, STALL_AFTER_S } from "./activity.js";

// 세션의 하위 작업(Claude가 띄운 서브에이전트·백그라운드 명령 등). 서버 계약은 docs/development.md "화면용 서버 계약".
// 화면에 그리지 않는 DOM 없는 계산만 둔다(목록 병합·개수·정렬·경과 시간·진행 없음 경고).
export const SUBTASK_STATUS = { running: "실행 중", completed: "완료", failed: "실패", stopped: "중지", interrupted: "중단됨" };
const TASK_TYPE = { local_agent: "서브에이전트", local_bash: "백그라운드 명령", local_workflow: "워크플로" };

// CLI 정리 작업(ambient)은 화면에 보이지 않는다.
export const visibleSubtasks = (tasks) => (tasks ?? []).filter((task) => !task.ambient);

// SSE subtasks { tasks, removed }를 id로 합친다. 순서는 처음 받은 순서를 지킨다.
export function mergeSubtasks(list, tasks = [], removed = []) {
  const gone = new Set(removed);
  const merged = new Map((list ?? []).filter((task) => !gone.has(task.id)).map((task) => [task.id, task]));
  for (const task of tasks) if (task?.id && !gone.has(task.id)) merged.set(task.id, task);
  return [...merged.values()];
}

// 목록 응답의 subtaskCount와 같은 계산(running은 정리 작업 제외). 작업이 없으면 null.
export const countSubtasks = (tasks) => tasks?.length ? { running: visibleSubtasks(tasks).filter((task) => task.status === "running").length, total: tasks.length } : null;

// "하위 작업 3개 · 모두 완료", "하위 작업 3개 · 실행 중 1개 · 실패 1개"
export function subtaskSummary(tasks) {
  const shown = visibleSubtasks(tasks);
  const by = (status) => shown.filter((task) => task.status === status).length;
  const parts = Object.keys(SUBTASK_STATUS).filter((status) => status !== "completed" && by(status)).map((status) => `${SUBTASK_STATUS[status]} ${by(status)}개`);
  return `하위 작업 ${shown.length}개 · ${parts.length ? parts.join(" · ") : "모두 완료"}`;
}

// "서브에이전트 · Explore · 백그라운드"
export function subtaskKind(task) {
  const kind = TASK_TYPE[task.taskType] ?? task.taskType;
  return [kind, task.type && task.type !== task.taskType ? task.type : null, task.background ? "백그라운드" : null].filter(Boolean).join(" · ");
}

const at = (value) => { const time = Date.parse(value ?? ""); return Number.isFinite(time) ? time : null; };

// 실행 중이면 지금까지, 끝났으면 걸린 시간. 시작 시각이 없으면 CLI가 알려 준 시간을 쓴다.
export function subtaskElapsed(task, now = Date.now()) {
  const start = at(task.startedAt);
  const end = task.status === "running" ? now : at(task.endedAt);
  if (start !== null && end !== null) return seconds(Math.max(0, Math.floor((end - start) / 1000)));
  return task.usage?.durationMs != null ? seconds(Math.floor(task.usage.durationMs / 1000)) : null;
}

// 실행 중인데 마지막 진행(없으면 시작)부터 오래 소식이 없으면 경고 글. 아니면 null.
export function subtaskStall(task, now = Date.now()) {
  if (task.status !== "running") return null;
  const last = at(task.lastProgressAt) ?? at(task.startedAt);
  if (last === null) return null;
  const quiet = Math.max(0, Math.floor((now - last) / 1000));
  return quiet >= STALL_AFTER_S ? `${seconds(quiet)}째 진행 없음` : null;
}

// 상위 작업 아래에 하위 작업이 오도록 줄 세운다. 상위가 목록에 없으면 CLI가 알려 준 깊이로 들여 쓴다.
export function orderSubtasks(tasks) {
  const shown = visibleSubtasks(tasks);
  const ids = new Set(shown.map((task) => task.id));
  const children = new Map();
  for (const task of shown) {
    const parent = task.parentId && ids.has(task.parentId) && task.parentId !== task.id ? task.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(task);
  }
  const ordered = [], seen = new Set();
  const visit = (task, level) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    ordered.push({ task, level });
    for (const child of children.get(task.id) ?? []) visit(child, level + 1);
  };
  for (const task of children.get(null) ?? []) visit(task, Math.max(0, (task.depth ?? 1) - 1));
  // 서로를 상위로 가리키는 잘못된 기록도 빠뜨리지 않는다.
  for (const task of shown) visit(task, 0);
  return ordered;
}

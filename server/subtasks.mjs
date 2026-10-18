// 세션의 하위 작업(Claude가 띄운 서브에이전트·백그라운드 명령 등) 목록. CLI의 task_* 시스템 메시지로 만든다.
// 세션에 session.subtasks로 저장하고, 바뀐 작업은 runner가 "subtasks" 이벤트로 화면에 알린다.
// status: running | completed | failed | stopped(사용자가 멈춤) | interrupted(CLI가 끝나 함께 끊김)

// 세션에 남기는 작업 수. 넘으면 끝난 작업부터 오래된 순으로 지운다.
export const SUBTASK_LIMIT = 30;
// 작업마다 남기는 최근 활동(도구 호출·글) 수
export const SUBTASK_ACTIVITY_LIMIT = 30;
const TEXT_MAX = 200;
const PROMPT_MAX = 2000;

const clip = (text, max = TEXT_MAX) => {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};
// CLI의 작업 상태(task_updated patch.status, task_notification status)를 AgentHub 상태로 바꾼다.
const STATUS = { pending: "running", running: "running", paused: "running", completed: "completed", failed: "failed", killed: "stopped", stopped: "stopped" };
const usageOf = (usage) => usage && typeof usage === "object"
  ? { totalTokens: usage.total_tokens ?? null, toolUses: usage.tool_uses ?? null, durationMs: usage.duration_ms ?? null } : null;

// 실행 중인 작업. 화면에 보이지 않는 CLI 정리 작업(ambient)은 세션 상태에 넣지 않는다.
export const activeSubtasks = (session) => (session?.subtasks ?? []).filter((task) => task.status === "running" && !task.ambient);

// claude.mjs parseLine이 만든 { kind: "subtask", phase, ... } 이벤트를 세션 작업 목록에 반영한다.
// 바뀐 작업과 목록에서 지운 작업 ID를 돌려준다. 바뀐 것이 없으면 null.
export function applySubtask(session, event, now = new Date().toISOString()) {
  if (!event?.taskId) return null;
  const list = session.subtasks ??= [];
  let task = list.find((item) => item.id === event.taskId);
  if (event.phase === "started") {
    if (!task) {
      task = { id: event.taskId, toolUseId: null, description: "", type: null, taskType: null, status: "running", background: false,
        parentId: null, depth: null, prompt: null, startedAt: now, endedAt: null, lastProgressAt: null, usage: null, lastTool: null, summary: null, error: null, activity: [] };
      list.push(task);
    }
    Object.assign(task, {
      toolUseId: event.toolUseId ?? task.toolUseId, description: clip(event.description ?? task.description), type: event.subagentType ?? event.taskType ?? task.type,
      taskType: event.taskType ?? task.taskType, background: !!event.background, parentId: event.parentId ?? task.parentId, depth: event.depth ?? task.depth,
      prompt: event.prompt ? clip(event.prompt, PROMPT_MAX) : task.prompt, status: "running",
      ...(event.ambient ? { ambient: true } : {}),
    });
    return { task, removed: prune(list) };
  }
  // 시작을 놓친 작업(서버가 중간에 붙은 경우 등)은 알림만으로도 만든다.
  if (!task) {
    if (event.phase === "updated") return null;
    return applySubtask(session, { ...event, phase: "started" }, now) && applySubtask(session, event, now);
  }
  if (event.phase === "progress") {
    Object.assign(task, { lastProgressAt: now, ...(event.usage ? { usage: usageOf(event.usage) } : {}), ...(event.lastTool ? { lastTool: event.lastTool } : {}), ...(event.summary ? { summary: clip(event.summary) } : {}) });
    if (event.description) task.description = clip(event.description);
  } else if (event.phase === "updated") {
    const patch = event.patch ?? {};
    if (patch.description) task.description = clip(patch.description);
    if (patch.is_backgrounded !== undefined) task.background = !!patch.is_backgrounded;
    if (patch.error) task.error = clip(patch.error);
    if (patch.status && STATUS[patch.status]) finish(task, STATUS[patch.status], patch.end_time ? new Date(patch.end_time).toISOString() : now);
  } else if (event.phase === "notification") {
    if (event.summary) task.summary = clip(event.summary);
    if (event.usage) task.usage = usageOf(event.usage);
    if (event.outputFile) task.outputFile = event.outputFile;
    if (event.reason) task.reason = event.reason;
    finish(task, STATUS[event.status] ?? "completed", task.endedAt ?? now);
  } else return null;
  return { task, removed: [] };
}

function finish(task, status, at) {
  task.status = status;
  if (status === "running") task.endedAt = null;
  else task.endedAt ??= at;
}

// 하위 작업 안에서 나온 대화(parent_tool_use_id가 있는 메시지)는 본 기록에 넣지 않고 그 작업의 최근 활동으로만 남긴다.
export function addSubtaskActivity(session, toolUseId, items = [], now = new Date().toISOString()) {
  const task = (session.subtasks ?? []).find((item) => item.toolUseId === toolUseId);
  if (!task || !items.length) return null;
  task.activity = [...(task.activity ?? []), ...items.map((item) => ({ ts: now, kind: item.kind, ...(item.label ? { label: item.label } : {}), text: clip(item.text) }))].slice(-SUBTASK_ACTIVITY_LIMIT);
  const tool = items.filter((item) => item.kind === "tool").at(-1);
  if (tool) task.lastTool = tool.label ?? tool.name ?? task.lastTool;
  task.lastProgressAt = now;
  return { task, removed: [] };
}

// CLI가 끝나 실행 중이던 작업을 모두 끝난 것으로 표시한다(stopped: 사용자가 멈춤, interrupted: 비정상 종료 등).
export function settleSubtasks(session, status, now = new Date().toISOString()) {
  const changed = (session.subtasks ?? []).filter((task) => task.status === "running");
  for (const task of changed) finish(task, status, now);
  return changed;
}

// 끝난 작업부터 오래된 순으로 지운다. 실행 중인 작업은 지우지 않는다.
function prune(list) {
  const removed = [];
  while (list.length > SUBTASK_LIMIT) {
    const index = list.findIndex((task) => task.status !== "running");
    if (index < 0) break;
    removed.push(list.splice(index, 1)[0].id);
  }
  return removed;
}

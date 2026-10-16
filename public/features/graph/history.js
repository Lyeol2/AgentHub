import { samePath } from "../../shared/store.js";

// 노드 그래프의 되돌리기(Ctrl+Z)·다시 실행(Ctrl+Y). 변경마다 되돌리는 방법을 함께 기록하고 같은 API로 되돌린다.
// 지운 노드·연결을 되살리면 id가 새로 생기므로, 예전 id를 새 id로 이어 두고 뒤의 기록이 따라가게 한다.
// 기록은 화면에만 두며 프로젝트를 옮기면 비운다. 세션 삭제처럼 되살릴 수 없는 변경은 기록하지 않는다.
export function createGraphHistory({ refresh, onChange = () => {}, limit = 100, getScope = () => null }) {
  let project = null;
  const scopes = new Map();
  const ids = new Map();
  let running = false;
  const scopeFor = (id = getScope()) => {
    if (!scopes.has(id)) scopes.set(id, { undo: [], redo: [] });
    return scopes.get(id);
  };
  // Cross-tab links need the same ID remapping even though their undo stacks differ.
  const tools = {
    resolve(id) {
      const seen = new Set();
      while (ids.has(id) && !seen.has(id)) { seen.add(id); id = ids.get(id); }
      return id;
    },
    remap(previous, next) { if (previous && next && previous !== next) ids.set(previous, next); },
  };

  function reset(projectPath = null) {
    project = projectPath;
    scopes.clear();
    ids.clear();
    onChange();
  }

  // entry: { label, undo(tools), redo(tools) }
  function record(projectPath, entry) {
    if (running || !projectPath) return;
    if (!samePath(project, projectPath)) reset(projectPath);
    const scope = scopeFor(entry.tabId === undefined ? getScope() : entry.tabId);
    scope.undo.push(entry);
    if (scope.undo.length > limit) scope.undo.shift();
    scope.redo = [];
    onChange();
  }

  async function step(projectPath, action) {
    if (running || !samePath(project, projectPath)) return null;
    const scope = scopeFor(), from = scope[action], to = scope[action === "undo" ? "redo" : "undo"];
    if (!from.length) return null;
    const entry = from.pop();
    running = true;
    onChange();
    try {
      await entry[action](tools);
      to.push(entry);
      return { ok: true, label: entry.label };
    } catch (error) {
      // 그 사이 다른 곳에서 노드를 지웠다면 이 기록은 더 이상 쓸 수 없다.
      return { ok: false, label: entry.label, error };
    } finally {
      running = false;
      await refresh(projectPath).catch(() => {});
      onChange();
    }
  }

  return {
    record, reset,
    invalidate: (projectPath, tabIds) => {
      if (samePath(project, projectPath)) for (const id of tabIds) scopes.delete(id);
      onChange();
    },
    undo: (projectPath) => step(projectPath, "undo"),
    redo: (projectPath) => step(projectPath, "redo"),
    state: (projectPath) => ({
      undo: samePath(project, projectPath) && !running ? scopeFor().undo.at(-1)?.label ?? null : null,
      redo: samePath(project, projectPath) && !running ? scopeFor().redo.at(-1)?.label ?? null : null,
      running,
    }),
    resolve: tools.resolve,
  };
}

// 연결을 되살릴 때 보낼 값
export const linkBody = (link) => ({ from: link.from, to: link.to, when: link.when, keyword: link.keyword ?? "", note: link.note ?? "",
  enabled: link.enabled !== false, approve: !!link.approve, ...(link.useGitWorktree !== undefined ? { useGitWorktree: link.useGitWorktree } : {}) });

// 노드를 되살릴 때 보낼 설정. 실행 상태·결과·받는 주소 같은 서버가 정하는 값은 뺀다.
export function commandBody(command) {
  const { id: _id, state: _state, lastRun: _lastRun, live: _live, queued: _queued, createdAt: _createdAt, hookToken: _hookToken,
    scheduleEnabled: _scheduleEnabled, nextRunAt: _nextRunAt, ...config } = command;
  return config;
}

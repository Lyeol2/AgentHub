/** Server snapshots are shared; transient UI state belongs to each feature. */
export function createStore() {
  return {
    data: { status: null, sessions: [], current: null, projects: null, links: [], commands: [],
      commandsProject: null, nodeGroups: [], nodeGroupsProject: null, graphTabs: [], graphTabsProject: null, defaultGraphTabId: null, shells: [], skills: [], skillsProject: null, messages: [] },
    navigation: { view: "dashboard", project: null, graphTabId: null, viewRevision: 0 },
  };
}

// Git이 주는 E:/Git/x와 Windows 경로 E:\Git\x, 끝 구분자 차이를 같은 경로로 본다.
export const pathKey = (p) => (p ?? "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
export const samePath = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);
export const firstLine = (text) => text?.split(/\r?\n/)[0] ?? "";

// Snapshots replace their arrays; mutations to an existing item remain visible through the map.
const indexes = new WeakMap();
export function indexById(items = []) {
  let cached = indexes.get(items);
  if (!cached || cached.size !== items.length) {
    cached = new Map(items.map((item) => [item.id, item]));
    indexes.set(items, cached);
  }
  return cached;
}

/** Apply live execution metadata equally to list and open-detail snapshots. */
export function applySessionState(data, payload) {
  const { sessionId, state: next } = payload;
  const item = indexById(data.sessions).get(sessionId);
  const targets = new Set([item, data.current?.id === sessionId ? data.current : null]);
  for (const session of targets) {
    if (!session) continue;
    session.state = next;
    // 진행 표시(시작 단계·마지막 출력 시각)는 실행 중에만 쓴다. 다음 실행의 값은 진행 알림으로 받는다.
    if (next !== "running") { session.runningStartedAt = null; delete session.runPhase; delete session.lastOutputAt; }
    else if (Object.hasOwn(payload, "runningStartedAt")) session.runningStartedAt = payload.runningStartedAt;
  }
  return item;
}

/** Server snapshots are shared; transient UI state belongs to each feature. */
export function createStore() {
  return {
    data: { status: null, sessions: [], current: null, projects: null, links: [], commands: [],
      commandsProject: null, nodeGroups: [], nodeGroupsProject: null, shells: [], skills: [], skillsProject: null, messages: [] },
    navigation: { view: "dashboard", project: null, viewRevision: 0 },
  };
}

// Git이 주는 E:/Git/x와 Windows 경로 E:\Git\x, 끝 구분자 차이를 같은 경로로 본다.
const pathKey = (p) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
export const samePath = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);
export const firstLine = (text) => text?.split(/\r?\n/)[0] ?? "";

/** Apply live execution metadata equally to list and open-detail snapshots. */
export function applySessionState(data, payload) {
  const { sessionId, state: next } = payload;
  const targets = new Set([data.sessions.find((s) => s.id === sessionId), data.current?.id === sessionId ? data.current : null]);
  for (const session of targets) {
    if (!session) continue;
    session.state = next;
    if (next !== "running") session.runningStartedAt = null;
    else if (Object.hasOwn(payload, "runningStartedAt")) session.runningStartedAt = payload.runningStartedAt;
  }
  return data.sessions.find((s) => s.id === sessionId);
}

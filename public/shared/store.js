/** Server snapshots are shared; transient UI state belongs to each feature. */
export function createStore() {
  return {
    data: { status: null, sessions: [], current: null, projects: null, links: [], commands: [],
      commandsProject: null, shells: [], skills: [], skillsProject: null, messages: [], hubs: new Map() },
    navigation: { view: "dashboard", project: null, viewRevision: 0 },
  };
}

export const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
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

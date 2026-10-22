import { pathKey } from "../../shared/store.js";

/** One pass over sessions supplies every project's sort key and membership. */
export function projectSummaries(projects = [], sessions = []) {
  const summaries = new Map();
  for (const project of projects) summaries.set(pathKey(project.path), { sessions: [], lastActive: project.lastActive ?? null });
  for (const session of sessions) {
    const key = pathKey(session.projectPath);
    let summary = summaries.get(key);
    if (!summary) summaries.set(key, summary = { sessions: [], lastActive: null });
    summary.sessions.push(session);
    if (session.updatedAt && (!summary.lastActive || session.updatedAt > summary.lastActive)) summary.lastActive = session.updatedAt;
  }
  return summaries;
}

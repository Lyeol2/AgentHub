export function taskRoutes(s) {
  return [
    ["GET", "workbranches", ({ query }) => s.workbranches(query.get("path"))],
    ["GET", "tasks", ({ query }) => s.list(query.get("path"))],
    ["GET", "tasks/context", ({ query }) => s.context(query.get("path"))],
    ["GET", "tasks/settings", ({ query }) => s.settings(query.get("path"))],
    ["PUT", "tasks/settings", ({ query, body }) => s.updateSettings(query.get("path"), body)],
    ["POST", "tasks", ({ body }) => s.create(body)],
    ["POST", "tasks/:id/finish", ({ params, body }) => s.finish(params.id, body)],
    ["POST", "tasks/:id/refresh", ({ params }) => s.refresh(params.id)],
    ["POST", "tasks/:id/sync", ({ params }) => s.sync(params.id)],
    ["POST", "tasks/:id/cleanup", ({ params }) => s.cleanup(params.id)],
    ["POST", "tasks/:id/session", ({ params, body }) => s.addSession(params.id, body)],
    ["DELETE", "tasks/:id", ({ params, query }) => s.remove(params.id, { force: query.get("force") === "1", deleteBranch: query.get("branch") === "delete" })],
  ];
}

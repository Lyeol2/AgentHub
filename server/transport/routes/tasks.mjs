export function taskRoutes(s) {
  return [
    ["GET", "tasks", ({ query }) => s.list(query.get("path"))],
    ["GET", "tasks/context", ({ query }) => s.context(query.get("path"))],
    ["POST", "tasks", ({ body }) => s.create(body)],
    ["POST", "tasks/:id/finish", ({ params, body }) => s.finish(params.id, body)],
    ["POST", "tasks/:id/refresh", ({ params }) => s.refresh(params.id)],
    ["POST", "tasks/:id/sync", ({ params }) => s.sync(params.id)],
    ["POST", "tasks/:id/cleanup", ({ params }) => s.cleanup(params.id)],
    ["POST", "tasks/:id/session", ({ params, body }) => s.addSession(params.id, body)],
  ];
}

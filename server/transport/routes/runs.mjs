export function runRoutes(s) {
  return [
    ["GET", "runs", ({ query }) => s.list(query.get("path"))],
    ["GET", "runs/:id", ({ params }) => s.get(params.id)],
    ["POST", "runs/:id/stop", ({ params }) => s.stop(params.id)],
    ["POST", "runs/:id/resume", ({ params, body }) => s.resume(params.id, body)],
  ];
}

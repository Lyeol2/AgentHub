export function runRoutes(s) {
  return [
    ["GET", "runs", ({ query }) => query.has("cursor") || query.has("limit")
      ? s.list(query.get("path"), { cursor: query.get("cursor"), limit: query.get("limit") ?? 50 }) : s.list(query.get("path"))],
    ["GET", "runs/:id", ({ params }) => s.get(params.id)],
    ["POST", "runs/:id/stop", ({ params }) => s.stop(params.id)],
    ["POST", "runs/:id/resume", ({ params, body }) => s.resume(params.id, body)],
  ];
}

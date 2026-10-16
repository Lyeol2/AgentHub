export function graphTabRoutes(s) {
  return [
    ["GET", "graph-tabs", ({ query }) => s.list(query.get("path"))],
    ["POST", "graph-tabs", ({ body }) => s.create(body)],
    ["POST", "graph-tabs/reorder", ({ body }) => s.reorder(body)],
    ["PUT", "graph-tabs/:id", ({ params, body }) => s.update(params.id, body)],
    ["POST", "graph-tabs/:id/move", ({ params, body }) => s.move(params.id, body)],
    ["DELETE", "graph-tabs/:id", ({ params, query }) => s.remove(params.id, query.get("target"))],
  ];
}

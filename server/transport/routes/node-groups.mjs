export function nodeGroupRoutes(s) {
  return [
    ["GET", "node-groups", ({ query }) => s.list(query.get("path"))],
    ["POST", "node-groups", ({ body }) => s.create(body)],
    ["PUT", "node-groups/:id", ({ params, body }) => s.update(params.id, body)],
    ["DELETE", "node-groups/:id", ({ params }) => s.remove(params.id)],
  ];
}

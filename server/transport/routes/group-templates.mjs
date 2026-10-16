export function groupTemplateRoutes(s) {
  return [
    ["GET", "group-templates", ({ query }) => s.list(query.get("path"))],
    ["POST", "group-templates", ({ body }) => s.create(body)],
    ["DELETE", "group-templates/:id", ({ params }) => s.remove(params.id)],
    ["POST", "group-templates/:id/instantiate", ({ params, body }) => s.instantiate(params.id, body)],
  ];
}

export function projectRoutes(s) {
  return [
    ["POST", "projects", ({ body }) => s.add(body)],
    ["DELETE", "projects", ({ query }) => s.remove(query.get("path"), { force: query.get("force") === "1", removeWorktrees: query.get("removeWorktrees") === "1" })],
    ["GET", "projects/all", () => s.all()],
    ["GET", "projects/discover", ({ query }) => s.discover(query.get("path"))],
    ["POST", "projects/hide", ({ body }) => s.hide(body)],
    ["DELETE", "projects/:index", ({ params }) => s.unregister(params.index)],
  ];
}

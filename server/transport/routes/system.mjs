export function systemRoutes(s) {
  return [
    ["GET", "status", () => s.status()],
    ["GET", "auth", ({ query }) => s.auth(query.get("fresh") === "1")],
    ["POST", "auth/:agent/login", ({ params }) => s.login(params.agent)],
    ["GET", "setup", () => s.setupStatus()],
    ...["install", "login", "input", "cancel"].map((action) => ["POST", `setup/:tool/${action}`, ({ params, body }) => s.setupAction(params.tool, action, body)]),
    ["GET", "limits", ({ query }) => s.limits(query.get("fresh") === "1")],
    ["GET", "update", () => s.updateState()],
    ...["check", "download", "install"].map((action) => ["POST", `update/${action}`, () => s.update(action)]),
    ["PUT", "settings", ({ body }) => s.settings(body)],
  ];
}

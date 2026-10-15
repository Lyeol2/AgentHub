export function workflowRoutes(s) {
  return [
    ["GET", "links", () => s.listLinks()],
    ["POST", "links", ({ body }) => s.createLink(body)],
    ["PUT", "links/:id", ({ params, body }) => s.updateLink(params.id, body)],
    ["DELETE", "links/:id", ({ params }) => s.removeLink(params.id)],
    ["POST", "links/:id/decide", ({ params, body }) => s.decideLink(params.id, body.action)],
    ["POST", "links/:id/run", ({ params }) => s.runLink(params.id)],
    ["GET", "hub", ({ query }) => s.hub(query.get("path"))],
    ["POST", "hub/init", ({ body }) => s.initHub(body.path)],
    ["POST", "hub/open", ({ body }) => s.openHub(body.path)],
    ["POST", "hub/flows", ({ body }) => s.createFlow(body)],
  ];
}

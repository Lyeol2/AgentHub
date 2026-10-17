export function taskRoutes(s) {
  return [
    ["GET", "workbranches", ({ query }) => s.workbranches(query.get("path"))],
    ["GET", "tasks", ({ query }) => s.list(query.get("path"))],
    ["GET", "tasks/context", ({ query }) => s.context(query.get("path"))],
    ["GET", "tasks/settings", ({ query }) => s.settings(query.get("path"))],
    ["PUT", "tasks/settings", ({ query, body }) => s.updateSettings(query.get("path"), body)],
    ["POST", "tasks", ({ body }) => s.create(body)],
    ["GET", "tasks/:id/review", ({ params }) => s.review(params.id)],
    ["GET", "tasks/:id/diff", ({ params, query }) => s.reviewDiff(params.id, query.get("file"))],
    ["POST", "tasks/:id/commit", ({ params, body }) => s.commitReview(params.id, body)],
    ["POST", "tasks/:id/finish", ({ params, body }) => s.finish(params.id, body)],
    ["POST", "tasks/:id/merge", ({ params, body }) => s.mergePull(params.id, body)],
    ["POST", "tasks/:id/push-target", ({ params }) => s.pushTarget(params.id)],
    ["POST", "tasks/:id/refresh", ({ params }) => s.refresh(params.id)],
    ["POST", "tasks/:id/sync", ({ params, body }) => s.sync(params.id, body)],
    ["POST", "tasks/:id/develop", ({ params }) => s.mergeDevelop(params.id)],
    ["POST", "tasks/:id/issue", ({ params, body }) => s.linkIssue(params.id, body)],
    ["DELETE", "tasks/:id/issue", ({ params }) => s.unlinkIssue(params.id)],
    ["POST", "tasks/:id/cleanup", ({ params }) => s.cleanup(params.id)],
    ["POST", "tasks/:id/session", ({ params, body }) => s.addSession(params.id, body)],
    ["DELETE", "tasks/:id", ({ params, query }) => s.remove(params.id, { force: query.get("force") === "1", deleteBranch: query.get("branch") === "delete" })],
  ];
}

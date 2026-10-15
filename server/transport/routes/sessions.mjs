import { IMAGE_BODY_LIMIT } from "../../attachments.mjs";

export function sessionRoutes(s) {
  return [
    ["GET", "sessions", () => s.list()],
    ["POST", "sessions", ({ body }) => s.create(body)],
    ["POST", "sessions/import", ({ body }) => s.importSession(body)],
    ["GET", "sessions/:id", ({ params }) => s.detail(params.id)],
    ["PUT", "sessions/:id", ({ params, body }) => s.update(params.id, body)],
    ["DELETE", "sessions/:id", ({ params, query }) => s.remove(params.id, {
      force: query.get("force") === "1",
      removeWorktree: query.get("removeWorktree") === "1",
      deleteRecords: query.get("records") === "delete"
    })],
    ["POST", "sessions/:id/attachments", ({ params, body }) => s.uploadAttachment(params.id, body), { maxBodyBytes: IMAGE_BODY_LIMIT }],
    ["GET", "sessions/:id/attachments/:image", ({ params, res }) => {
      const image = s.attachmentContent(params.id, params.image);
      res.writeHead(200, { "Content-Type": image.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(image.bytes);
    }],
    ["POST", "sessions/:id/export", ({ params }) => s.exportRecord(params.id)],
    ["POST", "sessions/:id/messages", ({ params, body }) => s.sendMessage(params.id, body)],
    ["DELETE", "sessions/:id/queue/:item", ({ params }) => s.queueAction(params.id, params.item, "delete")],
    ["POST", "sessions/:id/queue/:item", ({ params, body }) => s.queueAction(params.id, params.item, body.action)],
    ["POST", "sessions/:id/plans/:plan", ({ params, body }) => s.decidePlan(params.id, params.plan, body)],
    ["POST", "sessions/:id/questions/:question", ({ params, body }) => s.answerQuestion(params.id, params.question, body)],
    ["POST", "sessions/:id/permissions/:permission", ({ params, body }) => s.answerPermission(params.id, params.permission, body)],
    ...["stop", "pause", "resume", "restart", "recreate"].map((action) => ["POST", `sessions/:id/${action}`, ({ params }) => s[action](params.id)]),
    ["GET", "sessions/:id/diff", ({ params }) => s.diff(params.id)],
  ];
}

import { ATTACHMENT_BODY_LIMIT, isImageAttachment, safeAttachmentName } from "../../attachments.mjs";
import { BUNDLE_MAX_BYTES } from "../../session-bundle.mjs";
import { ARTIFACT_PREVIEW_CSP } from "../../session-artifacts.mjs";

const RECORD_BODY_LIMIT = BUNDLE_MAX_BYTES * 2 + 100_000; // JSON 이스케이프 여유(.md 문서보다 큰 .agenthub 파일 기준)

export function sessionRoutes(s) {
  return [
    ["GET", "sessions", () => s.list()],
    ["POST", "sessions", ({ body }) => s.create(body)],
    ["POST", "sessions/import", ({ body }) => s.importSession(body)],
    ["GET", "records", ({ query }) => s.listRecords({ projectPath: query.get("path"), sessionId: query.get("session") ?? undefined })],
    ["POST", "sessions/import-record", ({ body }) => s.importRecord(body), { maxBodyBytes: RECORD_BODY_LIMIT }],
    // meta=1: 기록(events) 없이 세션 정보만 돌려준다. 실행 중 화면의 머리글만 갱신할 때 쓴다.
    ["GET", "sessions/:id", ({ params, query }) => query.get("meta") === "1" ? s.detailMeta(params.id) : s.detail(params.id)],
    ["PUT", "sessions/:id", ({ params, body }) => s.update(params.id, body)],
    ["POST", "sessions/:id/read", ({ params, body }) => s.markRead(params.id, body)],
    ["DELETE", "sessions/:id", ({ params, query }) => s.remove(params.id, {
      force: query.get("force") === "1",
      removeWorktree: query.get("removeWorktree") === "1",
      deleteRecords: query.get("records") === "delete"
    })],
    ["POST", "sessions/:id/attachments", ({ params, body }) => s.uploadAttachment(params.id, body), { maxBodyBytes: ATTACHMENT_BODY_LIMIT }],
    ["GET", "sessions/:id/artifact", ({ params, query }) => s.artifact(params.id, query.get("path"), { summary: query.get("summary") === "1" })],
    ["GET", "sessions/:id/artifact/preview", ({ params, query, res }) => {
      const html = s.artifactPreview(params.id, query.get("path"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": ARTIFACT_PREVIEW_CSP,
      });
      res.end(html);
    }],
    ["GET", "sessions/:id/artifact/content", ({ params, query, req, res }) => {
      const file = s.artifactContent(params.id, query.get("path"));
      const inline = ["image", "video"].includes(file.kind) && query.get("download") !== "1";
      const filename = encodeURIComponent(safeAttachmentName(file.name)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
      const headers = {
        "Content-Type": inline ? file.mimeType : "application/octet-stream",
        "Content-Length": file.bytes.length,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="artifact"; filename*=UTF-8''${filename}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      };
      // Browser media players request byte ranges for metadata and seeking.
      if (inline && file.kind === "video") {
        headers["Accept-Ranges"] = "bytes";
        const range = req?.headers?.range;
        if (range) {
          const size = file.bytes.length;
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
          const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
          if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
            res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
            return res.end();
          }
          const bytes = file.bytes.subarray(start, end + 1);
          res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": bytes.length });
          return res.end(bytes);
        }
      }
      res.writeHead(200, headers);
      res.end(file.bytes);
    }],
    ["GET", "sessions/:id/attachments/:image", ({ params, res }) => {
      const image = s.attachmentContent(params.id, params.image);
      const headers = { "Content-Type": image.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
      if (!isImageAttachment(image)) {
        const filename = encodeURIComponent(safeAttachmentName(image.name)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
        headers["Content-Disposition"] = "attachment; filename=\"attachment\"; filename*=UTF-8''" + filename;
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
      }
      res.writeHead(200, headers);
      res.end(image.bytes);
    }],
    ["POST", "sessions/:id/export", ({ params, body }) => s.exportRecord(params.id, { format: body.format ?? "markdown" })],
    ["POST", "sessions/:id/read-record", ({ params, body }) => s.readRecordInto(params.id, body), { maxBodyBytes: RECORD_BODY_LIMIT }],
    ["GET", "sessions/:id/files", ({ params, query }) => s.files(params.id, query.get("q") ?? "")],
    ["GET", "sessions/:id/mcp", ({ params }) => s.mcpStatus(params.id)],
    ["POST", "sessions/:id/mcp/reconnect", ({ params, body }) => s.reconnectMcp(params.id, body)],
    ["POST", "sessions/:id/mcp/reload", ({ params }) => s.reloadMcp(params.id)],
    ["POST", "sessions/:id/messages", ({ params, body }) => s.sendMessage(params.id, body)],
    ["DELETE", "sessions/:id/queue/:item", ({ params }) => s.queueAction(params.id, params.item, "delete")],
    ["POST", "sessions/:id/queue/:item", ({ params, body }) => s.queueAction(params.id, params.item, body.action)],
    ["POST", "sessions/:id/plans/:plan", ({ params, body }) => s.decidePlan(params.id, params.plan, body)],
    ["POST", "sessions/:id/questions/:question", ({ params, body }) => s.answerQuestion(params.id, params.question, body)],
    ["POST", "sessions/:id/permissions/:permission", ({ params, body }) => s.answerPermission(params.id, params.permission, body)],
    // 하위 작업(백그라운드 서브에이전트 등) 하나만 멈춘다.
    ["POST", "sessions/:id/subtasks/:task/stop", ({ params }) => s.stopSubtask(params.id, params.task)],
    ...["stop", "pause", "resume", "restart", "recreate"].map((action) => ["POST", `sessions/:id/${action}`, ({ params }) => s[action](params.id)]),
    ["POST", "sessions/:id/clear-error", ({ params }) => s.clearError(params.id)],
    ["GET", "sessions/:id/diff", ({ params }) => s.diff(params.id)],
  ];
}

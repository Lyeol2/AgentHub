import path from "node:path";
import { sendFileRange } from "../../session-artifacts.mjs";

export function assetRoutes({ commands: c, skills: s }) {
  const project = ({ query, body }) => query.get("path") ?? body.projectPath;
  return [
    ["GET", "commands", ({ query }) => c.list(query.get("path"))],
    ["GET", "commands/git-branches", ({ query }) => c.gitBranches(query.get("path"))],
    ["POST", "commands/generate", ({ body }) => c.generate(body)],
    ["POST", "commands", ({ body }) => c.create(body)],
    ["PUT", "commands/:id", ({ params, body }) => c.update(params.id, body)],
    ["DELETE", "commands/:id", ({ params }) => c.remove(params.id)],
    ["POST", "commands/:id/run", ({ params, body }) => c.run(params.id, body)],
    ["POST", "commands/:id/stop", ({ params }) => c.stop(params.id)],
    ["POST", "commands/:id/clear-error", ({ params }) => c.clearError(params.id)],
    ["GET", "commands/:id/output", ({ params }) => c.output(params.id)],
    // 이미지 미리보기 노드가 받은 이미지. 기록에 있는 경로만 연다.
    ["GET", "commands/:id/image", ({ params, query, req, res }) => {
      const file = c.previewImage(params.id, query.get("run"), query.get("index"));
      return sendFileRange(req, res, file.realPath, { "Content-Type": file.mimeType, "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Content-Disposition": "inline" });
    }],
    ["GET", "commands/:id/gen3d/file", ({ params, query, req, res }) => {
      const file = c.gen3dFile(params.id, query.get("path"));
      const inline = /^image\//.test(file.mimeType) || file.mimeType === "video/mp4";
      const filename = encodeURIComponent(file.name).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
      return sendFileRange(req, res, file.realPath, { "Content-Type": inline ? file.mimeType : "application/octet-stream", "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="model"; filename*=UTF-8''${filename}` });
    }],
    ["POST", "commands/:id/gen3d/forward", ({ params, body }) => c.gen3dForward(params.id, body)],
    ["POST", "commands/:id/gen3d/expand", ({ params }) => c.gen3dExpand(params.id)],
    ["POST", "commands/:id/figcraft/open", ({ params, body }) => c.figcraftOpen(params.id, body)],
    ["POST", "commands/:id/artref/images", ({ params, body }) => c.addReferenceImage(params.id, body), { maxBodyBytes: 28_100_000 }],
    ["DELETE", "commands/:id/artref/image", ({ params, query }) => c.removeReferenceImage(params.id, query.get("name"))],
    ["GET", "commands/:id/artref/image", ({ params, query, req, res }) => {
      const file = c.referenceImage(params.id, query.get("name"));
      const type = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" }[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return sendFileRange(req, res, file, { "Content-Type": type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" });
    }],
    ["GET", "commands/:id/output/file", ({ params, res }) => {
      const output = c.output(params.id);
      const filename = encodeURIComponent(output.fileName).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
        "Content-Disposition": "attachment; filename=\"output.md\"; filename*=UTF-8''" + filename,
      });
      res.end(output.text);
    }],
    ["GET", "skills", (ctx) => s.list(project(ctx))],
    ["POST", "skills", (ctx) => s.create(project(ctx), ctx.body)],
    ["PUT", "skills/:name", (ctx) => s.update(project(ctx), ctx.params.name, ctx.body)],
    ["DELETE", "skills/:name", (ctx) => s.remove(project(ctx), ctx.params.name)],
    ["POST", "skills/:name/move", (ctx) => s.move(project(ctx), ctx.params.name, ctx.body.to)],
    // 스킬 보기(프로젝트 지침 탭): 목록·자세히·검사·참고 파일·두 위치 합치기·건너뜀 고치기·AI
    ["GET", "skills/catalog", (ctx) => s.catalog(project(ctx))],
    ["POST", "skills/check", (ctx) => s.check(project(ctx), ctx.body)],
    ["POST", "skills/fix-skipped", (ctx) => s.fixSkipped(project(ctx), ctx.body)],
    ["POST", "skills/draft", (ctx) => s.draft(project(ctx), ctx.body, ctx.res)],
    ["POST", "skills/trigger", (ctx) => s.trigger(project(ctx), ctx.body, ctx.res)],
    ["GET", "skills/:name/detail", (ctx) => s.detail(project(ctx), ctx.params.name, { file: ctx.query.get("file") ?? undefined })],
    ["GET", "skills/:name/file", (ctx) => s.readFile(project(ctx), ctx.params.name, ctx.query.get("rel"))],
    ["PUT", "skills/:name/file", (ctx) => s.writeFile(project(ctx), ctx.params.name, ctx.query.get("rel") ?? ctx.body.rel, ctx.body)],
    ["POST", "skills/:name/merge", (ctx) => s.mergePersonal(project(ctx), ctx.params.name, ctx.body)],
    ["POST", "skills/:name/suggest", (ctx) => s.suggest(project(ctx), ctx.params.name, ctx.body, ctx.res)],
  ];
}

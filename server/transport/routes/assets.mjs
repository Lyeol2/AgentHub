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
  ];
}

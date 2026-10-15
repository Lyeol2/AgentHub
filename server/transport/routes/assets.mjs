export function assetRoutes({ commands: c, skills: s }) {
  const project = ({ query, body }) => query.get("path") ?? body.projectPath;
  return [
    ["GET", "commands", ({ query }) => c.list(query.get("path"))],
    ["POST", "commands/generate", ({ body }) => c.generate(body)],
    ["POST", "commands", ({ body }) => c.create(body)],
    ["PUT", "commands/:id", ({ params, body }) => c.update(params.id, body)],
    ["DELETE", "commands/:id", ({ params }) => c.remove(params.id)],
    ["POST", "commands/:id/run", ({ params }) => c.run(params.id)],
    ["POST", "commands/:id/stop", ({ params }) => c.stop(params.id)],
    ["GET", "commands/:id/output", ({ params }) => c.output(params.id)],
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

// 프로젝트 지침 탭(AGENTS.md 작성 도우미)
export function guideRoutes(s) {
  const where = ({ query, body }) => ({ projectPath: query.get("path") ?? body.path, file: query.get("file") ?? body.file ?? undefined });
  return [
    ["GET", "guide", (ctx) => s.view(where(ctx).projectPath, where(ctx).file)],
    ["POST", "guide/check", (ctx) => s.check({ ...ctx.body, ...where(ctx) })],
    ["PUT", "guide", (ctx) => s.save({ ...ctx.body, ...where(ctx) })],
    ["POST", "guide/claude/link", (ctx) => s.linkClaude(where(ctx))],
    ["POST", "guide/claude/merge", (ctx) => s.mergeClaude({ ...ctx.body, ...where(ctx) })],
    ["POST", "guide/draft", (ctx) => s.draft({ ...ctx.body, ...where(ctx) }, ctx.res)],
    ["POST", "guide/rewrite", (ctx) => s.rewrite({ ...ctx.body, ...where(ctx) }, ctx.res)],
    ["GET", "guide/map", (ctx) => s.map(where(ctx))],
    ["GET", "guide/flow", (ctx) => s.getFlow({ ...where(ctx), session: ctx.query.get("session") ?? undefined })],
    ["POST", "guide/flow", (ctx) => s.drawFlow({ ...ctx.body, ...where(ctx) }, ctx.res)],
  ];
}

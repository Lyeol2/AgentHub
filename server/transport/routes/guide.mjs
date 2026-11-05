// 프로젝트 지침 탭(AGENTS.md 작성 도우미 · 갈래 만들기·삭제)
export function guideRoutes(s) {
  const where = ({ query, body }) => ({ projectPath: query.get("path") ?? body.path, file: query.get("file") ?? body.file ?? undefined });
  return [
    ["GET", "guide", (ctx) => s.view(where(ctx).projectPath, where(ctx).file)],
    ["POST", "guide/check", (ctx) => s.check({ ...ctx.body, ...where(ctx) })],
    ["PUT", "guide", (ctx) => s.save({ ...ctx.body, ...where(ctx) })],
    ["DELETE", "guide", (ctx) => s.removeFile({ ...where(ctx), baseHash: ctx.query.get("baseHash") ?? undefined, dropRefs: ctx.query.get("dropRefs") === "1" })],
    ["POST", "guide/claude/link", (ctx) => s.linkClaude(where(ctx))],
    ["POST", "guide/claude/merge", (ctx) => s.mergeClaude({ ...ctx.body, ...where(ctx) })],
    ["POST", "guide/draft", (ctx) => s.draft({ ...ctx.body, ...where(ctx) }, ctx.res)],
    ["POST", "guide/rewrite", (ctx) => s.rewrite({ ...ctx.body, ...where(ctx) }, ctx.res)],
    ["GET", "guide/map", (ctx) => s.map(where(ctx))],
    ["GET", "guide/flow", (ctx) => s.getFlow({ ...where(ctx), session: ctx.query.get("session") ?? undefined })],
    ["POST", "guide/flow", (ctx) => s.drawFlow({ ...ctx.body, ...where(ctx) }, ctx.res)],
    // 갈래 만들기·삭제
    ["GET", "guide/folders", (ctx) => s.folders({ ...where(ctx), q: ctx.query.get("q") ?? "" })],
    ["POST", "guide/files", (ctx) => s.createGuide({ ...ctx.body, ...where(ctx) })],
    ["POST", "guide/docs", (ctx) => s.createDoc({ ...ctx.body, ...where(ctx) })],
    ["GET", "guide/impact", (ctx) => s.impact(where(ctx))],
    ["GET", "guide/trash", (ctx) => s.trash(where(ctx))],
    ["POST", "guide/restore", (ctx) => s.restore({ ...ctx.body, ...where(ctx) })],
    ["GET", "guide/check-all", (ctx) => s.checkAll(where(ctx))],
    // 세션 지침
    ["POST", "guide/session-guides", (ctx) => s.createSessionGuide({ ...ctx.body, ...where(ctx) })],
    ["POST", "guide/session-guides/migrate", (ctx) => s.migrateRoles(where(ctx))],
    ["POST", "guide/session-guides/duplicate", (ctx) => s.duplicateSessionGuide({ ...ctx.body, ...where(ctx) })],
  ];
}

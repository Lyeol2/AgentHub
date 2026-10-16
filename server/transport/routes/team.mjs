// 계정 연결과 팀 작업(GitHub 이슈). 고정 경로를 :number보다 먼저 둔다.
export function teamRoutes(account, issues) {
  const where = ({ query, body }) => query.get("path") ?? body.path;
  return [
    ["GET", "account", ({ query }) => account.status(query.get("fresh") === "1")],
    ["POST", "account/connect", () => account.connect()],
    ["POST", "account/disconnect", ({ body }) => account.disconnect({ logout: body.logout === true })],
    ["GET", "issues/inbox", () => issues.inbox()],
    ["GET", "issues/context", (ctx) => issues.context(where(ctx), { remote: ctx.query.get("remote") ?? undefined })],
    ["GET", "issues/members", (ctx) => issues.members(where(ctx), { remote: ctx.query.get("remote") ?? undefined })],
    ["GET", "issues/draft", ({ query }) => issues.draft(query.get("session"))],
    ["GET", "issues", (ctx) => issues.list(where(ctx), { box: ctx.query.get("box") ?? "inbox", state: ctx.query.get("state") ?? "open", remote: ctx.query.get("remote") ?? undefined })],
    ["POST", "issues", (ctx) => issues.create(where(ctx), ctx.body)],
    ["GET", "issues/:number", (ctx) => issues.detail(where(ctx), ctx.params.number, { remote: ctx.query.get("remote") ?? undefined })],
    ["POST", "issues/:number/comments", (ctx) => issues.comment(where(ctx), ctx.params.number, ctx.body)],
    ["POST", "issues/:number/return", (ctx) => issues.giveBack(where(ctx), ctx.params.number, ctx.body)],
    ["POST", "issues/:number/close", (ctx) => issues.close(where(ctx), ctx.params.number, ctx.body)],
    ["POST", "issues/:number/reopen", (ctx) => issues.reopen(where(ctx), ctx.params.number, ctx.body)],
    ["POST", "issues/:number/start", (ctx) => issues.start(where(ctx), ctx.params.number, ctx.body)],
    ["PUT", "issues/:number/progress", (ctx) => issues.setProgress(where(ctx), ctx.params.number, ctx.body)],
  ];
}

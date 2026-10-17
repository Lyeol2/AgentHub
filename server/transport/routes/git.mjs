export function gitRoutes(s) {
  const options = ({ query, body, params }, write = false) => ({
    ...body,
    projectPath: query.get("path") ?? body.path,
    cwd: query.get("cwd") ?? body.cwd,
    sessionId: query.get("session") ?? body.session,
    file: query.get("file") ?? body.file,
    area: query.get("area") ?? body.area,
    hash: query.get("hash") ?? body.hash,
    branch: write ? body.branch : query.get("branch"),
    remote: write ? body.remote : query.get("remote"),
    state: write ? body.state : query.get("state"),
    number: params.number,
  });
  return [
    ["GET", "git", (ctx) => s.execute("overview", options(ctx))],
    ...["diff", "show", "branch", "worktrees", "remotes", "recovery"].map((action) => ["GET", `git/${action}`, (ctx) => s.execute(action, options(ctx))]),
    ...["stage", "unstage", "commit", "merge", "checkout", "push", "fetch", "preview", "execute", "restore"].map((action) => ["POST", `git/${action}`, (ctx) => s.execute(action, options(ctx, true))]),
    ["GET", "git/pull-state", (ctx) => s.execute("pullState", options(ctx))],
    ["POST", "git/pull-remote", (ctx) => s.execute("pullRemote", options(ctx, true))],
    ["POST", "git/branches", (ctx) => s.execute("createBranch", options(ctx, true))],
    ["POST", "git/worktrees", (ctx) => s.execute("createWorktree", options(ctx, true))],
    ["POST", "git/worktrees/remove", (ctx) => s.execute("removeWorktree", options(ctx, true))],
    ["GET", "git/pulls", (ctx) => s.execute("pulls", options(ctx))],
    ["GET", "git/pulls/:number", (ctx) => s.execute("pull", options(ctx))],
    ["POST", "git/pulls", (ctx) => s.execute("createPull", options(ctx, true))],
    ["POST", "git/pulls/:number/merge", (ctx) => s.execute("mergePull", options(ctx, true))],
    ["POST", "git/pulls/:number/close", (ctx) => s.execute("closePull", options(ctx, true))],
  ];
}

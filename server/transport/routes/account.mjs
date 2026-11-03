// 계정 연결(GitHub CLI 로그인). Git 탭의 Pull Request·작업 게시에서 쓴다.
export function accountRoutes(account) {
  return [
    ["GET", "account", ({ query }) => account.status(query.get("fresh") === "1")],
    ["POST", "account/connect", () => account.connect()],
    ["POST", "account/disconnect", ({ body }) => account.disconnect({ logout: body.logout === true })],
  ];
}

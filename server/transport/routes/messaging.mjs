export function messagingRoutes(s) {
  return [
    ["GET", "messages", ({ query }) => s.list(query.get("path"))],
    ["GET", "board", ({ query }) => s.readBoard(query.get("path"))],
    ["PUT", "board", ({ body }) => s.writeBoard(body)],
  ];
}

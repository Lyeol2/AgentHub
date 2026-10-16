export function flowAssistantRoutes(s) {
  return [
    ["POST", "flow-assistant/plan", ({ body }) => s.plan(body)],
    ["POST", "flow-assistant/apply", ({ body }) => s.apply(body)],
  ];
}

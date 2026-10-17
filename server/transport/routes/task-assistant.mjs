export function taskAssistantRoutes(service) {
  return [["POST", "task-assistant/plan", ({ body }) => service.plan(body)]];
}

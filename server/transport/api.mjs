import { HttpError } from "../application/errors.mjs";
import { send, readJson } from "./http.mjs";
import { sessionRoutes } from "./routes/sessions.mjs";
import { projectRoutes } from "./routes/projects.mjs";
import { workflowRoutes } from "./routes/workflows.mjs";
import { systemRoutes } from "./routes/system.mjs";
import { assetRoutes } from "./routes/assets.mjs";
import { gitRoutes } from "./routes/git.mjs";
import { messagingRoutes } from "./routes/messaging.mjs";
import { taskRoutes } from "./routes/tasks.mjs";
import { nodeGroupRoutes } from "./routes/node-groups.mjs";
import { teamRoutes } from "./routes/team.mjs";
import { runRoutes } from "./routes/runs.mjs";
import { groupTemplateRoutes } from "./routes/group-templates.mjs";
import { flowAssistantRoutes } from "./routes/flow-assistant.mjs";
import { taskAssistantRoutes } from "./routes/task-assistant.mjs";
import { graphTabRoutes } from "./routes/graph-tabs.mjs";
import { gen3dRoutes } from "./routes/gen3d.mjs";
import { figcraftRoutes } from "./routes/figcraft.mjs";

export function createApiHandler({ services, events }) {
  const routes = [
    ...sessionRoutes(services.sessions),
    ...projectRoutes(services.projects),
    ...workflowRoutes(services.workflows),
    ...(services.nodeGroups ? nodeGroupRoutes(services.nodeGroups) : []),
    ...(services.graphTabs ? graphTabRoutes(services.graphTabs) : []),
    ...(services.gen3d ? gen3dRoutes(services.gen3d) : []),
    ...(services.figcraft ? figcraftRoutes(services.figcraft, services.sessions) : []),
    ...(services.runs ? runRoutes(services.runs) : []),
    ...(services.groupTemplates ? groupTemplateRoutes(services.groupTemplates) : []),
    ...(services.flowAssistant ? flowAssistantRoutes(services.flowAssistant) : []),
    ...(services.taskAssistant ? taskAssistantRoutes(services.taskAssistant) : []),
    ...systemRoutes(services.system),
    ...assetRoutes(services),
    ...gitRoutes(services.git),
    ...messagingRoutes(services.messaging),
    ...taskRoutes(services.tasks),
    ...(services.account && services.issues ? teamRoutes(services.account, services.issues) : []),
  ].map(([method, pattern, run, options = {}]) => ({ method, parts: pattern.split("/"), run, ...options }));

  return async function handleApi(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    if (parts[0] === "stream" && req.method === "GET") return events.connect(req, res);
    for (const route of routes) {
      if (route.method !== req.method || route.parts.length !== parts.length) continue;
      const params = {};
      let matches = true;
      for (let i = 0; i < parts.length; i++) {
        const part = route.parts[i];
        if (part.startsWith(":")) params[part.slice(1)] = parts[i];
        else if (part !== parts[i]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const body = ["POST", "PUT"].includes(req.method) ? await readJson(req, { maxBytes: route.maxBodyBytes }) : {};
      const result = await route.run({ params, query: url.searchParams, body, req, res });
      if (res.writableEnded || res.headersSent) return;
      return send(res, 200, result);
    }
    throw new HttpError(404, "없는 API입니다.");
  };
}


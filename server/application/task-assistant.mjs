import { askOnce, selectOneShotAgent } from "../one-shot.mjs";
import { normalizeTaskDraft, parseTaskDraft, taskAssistantPrompt } from "../task-assistant.mjs";
import { projectGitflowSettings } from "../gitflow-settings.mjs";
import { HttpError } from "./errors.mjs";

export function createTaskAssistantService({ projects, graphTabs, cliPaths, config = {}, ask = askOnce }) {
  async function plan(body = {}) {
    const request = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!request || request.length > 4000) throw new HttpError(400, "요청을 1~4000자로 적어 주세요.");
    const project = projects.ensureProject(body.projectPath);
    const tabId = graphTabs?.resolve(project.path, body.tabId);
    const paths = cliPaths();
    const agent = selectOneShotAgent(paths, body.agent);
    if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 200 || /[\u0000-\u001f]/.test(body.model))) throw new HttpError(400, "모델 이름을 확인하세요.");
    let draft, history;
    try {
      draft = normalizeTaskDraft(body.draft ?? {}, { partial: true });
      if (body.history !== undefined && (!Array.isArray(body.history) || body.history.length > 12)) throw Error("대화는 최근 12개 메시지까지 보낼 수 있습니다.");
      history = (body.history ?? []).map((item) => {
        if (!["user", "assistant"].includes(item?.role) || typeof item.content !== "string" || item.content.length > 4000) throw Error("이전 대화의 형식을 확인하세요.");
        return { role: item.role, content: item.content };
      });
    } catch (error) { throw new HttpError(400, error.message, "task-assistant-input"); }
    const answer = await ask({ cliPaths: () => paths, agent, ...(body.model?.trim() ? { model: body.model.trim() } : {}),
      cwd: project.path, label: "작업 초안 만들기", prompt: taskAssistantPrompt({ request, draft, history, projectPath: project.path, settings: projectGitflowSettings(config, project.path) }) });
    try { return { ...parseTaskDraft(answer), projectPath: project.path, tabId, provider: { agent, model: body.model?.trim() || null } }; }
    catch (error) { throw new HttpError(422, error.message, "task-assistant-draft"); }
  }
  return { plan };
}

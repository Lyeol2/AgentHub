import { askOnce } from "../one-shot.mjs";
import { isCommandId } from "../commands.mjs";
import { assistantPrompt, graphOutline, normalizeActions, parseAssistantAnswer } from "../flow-assistant.mjs";
import { samePath } from "./projects.mjs";
import { HttpError } from "./errors.mjs";

const REQUEST_MAX = 4000;

// 세션 흐름 아래 입력창. plan은 AI에게 작업 목록을 받아 미리 보여 주고, apply는 사용자가 확인한 목록을 적용한다.
// 적용은 기존 세션·노드·연결 서비스를 거치므로 손으로 만들 때와 같은 검사를 받는다.
export function createFlowAssistantService({ store, commands, links, projects, sessions, commandService, workflowService, cliPaths, graphTabs, ask = askOnce, notify: broadcast }) {
  function graph(projectPath, requestedTabId) {
    const project = projects.ensureProject(projectPath);
    const tabId = graphTabs?.resolve(project.path, requestedTabId);
    const inTab = (item) => !graphTabs || graphTabs.tabFor(item) === tabId;
    return {
      project, tabId,
      sessions: store.list().filter((s) => !s.chat && samePath(s.projectPath, project.path) && inTab(s)),
      commands: commands.list(project.path).filter(inTab),
    };
  }

  async function plan({ projectPath, prompt, selected, tabId } = {}) {
    const request = String(prompt ?? "").trim();
    if (!request) throw new HttpError(400, "무엇을 할지 적어 주세요.");
    if (request.length > REQUEST_MAX) throw new HttpError(400, `요청은 ${REQUEST_MAX.toLocaleString("en-US")}자까지 적을 수 있습니다.`);
    const g = graph(projectPath, tabId);
    const outline = graphOutline({ ...g, links: links.list(), selected: Array.isArray(selected) ? selected.map(String) : [] });
    const text = await ask({ cliPaths, prompt: assistantPrompt({ request, outline, projectPath: g.project.path }), cwd: g.project.path, label: "흐름 도우미" });
    let raw;
    let actions;
    try {
      raw = parseAssistantAnswer(text);
      actions = normalizeActions(raw, g);
    } catch (error) { throw new HttpError(422, error.message, "assistant-plan"); }
    return { summary: String(raw.summary ?? "").trim().slice(0, 300), actions };
  }

  // 같은 두 노드가 이미 이어져 있으면 새로 잇지 않고 조건을 고친다.
  function link(from, to, fields) {
    try { return workflowService.createLink({ from, to, ...fields }); }
    catch (error) {
      const existing = error.status === 409 && links.list().find((item) => item.from === from && item.to === to);
      if (!existing) throw error;
      return workflowService.updateLink(existing.id, fields);
    }
  }

  async function apply({ projectPath, actions, tabId } = {}) {
    const g = graph(projectPath, tabId);
    let checked;
    // 미리 본 뒤 그래프가 바뀌었을 수 있으므로 다시 검사한다.
    try { checked = normalizeActions({ actions }, g); }
    catch (error) { throw new HttpError(400, error.message, "assistant-plan"); }
    for (const item of checked) if (item.type === "create_session") sessions.checkSessionOptions(item);
    const ids = new Map();
    const id = (value) => ids.get(value) ?? value;
    const done = [];
    const created = [];
    try {
      for (const item of checked) {
        if (item.type === "create_session") {
          const session = await sessions.createSession({ project: g.project, tabId: g.tabId, agent: item.agent, permission: item.permission,
            title: item.title, role: item.role, roleName: item.roleName });
          ids.set(item.key, session.id);
          created.push(session.id);
        } else if (item.type === "create_node") {
          const node = commandService.create({ ...item.fields, projectPath: g.project.path, tabId: g.tabId });
          ids.set(item.key, node.id);
          created.push(node.id);
        } else if (item.type === "set_role") {
          await sessions.update(id(item.target), { role: item.role, ...(item.roleName !== undefined ? { roleName: item.roleName } : {}) });
        } else if (item.type === "rename") {
          const target = id(item.target);
          if (isCommandId(target)) commandService.update(target, { title: item.title });
          else await sessions.update(target, { title: item.title });
        } else if (item.type === "link") {
          link(id(item.from), id(item.to), { when: item.when, keyword: item.keyword, note: item.note });
        } else if (item.type === "send") {
          sessions.sendMessage(id(item.to), { prompt: item.prompt });
        }
        done.push(item.text);
      }
    } catch (error) {
      throw new HttpError(error.status ?? 409, done.length ? `${done.length}개 작업을 적용한 뒤 멈췄습니다: ${error.message}` : error.message, "assistant-apply");
    } finally {
      broadcast("sessions", {});
      broadcast("commands", {});
      broadcast("links", {});
    }
    return { done, created };
  }

  return { plan, apply };
}

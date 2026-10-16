import path from "node:path";
import { askOnce } from "../one-shot.mjs";
import { newCommandId, checkCommand, commandKind, shells, generatePrompt, parseGenerated } from "../commands.mjs";
import { readMessageOutput } from "../utility-output.mjs";
import { listGitNodeBranches } from "../git-nodes.mjs";
import { HttpError } from "./errors.mjs";
import { FLOW_MEMBER_KINDS, inputValues, newHookToken } from "../flow-nodes.mjs";
import { HOOK_BODY_MAX, createHookRateLimit, findHookNode, hookVariables } from "../webhooks.mjs";

export function createCommandService({ commands, chain, links, store, projects, cliPaths, nodeGroups, ask = askOnce, notify: broadcast }) {
  const { ensureProject } = projects;
  const allowHook = createHookRateLimit();
  function getCommand(id) {
    const command = commands.get(id);
    if (!command) throw new HttpError(404, "명령 노드가 없습니다.");
    return command;
  }

  // 하고 싶은 일을 받아 Claude CLI(없으면 Codex)로 셸 명령을 만든다. 파일은 읽기만 하고, 기록은 남기지 않는다.
  async function generateCommand({ prompt, shell, projectPath }) {
    const text = await ask({ cliPaths, prompt: generatePrompt({ prompt, shell, projectPath }), cwd: projectPath, label: "명령 만들기" });
    try { return parseGenerated(text); }
    catch (error) { throw new HttpError(500, error.message); }
  }
  function list(projectPath) {
    return { shells: shells(), commands: projectPath ? commands.list(projectPath) : [], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  async function gitBranches(projectPath) {
    const project = ensureProject(projectPath);
    const sessions = store.list().filter((session) => session.projectPath && path.resolve(session.projectPath).toLowerCase() === path.resolve(project.path).toLowerCase());
    return listGitNodeBranches(project.path, { sessions, isSessionBusy: (session) => chain.busy?.(session) ?? session.state === "running" });
  }

  function savePos(command, pos) {
    if (pos === undefined) return;
    command.pos = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)
      ? { x: Math.max(0, Math.round(pos.x)), y: Math.max(0, Math.round(pos.y)) }
      : null;
  }

  async function generate(body) {
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) throw new HttpError(400, "어떤 명령이 필요한지 적으세요.");
    const project = ensureProject(body.projectPath);
    return generateCommand({ prompt: prompt.slice(0, 4000), shell: body.shell ?? shells()[0].id, projectPath: project.path });
  }

  // 결과 모으기에는 같은 프로젝트의 실행 노드와 세션(일반 채팅 제외)을 넣는다.
  function checkMembers(fields, projectPath, selfId = null) {
    if (fields.kind !== "group") return fields;
    for (const id of fields.members) {
      const session = store.get(id) ?? commands.get(id);
      if (!session) throw new HttpError(400, "결과를 모을 노드가 없습니다. 목록을 새로 고쳐 다시 고르세요.");
      if (id === selfId || (commands.get(id) && !FLOW_MEMBER_KINDS.includes(commandKind(session)))) throw new HttpError(400, "결과 모으기에는 세션, 명령, Git, 작업, 입력, 반복, 가공 노드만 넣을 수 있습니다.");
      if (session.chat || !session.projectPath || path.resolve(session.projectPath).toLowerCase() !== path.resolve(projectPath).toLowerCase()) {
        throw new HttpError(400, `"${session.title}"은 이 프로젝트의 노드가 아니라 결과를 모을 수 없습니다.`);
      }
    }
    return fields;
  }

  function create(body) {
    const project = ensureProject(body.projectPath);
    let fields;
    try { fields = checkCommand(body); }
    catch (error) { throw new HttpError(400, error.message); }
    checkMembers(fields, project.path);
    const command = {
      id: newCommandId(), projectPath: project.path, ...fields,
      state: "idle", lastRun: null, createdAt: new Date().toISOString(),
    };
    if (command.kind === "webhook-in") command.hookToken = newHookToken();
    if (command.kind === "schedule") Object.assign(command, { scheduleEnabled: false, nextRunAt: null });
    savePos(command, body.pos);
    commands.add(command);
    broadcast("commands", {});
    return command;
  }

  function update(id, body) {
    const command = getCommand(id);
    const editing = ["kind", "title", "prompt", "command", "shell", "cwdMode", "timeoutSec", "members", "gitAction", "branch", "targetBranch", "fields", "maxIterations", "delayMs", "transformMode", "expression", "template", "watchPaths", "debounceMs", "scheduleMode", "runAt", "timeOfDay", "intervalMinutes", "message", "notificationTitle", "level", "sound", "url", "method", "headers", "bodyType", "body", "enabled", "taskAction", "taskType", "titleTemplate", "version", "inPlace", "commitMessage", "description", "verification"].some((key) => body[key] !== undefined);
    if (editing && ["git", "task", "input", "repeat", "transform", "watch", "schedule", "notify", "webhook", "group"].includes(commandKind(command)) && (chain.runs.has(id) || ["running", "watching", "scheduled"].includes(command.state))) throw new HttpError(409, "실행 중인 노드는 편집할 수 없습니다. 중지한 뒤 다시 편집하세요.");
    let fields = null;
    try {
      if (editing) fields = checkCommand(body, command);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    if (fields) Object.assign(command, checkMembers(fields, command.projectPath, id));
    // 받는 주소가 새어 나갔으면 새 주소로 바꾼다. 이전 주소로 온 요청은 받지 않는다.
    if (commandKind(command) === "webhook-in" && (body.regenerateToken === true || !command.hookToken)) command.hookToken = newHookToken();
    savePos(command, body.pos);
    commands.update(command, {});
    broadcast("commands", {});
    return command;
  }

  function remove(id) {
    const command = getCommand(id);
    chain.stopCommand(command);
    commands.remove(id);
    for (const group of commands.list()) {
      if (commandKind(group) !== "group" || !group.members?.includes(id)) continue;
      commands.update(group, { members: group.members.filter((memberId) => memberId !== id) });
    }
    nodeGroups?.()?.pruneNode(id);
    links.removeForSession(id);
    broadcast("commands", {});
    broadcast("links", {});
    return { ok: true };
  }

  async function run(id, body = {}) {
    const command = getCommand(id);
    if (commandKind(command) === "markdown") throw new HttpError(400, "MD 출력 노드는 연결된 세션의 완료 메시지를 받아 실행합니다.");
    if (commandKind(command) === "group") {
      const result = await chain.fireGroup(command);
      if (result.busy.length) throw new HttpError(409, `아직 진행 중인 세션이 있어 넘길 수 없습니다: ${result.busy.map((s) => s.title).join(", ")}`);
      return command;
    }
    if (chain.runs.has(id)) throw new HttpError(409, "이미 실행 중입니다.");
    if (commandKind(command) === "input") {
      try { inputValues(command, body.values); }
      catch (error) { throw new HttpError(400, error.message); }
    }
    const origin = links.list().filter((link) => link.to === id).map((link) => store.get(link.from)).find(Boolean) ?? null;
    const pending = chain.runCommand(command, { origin, depth: 0, values: body.values });
    if (["button", "input", "repeat", "transform", "watch", "schedule", "notify", "webhook", "webhook-in"].includes(commandKind(command))) {
      try { await pending; }
      catch (error) { throw new HttpError(400, error.message); }
    }
    return command;
  }

  function output(id) {
    const command = getCommand(id);
    if (commandKind(command) !== "markdown") throw new HttpError(400, "MD 출력 노드에서만 완료 메시지를 볼 수 있습니다.");
    try { return readMessageOutput(command); }
    catch (error) {
      throw new HttpError(["OUTPUT_NOT_FOUND", "ENOENT"].includes(error.code) ? 404 : 400, error.message);
    }
  }

  function stop(id) {
    return { stopped: chain.stopCommand(getCommand(id)) };
  }

  // 바깥에서 웹훅 받기 주소로 보낸 요청. 꺼져 있거나 없는 주소는 같은 404로 답해 주소가 있는지 드러내지 않는다.
  function receiveHook(token, request) {
    const command = findHookNode(commands.list(), token);
    if (!command || command.enabled === false) throw new HttpError(404, "웹훅 주소가 없습니다.");
    if (String(request.body ?? "").length > HOOK_BODY_MAX) throw new HttpError(413, "요청이 너무 큽니다.");
    if (!allowHook(command.id)) throw new HttpError(429, "요청이 너무 잦습니다. 잠시 후 다시 보내세요.");
    let flow;
    try { flow = chain.workflow.trigger(command, hookVariables(request)); }
    catch (error) { throw new HttpError(400, error.message); }
    return { ok: true, node: command.title, runId: flow.id };
  }

  return { list, gitBranches, generate, create, update, remove, run, stop, output, receiveHook };
}

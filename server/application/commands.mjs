import path from "node:path";
import { askOnce } from "../one-shot.mjs";
import { newCommandId, checkCommand, commandKind, shells, generatePrompt, parseGenerated } from "../commands.mjs";
import { readMessageOutput } from "../utility-output.mjs";
import { listGitNodeBranches } from "../git-nodes.mjs";
import { HttpError } from "./errors.mjs";
import { FLOW_MEMBER_KINDS, inputValues, newHookToken } from "../flow-nodes.mjs";
import { HOOK_BODY_MAX, createHookRateLimit, findHookNode, hookVariables } from "../webhooks.mjs";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { GEN3D_STEPS, GEN3D_PROVIDERS, modelText } from "../gen3d.mjs";

export function createCommandService({ commands, chain, links, store, projects, cliPaths, nodeGroups, graphTabs, ask = askOnce, notify: broadcast }) {
  const { ensureProject } = projects;
  const allowHook = createHookRateLimit();
  const view = (command) => graphTabs ? { ...command, tabId: graphTabs.tabFor(command) } : command;
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
    return { shells: shells(), commands: projectPath ? commands.list(projectPath).map(view) : [], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
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
    const tabId = graphTabs?.resolve(project.path, body.tabId, body.connectFrom ?? body.createdBy);
    let fields;
    try { fields = checkCommand(body); }
    catch (error) { throw new HttpError(400, error.message); }
    checkMembers(fields, project.path);
    const command = {
      id: newCommandId(), projectPath: project.path, ...fields,
      ...(tabId ? { tabId } : {}),
      state: "idle", lastRun: null, createdAt: new Date().toISOString(),
    };
    if (command.kind === "webhook-in") command.hookToken = newHookToken();
    if (command.kind === "schedule") Object.assign(command, { scheduleEnabled: false, nextRunAt: null });
    savePos(command, body.pos);
    commands.add(command);
    broadcast("commands", {});
    return view(command);
  }

  function update(id, body) {
    const command = getCommand(id);
    if (body.tabId !== undefined && graphTabs) {
      const targetId = graphTabs.resolve(command.projectPath, body.tabId);
      if (targetId !== graphTabs.tabFor(command)) throw new HttpError(400, "노드는 탭 이동 메뉴로 옮기세요.");
    }
    const editing = ["kind", "title", "prompt", "command", "shell", "cwdMode", "timeoutSec", "members", "gitAction", "branch", "targetBranch", "fields", "maxIterations", "delayMs", "transformMode", "expression", "template", "watchPaths", "debounceMs", "scheduleMode", "runAt", "timeOfDay", "intervalMinutes", "message", "notificationTitle", "level", "sound", "url", "method", "headers", "bodyType", "body", "enabled", "taskAction", "taskType", "titleTemplate", "version", "inPlace", "commitMessage", "description", "verification", "finishMode", "pushTarget", "provider", "steps", "preset", "inputMode", "imagePath", "options", "outputDir", "pollSec", "timeoutMin"].some((key) => body[key] !== undefined);
    if (editing && ["git", "task", "input", "repeat", "transform", "watch", "schedule", "notify", "webhook", "gen3d", "group"].includes(commandKind(command)) && (chain.runs.has(id) || ["running", "watching", "scheduled"].includes(command.state))) throw new HttpError(409, "실행 중인 노드는 편집할 수 없습니다. 중지한 뒤 다시 편집하세요.");
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
    return view(command);
  }

  function remove(id) {
    const command = getCommand(id);
    chain.stopCommand(command);
    commands.remove(id);
    chain.workflow?.forgetNode?.(id);
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
      return view(command);
    }
    if (chain.runs.has(id)) throw new HttpError(409, "이미 실행 중입니다.");
    if (commandKind(command) === "input") {
      try { inputValues(command, body.values); }
      catch (error) { throw new HttpError(400, error.message); }
    }
    const origin = links.list().filter((link) => link.to === id).map((link) => store.get(link.from)).find(Boolean) ?? null;
    const pending = chain.runCommand(command, { origin, depth: 0, values: body.values, resume: body.resume === true });
    if (["button", "input", "repeat", "transform", "watch", "schedule", "notify", "webhook", "webhook-in"].includes(commandKind(command))) {
      try { await pending; }
      catch (error) { throw new HttpError(400, error.message); }
    }
    return view(command);
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

  // 실패한 노드의 오류 표시만 지운다. 마지막 실행 기록은 남기고 해제했다고 표시한다.
  function clearError(id) {
    const command = getCommand(id);
    if (chain.runs.has(id)) throw new HttpError(409, "실행 중인 노드는 오류를 해제할 수 없습니다.");
    if (command.state !== "error") throw new HttpError(409, "오류 상태인 노드가 아닙니다.");
    if (command.lastRun?.gitResult?.recoveryRequired) throw new HttpError(409, "Git 작업이 중간에 멈춰 복구가 필요합니다. 저장소 상태를 확인하고 다시 실행하세요.");
    commands.update(command, { state: command.scheduleEnabled ? "scheduled" : "idle",
      lastRun: command.lastRun ? { ...command.lastRun, cleared: true, clearedAt: new Date().toISOString() } : command.lastRun });
    broadcast("commands", {});
    return view(command);
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

  // ── 3D 생성 노드 ──────────────────────────────────────────────
  function gen3dNode(id) {
    const command = getCommand(id);
    if (commandKind(command) !== "gen3d") throw new HttpError(400, "3D 생성 노드가 아닙니다.");
    return command;
  }

  // 결과 기록의 파일(썸네일·모델). 이 노드가 실행 기록에 남긴 출력 폴더 안의 파일만 연다.
  const GEN3D_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".fbx": "application/octet-stream", ".obj": "text/plain", ".usdz": "model/vnd.usdz+zip", ".mp4": "video/mp4" };
  function gen3dFile(id, file) {
    const command = gen3dNode(id);
    const target = path.resolve(String(file ?? ""));
    const inside = (root) => { const rel = path.relative(root, target); return rel && !rel.startsWith("..") && !path.isAbsolute(rel); };
    if (!(command.history ?? []).some((run) => typeof run.outputDir === "string" && inside(path.resolve(run.outputDir)))) throw new HttpError(403, "이 노드의 결과 파일만 열 수 있습니다.");
    let real;
    try { real = fs.realpathSync(target); } catch { throw new HttpError(404, "결과 파일이 없습니다. 옮겨졌거나 지워졌을 수 있습니다."); }
    if (!fs.statSync(real).isFile()) throw new HttpError(404, "결과 파일이 없습니다.");
    return { realPath: real, name: path.basename(real), mimeType: GEN3D_MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream" };
  }

  // 기록의 한 실행 결과를 다시 만들지 않고 다음 노드로 넘긴다(예전 시안 중 마음에 드는 것만 골라 이어 하기).
  async function gen3dForward(id, body = {}) {
    const command = gen3dNode(id);
    const run = (command.history ?? []).find((item) => item.runId === body.runId);
    if (!run?.model) throw new HttpError(404, "넘길 결과가 없습니다. 성공한 실행만 넘길 수 있습니다.");
    if (!links.list().some((link) => link.from === id && link.enabled)) throw new HttpError(400, "이 노드에서 나가는 연결이 없습니다.");
    await chain.workflow.forward(command, modelText(run.model));
    return { ok: true };
  }

  // 통합 노드를 같은 설정의 단계 노드들로 펼친다. 들어오던 연결은 첫 단계로, 나가던 연결은 마지막 단계로 옮긴다.
  function gen3dExpand(id) {
    const command = gen3dNode(id);
    if (command.steps.length < 2) throw new HttpError(400, "단계가 하나인 노드는 펼칠 것이 없습니다.");
    if (chain.runs.has(id) || command.state === "running") throw new HttpError(409, "실행 중인 노드는 펼칠 수 없습니다. 중지한 뒤 다시 시도하세요.");
    const tabId = graphTabs?.tabFor(command);
    const at = command.pos ?? { x: 40, y: 40 };
    const label = GEN3D_PROVIDERS[command.provider].label;
    const created = command.steps.map((step, index) => create({
      kind: "gen3d", projectPath: command.projectPath, ...(tabId ? { tabId } : {}),
      title: `${label} · ${GEN3D_STEPS[step]}`, provider: command.provider, steps: [step],
      prompt: index === 0 ? command.prompt : "{{input}}", inputMode: command.inputMode, imagePath: command.imagePath,
      // 질감 단계가 따로 떨어져도 원래 요청 글을 질감 설명으로 쓴다.
      options: { ...command.options, ...(step === "texture" && !command.options?.texturePrompt ? { texturePrompt: command.prompt === "{{input}}" ? "" : command.prompt } : {}) },
      outputDir: command.outputDir, pollSec: command.pollSec, timeoutMin: command.timeoutMin,
      pos: { x: at.x + index * 280, y: at.y },
    }));
    for (const link of links.list()) {
      if (link.to === id) links.update(link, { to: created[0].id });
      if (link.from === id) links.update(link, { from: created.at(-1).id });
    }
    for (let i = 1; i < created.length; i++) links.add({ id: randomBytes(4).toString("hex"), from: created[i - 1].id, to: created[i].id, when: "success", keyword: "", enabled: true });
    chain.stopCommand(command);
    commands.remove(id);
    broadcast("commands", {});
    broadcast("links", {});
    return { nodes: created };
  }

  return { list, gitBranches, generate, create, update, remove, run, stop, clearError, output, receiveHook, gen3dFile, gen3dForward, gen3dExpand };
}

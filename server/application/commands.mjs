import path from "node:path";
import { spawnCli } from "../cli.mjs";
import { newCommandId, checkCommand, commandKind, shells, generatePrompt, parseGenerated } from "../commands.mjs";
import { readMessageOutput } from "../utility-output.mjs";
import { HttpError } from "./errors.mjs";

export function createCommandService({ commands, chain, links, store, projects, cliPaths, notify: broadcast }) {
  const { ensureProject } = projects;
  function getCommand(id) {
    const command = commands.get(id);
    if (!command) throw new HttpError(404, "명령 노드가 없습니다.");
    return command;
  }

  // 하고 싶은 일을 받아 Claude CLI(없으면 Codex)로 셸 명령을 만든다. 파일은 읽기만 하고, 기록은 남기지 않는다.
  function generateCommand({ prompt, shell, projectPath }) {
    const paths = cliPaths();
    const agent = paths.claude ? "claude" : paths.codex ? "codex" : null;
    if (!agent) throw new HttpError(400, "명령을 만들 Claude나 Codex CLI를 찾지 못했습니다.");
    const args = agent === "claude"
      ? ["-p", "--output-format", "json", "--model", "haiku", "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
        "--permission-mode", "default", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
      : ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", projectPath, "-"];
    return new Promise((resolve, reject) => {
      const child = spawnCli(paths[agent], args, { cwd: projectPath, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on("error", (e) => reject(new HttpError(500, `명령 만들기 실패: ${e.message}`)));
      child.on("close", () => {
        clearTimeout(timer);
        try {
          // Claude: { result }, Codex: 줄마다 이벤트(마지막 agent_message)
          const text = agent === "claude"
            ? JSON.parse(out).result ?? ""
            : out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
              .filter((m) => m?.item?.type === "agent_message").map((m) => m.item.text).at(-1) ?? "";
          resolve(parseGenerated(text));
        } catch (e) {
          reject(new HttpError(500, e instanceof SyntaxError ? `명령 만들기 실패: ${err.trim().slice(-300) || "CLI 응답을 읽지 못했습니다."}` : e.message));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(generatePrompt({ prompt, shell, projectPath }));
    });
  }
  function list(projectPath) {
    return { shells: shells(), commands: projectPath ? commands.list(projectPath) : [] };
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

  // 세션 묶음에는 같은 프로젝트의 세션(일반 채팅 제외)만 넣는다.
  function checkMembers(fields, projectPath) {
    if (fields.kind !== "group") return fields;
    for (const id of fields.members) {
      const session = store.get(id);
      if (!session) throw new HttpError(400, "묶으려는 세션이 없습니다. 목록을 새로 고쳐 다시 고르세요.");
      if (session.chat || !session.projectPath || path.resolve(session.projectPath).toLowerCase() !== path.resolve(projectPath).toLowerCase()) {
        throw new HttpError(400, `"${session.title}"은 이 프로젝트의 세션이 아니라 묶을 수 없습니다.`);
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
    savePos(command, body.pos);
    commands.add(command);
    broadcast("commands", {});
    return command;
  }

  function update(id, body) {
    const command = getCommand(id);
    const editing = ["kind", "title", "prompt", "command", "shell", "cwdMode", "timeoutSec", "members"].some((key) => body[key] !== undefined);
    let fields = null;
    try {
      if (editing) fields = checkCommand(body, command);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    if (fields) Object.assign(command, checkMembers(fields, command.projectPath));
    savePos(command, body.pos);
    commands.update(command, {});
    broadcast("commands", {});
    return command;
  }

  function remove(id) {
    const command = getCommand(id);
    chain.stopCommand(command);
    commands.remove(id);
    links.removeForSession(id);
    broadcast("commands", {});
    broadcast("links", {});
    return { ok: true };
  }

  async function run(id) {
    const command = getCommand(id);
    if (commandKind(command) === "markdown") throw new HttpError(400, "MD 출력 노드는 연결된 세션의 완료 메시지를 받아 실행합니다.");
    if (commandKind(command) === "group") {
      const result = await chain.fireGroup(command);
      if (result.busy.length) throw new HttpError(409, `아직 진행 중인 세션이 있어 넘길 수 없습니다: ${result.busy.map((s) => s.title).join(", ")}`);
      return command;
    }
    if (chain.runs.has(id)) throw new HttpError(409, "이미 실행 중입니다.");
    const origin = links.list().filter((link) => link.to === id).map((link) => store.get(link.from)).find(Boolean) ?? null;
    const pending = chain.runCommand(command, { origin, depth: 0 });
    if (commandKind(command) === "button") await pending;
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

  return { list, generate, create, update, remove, run, stop, output };
}

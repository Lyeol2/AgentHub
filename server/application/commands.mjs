import { spawnCli } from "../cli.mjs";
import { newCommandId, checkCommand, shells, generatePrompt, parseGenerated } from "../commands.mjs";
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

  function create(body) {
    const project = ensureProject(body.projectPath);
    let fields;
    try { fields = checkCommand(body); }
    catch (error) { throw new HttpError(400, error.message); }
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
    const editing = ["title", "command", "shell", "cwdMode", "timeoutSec"].some((key) => body[key] !== undefined);
    try {
      if (editing) Object.assign(command, checkCommand(body, command));
    } catch (error) {
      throw new HttpError(400, error.message);
    }
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

  function run(id) {
    const command = getCommand(id);
    if (chain.runs.has(id)) throw new HttpError(409, "이미 실행 중입니다.");
    const origin = links.list().filter((link) => link.to === id).map((link) => store.get(link.from)).find(Boolean) ?? null;
    chain.runCommand(command, { origin, depth: 0 });
    return command;
  }

  function stop(id) {
    return { stopped: chain.stopCommand(getCommand(id)) };
  }

  return { list, generate, create, update, remove, run, stop };
}

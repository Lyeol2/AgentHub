import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT, CHAT_DIR, DATA_DIR, loadConfig, saveConfig } from "./config.mjs";
import { locateCli, cliVersion, cliAuth, openLogin, spawnCli } from "./cli.mjs";
import { SessionStore, summary, useProjectFolder } from "./store.mjs";
import { Runner, AGENTS } from "./runner.mjs";
import { isGitRepo, removeWorktree, headCommit, diffSince, changedFiles } from "./git.mjs";
import { AGENT_NAME, handoverText, mapPermission } from "./handover.mjs";
import { gitOverview, fileDiff, showCommit, branchDiff, stage, unstage, commit, merge } from "./gitpanel.mjs";
import { discoverProjects, discoverSessions, loadHistory, deleteSessionRecords } from "./discover.mjs";
import { readLimits, recordClaudeLimit, refreshClaudeUsage } from "./limits.mjs";
import { ROLE_MAX, withRole } from "./role.mjs";
import { LinkStore } from "./links.mjs";
import { Chain, CONDITIONS, CONDITION_LABELS, lastAnswer } from "./chain.mjs";
import { orchestratorInput, extractPlan, normalizePlan } from "./orchestrator.mjs";
import { HUB_FILE, HUB_TEMPLATE, hubFilePath, readHubFile } from "./hubfile.mjs";
import { QUESTION_GUIDE, extractQuestions, answerPrompt, hasAnswer } from "./question.mjs";
import { listSkills, checkSkill, writeSkill, deleteSkill, moveSkill, withSkills, SCOPES } from "./skills.mjs";
import { Setup, TOOLS } from "./setup.mjs";
import { CommandStore, isCommandId, newCommandId, checkCommand, shells, generatePrompt, parseGenerated } from "./commands.mjs";
import { Mailbox, MESSAGE_GUIDE, ASK_TIMEOUT_SEC, ASK_TIMEOUT_MAX, extractMessages, readBoard, postBoard, writeBoard, clearBoard } from "./messages.mjs";
import { McpTokens, handleRpc } from "./mcp.mjs";

const config = loadConfig();
const port = Number(process.env.PORT ?? config.port);
const store = new SessionStore();
const runner = new Runner(store);
const links = new LinkStore();
const PUBLIC_DIR = path.join(ROOT, "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const MODEL_PATTERN = /^[\w.\-:[\]]{1,64}$/;

function checkModel(model) {
  model = String(model ?? "").trim();
  if (model && !MODEL_PATTERN.test(model)) throw new HttpError(400, "모델 이름 형식이 올바르지 않습니다.");
  return model;
}

function checkEffort(agent, effort) {
  effort = String(effort ?? "").trim();
  if (effort && !AGENTS[agent].efforts().includes(effort)) throw new HttpError(400, "추론 강도가 올바르지 않습니다.");
  return effort;
}

function agentStatus(agent, cliPath, version) {
  const a = AGENTS[agent];
  // autoPath: 직접 지정한 경로와 상관없이 자동으로 찾은 경로(설정 화면에 읽기 전용으로 보여 준다)
  // defaultModel: 모델을 고르지 않았을 때 실제로 쓸 모델(Codex는 설정의 기본 모델을 쓸 수 없으면 바꿔 실행한다)
  return { path: cliPath, autoPath: locateCli(agent, ""), version, permissions: a.PERMISSION_MODES, models: a.models(), efforts: a.efforts(), defaultModel: a.defaultModel?.() ?? null };
}

const cliPaths = () => ({
  claude: locateCli("claude", config.cli.claude),
  codex: locateCli("codex", config.cli.codex),
});
const setup = new Setup({ cliPath: (tool) => (tool === "gh" ? locateCli("gh", "") : cliPaths()[tool]) });
const commands = new CommandStore();
const chain = new Chain({
  store, runner, links, cliPaths, compose: composeInput, commands,
  notify: (kind, sessionId) => {
    if (kind === "links") broadcast("links", {});
    else if (kind === "commands") broadcast("commands", {});
    else broadcast("queue", { sessionId });
  },
});

// ── 세션 사이 메시지(MCP 도구·메시지 블록)와 공유 노트 ───────────────
const mailbox = new Mailbox({
  store, runner, chain,
  sessions: (projectPath) => projectSessions(projectPath),
  notify: (kind, data) => broadcast(kind, data),
});
const mcpTokens = new McpTokens();
const MCP_DIR = path.join(DATA_DIR, "mcp");

// CLI를 실행할 때마다 이 세션의 MCP 주소를 붙인다. Claude는 설정 파일로, Codex는 설정 덮어쓰기로 받는다.
runner.mcp = (session) => {
  const url = `http://127.0.0.1:${port}/mcp/${mcpTokens.token(session.id)}`;
  const configFile = path.join(MCP_DIR, `${session.id}.json`);
  fs.mkdirSync(MCP_DIR, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { agenthub: { type: "http", url } } }, null, 2));
  return { url, configFile };
};

const VIA_TEXT = {
  answer: "보냈다. 상대가 이 답을 기다리던 중이라 바로 받았다.",
  live: "보냈다. 상대가 작업 중이라 지금 하는 작업에 바로 들어갔다.",
  queue: "보냈다. 상대가 쉬고 있으면 바로 시작하고, 실행 중이면 지금 작업이 끝난 뒤 받는다.",
};

const MCP_TOOLS = [
  {
    name: "list_sessions",
    description: "같은 프로젝트의 다른 AgentHub 세션(이름, id, 에이전트, 역할, 상태)을 본다. 메시지를 보낼 상대를 찾을 때 쓴다.",
    inputSchema: { type: "object", properties: {} },
    run: (session) => mailbox.directory(session),
  },
  {
    name: "send_message",
    description: "다른 세션에 메시지를 보낸다. 답을 기다리지 않는다. 받은 메시지에 답할 때도 이것으로 보낸 세션에게 보낸다.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "받는 세션의 이름, 역할 이름, 또는 id" },
        text: { type: "string", description: "보낼 내용" },
      },
      required: ["to", "text"],
    },
    run: (session, { to, text }) => {
      const { target, via } = mailbox.send(session, to, text);
      return `"${target.title}"에게 ${VIA_TEXT[via]}`;
    },
  },
  {
    name: "ask_session",
    description: `다른 세션에 묻고 답이 올 때까지 기다린다(기본 ${ASK_TIMEOUT_SEC}초, 최대 ${ASK_TIMEOUT_MAX}초). 답 없이는 진행할 수 없을 때만 쓴다.`,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "받는 세션의 이름, 역할 이름, 또는 id" },
        question: { type: "string", description: "물을 내용" },
        timeoutSec: { type: "number", description: "기다릴 최대 시간(초)" },
      },
      required: ["to", "question"],
    },
    run: async (session, { to, question, timeoutSec }) => {
      const { target, answer } = await mailbox.ask(session, to, question, timeoutSec);
      return answer ?? `"${target.title}"에게서 제한 시간 안에 답이 오지 않았다. 늦게 온 답은 다음 요청으로 받는다. 기다리지 말고 할 수 있는 일을 계속한다.`;
    },
  },
  {
    name: "check_messages",
    description: "작업 중에 나에게 와서 아직 읽지 않은 메시지를 확인한다. 읽은 메시지는 다음 요청으로 다시 오지 않는다.",
    inputSchema: { type: "object", properties: {} },
    run: (session) => mailbox.inbox(session).join("\n\n---\n\n") || "새 메시지가 없다.",
  },
  {
    name: "board_read",
    description: "프로젝트 공유 노트를 읽는다. 다른 세션이 남긴 약속·결정·진행 상황이 있다.",
    inputSchema: { type: "object", properties: {} },
    run: (session) => readBoard(session.projectPath) || "공유 노트가 비어 있다.",
  },
  {
    name: "board_post",
    description: "프로젝트 공유 노트에 글을 덧붙인다. API 약속, 정한 사항, 진행 상황처럼 다른 세션도 알아야 할 것을 짧게 남긴다.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "남길 내용(마크다운)" } },
      required: ["text"],
    },
    run: (session, { text }) => {
      postBoard(session.projectPath, session.title, text);
      broadcast("board", { projectPath: session.projectPath });
      return "공유 노트에 남겼다.";
    },
  },
];

// POST /mcp/<토큰>: 에이전트 CLI가 부르는 MCP 요청
async function handleMcp(req, res, token) {
  const sessionId = mcpTokens.session(token);
  const session = sessionId && store.get(sessionId);
  if (!session) return send(res, 404, { error: "알 수 없는 MCP 주소입니다." });
  if (req.method === "DELETE") return send(res, 200, {});
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST, DELETE" }).end();
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const reply = await handleRpc(body, session, MCP_TOOLS, { name: "agenthub", version: VERSION, instructions: MESSAGE_GUIDE });
  if (!reply) {
    res.writeHead(202).end();
    return;
  }
  send(res, 200, reply);
}

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

// ── 보안: 로컬 전용 ─────────────────────────────────────────────
// 127.0.0.1에만 열고, Host 헤더와 사용자 정의 헤더를 확인해 다른 사이트의 요청(DNS 리바인딩, CSRF)을 막는다.
function isTrustedRequest(req) {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host)) return false;
  // 에이전트 CLI의 MCP 요청은 X-AgentHub 헤더 대신 주소의 비밀 토큰으로 확인한다. 브라우저에서 온 요청(Origin)은 받지 않는다.
  if (req.url.startsWith("/mcp/")) return !req.headers.origin;
  if (req.method !== "GET" && req.headers["x-agenthub"] !== "1") return false;
  return true;
}

// ── 공통 응답 ───────────────────────────────────────────────────
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// reason: 화면이 실패 종류에 따라 다음 선택지를 물을 수 있게 붙이는 구분 값
class HttpError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new HttpError(413, "요청이 너무 큽니다.");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "JSON 형식이 아닙니다.");
  }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": `${MIME[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
  fs.createReadStream(file).pipe(res);
}

// ── 실시간 이벤트(SSE) ──────────────────────────────────────────
const streams = new Set();
function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(payload);
}
runner.on("event", (sessionId, event) => {
  broadcast("event", { sessionId, event });
  // 질문·권한 요청이 오면 목록의 "답을 기다림" 표시도 바로 바꾼다.
  if (event.status === "pending" && (event.kind === "question" || event.kind === "permission")) broadcast("sessions", {});
});
runner.on("state", (sessionId, state) => broadcast("state", { sessionId, state }));
// 설치·로그인이 진행되면 화면에 알리고, 끝나면 CLI 상태도 다시 받게 한다.
setup.on("change", (jobs) => broadcast("setup", jobs));
setup.on("finished", () => broadcast("cli", {}));
// 턴이 끝나면 목록의 세션 수명(압축 횟수, 컨텍스트 크기)도 새로 받게 한다.
runner.on("turnEnd", () => broadcast("sessions", {}));
// 데스크톱 앱(Electron)이 업데이트 기능을 넘겨준다. 브라우저로 쓸 때는 없다.
let updater = null;
export function setUpdater(next) {
  updater = next;
  updater.on("state", (state) => broadcast("update", state));
}

runner.on("limit", (agent, info) => {
  if (agent === "claude") recordClaudeLimit(info);
  broadcast("limits", {});
});
setInterval(() => broadcast("ping", {}), 25000).unref();

// ── API ─────────────────────────────────────────────────────────
function getSession(id) {
  const session = store.get(id);
  if (!session) throw new HttpError(404, "세션이 없습니다.");
  return session;
}

// 실행 중으로 남아 있는데 실제로 도는 CLI가 없으면(중간에 실행이 끊긴 경우) 중단된 것으로 고친다.
// 그대로 두면 화면에서 중지·삭제 버튼이 막혀 지울 수 없는 세션이 된다.
function settleState(session) {
  if (session.state === "running" && !runner.isRunning(session.id)) runner.setState(session, "interrupted");
  return session;
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function getLink(id) {
  const link = links.get(id);
  if (!link) throw new HttpError(404, "연결이 없습니다.");
  return link;
}

// 연결 조건 입력을 검사해 저장할 값만 돌려준다.
function linkFields(body, current = {}) {
  const when = body.when ?? current.when ?? "success";
  if (!CONDITIONS.includes(when)) throw new HttpError(400, "연결 조건이 올바르지 않습니다.");
  // 키워드 조건이 아니면 키워드를 남겨 두지 않는다.
  const keyword = when === "keyword" ? String(body.keyword ?? current.keyword ?? "").trim().slice(0, 100) : "";
  if (when === "keyword" && !keyword) throw new HttpError(400, "키워드를 입력하세요. 여러 개는 쉼표로 나눕니다.");
  return {
    when,
    keyword,
    note: String(body.note ?? current.note ?? "").trim().slice(0, ROLE_MAX),
    enabled: !!(body.enabled ?? current.enabled ?? true),
    approve: !!(body.approve ?? current.approve ?? false), // 넘기기 전에 연결선 위에서 승인을 받는다
    ...(body.approve === false ? { pending: null } : {}), // 승인을 끄면 기다리던 것도 거둔다
  };
}

// Git 패널이 다룰 저장소. 폴더가 있고 git 저장소여야 한다.
async function gitRepo(projectPath) {
  if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
  const dir = path.resolve(String(projectPath));
  if (!fs.existsSync(dir)) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
  if (!(await isGitRepo(dir))) throw new HttpError(400, "git 저장소가 아닙니다.", "not-git");
  return dir;
}

// 세션의 분리한 작업 폴더. 이 프로젝트의 세션이어야 한다.
function sessionWorktree(sessionId, repo) {
  const session = getSession(sessionId);
  if (!samePath(session.projectPath, repo)) throw new HttpError(400, "이 프로젝트의 세션이 아닙니다.");
  if (!session.worktree || !fs.existsSync(session.worktree.dir)) throw new HttpError(400, "작업 폴더를 분리한 세션이 아닙니다.");
  return session.worktree.dir;
}

// 제거해서 숨긴 프로젝트를 다시 보이게 한다(저장은 부르는 쪽에서).
function unhideProject(dir) {
  config.hiddenProjects = config.hiddenProjects.filter((p) => !samePath(p, dir));
}

// 등록된 프로젝트를 찾고, 없으면(자동 감지된 프로젝트) 그 자리에서 등록한다.
function ensureProject(projectPath) {
  if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
  const existing = config.projects.find((p) => samePath(p.path, projectPath));
  if (existing) return existing;
  const dir = path.resolve(projectPath);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
  const project = { name: path.basename(dir), path: dir };
  config.projects.push(project);
  unhideProject(dir); // 제거했던 프로젝트에서 다시 세션을 만들면 다시 보인다.
  saveConfig(config);
  return project;
}

const projectSessions = (projectPath) => store.list().filter((s) => samePath(s.projectPath, projectPath));

// 지운 세션에 딸린 것(연결, 대기열, 메시지, MCP 토큰)을 정리한다.
// 지운 세션의 Claude Code·Codex 기록이 프로젝트 화면에 "가져오기"로 다시 뜨지 않게 숨기고, deleteRecords면 기록 파일까지 지운다.
function cleanupSession(session, { deleteRecords = false } = {}) {
  links.removeForSession(session.id);
  chain.queue.delete(session.id);
  mailbox.removeForSession(session.id);
  mcpTokens.forget(session.id);
  fs.rmSync(path.join(MCP_DIR, `${session.id}.json`), { force: true });
  let records = { deleted: 0, errors: [] };
  if (!session.chat) {
    const ids = cliSessionIds(session);
    if (deleteRecords) records = deleteSessionRecords(ids);
    hideRecords(ids);
  }
  return records;
}

// 프로젝트를 AgentHub에서 뺀다. 프로젝트 폴더·파일·AGENTHUB.md·CLI 기록 파일은 건드리지 않는다.
// 이 프로젝트의 AgentHub 세션·명령 노드·연결·공유 노트·메시지 기록은 지우고, 자동 감지로 다시 뜨지 않게 숨긴다.
// removeWorktrees: 세션마다 분리한 작업 폴더도 지운다(커밋하지 않은 변경이 있으면 남기고 알린다).
async function removeProject(projectPath, { force = false, removeWorktrees = false } = {}) {
  const dir = path.resolve(projectPath);
  const sessions = projectSessions(dir).filter((s) => !s.chat);
  const running = sessions.filter((s) => runner.isRunning(s.id));
  if (running.length && !force) {
    throw new HttpError(409, `실행 중인 세션이 ${running.length}개 있습니다: ${running.map((s) => s.title).join(", ")}`, "running");
  }
  const worktreeErrors = [];
  for (const s of sessions) {
    if (runner.isRunning(s.id)) runner.stop(s);
    if (removeWorktrees && s.worktree) {
      try {
        await removeWorktree(s.projectPath, s.worktree.dir);
      } catch (err) {
        worktreeErrors.push(`${s.title}: ${err.message}`);
      }
    }
    store.remove(s.id);
    cleanupSession(s);
  }
  const cmds = commands.list(dir);
  for (const c of cmds) {
    chain.stopCommand(c);
    commands.remove(c.id);
    links.removeForSession(c.id);
  }
  clearBoard(dir);
  delete config.skillLayout?.[dir.toLowerCase()];
  config.projects = config.projects.filter((p) => !samePath(p.path, dir));
  if (!config.hiddenProjects.some((p) => samePath(p, dir))) config.hiddenProjects.push(dir);
  saveConfig(config);
  return { sessions: sessions.length, commands: cmds.length, worktreeErrors };
}

// 이 세션이 쓴 Claude Code·Codex 대화 ID 전부(다시 시작하기 전 것 포함)
const cliSessionIds = (session) => [...new Set([...(session.cliSessionIds ?? []), session.agentSessionId].filter(Boolean))];

// 프로젝트 화면의 기록 목록에서 숨긴다. 기록 파일은 그대로 둔다.
function hideRecords(ids) {
  const fresh = ids.filter((id) => !config.hiddenSessions.includes(id));
  if (!fresh.length) return;
  config.hiddenSessions.push(...fresh);
  saveConfig(config);
}

// CLI에 실제로 넘길 내용. 오케스트레이터에는 지휘 규칙과 세션 상태를 함께 넣는다.
// AI를 바꾼 뒤 새 대화의 첫 요청에는 이전 AI의 진행 상황을 붙인다. 새 대화가 시작되면(아래 turnEnd) 지운다.
function composeInput(session, prompt) {
  const input = composeBase(session, prompt);
  return session.handover && !session.agentSessionId ? `${session.handover}\n\n${input}` : input;
}
runner.on("turnEnd", (session) => {
  if (session.handover && session.agentSessionId) delete session.handover;
});

// 세션의 AI를 바꾼다. CLI가 다르므로 새 대화로 시작하고, carry면 지금까지의 기록을 정리해 다음 요청에 넘긴다.
// 작업 폴더·역할·연결·스킬·화면 기록은 그대로 둔다.
async function switchAgent(session, body) {
  const agent = String(body.agent);
  if (!AGENTS[agent]) throw new HttpError(400, "agent는 claude 또는 codex입니다.");
  if (runner.isRunning(session.id)) throw new HttpError(409, "실행 중에는 AI를 바꿀 수 없습니다. 끝나거나 일시중지한 뒤 바꾸세요.");
  const permission = body.permission ?? mapPermission(session.permission, agent, { orchestrator: session.kind === "orchestrator" }) ?? undefined;
  const options = checkSessionOptions({ agent, model: body.model ?? "", effort: body.effort ?? "", permission, chat: session.chat });
  const carry = body.carry !== false && session.events.some((e) => e.kind === "user");
  if (carry) {
    const files = session.baseCommit ? await changedFiles(session.cwd, session.baseCommit).catch(() => "") : "";
    session.handover = handoverText(session, files); // 바꾸기 전 AI 이름·모델로 적는다.
  } else {
    delete session.handover;
  }
  const from = AGENT_NAME[session.agent];
  Object.assign(session, options);
  session.agentSessionId = null;
  session.compactions = 0;
  session.context = null;
  delete session.roleChanged; // 새 대화의 첫 요청에 역할을 통째로 붙인다.
  runner.append(session, {
    kind: "status",
    text: `AI를 ${from}에서 ${AGENT_NAME[agent]}(으)로 바꿨습니다. ${carry ? "지금까지의 진행 상황을 다음 요청에 함께 넘깁니다." : "이전 대화는 넘기지 않고 새로 시작합니다."}`,
  });
}

function composeBase(session, prompt) {
  if (session.chat) {
    // 일반 채팅의 안내 문구는 새 대화의 첫 요청에만 붙인다(Codex는 시스템 프롬프트를 바꿀 수 없다).
    const input = withRole(session, prompt);
    const intro = AGENTS[session.agent].CHAT_INTRO;
    return intro && !session.agentSessionId ? `${intro}\n\n${input}` : input;
  }
  let input = withSkills(session, session.kind !== "orchestrator" ? withRole(session, prompt) : orchestratorInput(session, prompt, {
    hub: readHubFile(session.projectPath),
    sessions: projectSessions(session.projectPath),
  }));
  // 원본 폴더를 함께 사용한다는 규칙은 기존 CLI 대화에도 한 번 알린다.
  if (!session.agentSessionId || !session.projectFolderGuide) {
    session.projectFolderGuide = true;
    input = `[AgentHub 작업 폴더]\n이 프로젝트의 모든 세션은 프로젝트 원본 폴더(${session.projectPath})에서 함께 작업한다. 별도 git worktree를 만들지 않는다. 같은 파일을 고칠 때는 다른 세션과 겹치지 않게 조율한다.\n\n${input}`;
  }
  // 세션 사이 소통 규칙도 CLI 대화마다 한 번 붙인다.
  if (!session.agentSessionId || !session.messageGuide) {
    session.messageGuide = true;
    input = `${MESSAGE_GUIDE}\n\n${input}`;
  }
  // Claude는 실행 중에 질문 도구로 직접 묻는다. 질문 블록 규칙은 그런 통로가 없는 CLI(Codex)에만 붙인다.
  if (AGENTS[session.agent].interactive) return input;
  // CLI 대화마다 한 번 붙인다. 가져온 세션처럼 이미 대화가 있어도 아직 안 붙였으면 붙인다.
  if (session.agentSessionId && session.askGuide) return input;
  session.askGuide = true;
  return `${QUESTION_GUIDE}\n\n${input}`;
}

// 세션에 이은 스킬을 바꾼다. 대화 중에 바꾸면 다음 요청에 바뀐 목록을 다시 알린다.
// 작업 폴더를 분리한 Claude 세션은 원래 프로젝트의 스킬 폴더가 작업 폴더 밖이므로 읽을 수 있게 열어 준다.
// 개인 스킬은 Claude가 Skill 도구로 저절로 불러오므로 열지 않는다.
function setSessionSkills(session, names) {
  const skills = listSkills(session.projectPath);
  const known = new Set(skills.map((s) => s.name));
  const next = [...new Set((Array.isArray(names) ? names : []).map(String))].filter((n) => known.has(n));
  if (next.join() === (session.skills ?? []).join()) return;
  if (session.agentSessionId) session.skillsChanged = true;
  session.skills = next;
  if (session.agent !== "claude" || samePath(session.cwd, session.projectPath)) return;
  const dirs = skills
    .filter((s) => next.includes(s.name) && s.scope !== "personal")
    .map((s) => path.dirname(path.dirname(s.file)));
  if (dirs.length) session.addDirs = [...new Set([...(session.addDirs ?? []), ...dirs])];
}

// 스킬이 없어진 세션에서는 그 스킬 연결을 뺀다(개인 스킬은 모든 프로젝트의 세션을 본다).
function dropMissingSkills(name) {
  for (const s of store.list()) {
    if (!s.skills?.includes(name) || listSkills(s.projectPath).some((k) => k.name === name)) continue;
    setSessionSkills(s, s.skills.filter((n) => n !== name));
    store.touch(s);
  }
}

function checkSessionOptions({ agent, model = "", effort = "", permission, chat = false }) {
  if (!AGENTS[agent]) throw new HttpError(400, "agent는 claude 또는 codex입니다.");
  model = checkModel(model);
  effort = checkEffort(agent, effort);
  if (chat) permission = AGENTS[agent].CHAT_PERMISSION;
  permission ??= AGENTS[agent].PERMISSION_MODES.at(-1);
  if (!AGENTS[agent].PERMISSION_MODES.includes(permission)) throw new HttpError(400, "권한 모드가 올바르지 않습니다.");
  return { agent, model, effort, permission };
}

// chat: 프로젝트 없이 빈 폴더에서 도구 없이 대화만 하는 일반 채팅(project는 null).
// 이전 클라이언트가 isolate/worktreeName을 보내도 모든 프로젝트 세션은 원본 폴더를 쓴다.
async function createSession({ project, title, role, roleName, orchestrator, createdBy, chat, ...options }) {
  chat = !!chat;
  if (chat && orchestrator) throw new HttpError(400, "일반 채팅은 오케스트레이터로 만들 수 없습니다.");
  const { agent, model, effort, permission } = checkSessionOptions({ ...options, chat });
  if (chat) {
    fs.mkdirSync(CHAT_DIR, { recursive: true });
    project = { name: "일반 채팅", path: null };
  }
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const git = chat ? false : await isGitRepo(project.path);
  const cwd = chat ? CHAT_DIR : project.path;

  const now = new Date().toISOString();
  const session = {
    id,
    title: String(title ?? "").trim() || (chat ? "새 채팅" : `${agent} 세션`),
    role: String(role ?? "").trim().slice(0, ROLE_MAX),
    roleName: String(roleName ?? "").trim().slice(0, 100),
    kind: orchestrator ? "orchestrator" : "worker",
    createdBy: createdBy ?? null, // 이 세션을 만든 오케스트레이터
    agent,
    chat,
    model,
    effort,
    permission,
    projectName: project.name,
    projectPath: project.path,
    cwd,
    worktree: null,
    baseCommit: git ? await headCommit(cwd) : null,
    agentSessionId: null,
    state: "idle",
    createdAt: now,
    updatedAt: now,
    events: [],
  };
  store.add(session);
  return session;
}

// ── 일시중지·재개 ─────────────────────────────────────────────
// 일시중지: 실행 중이면 턴을 멈추되 CLI 대화와 대기열은 그대로 둔다. 쉬고 있으면 넘어오는 작업을 쌓아 두기만 한다.
// 재개: 턴 중간에 멈췄으면 같은 대화에 이어서 하라고 보내고, 그다음 쌓인 작업을 차례로 보낸다.
const INTERRUPTED_NOTE = "[사용자가 앞의 작업을 중간에 일시중지했다. 멈춘 곳까지의 상태를 확인하고 이어서 판단한다]";
const RESUME_PROMPT = "일시중지했던 작업을 재개한다. 멈춘 곳부터 이어서 진행한다.";

// 일시중지를 풀고, 턴 중간에 멈췄었는지 돌려준다.
function clearPause(session) {
  if (!session.paused) return false;
  const midTurn = !!session.pausedMidTurn;
  delete session.paused;
  delete session.pausedMidTurn;
  return midTurn;
}

function pauseSession(session) {
  if (session.paused) throw new HttpError(409, "이미 일시중지한 세션입니다.");
  session.paused = true;
  if (runner.isRunning(session.id)) {
    session.pausedMidTurn = true;
    runner.interrupt(session); // 끝나면 runner가 "paused" 상태로 바꾼다.
  } else {
    runner.append(session, { kind: "status", text: "일시중지했습니다. 넘어오는 작업은 재개할 때까지 쌓아 둡니다." });
    runner.setState(session, "paused");
  }
}

function resumeSession(session) {
  if (!session.paused) throw new HttpError(409, "일시중지한 세션이 아닙니다.");
  if (runner.isRunning(session.id)) throw new HttpError(409, "아직 멈추는 중입니다. 잠시 뒤에 다시 시도하세요.");
  if (session.pausedMidTurn) {
    // 흐름 단계는 이어서 센다. 재개한 턴이 끝나면 연결·대기열도 평소처럼 이어진다.
    clearPause(session);
    startTurn(session, RESUME_PROMPT, session.chainDepth ?? 0);
    return;
  }
  clearPause(session);
  runner.append(session, { kind: "status", text: "재개했습니다." });
  runner.setState(session, "idle");
  chain.flush(session);
}

// 사용자가 직접 보낸 요청은 새 흐름(0단계)이다. 흐름 중간의 질문에 답한 것처럼 같은 흐름을 잇는 요청은 depth를 넘긴다.
function startTurn(session, prompt, depth = 0) {
  if (runner.isRunning(session.id)) throw new HttpError(409, "이 세션은 이미 실행 중입니다.");
  session.chainDepth = depth;
  delete session.awaitingReply; // 사용자가 직접 이어 가면 다른 세션의 답을 기다리지 않는다.
  // 일시중지 중에 직접 보내면 재개한 것으로 본다. 턴 중간에 멈췄으면 CLI에 그 사실을 알린다.
  const interrupted = clearPause(session);
  const input = interrupted ? `${INTERRUPTED_NOTE}\n\n${prompt}` : prompt;
  try {
    runner.send(session, prompt, cliPaths()[session.agent], composeInput(session, input));
  } catch (err) {
    throw new HttpError(409, err.message);
  }
}

// ── 오케스트레이터 계획 ─────────────────────────────────────────
// 오케스트레이터의 턴이 끝나면 답변의 계획 블록을 꺼내 승인 대기로 올린다.
// 연결 체인이 밀린 요청을 먼저 시작하면 마지막 답변을 못 읽으므로 체인보다 먼저 듣는다.
runner.prependListener("turnEnd", (session, ok) => {
  if (session.kind !== "orchestrator" || !ok) return;
  const found = extractPlan(lastAnswer(session));
  if (!found) return;
  const event = { kind: "plan", planId: randomBytes(4).toString("hex"), status: "pending", text: "계획" };
  try {
    if (found.error) throw new Error(found.error);
    event.raw = found.plan; // 승인할 때 이 원본으로 다시 검사한다.
    event.plan = normalizePlan(found.plan, planContext(session));
  } catch (err) {
    event.status = "invalid";
    event.error = err.message;
  }
  runner.append(session, event);
});

// ── 에이전트의 질문 ─────────────────────────────────────────────
// 턴이 끝나면 답변의 질문 블록을 꺼내 답을 기다리는 질문으로 올린다. 답을 기다리는 동안 연결로 넘기지 않는다.
runner.prependListener("turnEnd", (session, ok) => {
  if (session.chat || !ok || AGENTS[session.agent].interactive) return;
  const found = extractQuestions(lastAnswer(session));
  if (!found) return;
  const event = { kind: "question", questionId: randomBytes(4).toString("hex"), status: "pending", text: "질문" };
  if (found.error) {
    event.status = "invalid";
    event.error = found.error;
  } else {
    event.questions = found.questions;
    session.waiting = true;
  }
  runner.append(session, event);
});

// ── 메시지 블록 ─────────────────────────────────────────────────
// 턴이 끝나면 답변의 메시지 블록을 꺼내 받는 세션에 보낸다(MCP 도구를 쓰지 못한 경우의 통로).
// wait이면 답이 올 때까지 이 세션의 연결로 넘기지 않고, 답이 오면 하던 일을 잇는 요청으로 받는다.
runner.prependListener("turnEnd", (session, ok) => {
  if (session.chat || ok === null) return;
  const found = extractMessages(lastAnswer(session));
  if (!found) return;
  if (found.error) {
    runner.append(session, { kind: "error", text: found.error });
    return;
  }
  for (const message of found.messages) {
    try {
      const { target } = mailbox.send(session, message.to, message.text);
      if (message.wait && !session.awaitingReply) {
        session.awaitingReply = target.id;
        session.waiting = true;
        runner.append(session, { kind: "status", text: `"${target.title}"의 답을 기다립니다` });
      }
    } catch (err) {
      runner.append(session, { kind: "error", text: `메시지를 보내지 못했습니다: ${err.message}` });
    }
  }
});

function planContext(session) {
  return {
    hub: readHubFile(session.projectPath),
    sessions: projectSessions(session.projectPath),
    orchestratorId: session.id,
  };
}

// 승인한 계획을 실행한다. 사용자가 승인한 것이므로 요청은 새 흐름(0단계)으로 보낸다.
async function applyPlan(orchestrator, raw) {
  // 승인을 기다리는 사이 세션이 지워졌을 수 있으므로 다시 검사한다.
  const plan = normalizePlan(raw, planContext(orchestrator));
  const project = ensureProject(orchestrator.projectPath);
  const ids = new Map();
  let created = 0;
  for (const item of plan.sessions) {
    if (item.id) {
      ids.set(item.key, item.id);
      continue;
    }
    const session = await createSession({
      project,
      agent: item.agent,
      model: item.model,
      permission: item.permission,
      title: item.title,
      role: item.roleText,
      roleName: item.roleName,
      createdBy: orchestrator.id,
    });
    ids.set(item.key, session.id);
    created++;
  }
  const id = (name) => ids.get(name) ?? name;
  let linked = 0;
  let changed = 0;
  for (const item of plan.links) {
    const from = id(item.from);
    const to = id(item.to);
    const fields = { when: item.when, keyword: item.when === "keyword" ? item.keyword : "", note: item.note, enabled: true };
    // 이미 이어진 두 세션이면 계획의 조건으로 고친다(새 계획이 조건을 바꾸려는 것이다).
    const existing = links.list().find((l) => l.from === from && l.to === to);
    if (existing) {
      links.update(existing, { ...fields, pending: null });
      changed++;
      continue;
    }
    links.add({ id: randomBytes(4).toString("hex"), from, to, ...fields });
    linked++;
  }
  broadcast("sessions", {});
  broadcast("links", {});
  for (const item of plan.send) {
    const target = store.get(id(item.to));
    if (target) chain.enqueue(target, item.prompt, { from: orchestrator.id, fromTitle: orchestrator.title }, 0);
  }
  return `세션 ${created}개 만듦 · 연결 ${linked}개${changed ? ` · 연결 ${changed}개 고침` : ""} · 요청 ${plan.send.length}건`;
}

// AGENTHUB.md의 흐름 템플릿으로 역할마다 세션을 만들고 연결한다. prompt가 있으면 받는 연결이 없는 역할에 보낸다.
async function startFlow({ project, flowName, name, prompt }) {
  const hub = readHubFile(project.path);
  if (!hub) throw new HttpError(404, `${HUB_FILE}이 없습니다.`);
  const flow = hub.flows.find((f) => f.name === flowName);
  if (!flow) throw new HttpError(404, `흐름 "${flowName}"이 없습니다.`);
  const roleNames = [...new Set(flow.steps.flatMap((s) => [s.from, s.to]))];
  const roles = new Map(roleNames.map((n) => [n, hub.roles.find((r) => r.name === n)]));
  const missing = roleNames.filter((n) => !roles.get(n));
  if (missing.length) throw new HttpError(400, `${HUB_FILE}에 없는 역할입니다: ${missing.join(", ")}`);
  for (const role of roles.values()) checkSessionOptions(role);

  const label = String(name ?? "").trim().slice(0, 100);
  const sessions = new Map();
  for (const [roleName, role] of roles) {
    sessions.set(roleName, await createSession({
      project,
      agent: role.agent,
      model: role.model,
      permission: role.permission,
      title: label ? `${label} · ${roleName}` : roleName,
      role: role.body,
      roleName,
    }));
  }
  for (const step of flow.steps) {
    links.add({
      id: randomBytes(4).toString("hex"),
      from: sessions.get(step.from).id,
      to: sessions.get(step.to).id,
      when: step.when,
      keyword: step.keyword,
      note: step.note,
      enabled: true,
    });
  }

  const text = String(prompt ?? "").trim();
  if (text) {
    const targets = new Set(flow.steps.map((s) => s.to));
    const roots = roleNames.filter((n) => !targets.has(n));
    for (const n of roots.length ? roots : roleNames.slice(0, 1)) startTurn(sessions.get(n), text);
  }
  return [...sessions.values()];
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // "api" 제외
  const method = req.method;

  if (parts[0] === "stream" && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }

  if (parts[0] === "status" && method === "GET") {
    const paths = cliPaths();
    const [claudeVersion, codexVersion] = await Promise.all([cliVersion(paths.claude), cliVersion(paths.codex)]);
    return send(res, 200, {
      agents: {
        claude: agentStatus("claude", paths.claude, claudeVersion),
        codex: agentStatus("codex", paths.codex, codexVersion),
      },
      cliOverrides: config.cli,
      projects: config.projects,
      // 연결 조건 선택지(보이는 순서)
      linkConditions: Object.entries(CONDITION_LABELS).map(([id, label]) => ({ id, label })),
    });
  }

  // CLI 로그인 상태. fresh=1이면 캐시를 쓰지 않고 다시 확인한다.
  if (parts[0] === "auth" && parts.length === 1 && method === "GET") {
    const paths = cliPaths();
    const fresh = url.searchParams.get("fresh") === "1";
    const [claude, codex] = await Promise.all([cliAuth("claude", paths.claude, { fresh }), cliAuth("codex", paths.codex, { fresh })]);
    return send(res, 200, { claude, codex });
  }

  // CLI 설치·로그인(Claude Code, Codex, GitHub CLI). 진행 상황은 "setup" 이벤트로 보낸다.
  if (parts[0] === "setup") {
    if (method === "GET" && parts.length === 1) return send(res, 200, await setup.status());
    const tool = parts[1];
    if (!TOOLS[tool]) throw new HttpError(404, "없는 CLI입니다.");
    const body = method === "POST" ? await readJson(req) : {};
    try {
      if (method === "POST" && parts[2] === "install") return send(res, 200, setup.install(tool));
      if (method === "POST" && parts[2] === "login") return send(res, 200, setup.login(tool));
      if (method === "POST" && parts[2] === "input") {
        setup.input(tool, String(body.text ?? "").slice(0, 2000));
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && parts[2] === "cancel") return send(res, 200, { canceled: setup.cancel(tool) });
    } catch (err) {
      throw new HttpError(409, err.message);
    }
  }

  if (parts[0] === "auth" && parts[2] === "login" && method === "POST") {
    const agent = parts[1];
    if (!AGENTS[agent]) throw new HttpError(400, "agent는 claude 또는 codex입니다.");
    const file = cliPaths()[agent];
    if (!file) throw new HttpError(400, "CLI를 찾지 못했습니다. 설정에서 경로를 지정하세요.");
    try {
      openLogin(agent, file);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return send(res, 200, { ok: true });
  }

  if (parts[0] === "limits" && method === "GET") {
    await refreshClaudeUsage({ fresh: url.searchParams.get("fresh") === "1" });
    return send(res, 200, readLimits());
  }

  if (parts[0] === "update") {
    if (method === "GET" && parts.length === 1) {
      return send(res, 200, updater?.state ?? { supported: false, desktop: false, current: VERSION, status: "idle" });
    }
    if (method === "POST" && ["check", "download", "install"].includes(parts[1])) {
      if (!updater) throw new HttpError(400, "데스크톱 앱에서만 업데이트할 수 있습니다.");
      try {
        return send(res, 200, await updater[parts[1]]());
      } catch (err) {
        throw new HttpError(409, err.message);
      }
    }
  }

  if (parts[0] === "settings" && method === "PUT") {
    const body = await readJson(req);
    for (const agent of ["claude", "codex"]) {
      const value = (body.cli?.[agent] ?? "").trim();
      if (value && !fs.existsSync(value)) throw new HttpError(400, `${agent} 경로가 없습니다: ${value}`);
      config.cli[agent] = value;
    }
    saveConfig(config);
    return send(res, 200, { ok: true });
  }

  if (parts[0] === "projects") {
    if (method === "POST" && parts.length === 1) {
      const body = await readJson(req);
      const dir = path.resolve(String(body.path ?? "").trim());
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, "폴더가 없습니다.");
      if (config.projects.some((p) => p.path === dir)) throw new HttpError(400, "이미 등록된 프로젝트입니다.");
      config.projects.push({ name: String(body.name ?? "").trim() || path.basename(dir), path: dir });
      unhideProject(dir);
      saveConfig(config);
      broadcast("projects", {});
      return send(res, 200, config.projects);
    }
    // 프로젝트 제거. force=1: 실행 중인 세션을 멈추고 제거, removeWorktrees=1: 분리한 작업 폴더도 지운다.
    if (method === "DELETE" && parts.length === 1) {
      const projectPath = url.searchParams.get("path");
      if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
      const result = await removeProject(projectPath, {
        force: url.searchParams.get("force") === "1",
        removeWorktrees: url.searchParams.get("removeWorktrees") === "1",
      });
      broadcast("projects", {});
      broadcast("sessions", {});
      broadcast("links", {});
      broadcast("commands", {});
      return send(res, 200, result);
    }
    // 등록한 프로젝트와 Claude Code·Codex 기록에서 감지한 프로젝트를 합친 목록.
    if (parts[1] === "all" && method === "GET") {
      const detected = discoverProjects();
      const merged = config.projects.map((p) => {
        const d = detected.find((x) => samePath(x.path, p.path));
        return { name: p.name, path: p.path, registered: true, claude: d?.claude ?? 0, codex: d?.codex ?? 0, lastActive: d?.lastActive ?? null };
      });
      // 제거한 프로젝트는 기록에서 다시 감지돼도 보이지 않는다.
      for (const d of detected) {
        if (merged.some((p) => samePath(p.path, d.path)) || config.hiddenProjects.some((h) => samePath(h, d.path))) continue;
        merged.push({ ...d, registered: false });
      }
      return send(res, 200, merged);
    }
    // AgentHub 밖에서 만든 Claude Code·Codex 세션 목록. 이미 가져온 것은 linkedId로 표시한다.
    if (parts[1] === "discover" && method === "GET") {
      const projectPath = url.searchParams.get("path");
      if (!projectPath || !fs.existsSync(projectPath)) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
      const project = { path: path.resolve(projectPath) };
      // 다시 시작하기 전의 CLI 대화도 그 세션에 연결된 것으로 본다.
      const linked = new Map(store.list().flatMap((s) => cliSessionIds(s).map((id) => [id, s.id])));
      const hidden = new Set(config.hiddenSessions);
      return send(res, 200, discoverSessions(project.path).map(({ file, ...found }) => {
        const linkedId = linked.get(found.agentSessionId) ?? null;
        // 연결된 기록은 AgentHub 세션 이름으로 보인다(흐름 그래프 카드와 같게).
        return { ...found, linkedId, linkedTitle: linkedId ? store.get(linkedId)?.title ?? null : null, hidden: hidden.has(found.agentSessionId) };
      }));
    }
    // 기록 목록에서 숨기거나 다시 보인다. Claude Code·Codex의 기록 파일은 그대로 둔다.
    if (parts[1] === "hide" && method === "POST") {
      const body = await readJson(req);
      const id = String(body.agentSessionId ?? "").trim();
      if (!id) throw new HttpError(400, "세션 ID가 없습니다.");
      config.hiddenSessions = config.hiddenSessions.filter((x) => x !== id);
      if (body.hidden !== false) config.hiddenSessions.push(id);
      saveConfig(config);
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE" && parts[1] !== undefined) {
      config.projects.splice(Number(parts[1]), 1);
      saveConfig(config);
      return send(res, 200, config.projects);
    }
  }

  // 프로젝트의 AGENTHUB.md
  // 프로젝트 스킬(.claude/skills/<이름>/SKILL.md). 흐름 그래프의 스킬 노드 위치는 설정에 둔다.
  // 명령 노드. 연결로 넘어오면 실행하고, 결과(종료 코드)에 따라 다음 연결로 넘긴다.
  if (parts[0] === "commands") {
    if (method === "GET" && parts.length === 1) {
      const projectPath = url.searchParams.get("path");
      return send(res, 200, { shells: shells(), commands: projectPath ? commands.list(projectPath) : [] });
    }
    const body = method === "DELETE" ? {} : await readJson(req);
    const savePos = (cmd, pos) => {
      if (pos === undefined) return;
      cmd.pos = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: Math.max(0, Math.round(pos.x)), y: Math.max(0, Math.round(pos.y)) } : null;
    };
    if (method === "POST" && parts[1] === "generate") {
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) throw new HttpError(400, "어떤 명령이 필요한지 적으세요.");
      const project = ensureProject(body.projectPath);
      return send(res, 200, await generateCommand({ prompt: prompt.slice(0, 4000), shell: body.shell ?? shells()[0].id, projectPath: project.path }));
    }
    if (method === "POST" && parts.length === 1) {
      const project = ensureProject(body.projectPath);
      let fields;
      try {
        fields = checkCommand(body);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      const cmd = { id: newCommandId(), projectPath: project.path, ...fields, state: "idle", lastRun: null, createdAt: new Date().toISOString() };
      savePos(cmd, body.pos);
      commands.add(cmd);
      broadcast("commands", {});
      return send(res, 200, cmd);
    }
    const cmd = getCommand(parts[1]);
    if (method === "PUT" && parts.length === 2) {
      // 위치만 옮길 때는 명령을 다시 검사하지 않는다.
      const editing = ["title", "command", "shell", "cwdMode", "timeoutSec"].some((k) => body[k] !== undefined);
      try {
        if (editing) Object.assign(cmd, checkCommand(body, cmd));
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      savePos(cmd, body.pos);
      commands.update(cmd, {});
      broadcast("commands", {});
      return send(res, 200, cmd);
    }
    if (method === "DELETE" && parts.length === 2) {
      chain.stopCommand(cmd);
      commands.remove(cmd.id);
      links.removeForSession(cmd.id);
      broadcast("commands", {});
      broadcast("links", {});
      return send(res, 200, { ok: true });
    }
    // 직접 실행. 실행 폴더가 "보낸 세션"이면 이 노드로 들어오는 연결의 첫 세션 폴더를 쓴다.
    if (method === "POST" && parts[2] === "run") {
      if (chain.runs.has(cmd.id)) throw new HttpError(409, "이미 실행 중입니다.");
      const origin = links.list().filter((l) => l.to === cmd.id).map((l) => store.get(l.from)).find(Boolean) ?? null;
      chain.runCommand(cmd, { origin, depth: 0 });
      return send(res, 200, cmd);
    }
    if (method === "POST" && parts[2] === "stop") return send(res, 200, { stopped: chain.stopCommand(cmd) });
  }

  if (parts[0] === "skills") {
    const body = method === "GET" || method === "DELETE" ? {} : await readJson(req);
    const projectPath = url.searchParams.get("path") ?? body.projectPath;
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const project = method === "GET" ? { path: path.resolve(projectPath) } : ensureProject(projectPath);
    const key = project.path.toLowerCase();
    const layout = (config.skillLayout ??= {});
    const savePos = (name, pos) => {
      if (pos === undefined) return;
      layout[key] ??= {};
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) layout[key][name] = { x: Math.max(0, Math.round(pos.x)), y: Math.max(0, Math.round(pos.y)) };
      else delete layout[key][name];
      saveConfig(config);
    };

    if (method === "GET" && parts.length === 1) {
      return send(res, 200, listSkills(project.path).map((s) => ({ ...s, pos: layout[key]?.[s.name] ?? null })));
    }
    // scope: project(AgentHub 전용, 기본) | personal(~/.claude·~/.agents 두 곳). claude 범위는 예전 스킬을 보여 주기만 하고 새로 만들지 않는다.
    if (method === "POST" && parts.length === 1) {
      const scope = body.scope === "personal" ? "personal" : "project";
      let skill;
      try {
        skill = writeSkill(project.path, checkSkill(body), { create: true, scope });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      savePos(skill.name, body.pos);
      broadcast("skills", { projectPath: project.path });
      return send(res, 200, skill);
    }
    const name = parts[1];
    const existing = listSkills(project.path).find((s) => s.name === name);
    if (!existing) throw new HttpError(404, "스킬이 없습니다.");
    if (method === "PUT") {
      // 위치만 옮길 때는 파일을 다시 쓰지 않는다.
      if (body.description !== undefined || body.body !== undefined) {
        try {
          writeSkill(project.path, checkSkill({ ...existing, ...body, name }), { scope: existing.scope });
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
      savePos(name, body.pos);
      broadcast("skills", { projectPath: project.path });
      return send(res, 200, { ok: true });
    }
    // 다른 범위로 옮긴다(Claude 프로젝트 스킬 → AgentHub 전용, 프로젝트 ↔ 개인).
    if (method === "POST" && parts[2] === "move") {
      if (!SCOPES.includes(body.to) || body.to === "claude") throw new HttpError(400, "옮길 곳은 project 또는 personal입니다.");
      let moved;
      try {
        moved = moveSkill(project.path, name, body.to);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      dropMissingSkills(name);
      broadcast("skills", { projectPath: project.path });
      broadcast("sessions", {});
      return send(res, 200, moved);
    }
    if (method === "DELETE") {
      deleteSkill(project.path, name, { scope: existing.scope });
      savePos(name, null);
      dropMissingSkills(name); // 이 스킬을 이어 둔 세션에서도 뺀다.
      broadcast("skills", { projectPath: project.path });
      broadcast("sessions", {});
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] === "hub") {
    if (method === "GET") {
      const projectPath = url.searchParams.get("path");
      if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
      const hub = readHubFile(projectPath);
      return send(res, 200, { file: hubFilePath(path.resolve(projectPath)), exists: !!hub, ...hub });
    }
    if (method === "POST" && parts[1] === "init") {
      const project = ensureProject((await readJson(req)).path);
      const file = hubFilePath(project.path);
      if (fs.existsSync(file)) throw new HttpError(409, `${HUB_FILE}이 이미 있습니다.`);
      fs.writeFileSync(file, HUB_TEMPLATE);
      return send(res, 200, { file, exists: true, ...readHubFile(project.path) });
    }
    // 이 PC의 기본 편집기로 연다(서버는 로컬에서만 열린다).
    if (method === "POST" && parts[1] === "open") {
      const file = hubFilePath(ensureProject((await readJson(req)).path).path);
      if (!fs.existsSync(file)) throw new HttpError(404, `${HUB_FILE}이 없습니다.`);
      const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [file], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && parts[1] === "flows") {
      const body = await readJson(req);
      const created = await startFlow({ ...body, project: ensureProject(body.projectPath) });
      broadcast("sessions", {});
      broadcast("links", {});
      return send(res, 200, created.map(summary));
    }
  }

  // 프로젝트 화면의 Git 패널. 조회는 GET(path 쿼리), 스테이징·커밋·병합은 POST(본문의 path).
  // session을 주면 그 세션의 분리한 작업 폴더(브랜치)에서 한다.
  if (parts[0] === "git") {
    const body = method === "POST" ? await readJson(req) : {};
    const repo = await gitRepo(url.searchParams.get("path") ?? body.path);
    const sessionId = url.searchParams.get("session") ?? body.session;
    const dir = sessionId ? sessionWorktree(sessionId, repo) : repo;
    try {
      if (method === "GET" && parts.length === 1) {
        return send(res, 200, await gitOverview(repo, projectSessions(repo)));
      }
      if (method === "GET" && parts[1] === "diff") return send(res, 200, { diff: await fileDiff(dir, url.searchParams.get("file") ?? "", url.searchParams.get("area")) });
      if (method === "GET" && parts[1] === "show") return send(res, 200, { diff: await showCommit(repo, url.searchParams.get("hash")) });
      if (method === "GET" && parts[1] === "branch") return send(res, 200, { diff: await branchDiff(repo, url.searchParams.get("branch")) });
      if (method === "POST" && (parts[1] === "stage" || parts[1] === "unstage")) {
        if (sessionId && runner.isRunning(sessionId)) throw new HttpError(409, "세션이 실행 중입니다. 끝나거나 일시중지한 뒤 변경하세요.");
        const count = await (parts[1] === "stage" ? stage : unstage)(dir, body.files);
        broadcast("git", { projectPath: repo });
        return send(res, 200, { ok: true, count });
      }
      if (method === "POST" && parts[1] === "commit") {
        if (sessionId && runner.isRunning(sessionId)) throw new HttpError(409, "세션이 실행 중입니다. 끝나거나 일시중지한 뒤 커밋하세요.");
        const files = Array.isArray(body.files) ? body.files : null;
        const result = await commit(dir, body.message, files, { staged: body.staged === true });
        broadcast("git", { projectPath: repo });
        return send(res, 200, { ok: true, result });
      }
      if (method === "POST" && parts[1] === "merge") {
        const result = await merge(repo, String(body.branch ?? ""));
        broadcast("git", { projectPath: repo });
        return send(res, 200, { ok: true, result });
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // 충돌은 상태 충돌(409), 나머지 git 실패는 입력·상태 문제로 보고 메시지를 그대로 보인다.
      throw new HttpError(err.conflict ? 409 : 400, err.message, err.conflict ? "conflict" : undefined);
    }
    throw new HttpError(404, "없는 API입니다.");
  }

  // 프로젝트에서 세션끼리 주고받은 메시지(최근 것)
  if (parts[0] === "messages" && parts.length === 1 && method === "GET") {
    const projectPath = url.searchParams.get("path");
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    return send(res, 200, mailbox.list(projectPath, samePath));
  }

  // 프로젝트 공유 노트. 세션은 MCP 도구로 덧붙이고, 화면에서는 보고 고치거나 비운다.
  if (parts[0] === "board" && parts.length === 1) {
    if (method === "GET") {
      const projectPath = url.searchParams.get("path");
      if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
      return send(res, 200, { text: readBoard(projectPath) });
    }
    if (method === "PUT") {
      const body = await readJson(req);
      const project = ensureProject(body.path);
      const text = String(body.text ?? "").trim();
      if (text.length > 60000) throw new HttpError(400, "공유 노트는 60000자까지 쓸 수 있습니다.");
      if (text) writeBoard(project.path, `${text}\n`);
      else clearBoard(project.path);
      broadcast("board", { projectPath: project.path });
      return send(res, 200, { text: readBoard(project.path) });
    }
  }

  if (parts[0] === "links") {
    if (parts.length === 1 && method === "GET") return send(res, 200, links.list());

    if (parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      // 연결 끝은 세션이나 명령 노드다.
      const endpoint = (id) => (isCommandId(id) ? getCommand(id) : getSession(id));
      const from = endpoint(body.from);
      const to = endpoint(body.to);
      if (from.chat || to.chat) throw new HttpError(400, "일반 채팅 세션은 연결할 수 없습니다.");
      if (from.id === to.id) throw new HttpError(400, "같은 세션끼리는 연결할 수 없습니다.");
      if (!samePath(from.projectPath, to.projectPath)) throw new HttpError(400, "같은 프로젝트의 세션끼리만 연결할 수 있습니다.");
      if (links.list().some((l) => l.from === from.id && l.to === to.id)) throw new HttpError(409, "이미 연결되어 있습니다.");
      const link = { id: randomBytes(4).toString("hex"), from: from.id, to: to.id, ...linkFields(body) };
      links.add(link);
      broadcast("links", {});
      return send(res, 200, link);
    }

    const link = getLink(parts[1]);
    if (parts.length === 2 && method === "PUT") {
      links.update(link, linkFields(await readJson(req), link));
      broadcast("links", {});
      return send(res, 200, link);
    }
    if (parts.length === 2 && method === "DELETE") {
      links.remove(link.id);
      broadcast("links", {});
      return send(res, 200, { ok: true });
    }
    // 연결선 위에서 승인을 기다리는 넘기기를 승인하거나 거절한다.
    if (parts[2] === "decide" && method === "POST") {
      const { action } = await readJson(req);
      if (!["approve", "reject"].includes(action)) throw new HttpError(400, "action은 approve 또는 reject입니다.");
      try {
        await chain.decide(link, action === "approve");
      } catch (err) {
        throw new HttpError(409, err.message);
      }
      return send(res, 200, link);
    }
    // 조건과 상관없이 지금 넘긴다.
    if (parts[2] === "run" && method === "POST") {
      await chain.deliver(link, 0);
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] === "sessions") {
    if (parts.length === 1 && method === "GET") return send(res, 200, store.list().map((s) => summary(settleState(s))));

    if (parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      const session = await createSession({ ...body, project: body.chat ? null : ensureProject(body.projectPath) });
      broadcast("sessions", {});
      return send(res, 200, summary(session));
    }

    if (parts[1] === "import" && method === "POST") {
      const body = await readJson(req);
      const project = ensureProject(body.projectPath);
      const existing = store.list().find((s) => cliSessionIds(s).includes(body.agentSessionId));
      if (existing) return send(res, 200, summary(existing));
      const found = discoverSessions(project.path)
        .find((s) => s.agent === body.agent && s.agentSessionId === body.agentSessionId);
      if (!found) throw new HttpError(404, "세션 기록을 찾지 못했습니다.");

      const cwd = found.cwd || project.path;
      const git = await isGitRepo(project.path);
      const now = new Date().toISOString();
      const history = loadHistory(found);
      const session = {
        id: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
        title: found.title || `${found.agent} 세션`,
        agent: found.agent,
        model: "",
        permission: found.agent === "claude" ? "acceptEdits" : "workspace-write",
        projectName: project.name,
        projectPath: project.path,
        cwd,
        worktree: null,
        baseCommit: git ? await headCommit(project.path) : null,
        agentSessionId: found.agentSessionId,
        cliSessionIds: [found.agentSessionId],
        imported: true,
        state: "idle",
        createdAt: now,
        updatedAt: now,
        compactions: history.compactions,
        context: history.context,
        events: history.events,
      };
      useProjectFolder(session);
      store.add(session);
      broadcast("sessions", {});
      return send(res, 200, summary(session));
    }

    const session = getSession(parts[1]);

    // queue: 실행이 끝나면 차례로 보낼 요청, canInject: 실행 중인 작업에 요청을 붙일 수 있는지
    if (parts.length === 2 && method === "GET") {
      return send(res, 200, { ...settleState(session), queue: chain.list(session.id), canInject: !!AGENTS[session.agent].interactive });
    }

    // 실행 중에 보내면 mode에 따라 지금 작업에 붙이거나(steer) 대기열에 넣는다(queue).
    if (parts[2] === "messages" && method === "POST") {
      const body = await readJson(req);
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) throw new HttpError(400, "내용을 입력하세요.");
      if (runner.isRunning(session.id)) {
        if (body.mode === "steer" && runner.canInject(session)) {
          runner.inject(session, prompt);
          return send(res, 200, { injected: true });
        }
        chain.enqueue(session, prompt, { user: true }, 0);
        return send(res, 200, { queued: true });
      }
      startTurn(session, prompt);
      return send(res, 200, { ok: true });
    }

    // 대기열의 요청: DELETE는 지우기, POST action=steer는 지금 작업에 붙이기, action=send는 실행 중이 아닐 때 바로 보내기
    if (parts[2] === "queue" && parts[3]) {
      const found = chain.list(session.id).find((item) => item.id === parts[3]);
      if (!found) throw new HttpError(404, "대기열에 없는 요청입니다.");
      if (method === "DELETE") {
        chain.take(session.id, parts[3]);
        return send(res, 200, { ok: true });
      }
      if (method === "POST") {
        const { action } = await readJson(req);
        if (action === "steer") {
          if (!runner.canInject(session)) throw new HttpError(409, "실행 중인 Claude 세션에만 붙일 수 있습니다.");
          runner.inject(session, chain.take(session.id, parts[3]).text);
          return send(res, 200, { ok: true });
        }
        if (action === "send") {
          if (runner.isRunning(session.id)) throw new HttpError(409, "실행 중입니다. 끝나면 차례로 보냅니다.");
          // 일시중지 중에 직접 보내면 재개한 것으로 본다.
          if (clearPause(session) || session.state === "paused") runner.setState(session, "idle");
          const item = chain.take(session.id, parts[3]);
          chain.enqueue(session, item.text, item.meta, item.depth); // 실행 중이 아니므로 바로 시작한다.
          return send(res, 200, { ok: true });
        }
        throw new HttpError(400, "action은 steer 또는 send입니다.");
      }
    }

    if (parts.length === 2 && method === "PUT") {
      const body = await readJson(req);
      if (body.agent !== undefined && body.agent !== session.agent) await switchAgent(session, body);
      if (body.title !== undefined) session.title = String(body.title).trim() || session.title;
      // 모델·추론 강도·권한은 다음 요청부터 적용된다.
      if (body.model !== undefined) session.model = checkModel(body.model);
      if (body.effort !== undefined) session.effort = checkEffort(session.agent, body.effort);
      if (body.permission !== undefined && !session.chat) {
        if (!AGENTS[session.agent].PERMISSION_MODES.includes(body.permission)) throw new HttpError(400, "권한 모드가 올바르지 않습니다.");
        session.permission = body.permission;
      }
      if (body.role !== undefined) {
        const role = String(body.role).trim().slice(0, ROLE_MAX);
        if (role !== (session.role ?? "") && session.agentSessionId) session.roleChanged = true;
        session.role = role;
      }
      if (body.graphPos !== undefined) {
        const { x, y } = body.graphPos ?? {};
        session.graphPos = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.max(0, x), y: Math.max(0, y) } : null;
      }
      if (body.skills !== undefined && !session.chat) setSessionSkills(session, body.skills);
      store.touch(session);
      broadcast("sessions", {});
      return send(res, 200, summary(session));
    }

    if (parts[2] === "plans" && parts[3] && method === "POST") {
      const event = session.events.find((e) => e.kind === "plan" && e.planId === parts[3]);
      if (!event) throw new HttpError(404, "계획이 없습니다.");
      if (event.status !== "pending") throw new HttpError(409, "이미 처리한 계획입니다.");
      const body = await readJson(req);
      if (body.action === "approve") {
        try {
          event.result = await applyPlan(session, event.raw);
          event.status = "applied";
        } catch (err) {
          throw new HttpError(400, `계획을 실행하지 못했습니다: ${err.message}`);
        }
      } else if (body.action === "reject") {
        event.status = "rejected";
        const reason = String(body.reason ?? "").trim();
        // 이유를 적으면 오케스트레이터가 계획을 고치도록 알려 준다.
        if (reason) chain.enqueue(session, `[계획 거절] ${reason}\n계획을 고쳐 다시 제안하라.`, {}, 0);
      } else {
        throw new HttpError(400, "action은 approve 또는 reject입니다.");
      }
      store.touch(session);
      broadcast("session", { sessionId: session.id });
      return send(res, 200, event);
    }

    if (parts[2] === "questions" && parts[3] && method === "POST") {
      const event = session.events.find((e) => e.kind === "question" && e.questionId === parts[3]);
      if (!event) throw new HttpError(404, "질문이 없습니다.");
      if (event.status !== "pending") throw new HttpError(409, "이미 답했거나 지나간 질문입니다.");
      const { answers } = await readJson(req);
      if (!hasAnswer(answers)) throw new HttpError(400, "답을 고르거나 적으세요.");
      // 실행 중에 CLI가 물은 질문이면 답을 CLI에 바로 돌려주고, 같은 턴이 이어진다.
      if (event.live) {
        try {
          runner.answer(event.questionId, { answers });
        } catch (err) {
          throw new HttpError(409, err.message);
        }
        broadcast("session", { sessionId: session.id });
        broadcast("sessions", {});
        return send(res, 200, event);
      }
      if (runner.isRunning(session.id)) throw new HttpError(409, "이 세션은 이미 실행 중입니다.");
      event.status = "answered";
      event.answers = answers;
      try {
        // 흐름 중간에 물은 질문이면 단계를 이어 세어 연결이 끝없이 돌지 않게 한다.
        startTurn(session, answerPrompt(event.questions, answers), session.chainDepth ?? 0);
      } catch (err) {
        event.status = "pending"; // 보내지 못했으면 다시 답할 수 있게 둔다.
        delete event.answers;
        throw err;
      }
      broadcast("session", { sessionId: session.id });
      return send(res, 200, event);
    }

    // 실행 중에 CLI가 물은 권한 요청에 답한다. decision: allow | always(같은 종류는 다시 묻지 않음) | deny
    if (parts[2] === "permissions" && parts[3] && method === "POST") {
      const { decision, message } = await readJson(req);
      if (!["allow", "always", "deny"].includes(decision)) throw new HttpError(400, "decision은 allow, always, deny 중 하나입니다.");
      if (!runner.hasPrompt(parts[3], session.id)) throw new HttpError(409, "이미 답했거나 끝난 요청입니다.");
      const event = runner.answer(parts[3], { decision, message: String(message ?? "").trim().slice(0, 2000) });
      broadcast("session", { sessionId: session.id });
      broadcast("sessions", {});
      return send(res, 200, event);
    }

    if (parts[2] === "stop" && method === "POST") {
      // 일시중지한 세션을 중지하면 이어서 하지 않고 넘어온 작업도 버린다(사용자가 넣은 요청은 남긴다).
      if (session.paused && !runner.isRunning(session.id)) {
        clearPause(session);
        runner.setState(session, "idle");
        await chain.onTurnEnd(session, null);
        runner.append(session, { kind: "status", text: "일시중지를 풀고 중지했습니다." });
        return send(res, 200, { stopped: true });
      }
      return send(res, 200, { stopped: runner.stop(session) });
    }

    if (parts[2] === "pause" && method === "POST") {
      pauseSession(session);
      return send(res, 200, summary(session));
    }

    if (parts[2] === "resume" && method === "POST") {
      resumeSession(session);
      return send(res, 200, summary(session));
    }

    if (parts[2] === "restart" && method === "POST") {
      try {
        runner.restart(session);
      } catch (err) {
        throw new HttpError(409, err.message);
      }
      broadcast("sessions", {});
      broadcast("session", { sessionId: session.id });
      return send(res, 200, summary(session));
    }

    // 재생성: 같은 설정(제목·역할·모델·권한·연결·그래프 위치)으로 새 세션을 만들고 기존 세션은 지운다.
    // 화면 기록과 CLI 대화는 새로 시작하고, 원본 프로젝트 폴더에서 작업한다.
    if (parts[2] === "recreate" && method === "POST") {
      if (runner.isRunning(session.id)) throw new HttpError(409, "실행 중인 세션은 재생성할 수 없습니다. 먼저 중지하세요.", "running");
      const created = await createSession({
        project: session.chat ? null : ensureProject(session.projectPath),
        title: session.title,
        role: session.role,
        roleName: session.roleName,
        orchestrator: session.kind === "orchestrator",
        createdBy: session.createdBy,
        chat: session.chat,
        agent: session.agent,
        model: session.model,
        effort: session.effort,
        permission: session.permission,
      });
      Object.assign(created, {
        baseCommit: session.baseCommit ?? created.baseCommit,
        graphPos: session.graphPos ?? null,
        previousCwd: session.previousCwd,
        previousWorktree: session.previousWorktree,
      });
      store.touch(created);
      for (const link of links.list()) {
        if (link.from === session.id) links.update(link, { from: created.id, pending: null });
        if (link.to === session.id) links.update(link, { to: created.id, pending: null });
      }
      // 오케스트레이터를 재생성하면 그가 만든 세션들의 지휘선도 새 세션으로 잇는다.
      for (const other of store.list()) {
        if (other.createdBy !== session.id) continue;
        other.createdBy = created.id;
        store.touch(other);
      }
      store.remove(session.id);
      if (!session.chat) hideRecords(cliSessionIds(session)); // 지운 쪽의 CLI 대화가 "가져오기"로 다시 뜨지 않게
      broadcast("sessions", {});
      broadcast("links", {});
      return send(res, 200, summary(created));
    }

    if (parts[2] === "diff" && method === "GET") {
      if (!session.baseCommit) throw new HttpError(400, "git 저장소가 아닙니다.");
      return send(res, 200, await diffSince(session.cwd, session.baseCommit));
    }

    // force=1: 실행 중이면 CLI를 멈추고 지운다(멈추지 않고 남은 세션을 지울 때).
    if (parts.length === 2 && method === "DELETE") {
      if (runner.isRunning(session.id)) {
        if (url.searchParams.get("force") !== "1") throw new HttpError(409, "실행 중인 세션입니다.", "running");
        runner.stop(session);
      }
      if (session.worktree && url.searchParams.get("removeWorktree") === "1") {
        try {
          await removeWorktree(session.projectPath, session.worktree.dir);
        } catch (err) {
          throw new HttpError(409, `작업 폴더를 지우지 못했습니다(커밋하지 않은 변경이 있을 수 있음): ${err.message}`, "worktree");
        }
      }
      try {
        store.remove(session.id);
      } catch (err) {
        throw new HttpError(500, `세션 파일을 지우지 못했습니다: ${err.message}`);
      }
      const records = cleanupSession(session, { deleteRecords: url.searchParams.get("records") === "delete" });
      broadcast("sessions", {});
      broadcast("links", {});
      return send(res, 200, { ok: true, records });
    }
  }

  throw new HttpError(404, "없는 API입니다.");
}

const server = http.createServer(async (req, res) => {
  if (!isTrustedRequest(req)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const mcp = url.pathname.match(/^\/mcp\/([0-9a-f]{48})$/);
  if (mcp) {
    try {
      await handleMcp(req, res, mcp[1]);
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
    return;
  }
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);
  try {
    await handleApi(req, res, url);
  } catch (err) {
    send(res, err.status ?? 500, { error: err.message, reason: err.reason });
  }
});

export { port };

// 서버가 열리면 resolve, 포트가 이미 쓰이고 있으면 reject된다(Electron 앱이 기다린다).
export const listening = new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => {
    console.log(`AgentHub: http://127.0.0.1:${port}`);
    resolve();
    // 첫 프로젝트 검색은 기록 파일을 모두 읽어 1~2초 걸리므로 미리 해 둔다. 이후에는 바뀐 파일만 읽는다.
    setTimeout(() => discoverProjects(), 200);
  });
});

// 실행 중인 에이전트를 멈추고 세션을 저장한다.
export function shutdown() {
  runner.stopAll();
  store.flushAll();
  server.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}

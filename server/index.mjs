import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT, CHAT_DIR, loadConfig, saveConfig } from "./config.mjs";
import { locateCli, cliVersion, cliAuth, openLogin } from "./cli.mjs";
import { SessionStore, summary } from "./store.mjs";
import { Runner, AGENTS } from "./runner.mjs";
import { isGitRepo, createWorktree, removeWorktree, headCommit, diffSince } from "./git.mjs";
import { discoverProjects, discoverSessions, loadHistory } from "./discover.mjs";
import { readLimits, recordClaudeLimit } from "./limits.mjs";
import { ROLE_MAX, withRole } from "./role.mjs";
import { LinkStore } from "./links.mjs";
import { Chain, CONDITIONS, lastAnswer } from "./chain.mjs";
import { orchestratorInput, extractPlan, normalizePlan } from "./orchestrator.mjs";
import { HUB_FILE, HUB_TEMPLATE, hubFilePath, readHubFile } from "./hubfile.mjs";

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
  return { path: cliPath, autoPath: locateCli(agent, ""), version, permissions: a.PERMISSION_MODES, models: a.models(), efforts: a.efforts() };
}

const cliPaths = () => ({
  claude: locateCli("claude", config.cli.claude),
  codex: locateCli("codex", config.cli.codex),
});
const chain = new Chain({ store, runner, links, cliPaths, compose: composeInput });

// ── 보안: 로컬 전용 ─────────────────────────────────────────────
// 127.0.0.1에만 열고, Host 헤더와 사용자 정의 헤더를 확인해 다른 사이트의 요청(DNS 리바인딩, CSRF)을 막는다.
function isTrustedRequest(req) {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host)) return false;
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
runner.on("event", (sessionId, event) => broadcast("event", { sessionId, event }));
runner.on("state", (sessionId, state) => broadcast("state", { sessionId, state }));
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
  const keyword = String(body.keyword ?? current.keyword ?? "").trim().slice(0, 100);
  if (when === "keyword" && !keyword) throw new HttpError(400, "키워드를 입력하세요.");
  return {
    when,
    keyword,
    note: String(body.note ?? current.note ?? "").trim().slice(0, ROLE_MAX),
    enabled: body.enabled ?? current.enabled ?? true,
  };
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
  saveConfig(config);
  return project;
}

const projectSessions = (projectPath) => store.list().filter((s) => samePath(s.projectPath, projectPath));

// CLI에 실제로 넘길 내용. 오케스트레이터에는 지휘 규칙과 세션 상태를 함께 넣는다.
function composeInput(session, prompt) {
  if (session.chat) {
    // 일반 채팅의 안내 문구는 새 대화의 첫 요청에만 붙인다(Codex는 시스템 프롬프트를 바꿀 수 없다).
    const input = withRole(session, prompt);
    const intro = AGENTS[session.agent].CHAT_INTRO;
    return intro && !session.agentSessionId ? `${intro}\n\n${input}` : input;
  }
  if (session.kind !== "orchestrator") return withRole(session, prompt);
  return orchestratorInput(session, prompt, {
    hub: readHubFile(session.projectPath),
    sessions: projectSessions(session.projectPath),
  });
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
async function createSession({ project, isolate, title, role, roleName, orchestrator, createdBy, chat, ...options }) {
  chat = !!chat;
  if (chat && orchestrator) throw new HttpError(400, "일반 채팅은 오케스트레이터로 만들 수 없습니다.");
  const { agent, model, effort, permission } = checkSessionOptions({ ...options, chat });
  if (chat) {
    fs.mkdirSync(CHAT_DIR, { recursive: true });
    project = { name: "일반 채팅", path: null };
  }
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const git = chat ? false : await isGitRepo(project.path);
  let cwd = chat ? CHAT_DIR : project.path;
  let worktree = null;
  if (isolate && !chat) {
    if (!git) throw new HttpError(400, "git 저장소가 아니어서 작업 폴더를 분리할 수 없습니다.");
    worktree = await createWorktree(project.path, id);
    cwd = worktree.dir;
  }

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
    worktree,
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

// 사용자가 직접 보낸 요청은 새 흐름이다.
function startTurn(session, prompt) {
  if (runner.isRunning(session.id)) throw new HttpError(409, "이 세션은 이미 실행 중입니다.");
  session.chainDepth = 0;
  try {
    runner.send(session, prompt, cliPaths()[session.agent], composeInput(session, prompt));
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
  const git = await isGitRepo(project.path);
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
      isolate: item.isolate && git,
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
  for (const item of plan.links) {
    const from = id(item.from);
    const to = id(item.to);
    if (links.list().some((l) => l.from === from && l.to === to)) continue;
    links.add({ id: randomBytes(4).toString("hex"), from, to, when: item.when, keyword: item.keyword, note: item.note, enabled: true });
    linked++;
  }
  broadcast("sessions", {});
  broadcast("links", {});
  for (const item of plan.send) {
    const target = store.get(id(item.to));
    if (target) chain.enqueue(target, item.prompt, { from: orchestrator.id, fromTitle: orchestrator.title }, 0);
  }
  return `세션 ${created}개 만듦 · 연결 ${linked}개 · 요청 ${plan.send.length}건`;
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

  const git = await isGitRepo(project.path);
  const label = String(name ?? "").trim().slice(0, 100);
  const sessions = new Map();
  for (const [roleName, role] of roles) {
    sessions.set(roleName, await createSession({
      project,
      agent: role.agent,
      model: role.model,
      permission: role.permission,
      isolate: role.isolate && git,
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
    });
  }

  // CLI 로그인 상태. fresh=1이면 캐시를 쓰지 않고 다시 확인한다.
  if (parts[0] === "auth" && parts.length === 1 && method === "GET") {
    const paths = cliPaths();
    const fresh = url.searchParams.get("fresh") === "1";
    const [claude, codex] = await Promise.all([cliAuth("claude", paths.claude, { fresh }), cliAuth("codex", paths.codex, { fresh })]);
    return send(res, 200, { claude, codex });
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

  if (parts[0] === "limits" && method === "GET") return send(res, 200, readLimits());

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
    if (method === "POST") {
      const body = await readJson(req);
      const dir = path.resolve(String(body.path ?? "").trim());
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, "폴더가 없습니다.");
      if (config.projects.some((p) => p.path === dir)) throw new HttpError(400, "이미 등록된 프로젝트입니다.");
      config.projects.push({ name: String(body.name ?? "").trim() || path.basename(dir), path: dir });
      saveConfig(config);
      return send(res, 200, config.projects);
    }
    // 등록한 프로젝트와 Claude Code·Codex 기록에서 감지한 프로젝트를 합친 목록.
    if (parts[1] === "all" && method === "GET") {
      const detected = discoverProjects();
      const merged = config.projects.map((p) => {
        const d = detected.find((x) => samePath(x.path, p.path));
        return { name: p.name, path: p.path, registered: true, claude: d?.claude ?? 0, codex: d?.codex ?? 0, lastActive: d?.lastActive ?? null };
      });
      for (const d of detected) {
        if (!merged.some((p) => samePath(p.path, d.path))) merged.push({ ...d, registered: false });
      }
      return send(res, 200, merged);
    }
    // AgentHub 밖에서 만든 Claude Code·Codex 세션 목록. 이미 가져온 것은 linkedId로 표시한다.
    if (parts[1] === "discover" && method === "GET") {
      const projectPath = url.searchParams.get("path");
      if (!projectPath || !fs.existsSync(projectPath)) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
      const project = { path: path.resolve(projectPath) };
      const linked = new Map(store.list().filter((s) => s.agentSessionId).map((s) => [s.agentSessionId, s.id]));
      return send(res, 200, discoverSessions(project.path).map(({ file, ...found }) => ({
        ...found,
        linkedId: linked.get(found.agentSessionId) ?? null,
      })));
    }
    if (method === "DELETE" && parts[1] !== undefined) {
      config.projects.splice(Number(parts[1]), 1);
      saveConfig(config);
      return send(res, 200, config.projects);
    }
  }

  // 프로젝트의 AGENTHUB.md
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

  if (parts[0] === "links") {
    if (parts.length === 1 && method === "GET") return send(res, 200, links.list());

    if (parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      const from = getSession(body.from);
      const to = getSession(body.to);
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
      const existing = store.list().find((s) => s.agentSessionId && s.agentSessionId === body.agentSessionId);
      if (existing) return send(res, 200, summary(existing));
      const found = discoverSessions(project.path)
        .find((s) => s.agent === body.agent && s.agentSessionId === body.agentSessionId);
      if (!found) throw new HttpError(404, "세션 기록을 찾지 못했습니다.");

      const cwd = found.cwd && fs.existsSync(found.cwd) ? found.cwd : project.path;
      const git = await isGitRepo(cwd);
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
        baseCommit: git ? await headCommit(cwd) : null,
        agentSessionId: found.agentSessionId,
        imported: true,
        state: "idle",
        createdAt: now,
        updatedAt: now,
        compactions: history.compactions,
        context: history.context,
        events: history.events,
      };
      store.add(session);
      broadcast("sessions", {});
      return send(res, 200, summary(session));
    }

    const session = getSession(parts[1]);

    if (parts.length === 2 && method === "GET") return send(res, 200, settleState(session));

    if (parts[2] === "messages" && method === "POST") {
      const body = await readJson(req);
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) throw new HttpError(400, "내용을 입력하세요.");
      startTurn(session, prompt);
      return send(res, 200, { ok: true });
    }

    if (parts.length === 2 && method === "PUT") {
      const body = await readJson(req);
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

    if (parts[2] === "stop" && method === "POST") return send(res, 200, { stopped: runner.stop(session) });

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
      links.removeForSession(session.id);
      broadcast("sessions", {});
      broadcast("links", {});
      return send(res, 200, { ok: true });
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

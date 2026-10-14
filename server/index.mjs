import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, loadConfig, saveConfig } from "./config.mjs";
import { locateCli, cliVersion } from "./cli.mjs";
import { SessionStore, summary } from "./store.mjs";
import { Runner, AGENTS } from "./runner.mjs";
import { isGitRepo, createWorktree, removeWorktree, headCommit, diffSince } from "./git.mjs";
import { discoverProjects, discoverSessions, loadHistory } from "./discover.mjs";
import { readLimits, recordClaudeLimit } from "./limits.mjs";

const config = loadConfig();
const port = Number(process.env.PORT ?? config.port);
const store = new SessionStore();
const runner = new Runner(store);
const PUBLIC_DIR = path.join(ROOT, "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const MODEL_PATTERN = /^[\w.\-:[\]]{1,64}$/;

const cliPaths = () => ({
  claude: locateCli("claude", config.cli.claude),
  codex: locateCli("codex", config.cli.codex),
});

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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

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
        claude: { path: paths.claude, version: claudeVersion, permissions: AGENTS.claude.PERMISSION_MODES },
        codex: { path: paths.codex, version: codexVersion, permissions: AGENTS.codex.PERMISSION_MODES },
      },
      cliOverrides: config.cli,
      projects: config.projects,
    });
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

  if (parts[0] === "sessions") {
    if (parts.length === 1 && method === "GET") return send(res, 200, store.list().map(summary));

    if (parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      const agent = body.agent;
      if (!AGENTS[agent]) throw new HttpError(400, "agent는 claude 또는 codex입니다.");
      const project = ensureProject(body.projectPath);
      const model = String(body.model ?? "").trim();
      if (model && !MODEL_PATTERN.test(model)) throw new HttpError(400, "모델 이름 형식이 올바르지 않습니다.");
      const permission = body.permission ?? AGENTS[agent].PERMISSION_MODES.at(-1);
      if (!AGENTS[agent].PERMISSION_MODES.includes(permission)) throw new HttpError(400, "권한 모드가 올바르지 않습니다.");

      const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      const git = await isGitRepo(project.path);
      let cwd = project.path;
      let worktree = null;
      if (body.isolate) {
        if (!git) throw new HttpError(400, "git 저장소가 아니어서 작업 폴더를 분리할 수 없습니다.");
        worktree = await createWorktree(project.path, id);
        cwd = worktree.dir;
      }

      const now = new Date().toISOString();
      const session = {
        id,
        title: String(body.title ?? "").trim() || `${agent} 세션`,
        agent,
        model,
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
        events: loadHistory(found),
      };
      store.add(session);
      broadcast("sessions", {});
      return send(res, 200, summary(session));
    }

    const session = getSession(parts[1]);

    if (parts.length === 2 && method === "GET") return send(res, 200, session);

    if (parts[2] === "messages" && method === "POST") {
      const body = await readJson(req);
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) throw new HttpError(400, "내용을 입력하세요.");
      try {
        runner.send(session, prompt, cliPaths()[session.agent]);
      } catch (err) {
        throw new HttpError(409, err.message);
      }
      return send(res, 200, { ok: true });
    }

    if (parts[2] === "stop" && method === "POST") return send(res, 200, { stopped: runner.stop(session) });

    if (parts[2] === "diff" && method === "GET") {
      if (!session.baseCommit) throw new HttpError(400, "git 저장소가 아닙니다.");
      return send(res, 200, await diffSince(session.cwd, session.baseCommit));
    }

    if (parts.length === 2 && method === "DELETE") {
      if (runner.isRunning(session.id)) throw new HttpError(409, "실행 중인 세션은 삭제할 수 없습니다.");
      if (session.worktree && url.searchParams.get("removeWorktree") === "1") {
        try {
          await removeWorktree(session.projectPath, session.worktree.dir);
        } catch (err) {
          throw new HttpError(409, `작업 폴더를 지우지 못했습니다(커밋하지 않은 변경이 있을 수 있음): ${err.message}`);
        }
      }
      store.remove(session.id);
      broadcast("sessions", {});
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
    send(res, err.status ?? 500, { error: err.message });
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

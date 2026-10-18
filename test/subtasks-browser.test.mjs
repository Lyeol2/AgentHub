import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function browser(profile, url) {
  const child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => stderr += chunk);
  const closed = new Promise((resolve) => child.on("exit", resolve));
  let socket;
  try {
    let port;
    const end = Date.now() + 10000;
    while (!port) {
      if (Date.now() > end) throw Error("Browser launch timeout: " + stderr);
      port = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").then((text) => Number(text.split("\n")[0]), () => null);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((res) => res.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const pending = new Map(), errors = [];
    let id = 0;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result); }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id, timer = setTimeout(() => reject(Error(`DevTools timeout: ${method}\n${errors.join("\n")}`)), 30000);
      pending.set(requestId, { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => {
      const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } };
      socket.addEventListener("message", listener);
    });
    await command("Page.navigate", { url });
    await loaded;
    const result = await command("Runtime.evaluate", { expression: await fs.readFile(new URL("./fixtures/subtasks-browser.js.txt", import.meta.url), "utf8"), awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + "\nBrowser errors:\n" + errors.join("\n"));
    return { checks: result.result.value, errors };
  } finally {
    socket?.close();
    child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

// 모든 API는 고정 응답이다. CLI·Git·사용자 데이터는 건드리지 않는다.
test("browser: 하위 작업 패널·대화 연결·중지·SSE 병합·목록과 그래프 배지", { timeout: 60000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chrome).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-subtasks-browser-"));
  const project = { path: "C:/fixture", name: "Fixture", claude: 0, codex: 0, registered: true };
  const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
  const parent = {
    id: "t1", toolUseId: "toolu_1", description: "코드 조사", type: "Explore", taskType: "local_agent", status: "running", background: true, parentId: null, depth: 1,
    prompt: "server 폴더에서 하위 작업 코드를 찾아라", startedAt: ago(120), endedAt: null, lastProgressAt: ago(90), usage: { totalTokens: 1234, toolUses: 3, durationMs: 5000 },
    lastTool: "파일 읽기", summary: "runner.mjs 읽는 중", error: null, outputFile: "C:/tmp/t1.output", reason: null,
    activity: [{ ts: ago(100), kind: "tool", label: "파일 읽기", text: "Read: server/runner.mjs" }, { ts: ago(95), kind: "text", text: "중간 보고" }],
  };
  const child = { id: "t2", toolUseId: "toolu_2", description: "테스트 돌리기", type: "local_bash", taskType: "local_bash", status: "completed", background: true, parentId: "t1", depth: 2,
    prompt: null, startedAt: "2026-10-18T00:00:00.000Z", endedAt: "2026-10-18T00:00:10.000Z", lastProgressAt: null, usage: null, lastTool: null, summary: "통과", error: null, activity: [] };
  const ambient = { id: "t3", description: "정리", status: "running", ambient: true, startedAt: ago(5), activity: [] };
  const session = {
    id: "s1", title: "하위 작업 세션", agent: "claude", state: "background", permission: "default", projectName: project.name, projectPath: project.path, cwd: project.path,
    createdAt: ago(600), updatedAt: ago(10), skills: [], queue: [], subtasks: [parent, child, ambient],
    events: [{ seq: 0, kind: "user", text: "조사해 줘" }, { seq: 1, kind: "tool", text: "Agent: 코드 조사", label: "에이전트", toolUseId: "toolu_1" }, { seq: 2, kind: "tool", text: "Bash: ls", toolUseId: "toolu_x" }],
  };
  const agents = Object.fromEntries(["claude", "codex"].map((agent) => [agent, { models: [], efforts: [], permissions: ["default"] }]));
  const streams = new Set(), stops = [], unexpected = [];
  let stopMode = "unconfirmed";
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      let value;
      if (url.pathname === "/fixture/emit") {
        // 서버처럼 상세에도 반영해 두고 SSE로 알린다.
        for (const task of body.tasks ?? []) { const index = session.subtasks.findIndex((item) => item.id === task.id); if (index < 0) session.subtasks.push(task); else session.subtasks[index] = task; }
        session.subtasks = session.subtasks.filter((task) => !(body.removed ?? []).includes(task.id));
        for (const stream of streams) stream.write(`event: subtasks\ndata: ${JSON.stringify({ sessionId: "s1", tasks: [], removed: [], ...body })}\n\n`);
        value = { streams: streams.size };
      } else if (url.pathname === "/fixture/stops") value = { stops, unexpected };
      else if (url.pathname === "/fixture/stop-mode") { stopMode = body.mode; value = {}; }
      else if (url.pathname === "/api/status") value = { agents, projects: [project], cliOverrides: {}, linkConditions: [] };
      else if (url.pathname === "/api/sessions") {
        const { events, subtasks, ...rest } = session;
        const running = subtasks.filter((task) => task.status === "running" && !task.ambient).length;
        value = [{ ...rest, ...(subtasks.length ? { subtaskCount: { running, total: subtasks.length } } : {}) }];
      } else if (url.pathname === "/api/sessions/s1") value = structuredClone(session);
      else if (url.pathname.startsWith("/api/sessions/s1/subtasks/") && req.method === "POST") {
        stops.push(url.pathname);
        if (stopMode === "unconfirmed") value = { ok: true, confirmed: false };
        else { res.statusCode = 409; value = { error: "이미 끝난 하위 작업입니다." }; }
      } else if (url.pathname === "/api/projects/all") value = [project];
      else if (["/api/projects/discover", "/api/links", "/api/skills", "/api/messages"].includes(url.pathname)) value = [];
      else if (url.pathname === "/api/commands") value = { shells: [], commands: [] };
      else if (url.pathname === "/api/node-groups") value = { groups: [] };
      else if (url.pathname === "/api/graph-tabs") value = { tabs: [{ id: "tab-default", title: "기본", projectPath: project.path, order: 0 }], defaultTabId: "tab-default" };
      else if (url.pathname === "/api/limits") value = { claude: { windows: [] }, codex: { windows: [] } };
      else if (url.pathname === "/api/auth") value = { claude: false, codex: false };
      else if (url.pathname === "/api/setup") value = { tools: [], jobs: {} };
      else if (url.pathname === "/api/update") value = { current: "0.2.0", desktop: false };
      else if (url.pathname === "/api/account") value = { installed: false, connected: false };
      else if (url.pathname.startsWith("/api/")) { unexpected.push(`${req.method} ${url.pathname}`); res.statusCode = 404; value = { error: "fixture" }; }
      else {
        const publicRoot = path.resolve(root, "public");
        const file = path.resolve(publicRoot, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
        if (!file.startsWith(publicRoot + path.sep)) throw Error("Unsafe static fixture path");
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html");
        res.end(await fs.readFile(file)); return;
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { checks, errors } = await browser(path.join(temporary, "profile"), `http://127.0.0.1:${server.address().port}/`);
    assert.ok(checks.length >= 15, JSON.stringify(checks));
    assert.deepEqual(errors, []);
    assert.deepEqual(stops, ["/api/sessions/s1/subtasks/t1/stop", "/api/sessions/s1/subtasks/t1/stop"]);
    assert.deepEqual(unexpected, []);
  } finally {
    for (const stream of streams) stream.end();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.basename(temporary).startsWith("agenthub-subtasks-browser-"));
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const browserExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function runBrowser(temp, url) {
  const profile = path.join(temp, "profile");
  const child = spawn(browserExecutable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true });
  let stderr = "", socket;
  child.stderr.on("data", (chunk) => stderr += chunk);
  const closed = new Promise((resolve) => child.on("exit", resolve));
  try {
    const deadline = Date.now() + 10000;
    let port;
    while (!port) {
      if (Date.now() > deadline) throw Error("Browser launch timeout: " + stderr);
      port = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").then((value) => Number(value.split("\n")[0]), () => null);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then((res) => res.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map(), errors = [];
    let id = 0;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
      }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
      if (message.method === "Runtime.bindingCalled" && message.params.name === "__captureFixture") {
        capture(message.params.payload).then(() => evaluate("window.__captureResolve(true)"), (error) => errors.push(error.message));
      }
    });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(Error("DevTools timed out: " + method + "\n" + errors.join("\n"))), 30000);
      pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + "\nBrowser errors:\n" + errors.join("\n"));
      return result.result.value;
    };
    const capture = async (name) => {
      assert.match(name, /^[a-z-]+$/);
      const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await fs.mkdir(path.join(projectRoot, "data/mcp-qa"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, "data/mcp-qa", name + ".png"), Buffer.from(screenshot.data, "base64"));
    };
    await command("Runtime.enable"); await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => {
      const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } };
      socket.addEventListener("message", listener);
    });
    await command("Page.navigate", { url }); await loaded; await command("Page.bringToFront");
    await command("Runtime.addBinding", { name: "__captureFixture" });
    await evaluate("window.captureFixture = name => new Promise(resolve => { window.__captureResolve = resolve; window.__captureFixture(name); })");
    const checks = await evaluate(await fs.readFile(new URL("./fixtures/mcp-dialog-browser.js.txt", import.meta.url), "utf8"));
    await evaluate("document.querySelector('.mcp-tools').open = true");
    await capture("desktop");
    // A trusted key event exercises Chromium's native dialog cancellation as well as the app's Escape handler.
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    const escaped = await evaluate(`(async () => {
      const end = Date.now() + 3000;
      while (document.getElementById('mcp-dialog').open && Date.now() < end) await new Promise(r => setTimeout(r, 20));
      return { open: document.getElementById('mcp-dialog').open, requests: await fetch('/fixture/requests').then(r => r.json()) };
    })()`);
    assert.equal(escaped.open, false, "Escape closes MCP dialog");
    assert.ok(!escaped.requests.some((request) => /\/(pause|stop)$/.test(request.path) && request.method === "POST"), "Escape in MCP dialog must not pause a running session");
    checks.push("native Escape closes dialog without pausing the running session");
    await evaluate(`(async () => { document.getElementById('s-prompt').value = '/mcp'; document.getElementById('s-form').requestSubmit(); while (document.getElementById('mcp-refresh').disabled) await new Promise(r => setTimeout(r, 20)); document.querySelector('.mcp-tools').open = true; })()`);
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
      const dialog = document.getElementById('mcp-dialog'), rect = dialog.getBoundingClientRect();
      resolve({ width: innerWidth, page: document.documentElement.scrollWidth, dialog: dialog.clientWidth, content: dialog.scrollWidth, left: rect.left, right: rect.right });
    }))`);
    assert.equal(mobile.width, 390);
    assert.ok(mobile.page <= 390 && mobile.content <= mobile.dialog + 1 && mobile.left >= 0 && mobile.right <= 390, JSON.stringify(mobile));
    await capture("mobile");
    checks.push("390px viewport contains long MCP names, tools, errors, and actions");
    await fs.writeFile(path.join(projectRoot, "data/mcp-qa/checks.json"), JSON.stringify({ checks, errors }, null, 2));
    return { checks, errors };
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

// Serves the real frontend against fixture-only HTTP/SSE APIs. Never starts a CLI or opens the application store.
test("browser: unread results and local MCP command, capabilities, recovery, stale responses, and modal behavior", { timeout: 60000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-mcp-browser-"));
  const streams = new Set(), requests = [], held = new Map();
  const project = { path: "C:/fixture", name: "Fixture", claude: 0, codex: 0, registered: true };
  const session = (id, title, agent = "codex") => ({ id, title, agent, projectPath: project.path, projectName: project.name, cwd: project.path, permission: "workspace-write", state: "idle", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", skills: [], events: [], queue: [], lastResultSeq: -1, readResultSeq: -1, unread: false });
  const sessions = [session("s1", "First"), session("s2", "Second", "claude")];
  Object.assign(sessions[1], { state: "running", runningStartedAt: new Date().toISOString(), lastResultSeq: 2, unread: true, events: [
    { seq: 0, kind: "user", text: "Earlier request" }, { seq: 1, kind: "text", text: "Completed answer awaiting review" }, { seq: 2, kind: "result", text: "Earlier turn completed" },
  ] });
  const agents = Object.fromEntries(["claude", "codex"].map((name) => [name, { path: null, autoPath: null, models: [{ id: "test", label: "Test", efforts: ["medium"] }], efforts: ["medium"], permissions: ["read-only", "workspace-write"] }]));
  const injection = '<img src=x onerror="window.mcpInjected=true">';
  const servers = ["connected", "failed", "needs-auth", "pending", "disabled", "disconnected", "unknown", "future-status"].map((status, index) => ({
    name: index === 0 ? "fixture-" + "long-server-name-".repeat(8) : status,
    status, authStatus: ["authenticated", "unauthenticated", "not-authenticated", "not-required", "unsupported", "unknown", "bearerToken", "oAuth"][index],
    tools: index === 0 ? [{ name: injection + "long-tool-name-".repeat(8), description: "Tool description " + injection + "x".repeat(200) }] : [],
    ...(status === "failed" ? { error: "Connection failed " + injection + "x".repeat(200) } : {}),
  }));
  const original = { live: true, checkedAt: "2026-10-23T05:00:00Z", servers, actions: { reconnect: true, reload: true }, message: "Fixture MCP snapshot" };
  const mode = { snapshot: structuredClone(original), getError: false, actionError: false, hold: null, actionMessage: "Exact action result <not markup>" };
  const emit = (type, payload) => { for (const stream of streams) stream.write("event: " + type + "\ndata: " + JSON.stringify(payload) + "\n\n"); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      requests.push({ method: req.method, path: url.pathname, body });
      res.setHeader("Cache-Control", "no-store");
      let value;
      if (url.pathname === "/fixture/mode") { if (body.reset) mode.snapshot = structuredClone(original); Object.assign(mode, body); value = {}; }
      else if (url.pathname === "/fixture/requests") value = requests;
      else if (url.pathname === "/fixture/held") value = [...held.keys()];
      else if (url.pathname === "/fixture/release") { held.get(body.key)?.(); held.delete(body.key); value = {}; }
      else if (url.pathname === "/fixture/emit") {
        const s = sessions.find((entry) => entry.id === body.payload.sessionId);
        if (body.type === "state") Object.assign(s, body.payload);
        if (body.type === "event") {
          s.events.push(body.payload.event);
          if (body.payload.event.kind === "result") { s.lastResultSeq = body.payload.event.seq; s.unread = s.lastResultSeq > s.readResultSeq; }
        }
        if (body.type === "session-read") Object.assign(s, body.payload);
        emit(body.type, body.payload); value = {};
      }
      else if (url.pathname === "/api/status") value = { agents, projects: [project], cliOverrides: { claude: "", codex: "" }, linkConditions: [{ id: "success", label: "Success" }] };
      else if (url.pathname === "/api/sessions") {
        if (req.method === "POST") { const s = { ...session("chat" + sessions.length, body.title, body.agent), ...body, projectPath: null, chat: true }; sessions.push(s); value = s; }
        else value = sessions;
      }
      else if (url.pathname.startsWith("/api/sessions/")) {
        const parts = url.pathname.split("/"), s = sessions.find((entry) => entry.id === parts[3]);
        if (!s) throw Error("Unknown fixture session");
        if (parts[4] === "mcp") {
          const action = parts[5];
          value = action ? { message: mode.actionMessage } : { agent: s.agent, ...structuredClone(mode.snapshot) };
          const errorKey = action ? "actionError" : "getError";
          const failure = mode[errorKey]; mode[errorKey] = false;
          if (mode.hold?.type === (action ? "action" : "get")) {
            const key = mode.hold.key; mode.hold = null;
            res.setHeader("Content-Type", "application/json");
            if (failure) res.statusCode = 400;
            res.flushHeaders();
            await new Promise((resolve) => held.set(key, resolve));
          }
          if (failure) throw Error(typeof failure === "string" ? failure : `fixture ${action ? "action" : "GET"} failure`);
        }
        else if (parts[4] === "read") { s.readResultSeq = Math.max(s.readResultSeq, body.seq); s.unread = s.lastResultSeq > s.readResultSeq; value = { sessionId: s.id, lastResultSeq: s.lastResultSeq, readResultSeq: s.readResultSeq, unread: s.unread }; emit("session-read", value); }
        else if (parts[4] === "messages") { const event = { seq: s.events.length, kind: "user", text: body.prompt }; s.events.push(event); emit("event", { sessionId: s.id, event }); value = { queued: false }; }
        else if (parts[4] === "queue") value = s.queue;
        else if (parts[4] === "pause" || parts[4] === "stop" || parts[4] === "attachments") throw Error("MCP command must not modify execution or upload drafts");
        else value = s;
      }
      else if (url.pathname === "/api/projects/all") value = [project];
      else if (["/api/projects/discover", "/api/links", "/api/skills", "/api/messages"].includes(url.pathname)) value = [];
      else if (url.pathname === "/api/commands") value = { shells: [], commands: [] };
      else if (url.pathname === "/api/graph-tabs") value = { tabs: [{ id: "default", title: "Main", projectPath: project.path }], defaultTabId: "default" };
      else if (url.pathname === "/api/node-groups") value = { groups: [] };
      else if (url.pathname === "/api/runs") value = { runs: [] };
      else if (url.pathname === "/api/account") value = { connected: false };
      else if (url.pathname === "/api/limits") value = { claude: { windows: [] }, codex: { windows: [] } };
      else if (url.pathname === "/api/auth") value = { claude: false, codex: false };
      else if (url.pathname === "/api/setup") value = { tools: [], jobs: {} };
      else if (url.pathname === "/api/update") value = { current: "0.2.0", desktop: false };
      else if (url.pathname.startsWith("/api/")) throw Error("Unexpected fixture request " + req.method + " " + req.url);
      else {
        const target = path.resolve(projectRoot, "public", "." + (url.pathname === "/" ? "/index.html" : url.pathname));
        if (!target.startsWith(path.resolve(projectRoot, "public") + path.sep)) throw Error("Unsafe fixture path");
        res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "text/html"); res.end(await fs.readFile(target)); return;
      }
      if (!res.headersSent) res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    } catch (error) { if (!res.headersSent) { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); } res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const report = await runBrowser(temp, "http://127.0.0.1:" + server.address().port);
    assert.ok(report.checks.length >= 25, JSON.stringify(report.checks));
    assert.deepEqual(report.errors, []);
    assert.ok(!requests.some((request) => /^\/api\/sessions\/s[12]\/(messages|queue|attachments|pause|stop)$/.test(request.path) && request.method === "POST"));
    t.diagnostic(`${report.checks.length} browser checks passed; screenshots and report: data/mcp-qa`);
  } finally {
    for (const release of held.values()) release();
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

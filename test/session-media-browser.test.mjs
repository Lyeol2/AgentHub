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
  let stderr = "";
  child.stderr.on("data", (chunk) => stderr += chunk);
  const closed = new Promise((resolve) => child.on("exit", resolve));
  let socket;
  try {
    const deadline = Date.now() + 10000;
    let port;
    while (!port) {
      if (Date.now() > deadline) throw Error("Browser launch timeout: " + stderr);
      port = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").then((s) => Number(s.split("\n")[0]), () => null);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const target = await fetch("http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((res) => res.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map(), errors = [], messages = [];
    let id = 0;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data); messages.push(message);
      if (message.id) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result); }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; const timer = setTimeout(() => reject(Error("DevTools timed out: " + method + "\n" + errors.join("\n") + "\nMessages " + JSON.stringify(messages) + "\nLog " + stderr)), 15000); pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id: requestId, method, params })); });
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => { const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } }; socket.addEventListener("message", listener); });
    await command("Page.navigate", { url }); await loaded;
    await command("Page.bringToFront");
    const expression = await fs.readFile(new URL("./fixtures/session-media-browser.js.txt", import.meta.url), "utf8");
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + "\nBrowser errors:\n" + errors.join("\n"));
    await fs.mkdir(path.join(projectRoot, "data/session-media-qa"), { recursive: true });
    const desktop = await command("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(projectRoot, "data/session-media-qa/desktop.png"), Buffer.from(desktop.data, "base64"));
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await command("Runtime.evaluate", { expression: "new Promise(resolve => requestAnimationFrame(() => resolve({width: innerWidth, scroll: document.documentElement.scrollWidth, composer: document.querySelector('#s-form').getBoundingClientRect().right})))", awaitPromise: true, returnByValue: true });
    assert.equal(mobile.result.value.width, 390);
    assert.ok(mobile.result.value.scroll <= 390, JSON.stringify(mobile.result.value));
    await command("Runtime.evaluate", { expression: "new Promise(resolve => { document.querySelector('#s-form').scrollIntoView({block: 'end'}); requestAnimationFrame(() => resolve(true)); })", awaitPromise: true });
    const screen = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await fs.writeFile(path.join(projectRoot, "data/session-media-qa/mobile.png"), Buffer.from(screen.data, "base64"));
    return { checks: [...result.result.value, "mobile viewport fits"], errors };
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}


// Fixture-only session media flows: no CLI processes or application data store.
test("browser: session attachments, clipboard races, draft isolation, export, permissions, and completed conversation folding", { timeout: 45000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-media-browser-"));
  const streams = new Set(), requests = [], uploads = new Map(), uploadData = new Map();
  const project = { path: "C:/fixture", name: "Fixture", claude: 0, codex: 0, registered: true };
  const session = (id, title, agent = "codex") => ({ id, title, agent, projectPath: project.path, projectName: project.name, cwd: project.path, permission: "workspace-write", state: "idle", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", skills: [], events: [], queue: [] });
  const sessions = [session("s1", "First"), session("s2", "Second", "claude")];
  const agents = Object.fromEntries(["claude", "codex"].map((name) => [name, { path: null, autoPath: null, models: [{ id: "test", label: "Test", efforts: ["medium"] }], efforts: ["medium"], permissions: ["read-only", "workspace-write"] }]));
  const mode = { uploadError: false, messageError: false, exportError: false, holdUpload: false };
  let releaseUpload;
  const emit = (type, payload) => { for (const stream of streams) stream.write("event: " + type + "\ndata: " + JSON.stringify(payload) + "\n\n"); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      requests.push({ method: req.method, path: url.pathname, body });
      let value;
      if (url.pathname === "/fixture/emit") {
        if (body.type === "state") Object.assign(sessions.find((s) => s.id === body.payload.sessionId), body.payload);
        if (body.type === "event") sessions.find((s) => s.id === body.payload.sessionId).events.push(body.payload.event);
        emit(body.type, body.payload); value = {};
      } else if (url.pathname === "/fixture/mode") { Object.assign(mode, body); value = {}; }
      else if (url.pathname === "/fixture/release") { releaseUpload?.(); value = {}; }
      else if (url.pathname === "/fixture/requests") value = requests;
      else if (url.pathname === "/api/status") value = { agents, projects: [project], cliOverrides: { claude: "", codex: "" }, linkConditions: [{ id: "success", label: "성공 시" }] };
      else if (url.pathname === "/api/sessions") {
        if (req.method === "POST") { const s = { ...session("chat" + sessions.length, body.title, body.agent), ...body, projectPath: null, chat: true }; sessions.push(s); value = s; }
        else value = sessions;
      } else if (url.pathname.startsWith("/api/sessions/")) {
        const parts = url.pathname.split("/"), s = sessions.find((s) => s.id === parts[3]);
        if (parts[4] === "attachments" && req.method === "POST") {
          if (mode.holdUpload) { mode.holdUpload = false; await new Promise((resolve) => releaseUpload = resolve); }
          if (mode.uploadError) { mode.uploadError = false; throw Error("fixture upload failure"); }
          const attachment = { id: "img" + uploads.size, name: body.name, mimeType: body.mimeType, size: 68, url: "/api/sessions/" + s.id + "/attachments/img" + uploads.size };
          uploads.set(attachment.id, attachment); uploadData.set(attachment.id, Buffer.from(body.data, "base64")); value = attachment;
        } else if (parts[4] === "attachments") { res.setHeader("Content-Type", uploads.get(parts[5]).mimeType); res.end(uploadData.get(parts[5])); return; }
        else if (parts[4] === "messages") {
          if (mode.messageError) { mode.messageError = false; throw Error("fixture message failure"); }
          const attachments = (body.attachments ?? []).map((id) => uploads.get(id));
          if (body.mode === "queue") { s.queue.push({ id: "q" + s.queue.length, text: body.prompt, user: true, attachments }); emit("queue", { sessionId: s.id }); value = { queued: true }; }
          else { const event = { seq: s.events.length, kind: "user", text: body.prompt, attachments }; s.events.push(event); emit("event", { sessionId: s.id, event }); value = { queued: false }; }
        } else if (parts[4] === "export") { if (mode.exportError) { mode.exportError = false; throw Error("fixture export failure"); } value = { path: "C:/fixture/docs/agenthub/first.md", relativePath: "docs/agenthub/first.md", format: "markdown" }; }
        else if (parts[4] === "permissions") value = {};
        else value = s;
      }
      else if (url.pathname === "/api/projects/all") value = [project];
      else if (url.pathname === "/api/projects/discover" || url.pathname === "/api/links" || url.pathname === "/api/skills" || url.pathname === "/api/messages") value = [];
      else if (url.pathname === "/api/commands") value = { shells: [], commands: [] };
      else if (url.pathname === "/api/limits") value = { claude: { windows: [] }, codex: { windows: [] } };
      else if (url.pathname === "/api/auth") value = { claude: false, codex: false };
      else if (url.pathname === "/api/setup") value = { tools: [], jobs: {} };
      else if (url.pathname === "/api/update") value = { current: "0.2.0", desktop: false };
      else if (url.pathname.startsWith("/api/")) throw Error("Unexpected fixture request " + req.method + " " + req.url);
      else {
        const target = path.resolve(projectRoot, "public", "." + (url.pathname === "/" ? "/index.html" : url.pathname));
        if (!target.startsWith(path.resolve(projectRoot, "public") + path.sep)) throw Error("Unsafe fixture path");
        const content = await fs.readFile(target); res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "text/html"); res.end(content); return;
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const report = await runBrowser(temp, "http://127.0.0.1:" + server.address().port);
    assert.ok(report?.checks.length >= 20); assert.deepEqual(report.errors, []);
    assert.ok(!requests.some((request) => /\/(run|stop)$/.test(request.path) && request.method === "POST"));
    await fs.writeFile(path.join(projectRoot, "data/session-media-qa/checks.json"), JSON.stringify(report, null, 2));
  } finally {
    releaseUpload?.(); for (const stream of streams) stream.end();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

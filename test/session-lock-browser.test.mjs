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
  const process = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true });
  let stderr = "";
  process.stderr.on("data", (chunk) => stderr += chunk);
  const closed = new Promise((resolve) => process.on("exit", resolve));
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
      const requestId = ++id, timer = setTimeout(() => reject(Error(`DevTools timeout: ${method}\n${errors.join("\n")}`)), 15000);
      pending.set(requestId, { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const navigate = async () => {
      const loaded = new Promise((resolve) => {
        const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } };
        socket.addEventListener("message", listener);
      });
      await command("Page.navigate", { url });
      await loaded;
    };
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate();
    const checks = await evaluate(await fs.readFile(new URL("./fixtures/session-lock-browser.js.txt", import.meta.url), "utf8"));
    // A stale list can still report unlocked while detail has already become locked.
    await evaluate(`fetch('/fixture/stale', {method:'POST'}).then(() => true)`);
    await navigate();
    const stale = await evaluate(`(async () => {
      const end = Date.now() + 8000;
      while (document.getElementById('view-project').hidden || !document.querySelector('.gcard.locked')) {
        if (Date.now() > end) throw Error('Locked detail response did not recover the popup');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return { popup: document.body.classList.contains('popup'), events: document.getElementById('s-events').textContent, sessionHidden: document.getElementById('view-session').hidden };
    })()`);
    assert.deepEqual(stale, { popup: false, events: "", sessionHidden: true });
    assert.deepEqual(errors, []);
    return checks;
  } finally {
    socket?.close();
    process.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

test("browser: locked direct popup URLs, sidebar/table toggles, and disabled chat open actions", { timeout: 45000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chrome).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-lock-browser-"));
  const project = { path: "C:/fixture", name: "Fixture", claude: 0, codex: 0, registered: true };
  const session = { id: "s1", title: "Locked session", agent: "codex", locked: true, state: "idle", permission: "workspace-write", projectName: project.name, projectPath: project.path, cwd: project.path, createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", skills: [], events: [{ seq: 0, kind: "text", text: "Private fixture conversation" }], queue: [] };
  const agents = Object.fromEntries(["claude", "codex"].map((agent) => [agent, { models: [], efforts: [], permissions: ["workspace-write"] }]));
  const streams = new Set(), updates = [], denied = [];
  let staleList = false;
  let heldMode, detailStarted, markDetailStarted, releaseDetail;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      if (url.pathname.startsWith("/api/")) {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      let value;
      if (url.pathname === "/fixture/stale") { session.locked = true; staleList = true; value = {}; }
      else if (url.pathname === "/fixture/hold-detail") {
        heldMode = body.mode;
        session.locked = heldMode === "locked";
        detailStarted = new Promise((resolve) => { markDetailStarted = resolve; });
        value = {};
      } else if (url.pathname === "/fixture/await-detail") { await detailStarted; value = {}; }
      else if (url.pathname === "/fixture/release-detail") { releaseDetail?.(); releaseDetail = null; value = {}; }
      else if (url.pathname === "/api/status") value = { agents, projects: [project], cliOverrides: {}, linkConditions: [] };
      else if (url.pathname === "/api/sessions") { value = [{ ...session, events: undefined, locked: staleList ? false : session.locked }]; staleList = false; }
      else if (url.pathname === "/api/sessions/s1") {
        if (req.method === "PUT") { updates.push(body); Object.assign(session, body); value = session; }
        else {
          if (session.locked) { denied.push(url.pathname); res.statusCode = 423; value = { error: "잠긴 세션입니다.", reason: "locked" }; }
          else value = structuredClone(session);
          if (heldMode) {
            heldMode = null;
            res.setHeader("X-Fixture-Held", "1");
            res.flushHeaders();
            await new Promise((resolve) => { releaseDetail = resolve; markDetailStarted(); });
          }
        }
      } else if (url.pathname === "/api/projects/all") value = [project];
      else if (["/api/projects/discover", "/api/links", "/api/skills", "/api/messages"].includes(url.pathname)) value = [];
      else if (url.pathname === "/api/commands") value = { shells: [], commands: [] };
      else if (url.pathname === "/api/graph-tabs") value = { tabs: [{ id: "tab-default", title: "기본", projectPath: project.path, order: 0 }], defaultTabId: "tab-default" };
      else if (url.pathname === "/api/limits") value = { claude: { windows: [] }, codex: { windows: [] } };
      else if (url.pathname === "/api/auth") value = { claude: false, codex: false };
      else if (url.pathname === "/api/setup") value = { tools: [], jobs: {} };
      else if (url.pathname === "/api/update") value = { current: "0.2.0", desktop: false };
      else if (url.pathname.startsWith("/api/")) throw Error("Unexpected fixture API: " + url.pathname);
      else {
        const publicRoot = path.resolve(root, "public");
        const file = path.resolve(publicRoot, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
        if (!file.startsWith(publicRoot + path.sep)) throw Error("Unsafe static fixture path");
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html");
        res.end(await fs.readFile(file)); return;
      }
      if (!res.headersSent) res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const checks = await browser(path.join(temporary, "profile"), `http://127.0.0.1:${server.address().port}/?session=s1`).catch((error) => {
      error.message += "\nFixture lock updates: " + JSON.stringify(updates);
      throw error;
    });
    assert.ok(checks.length >= 8, JSON.stringify(checks));
    assert.deepEqual(updates, [{ locked: false }, { locked: true }, { locked: false }, { locked: true }, { locked: false }, { locked: false }, { locked: true }]);
    assert.ok(denied.length >= 1, "Stale summary must be rejected by the detail API");
  } finally {
    releaseDetail?.();
    for (const stream of streams) stream.end();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("agenthub-lock-browser-"));
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

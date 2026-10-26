import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";
import { serveStatic } from "../server/transport/http.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const browserExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";

test("browser: Mermaid renders offline with isolated SVG, source and error fallback", { timeout: 60000 }, async (t) => {
  if (!await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Chrome required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-mermaid-"));
  const server = http.createServer((req, res) => {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><meta charset="utf-8"><title>Mermaid</title><body style="background:#222;color:white;max-width:760px;margin:24px auto"><h1>채팅 다이어그램</h1>'); }
    else serveStatic(req, res, path.join(projectRoot, "public"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const report = await runBrowser(temp, `http://127.0.0.1:${server.address().port}`);
    assert.ok(report.checks.length >= 6);
    assert.deepEqual(report.errors, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

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
    const expression = await fs.readFile(new URL("./fixtures/mermaid-browser.js.txt", import.meta.url), "utf8");
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + "\nBrowser errors:\n" + errors.join("\n"));
    await fs.mkdir(path.join(projectRoot, "data/mermaid-qa"), { recursive: true });
    const desktop = await command("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(projectRoot, "data/mermaid-qa/desktop.png"), Buffer.from(desktop.data, "base64"));
    return { checks: result.result.value, errors };
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}



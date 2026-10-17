import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const browser = "C:/Program Files/Google/Chrome/Application/chrome.exe";

test("browser: workspace context, Git previews, protected history, push and recovery", { timeout: 45000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browser).then(() => true, () => false)) return t.skip("Installed Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-git-ui-"));
  // Only static assets are served. The browser injects fixture API responses; no Git or agent process is run.
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const filename = path.resolve(publicRoot, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!filename.startsWith(publicRoot)) throw Error("Unsafe path");
      let body = await fs.readFile(filename);
      if (url.pathname === "/") body = body.toString("utf8").replace(/<script type="module"[^>]+><\/script>/g, "");
      res.setHeader("Content-Type", filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".svg") ? "image/svg+xml" : "text/html");
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + path.join(temp, "profile"), "about:blank"], { windowsHide: true });
  const closed = new Promise(resolve => child.on("exit", resolve));
  let socket, stderr = "";
  child.stderr.on("data", chunk => stderr += chunk);
  try {
    const end = Date.now() + 10000;
    let port;
    while (!port) {
      if (Date.now() > end) throw Error("Browser timeout " + stderr);
      port = await fs.readFile(path.join(temp, "profile", "DevToolsActivePort"), "utf8").then(s => Number(s.split("\n")[0]), () => null);
      if (!port) await new Promise(resolve => setTimeout(resolve, 30));
    }
    const target = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" }).then(res => res.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const pending = new Map(), errors = [];
    let id = 0;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(Error(message.error.message)) : p.resolve(message.result); }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(" "));
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id, timer = setTimeout(() => reject(Error("CDP timeout: " + method)), 20000);
      pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
    await command("Runtime.enable"); await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise(resolve => { const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } }; socket.addEventListener("message", listener); });
    await command("Page.navigate", { url: "http://127.0.0.1:" + server.address().port }); await loaded;
    const expression = await fs.readFile(new URL("./fixtures/git-operations-browser.js.txt", import.meta.url), "utf8");
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text);
    assert.ok(result.result.value.length >= 20, JSON.stringify(result.result.value));
    assert.deepEqual(errors, []);
    for (const width of [1280, 390]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const layout = await command("Runtime.evaluate", { expression: `new Promise(resolve => requestAnimationFrame(() => { const dialog = document.getElementById('g-operation-dialog'); const r = dialog.getBoundingClientRect(); resolve({ left: r.left, right: r.right, width: dialog.scrollWidth, client: dialog.clientWidth }); }))`, awaitPromise: true, returnByValue: true });
      const size = layout.result.value;
      assert.ok(size.left >= 0 && size.right <= width && size.width <= size.client + 1, "Dialog fits viewport " + JSON.stringify({ width, ...size }));
    }
    if (process.env.AGENTHUB_GIT_SCREENSHOT) {
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(process.env.AGENTHUB_GIT_SCREENSHOT, Buffer.from(data, "base64"));
      // 창을 닫은 넓은 화면: 도구 막대와 왼쪽 탐색 배치를 확인한다.
      await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await command("Runtime.evaluate", { expression: "new Promise(resolve => { document.getElementById('g-operation-dialog').close(); document.body.style.display = 'block'; document.getElementById('g-tab-changes').click(); document.querySelector('#g-unstaged .link')?.click(); requestAnimationFrame(() => requestAnimationFrame(resolve)); })", awaitPromise: true });
      const wide = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(process.env.AGENTHUB_GIT_SCREENSHOT.replace(/\.png$/, "-wide.png"), Buffer.from(wide.data, "base64"));
    }
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

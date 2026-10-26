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
      if (message.method === "Page.javascriptDialogOpening") { errors.push(message.params.message); socket.send(JSON.stringify({ id: ++id, method: "Page.handleJavaScriptDialog", params: { accept: true } })); }
      if (message.id && pending.has(message.id)) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result); }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; const timer = setTimeout(() => reject(Error("DevTools timed out: " + method + "\n" + errors.join("\n") + "\nMessages " + JSON.stringify(messages) + "\nLog " + stderr)), 15000); pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id: requestId, method, params })); });
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => { const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } }; socket.addEventListener("message", listener); });
    await command("Page.navigate", { url }); await loaded;
    const expression = await fs.readFile(new URL("./fixtures/frontend-browser.js.txt", import.meta.url), "utf8");
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + "\nBrowser errors:\n" + errors.join("\n"));
    for (const [width, height] of [[900, 600], [1400, 900]]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      const layout = await command("Runtime.evaluate", { expression: `new Promise(resolve => requestAnimationFrame(() => {
        const graph = document.getElementById("p-graph").getBoundingClientRect();
        const tabs = document.getElementById("p-graph-tabs").getBoundingClientRect();
        const toolbar = document.getElementById("p-flow-assistant").getBoundingClientRect();
        const content = document.querySelector("#view-project > .content");
        const bottom = content.getBoundingClientRect().bottom - parseFloat(getComputedStyle(content).paddingBottom);
        resolve({ height: graph.height, bottom: toolbar.bottom, graphGap: Math.abs(graph.bottom - tabs.top), tabsGap: Math.abs(tabs.bottom - toolbar.top), tabsHeight: tabs.height, toolbarHeight: toolbar.height, expectedBottom: bottom - 1, right: graph.right, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight });
      }))`, awaitPromise: true, returnByValue: true });
      const bounds = layout.result.value;
      assert.ok(bounds.height > 100 && bounds.tabsHeight > 0 && bounds.graphGap < 2 && bounds.tabsGap < 2 && Math.abs(bounds.bottom - bounds.expectedBottom) < 2, "Graph fills resized window above its tabs and toolbar: " + JSON.stringify({ width, height, ...bounds }));
      assert.ok(bounds.right <= width && bounds.documentWidth <= width && bounds.documentHeight <= height, "Panels stay inside resized window");
      const sidebar = await command("Runtime.evaluate", { expression: `(() => {
        const foot = document.querySelector('.sidebar-foot').getBoundingClientRect();
        const list = document.getElementById('session-list').getBoundingClientRect();
        return { foot: foot.height, bottom: foot.bottom, list: list.height, listBottom: list.bottom };
      })()`, returnByValue: true });
      assert.ok(sidebar.result.value.foot < 125 && sidebar.result.value.bottom <= height && sidebar.result.value.list > 100 && sidebar.result.value.listBottom <= sidebar.result.value.bottom - sidebar.result.value.foot, "Sidebar reserves visible list space at short window heights: " + JSON.stringify(sidebar.result.value));
      if (process.env.AGENTHUB_UI_SCREENSHOT && width === 900) {
        const { data } = await command("Page.captureScreenshot", { format: "png" });
        await fs.writeFile(process.env.AGENTHUB_UI_SCREENSHOT.replace(/\.png$/, "-short.png"), Buffer.from(data, "base64"));
      }
    }
    if (process.env.AGENTHUB_UI_SCREENSHOT) {
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(process.env.AGENTHUB_UI_SCREENSHOT, Buffer.from(data, "base64"));
    }
    const compact = await command("Runtime.evaluate", { expression: `new Promise(resolve => {
      document.getElementById('sidebar-resizer').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}));
      document.getElementById('sidebar-status-toggle').click();
      requestAnimationFrame(() => {
        const sidebar = document.getElementById('sidebar').getBoundingClientRect();
        const panel = document.getElementById('sidebar-status').getBoundingClientRect();
        const mini = document.getElementById('limit-mini');
        resolve(sidebar.width === 180 && panel.width > 0 && panel.left >= sidebar.left && panel.right <= sidebar.right && mini.scrollWidth <= mini.clientWidth);
      });
    })`, awaitPromise: true, returnByValue: true });
    assert.equal(compact.result.value, true, "Compact controls and update details fit the minimum sidebar width");
    if (process.env.AGENTHUB_UI_SCREENSHOT) {
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(process.env.AGENTHUB_UI_SCREENSHOT.replace(/\.png$/, "-details.png"), Buffer.from(data, "base64"));
    }
    await command("Runtime.evaluate", { expression: `document.querySelector('[data-sidebar-section="projects"]').click(); document.querySelector('[data-sidebar-section="sessions"]').click()` });
    const reloaded = new Promise((resolve) => { const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } }; socket.addEventListener("message", listener); });
    await command("Page.reload"); await reloaded;
    const restored = await command("Runtime.evaluate", { expression: `new Promise((resolve, reject) => {
      const end = Date.now() + 8000;
      const check = () => {
        const toggle = document.querySelector('[data-sidebar-section="projects"]');
        if (toggle?.getAttribute('aria-expanded') === 'false') return resolve(document.getElementById('project-nav').hidden && document.getElementById('session-list').hidden && document.getElementById('session-filter').hidden);
        if (Date.now() > end) return reject(Error('Collapsed sections were not restored after reload'));
        setTimeout(check, 20);
      }; check();
    })`, awaitPromise: true, returnByValue: true });
    assert.equal(restored.result.value, true, "Section preferences survive a full page reload");
    return { checks: result.result.value, errors };
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}


// All APIs are fixture responses. No CLI, Git, or user-data store is accessed.
test("browser: feature composition, graph gestures, Git, settings, and live session updates", { timeout: 45000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-browser-"));
  const streams = new Set(), requests = [];
  const setupMode = { refreshFailure: false };
  let cliAutoUpdate = true, updateAttempt = 0, releaseUpdate;
  const project = { path: "C:/fixture", name: "Fixture", claude: 0, codex: 0, registered: true };
  const session = (id, title, agent = "codex") => ({ id, title, agent, projectPath: project.path, projectName: project.name, cwd: project.path, state: "idle", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", baseCommit: "a".repeat(40), skills: [], events: id === "s1" ? [{ seq: 0, kind: "text", text: "Hello **world**" }] : [], graphPos: { x: id === "s1" ? 20 : 360, y: 20 }, queue: [] });
  const sessions = [session("s1", "First"), session("s2", "Second", "claude")];
  const agents = Object.fromEntries(["claude", "codex"].map((name) => [name, { path: null, autoPath: null, models: [{ id: "test", label: "Test", efforts: ["medium"] }], efforts: ["medium"], permissions: name === "claude" ? ["default", "acceptEdits"] : ["read-only", "workspace-write"] }]));
  const setup = {
    winget: { id: "winget", label: "Windows 패키지 관리자 (winget)", path: null, version: null, installable: true,
      manual: { links: [{ label: "Microsoft 공식 설치 안내", url: "https://learn.microsoft.com/windows/package-manager/winget/" }], command: "Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe", note: "PowerShell에서 직접 설치할 수 있습니다." } },
    tools: [{ id: "codex", label: "Codex", path: "C:/fixture/codex.cmd", version: null, loggedIn: true, installable: true, updatable: false, updateReason: "Fixture installation method is not verified",
      manual: { links: [{ label: "Codex 공식 설치 안내", url: "https://developers.openai.com/codex/cli/" }], command: "npm install -g @openai/codex", note: "Node.js를 설치한 뒤 실행하세요." } }],
    jobs: { codex: { kind: "install", state: "error", log: "Fixture install failed" } },
  };
  const emit = (type, payload) => { for (const stream of streams) stream.write("event: " + type + "\ndata: " + JSON.stringify(payload) + "\n\n"); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      requests.push({ method: req.method, path: url.pathname, search: url.search, body });
      if (url.pathname === "/fixture/emit") { emit(body.type, body.payload ?? {}); res.end("{}"); return; }
      if (url.pathname === "/fixture/requests") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(requests)); return; }
      if (url.pathname === "/fixture/setup-mode") {
        Object.assign(setupMode, body);
        if (body.updateReady) {
          Object.assign(setup.tools[0], { version: "codex 1.0.0", updatable: true, updateReason: "" });
          Object.assign(agents.codex, { path: setup.tools[0].path, autoPath: setup.tools[0].path, version: "1.0.0" });
          delete setup.jobs.codex;
        }
        res.end("{}"); return;
      }
      if (url.pathname === "/fixture/release-update") { releaseUpdate?.(); releaseUpdate = null; res.end("{}"); return; }
      if (setupMode.refreshFailure && url.searchParams.get("fresh") === "1" && ["/api/status", "/api/auth", "/api/setup"].includes(url.pathname)) {
        throw Error("Fixture " + url.pathname.split("/").at(-1) + " refresh failed");
      }
      let value;
      if (url.pathname === "/api/status") value = { agents, projects: [project], cliOverrides: { claude: "", codex: "" }, cliAutoUpdate, linkConditions: [{ id: "success", label: "성공 시" }] };
      else if (url.pathname === "/api/settings" && req.method === "PUT") { cliAutoUpdate = body.cliAutoUpdate; value = { cliAutoUpdate }; }
      else if (url.pathname === "/api/sessions") {
        if (req.method === "POST") {
          value = { ...session("created-" + sessions.length, body.title, body.agent), ...body };
          if (body.isolate) {
            value.cwd = "C:/fixture.agenthub/" + body.worktreeName;
            value.worktree = { branch: "agenthub/" + body.worktreeName };
          }
          sessions.push(value);
        } else value = sessions;
      }
      else if (/^\/api\/sessions\/[^/]+\/diff$/.test(url.pathname)) value = { status: "M fixture.txt", diff: "+fixture change" };
      else if (url.pathname.startsWith("/api/sessions/")) {
        const s = sessions.find((s) => s.id === url.pathname.split("/")[3]);
        if (req.method === "GET" && s.locked) { res.statusCode = 423; value = { error: "잠긴 세션입니다.", reason: "locked" }; }
        else { if (req.method === "PUT") Object.assign(s, body); if (req.method === "DELETE") sessions.splice(sessions.indexOf(s), 1); value = s; }
      }
      else if (url.pathname === "/api/projects/all") value = [project];
      else if (url.pathname === "/api/projects/discover") value = [];
      else if (url.pathname === "/api/links") value = [{ id: "l1", from: "s1", to: "s2", enabled: true, when: "success" }];
      else if (url.pathname === "/api/graph-tabs") value = { tabs: [{ id: "tab-default", title: "기본", projectPath: project.path, order: 0 }], defaultTabId: "tab-default" };
      else if (url.pathname === "/api/flow-assistant/plan") value = { summary: "리뷰 세션을 붙입니다.", actions: [
        { type: "create_session", key: "rev", agent: "codex", permission: "read-only", title: "리뷰", role: "검토한다.", roleName: "", text: '새 세션 "리뷰" 만들기' },
        { type: "link", from: "s1", to: "rev", when: "success", keyword: "", note: "", text: '"First" → "리뷰" 연결 (성공하면)' }] };
      else if (url.pathname === "/api/flow-assistant/apply") value = { done: body.actions.map((action) => action.text), created: ["s1"] };
      else if (url.pathname.startsWith("/api/commands/") && req.method === "DELETE") throw Error("locked");
      else if (url.pathname.startsWith("/api/commands/") && req.method === "PUT") value = {};
      else if (url.pathname === "/api/commands") value = { shells: [{ id: "powershell", label: "PowerShell" }], commands: [
        { id: "cmd-a", title: "Check", projectPath: project.path, command: "echo fixture", shell: "powershell", state: "idle", pos: { x: 20, y: 200 } },
        { id: "cmd-button", kind: "button", title: "작업 시작", prompt: "작업을 시작하세요.", projectPath: project.path, state: "idle", pos: { x: 360, y: 200 } },
        { id: "cmd-md", kind: "markdown", title: "완료 보고서", cwdMode: "source", projectPath: project.path, state: "idle", pos: { x: 700, y: 200 } },
      ] };
      else if (url.pathname === "/api/skills" || url.pathname === "/api/messages") value = [];
      else if (url.pathname === "/api/limits") value = {
        claude: { windows: [{ id: "five_hour", label: "5시간", usedPercent: 24, resetsAt: new Date(Date.now() + 2 * 3600000).toISOString() }, { id: "seven_day", label: "주간", usedPercent: 61, resetsAt: new Date(Date.now() + 3 * 86400000).toISOString() }] },
        codex: { windows: [{ id: "primary", label: "5시간", usedPercent: 35, resetsAt: new Date(Date.now() + 90 * 60000).toISOString() }] },
      };
      else if (url.pathname === "/api/auth") value = { claude: false, codex: false };
      else if (url.pathname === "/api/setup") value = setup;
      else if (url.pathname === "/api/setup/winget/install" && req.method === "POST") {
        setup.jobs.winget = { kind: "install", state: "running", log: "Fixture preparation only" };
        emit("setup", setup.jobs); value = setup.jobs.winget;
      }
      else if (url.pathname === "/api/setup/winget/cancel" && req.method === "POST") {
        setup.jobs.winget = { ...setup.jobs.winget, state: "canceled" };
        emit("setup", setup.jobs); value = { canceled: true };
      }
      else if (url.pathname === "/api/setup/codex/update" && req.method === "POST") {
        const attempt = ++updateAttempt;
        const started = { kind: "update", state: "running", log: "Fixture update pending" };
        setup.jobs.codex = started; emit("setup", setup.jobs);
        await new Promise((resolve) => { releaseUpdate = resolve; });
        setup.jobs.codex = attempt === 1
          ? { kind: "update", state: "error", error: "Fixture update failed", log: "Fixture update failed; retry after refreshing" }
          : { kind: "update", state: "done", log: "Fixture update complete" };
        emit("setup", setup.jobs);
        // The retry intentionally returns an older snapshot after its terminal event.
        value = attempt === 1 ? setup.jobs.codex : started;
      }
      else if (url.pathname === "/api/update") value = { current: "0.2.0", desktop: false };
      else if (url.pathname === "/api/git") value = { branch: "main", files: [], moreFiles: 0, stagedCount: 0, unstagedCount: 0, branches: [{ name: "main", current: true }], commits: [{ hash: "a".repeat(40), short: "aaaaaaa", subject: "Fixture", author: "test", date: "2026-10-01T00:00:00Z", parents: [], refs: ["main"] }] };
      else if (url.pathname.startsWith("/api/")) throw Error("Unexpected fixture request " + req.method + " " + req.url);
      else {
        const target = path.resolve(projectRoot, "public", "." + (url.pathname === "/" ? "/index.html" : url.pathname));
        if (!target.startsWith(path.resolve(projectRoot, "public") + path.sep)) throw Error("Unsafe fixture path");
        const content = await fs.readFile(target); res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "text/html"); res.end(content); return;
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const report = await runBrowser(temp, "http://127.0.0.1:" + server.address().port);
    assert.ok(report?.checks.length >= 20); assert.deepEqual(report.errors, []);
    for (const endpoint of ["status", "auth", "setup"]) assert.ok(requests.some((request) => request.path === `/api/${endpoint}` && request.search === "?fresh=1"), `${endpoint} must bypass cached detection on recheck`);
    assert.deepEqual(requests.filter((request) => request.method === "POST" && request.path.startsWith("/api/setup/")).map((request) => request.path), ["/api/setup/winget/install", "/api/setup/winget/cancel", "/api/setup/codex/update", "/api/setup/codex/update"], "setup actions stay inside fixture handlers and duplicate clicks do not start another update");
    assert.deepEqual(requests.filter((request) => request.method === "PUT" && request.path === "/api/settings").map((request) => request.body), [
      { cli: { claude: "", codex: "" }, cliAutoUpdate: false, cliKeepAlive: { idleMinutes: 15, maxProcesses: 8 } },
      { cli: { claude: "", codex: "" }, cliAutoUpdate: true, cliKeepAlive: { idleMinutes: 15, maxProcesses: 8 } },
    ], "automatic CLI update preference saves both disabled and enabled states");
    for (const request of requests.filter((request) => request.method === "POST" && request.path === "/api/setup/codex/update")) {
      assert.ok(requests.slice(requests.indexOf(request) + 1).some((next) => next.method === "GET" && next.path === "/api/setup" && !next.search), "updates re-read the latest job state after their response");
    }
    assert.ok(!requests.some((request) => /\/(run|stop|messages)$/.test(request.path) && request.method === "POST"), "Verification must not start an agent or command");
    const creations = requests.filter((request) => request.method === "POST" && request.path === "/api/sessions").map((request) => request.body);
    assert.deepEqual(creations.map((body) => body.title), ["Default workspace", "Separate workspace", "Worktree disabled", "Chat without workspace"], "all workspace choices submit through the real session form");
    assert.deepEqual(creations.map(({ isolate, worktreeName, chat, projectPath }) => ({ isolate, worktreeName, chat, projectPath })), [
      { isolate: false, worktreeName: undefined, chat: false, projectPath: project.path },
      { isolate: true, worktreeName: "browser-worktree", chat: false, projectPath: project.path },
      { isolate: false, worktreeName: undefined, chat: false, projectPath: project.path },
      { isolate: false, worktreeName: undefined, chat: true, projectPath: undefined },
    ], "session creation preserves explicit worktree opt-in, trims its name, and omits stale workspace fields");
    assert.ok(creations.every((body) => !Object.hasOwn(body, "worktreeMode") && !Object.hasOwn(body, "workBranch")), "new and original workspace requests do not leak branch picker fields");
    const commandMoves = requests.filter((request) => request.method === "PUT" && request.path === "/api/commands/cmd-a" && request.body?.pos !== undefined).map((request) => request.body.pos);
    assert.deepEqual(commandMoves.at(-2), { x: 20, y: 200 }, "undo restores the command node's saved position");
    assert.deepEqual(commandMoves.at(-1), commandMoves.at(-3), "redo puts the command node back where it was dragged");
    const planned = requests.find((request) => request.path === "/api/flow-assistant/plan");
    assert.equal(planned?.body.prompt, "리뷰 세션 붙여 줘", "flow assistant sends the typed request");
    assert.deepEqual(planned?.body.selected, ["s1"], "flow assistant sends the selected cards");
    const applied = requests.find((request) => request.path === "/api/flow-assistant/apply");
    assert.deepEqual(applied?.body.actions.map((action) => action.type), ["create_session", "link"], "flow assistant applies the previewed actions unchanged");
  } finally {
    releaseUpdate?.();
    for (const stream of streams) stream.end();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

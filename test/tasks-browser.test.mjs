import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const chromium = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function browser(temp, url, expression) {
  const profile = path.join(temp, "profile");
  const child = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true });
  let log = "", socket;
  child.stderr.on("data", (chunk) => log += chunk);
  const closed = new Promise((resolve) => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 10000;
    let port;
    while (!port) {
      if (Date.now() > deadline) throw Error("Browser launch timed out: " + log);
      port = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").then((value) => Number(value.split("\n")[0]), () => null);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const target = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" }).then((res) => res.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map(), errors = [];
    let id = 0;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
      }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error("DevTools timeout: " + method + "\n" + errors.join("\n"))); }, 20000);
      pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    await command("Runtime.enable"); await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => {
      const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } };
      socket.addEventListener("message", listener);
    });
    await command("Page.navigate", { url }); await loaded;
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const state = await command("Runtime.evaluate", { expression: "JSON.stringify({viewProject:document.getElementById('view-project')?.hidden,panel:document.getElementById('tab-tasks')?.hidden,refresh:document.getElementById('tasks-refresh')?.outerHTML,context:document.getElementById('tasks-context')?.textContent,body:document.body.innerText.slice(-3500)})", returnByValue: true });
      throw Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + "\n" + errors.join("\n") + "\nState: " + state.result.value);
    }
    const output = path.join(root, "data/tasks-qa"); await fs.mkdir(output, { recursive: true });
    const desktop = await command("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(output, "desktop.png"), Buffer.from(desktop.data, "base64"));
    const settingsOutput = path.join(root, ".tmp", "gitflow-settings-ui.png");
    await fs.mkdir(path.dirname(settingsOutput), { recursive: true });
    await fs.writeFile(settingsOutput, Buffer.from(desktop.data, "base64"));
    await command("Runtime.evaluate", { expression: "document.documentElement.dataset.theme='light'" });
    const light = await command("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(output, "light.png"), Buffer.from(light.data, "base64"));
    await command("Runtime.evaluate", { expression: "document.documentElement.dataset.theme='dark'" });
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await command("Runtime.evaluate", { expression: "new Promise(resolve => requestAnimationFrame(() => resolve({width:innerWidth,scroll:document.documentElement.scrollWidth})))", awaitPromise: true, returnByValue: true });
    assert.equal(mobile.result.value.width, 390);
    assert.ok(mobile.result.value.scroll <= 390, JSON.stringify(mobile.result.value));
    const taskFit = await command("Runtime.evaluate", { expression: "new Promise(resolve => { document.getElementById('tab-tasks').scrollIntoView({block:'start'}); requestAnimationFrame(() => resolve([...document.querySelectorAll('.task-card')].every(card => card.getBoundingClientRect().right <= innerWidth))); })", awaitPromise: true, returnByValue: true });
    assert.equal(taskFit.result.value, true, "Task cards must fit the mobile viewport");
    const settingsFit = await command("Runtime.evaluate", { expression: "new Promise(resolve => requestAnimationFrame(() => { const dialog = document.getElementById('task-settings-dialog'); const rect = dialog.getBoundingClientRect(); resolve(dialog.open && rect.left >= 0 && rect.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth); }))", awaitPromise: true, returnByValue: true });
    assert.equal(settingsFit.result.value, true, "GitFlow settings must fit the mobile viewport");
    const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await fs.writeFile(path.join(output, "mobile.png"), Buffer.from(shot.data, "base64"));
    return { checks: result.result.value, errors, mobile: mobile.result.value };
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

test("browser: task references, GitFlow tasks and per-project settings retain state and isolate delayed responses", { timeout: 60000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chromium).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-tasks-browser-"));
  const streams = new Set(), requests = [], tasks = [], sessions = [];
  const project = { path: "C:/fixture", name: "Fixture", registered: true, claude: 0, codex: 0 };
  const secondProject = { ...project, path: "C:/other", name: "Other" };
  const projects = [project, secondProject];
  const defaults = { main: "main", develop: "develop", featurePrefix: "feature/", hotfixPrefix: "hotfix/", releasePrefix: "release/" };
  const settings = new Map(projects.map((item) => [item.path, { ...defaults }]));
  const agents = Object.fromEntries(["claude", "codex"].map((name) => [name, { path: name === "codex" ? "C:/bin/codex.exe" : null, version: name === "codex" ? "1.0.0" : null, models: [{ id: "test", label: "Test", efforts: ["medium"] }], efforts: ["medium"], permissions: name === "claude" ? ["default", "acceptEdits"] : ["read-only", "workspace-write"] }]));
  const context = { mainSha: "a".repeat(40), developSha: "a".repeat(40), mainInDevelop: true, needsSetup: false, checkedAt: "2026-10-15T12:00:00Z", freshness: { state: "current", checkedAt: "2026-10-15T12:00:00Z" } };
  const mode = { uncertain: false, contextFailure: false, holdCreate: false, holdSettingsRead: false, holdSettingsSave: false, settingsReadFailure: false, settingsSaveFailure: false, assistantFailure: false, holdAssistant: false };
  let releaseCreate, releaseSettingsRead, releaseSettingsSave, releaseAssistant;
  const reviews = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      requests.push({ method: req.method, path: url.pathname, search: url.search, body });
      let value;
      if (url.pathname === "/fixture/mode") { Object.assign(mode, body); value = {}; }
      else if (url.pathname === "/fixture/release") { releaseCreate?.(); value = {}; }
      else if (url.pathname === "/fixture/release-assistant") { releaseAssistant?.(); value = {}; }
      else if (url.pathname === "/fixture/release-settings") { if (body.read) releaseSettingsRead?.(); if (body.save) releaseSettingsSave?.(); value = {}; }
      else if (url.pathname === "/fixture/requests") value = requests;
      else if (url.pathname === "/fixture/emit") {
        if (body.type === "event") sessions.find((session) => session.id === body.payload.sessionId)?.events.push(body.payload.event);
        for (const stream of streams) stream.write("event: " + body.type + "\ndata: " + JSON.stringify(body.payload ?? {}) + "\n\n");
        value = {};
      }
      else if (url.pathname === "/api/status") value = { agents, projects, cliOverrides: { claude: "", codex: "" }, linkConditions: [{ id: "success", label: "성공 시" }] };
      else if (url.pathname === "/api/task-assistant/plan") {
        if (mode.holdAssistant) { mode.holdAssistant = false; await new Promise((resolve) => releaseAssistant = resolve); }
        if (mode.assistantFailure) throw Object.assign(Error("초안 생성 실패. 입력은 유지됩니다."), { status: 422 });
        value = { summary: body.history?.length ? "접근성 확인도 반영했습니다." : "로그인 문제 수정 초안을 정리했습니다.",
          draft: { title: "AI 로그인 초안", content: body.draft.content || "모바일 로그인 문제를 수정한다.", acceptance: "모바일·데스크톱 로그인과 접근성을 확인한다.", type: "feature", agent: "codex", branchName: "", worktreeName: "", version: "" } };
      }
      else if (url.pathname === "/api/tasks/context") { if (mode.contextFailure) throw Object.assign(Error("원격 확인 실패"), { status: 400 }); value = { ...context, settings: settings.get(url.searchParams.get("path")) }; }
      else if (url.pathname === "/api/tasks/settings") {
        const projectPath = url.searchParams.get("path");
        if (!settings.has(projectPath)) throw Error("Unknown project settings");
        if (req.method === "PUT") {
          if (mode.settingsSaveFailure) throw Object.assign(Error("브랜치 이름을 확인해 주세요."), { status: 400 });
          settings.set(projectPath, { ...body.settings });
          if (mode.holdSettingsSave) { mode.holdSettingsSave = false; await new Promise((resolve) => releaseSettingsSave = resolve); }
        }
        const snapshot = { ...settings.get(projectPath) };
        if (req.method === "GET") {
          if (mode.holdSettingsRead) { mode.holdSettingsRead = false; await new Promise((resolve) => releaseSettingsRead = resolve); }
          if (mode.settingsReadFailure) throw Object.assign(Error("프로젝트 설정 읽기 실패"), { status: 400 });
        }
        value = { settings: snapshot };
      }
      else if (url.pathname === "/api/workbranches") value = { currentBranch: 'main', branches: [
        { name: 'main', cwd: project.path, original: true, selectable: false, reason: '원본 작업 폴더' },
        { name: 'feature/selected', cwd: 'C:/fixture.agenthub/selected', selectable: true, selectableForTask: !tasks.some((task) => task.branch === 'feature/selected'), selectableForSession: true },
        { name: 'feature/locked', cwd: 'C:/fixture.agenthub/locked', selectable: false, locked: true, reason: '잠긴 작업 폴더' },
        ...tasks.filter((task) => task.branch !== 'feature/selected').map((task) => ({ name: task.branch, cwd: task.cwd, selectable: true, selectableForTask: false, selectableForSession: true, taskId: task.id })),
      ] };
      else if (url.pathname === "/api/tasks") {
        if (req.method === "POST") {
          if (mode.holdCreate) { mode.holdCreate = false; await new Promise((resolve) => releaseCreate = resolve); }
          const id = "task-" + (tasks.length + 1), sessionId = "session-" + id;
          const flow = { ...settings.get(body.projectPath) };
          const type = body.type ?? "feature", branch = body.workBranch ?? flow[type + "Prefix"] + (type === "release" ? body.version : id), baseBranch = type === "hotfix" ? flow.main : flow.develop;
          const task = { id, title: body.title, projectPath: body.projectPath, type, branch, baseBranch, targetBranch: type === "feature" ? flow.develop : flow.main, gitflow: flow, cwd: "C:/fixture.agenthub/" + id, sessionIds: [sessionId], state: "working", pull: null, createdAt: context.checkedAt, updatedAt: context.checkedAt, freshness: { state: "current", checkedAt: context.checkedAt } };
          const session = { id: sessionId, title: body.title, taskId: id, projectPath: project.path, projectName: project.name, cwd: task.cwd, worktree: { dir: task.cwd, branch }, agent: body.agent, permission: body.permission, state: "idle", events: [], skills: [], queue: [], createdAt: context.checkedAt, updatedAt: context.checkedAt };
          tasks.unshift(task); sessions.push(session); value = { task, session };
        } else value = { tasks: tasks.filter((task) => task.projectPath === url.searchParams.get("path")) };
      } else if (url.pathname.startsWith("/api/tasks/")) {
        const [, , , id, action] = url.pathname.split("/"); const task = tasks.find((item) => item.id === id);
        if (!task) throw Error("Task not found");
        if (!reviews.has(id)) {
          const files = mode.reviewScenario ? [{ path: 'chosen.txt', label: '수정' }, { path: 'remaining.txt', label: '새 파일' }] : [];
          reviews.set(id, { files, head: 'b'.repeat(40), token: 'review-' + id, behind: !!mode.reviewScenario });
          mode.reviewScenario = false;
        }
        const review = reviews.get(id);
        if (action === "review") {
          task.freshness.behind = review.behind;
          value = { task, ...review, localTargetHead: 'a'.repeat(40), localBehind: false, clean: !review.files.length, commits: [{ hash: review.head, subject: '검토할 커밋' }] };
        } else if (action === "diff") value = { diff: '+ selected change', head: review.head, token: review.token };
        else if (action === "commit") {
          if (body.reviewToken !== review.token) throw Error('Stale fixture token');
          review.files = review.files.filter(file => !body.files.includes(file.path)); review.token += '-commit'; review.head = 'c'.repeat(40); value = { task };
        } else if (action === "finish") {
          task.pull = { number: 42, url: "https://github.com/fixture/repo/pull/42", state: "OPEN", headRefName: task.branch, baseRefName: task.targetBranch, headRefOid: "b".repeat(40) };
          if (mode.uncertain) { mode.uncertain = false; task.pendingAction = { action: "pull", expectedHead: "b".repeat(40), outcomeUnknown: true }; throw Object.assign(Error("완료 여부를 확인한 뒤 다시 시도하세요."), { status: 504, reason: "github-timeout", outcomeUnknown: true }); }
          task.state = "review"; value = { task, pull: task.pull };
        } else if (action === "refresh") { delete task.pendingAction; if (task.pull) task.state = "review"; value = { task }; }
        else if (action === "sync") { review.behind = false; review.head = 'd'.repeat(40); review.token += '-sync'; value = { task }; }
        else if (action === "cleanup") { task.state = "cleaned"; value = { task }; }
        else if (action === "issue") {
          if (req.method === "DELETE") delete task.issue;
          else if (body.number === "13") throw Object.assign(Error("GitHub CLI 인증이 필요합니다."), { status: 401, reason: "gh-auth" });
          else task.issue = { repo: "fixture/repo", number: Number(body.number), title: "로그인 이슈", url: "https://github.com/fixture/repo/issues/" + body.number, state: "open" };
          value = { task };
        }
        else value = { task };
      } else if (url.pathname === "/api/sessions") {
        if (req.method === 'POST') {
          const owner = tasks.find((task) => task.branch === body.workBranch);
          const session = { id: 'selected-session-' + sessions.length, title: body.title || 'Existing branch session', taskId: owner?.id,
            projectPath: project.path, projectName: project.name, cwd: owner?.cwd || 'C:/fixture.agenthub/selected',
            worktree: { dir: owner?.cwd || 'C:/fixture.agenthub/selected', branch: body.workBranch, shared: true },
            agent: body.agent, permission: body.permission, state: 'idle', events: [], skills: [], queue: [], createdAt: context.checkedAt, updatedAt: context.checkedAt };
          sessions.push(session); owner?.sessionIds.push(session.id); value = session;
        } else value = sessions;
      }
      else if (url.pathname.startsWith("/api/sessions/")) value = sessions.find((item) => item.id === url.pathname.split("/")[3]);
      else if (url.pathname === "/api/projects/all") value = projects;
      else if (["/api/projects/discover", "/api/links", "/api/skills", "/api/messages"].includes(url.pathname)) value = [];
      else if (url.pathname === "/api/commands") value = { shells: [], commands: [] };
      else if (url.pathname === "/api/limits") value = { claude: { windows: [] }, codex: { windows: [] } };
      else if (url.pathname === "/api/auth") value = { claude: false, codex: false };
      else if (url.pathname === "/api/setup") value = { tools: [], jobs: {} };
      else if (url.pathname === "/api/update") value = { current: "0.3.1", desktop: false };
      else if (url.pathname.startsWith("/api/")) throw Error("Unexpected fixture request " + req.method + " " + req.url);
      else {
        const target = path.resolve(root, "public", "." + (url.pathname === "/" ? "/index.html" : url.pathname));
        if (!target.startsWith(path.resolve(root, "public") + path.sep)) throw Error("Unsafe fixture path");
        const content = await fs.readFile(target);
        res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "text/html"); res.end(content); return;
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = error.status ?? 500; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: error.message, reason: error.reason, outcomeUnknown: error.outcomeUnknown })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const expression = await fs.readFile(new URL("./fixtures/tasks-browser.js.txt", import.meta.url), "utf8");
    const report = await browser(temp, "http://127.0.0.1:" + server.address().port, expression);
    assert.ok(report.checks.length >= 35); assert.deepEqual(report.errors, []);
    assert.ok(!requests.some((request) => /\/(run|stop|messages)$/.test(request.path) && request.method === "POST"));
    await fs.writeFile(path.join(root, "data/tasks-qa/checks.json"), JSON.stringify(report, null, 2));
  } finally {
    releaseCreate?.(); releaseSettingsRead?.(); releaseSettingsSave?.(); releaseAssistant?.(); for (const stream of streams) stream.end();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

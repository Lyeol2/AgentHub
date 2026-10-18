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

// Serve the real dialog markup and CSS without bootstrapping application services.
// The browser fixture supplies all API responses; no agent or shell is executed.
test("browser: Git node editor, output ports, and worktree links", { timeout: 35000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-git-node-browser-"));
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      const target = path.resolve(projectRoot, "public", "." + (pathname === "/" ? "/index.html" : pathname));
      if (!target.startsWith(path.resolve(projectRoot, "public") + path.sep)) throw Error("Unsafe fixture path");
      let content = await fs.readFile(target, "utf8");
      if (target.endsWith("index.html")) content = content.replace(/<script type="module" src="\/(?:app|layout)\.js"><\/script>/g, "");
      res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html");
      res.end(content);
    } catch (error) { res.statusCode = 404; res.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = path.join(temp, "profile");
  const child = spawn(browserExecutable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true });
  const closed = new Promise((resolve) => child.on("exit", resolve));
  let stderr = "", socket;
  child.stderr.on("data", (chunk) => stderr += chunk);
  try {
    const deadline = Date.now() + 10000;
    let port;
    while (!port) {
      if (Date.now() > deadline) throw Error("Browser launch timeout: " + stderr);
      port = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").then((s) => Number(s.split("\n")[0]), () => null);
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
    });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(Error("DevTools timed out: " + method + "\n" + stderr)), 12000);
      pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    await command("Runtime.enable"); await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => {
      const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } };
      socket.addEventListener("message", listener);
    });
    await command("Page.navigate", { url: "http://127.0.0.1:" + server.address().port }); await loaded;
    const expression = `(${gitBrowserChecks.toString()})()`;
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    assert.ok(result.result.value.length >= 12, JSON.stringify(result.result.value));
    assert.deepEqual(errors, []);
    if (process.env.AGENTHUB_GIT_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.AGENTHUB_GIT_SCREENSHOT_DIR, { recursive: true });
      const graphShot = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.AGENTHUB_GIT_SCREENSHOT_DIR, "git-graph.png"), Buffer.from(graphShot.data, "base64"));
      await command("Runtime.evaluate", { expression: "window.__gitBrowserPreview()", awaitPromise: true });
      const dialogShot = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.AGENTHUB_GIT_SCREENSHOT_DIR, "git-dialog.png"), Buffer.from(dialogShot.data, "base64"));
    }
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

async function gitBrowserChecks() {
  const { createCommandsController } = await import("/features/commands/controller.js");
  const { createGraphController } = await import("/features/graph/controller.js");
  const $ = (id) => document.getElementById(id);
  const checks = [], requests = [], alerts = [];
  const check = (condition, label) => { if (!condition) throw Error(label); checks.push(label); };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  const until = async (predicate) => { const end = Date.now() + 8000; while (!predicate()) { if (Date.now() > end) throw Error("Timed out: " + predicate); await tick(); } };
  window.alert = (message) => alerts.push(message); new MutationObserver((records) => { for (const record of records) for (const added of record.addedNodes) if (added.classList?.contains("error-toast")) alerts.push(added.querySelector(".error-report-message")?.textContent ?? added.textContent); }).observe(document.body, { childList: true, subtree: true });
  const project = "C:/fixture";
  const gitUse = { id: "cmd-use", kind: "git", gitAction: "use", title: "작업 브랜치", branch: "feature/login", projectPath: project, state: "idle", pos: { x: 20, y: 20 } };
  const gitMerge = { id: "cmd-merge", kind: "git", gitAction: "merge", title: "통합", branch: "feature/login", targetBranch: "develop", projectPath: project, state: "idle", pos: { x: 20, y: 180 } };
  const shell = { id: "cmd-shell", title: "검증", command: "npm test", projectPath: project, state: "idle", pos: { x: 400, y: 20 } };
  const button = { id: "cmd-button", kind: "button", title: "시작", prompt: "시작", projectPath: project, state: "idle", pos: { x: 20, y: 340 } };
  const session = { id: "s1", title: "후속 세션", agent: "codex", state: "idle", projectPath: project, createdAt: "2026-01-01", updatedAt: new Date().toISOString(), graphPos: { x: 740, y: 20 } };
  const branches = [
    { name: "feature/login", head: "abc123", cwd: "C:/fixture.login", checkedOut: true, useSelectable: true, targetSelectable: true },
    { name: "develop", head: "def456", cwd: "C:/fixture", checkedOut: true, useSelectable: false, useReason: "보호된 브랜치", targetSelectable: true },
    { name: "feature/busy", cwd: "C:/fixture.busy", checkedOut: true, busy: true, useSelectable: false, targetSelectable: false, reason: "세션이 실행 중입니다" },
  ];
  const data = { commands: [gitUse, gitMerge, shell, button], shells: [{ id: "powershell", label: "PowerShell" }], commandsProject: project, sessions: [session], links: [], messages: [], status: { linkConditions: [{ id: "success", label: "성공 시" }, { id: "error", label: "실패 시" }, { id: "keyword", label: "키워드" }, { id: "always", label: "항상" }, { id: "otherwise", label: "그 외" }, { id: "manual", label: "수동" }] } };
  const navigation = { project, view: "project" };
  let cmdController, graph, newSessionArgs, deferredBranches;
  const api = async (method, url, body) => {
    requests.push({ method, url, body });
    if (method === "GET" && url.startsWith("/api/commands/git-branches?")) return deferredBranches ?? { branches, currentBranch: "develop" };
    if (method === "GET" && url.startsWith("/api/commands?")) return { shells: data.shells, commands: data.commands };
    if (method === "GET" && url === "/api/links") return data.links;
    if (method === "POST" && url === "/api/commands") { const created = { ...body, id: "cmd-new-" + requests.length, state: "idle" }; data.commands.push(created); return created; }
    if (method === "PUT" && url.startsWith("/api/commands/")) { Object.assign(data.commands.find((c) => url.endsWith(c.id)), body); return {}; }
    if (method === "POST" && url === "/api/links") { const link = { ...body, id: "link-" + requests.length }; data.links.push(link); return link; }
    if (method === "POST" && (url.endsWith("/run") || url.endsWith("/stop"))) return {};
    throw Error("Unexpected API " + method + " " + url);
  };
  const commandById = (id) => data.commands.find((c) => c.id === id);
  cmdController = createCommandsController({ api, loadLinks: () => graph.loadLinks(), renderGraph: () => graph.renderGraph(), connectCreatedGraphNode: (...args) => graph.connectCreatedGraphNode(...args), commandById, data, navigation });
  graph = createGraphController({ api, data, navigation, commandById, sessionById: (id) => data.sessions.find((s) => s.id === id), nodeTitle: (id) => commandById(id)?.title ?? session.title, commandNode: cmdController.commandNode, openCommandDialog: cmdController.openCommandDialog, runCommand: cmdController.runCommand, stopCommand: cmdController.stopCommand, removeCommand: cmdController.removeCommand, openCommandOutput: cmdController.openCommandOutput, skillChips: () => null, restartSession: () => {}, toggleSessionLock: () => {}, openNew: (...args) => { newSessionArgs = args; }, openSkillsManager: () => {}, cancelNodeCreation: () => {}, loadCommands: cmdController.loadCommands, loadSessions: async () => {} });
  $("view-dashboard").hidden = true; $("view-project").hidden = false;
  Object.assign($("p-graph").style, { position: "fixed", left: "20px", top: "20px", width: "1300px", height: "800px", zIndex: "1" });
  graph.renderLinkConditions(); graph.renderGraph();
  const card = (id) => $("p-graph").querySelector('[data-id="' + id + '"]');
  check(card(gitUse.id).querySelectorAll(".gcard-handle[data-when]").length === 2, "Git card has two DOM output ports");
  check(card(gitMerge.id).textContent.includes("feature/login → develop"), "merge card shows source and target");

  cmdController.openCommandDialog(gitMerge);
  await until(() => !$("command-save").disabled);
  check(!$("git-settings").hidden && $("command-settings").hidden && $("command-text-row").hidden, "Git editor shows branch settings");
  check($("git-target").value === "develop" && !$("git-target").querySelector('[value="develop"]').disabled, "protected work branch can be a merge target");
  check($("git-target").querySelector('[value="feature/busy"]').disabled, "busy merge target is disabled with its reason");
  check($("git-branch-details").textContent.includes("C:/fixture") && $("git-merge-hint").textContent.includes("커밋된 변경"), "branch folder and committed-only merge are explained");
  $("command-title").value = "로그인 통합"; $("command-save").click();
  await until(() => !$("command-dialog").open);
  const edited = requests.find((r) => r.method === "PUT" && r.url.endsWith(gitMerge.id));
  check(edited.body.gitAction === "merge" && edited.body.branch === "feature/login" && edited.body.targetBranch === "develop" && !Object.hasOwn(edited.body, "command"), "merge editor saves the Git contract");

  cmdController.openCommandDialog(gitUse); await until(() => !$("command-save").disabled);
  check($("git-target-row").hidden && $("git-branch").querySelector('[value="develop"]').disabled, "branch use respects use eligibility");
  $("git-branch").value = ""; $("command-save").click();
  await tick(); check($("command-dialog").open && $("command-error").textContent.includes("선택"), "empty branch is rejected before saving");
  $("command-dialog").close();

  gitMerge.lastRun = { ok: false, startedAt: new Date().toISOString(), deliveryErrors: ["기존 대화의 작업 폴더가 다릅니다"], cwd: "C:/fixture", tail: "충돌로 병합 실패", gitResult: { branch: "feature/login", targetBranch: "develop", beforeHead: "before-sha", afterHead: "after-sha", conflicts: ["src/login.js"], reason: "merge-conflict", recoveryRequired: true } };
  cmdController.openCommandDialog(gitMerge); await until(() => !$("command-save").disabled);
  check($("command-output").textContent.includes("src/login.js") && $("command-output").textContent.includes("before-sha") && $("command-output").textContent.includes("after-sha") && $("command-output").textContent.includes("merge-conflict") && $("command-output").textContent.includes("기존 대화의 작업 폴더가 다릅니다") && $("command-last-meta").textContent.includes("복구 필요"), "Git details show heads, conflicts, and required recovery");
  $("command-dialog").close();

  gitUse.state = "running"; graph.renderGraph();
  const stops = () => requests.filter((r) => r.method === "POST" && r.url === "/api/commands/cmd-use/stop").length;
  check(!card(gitUse.id).querySelector(".gcmd-btn").disabled && card(gitUse.id).querySelector(".gcmd-btn").textContent === "중지", "running Git card exposes stop");
  card(gitUse.id).querySelector(".gcmd-btn").click(); await until(() => stops() === 1);
  card(gitUse.id).dispatchEvent(new MouseEvent("contextmenu", { clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
  const stopMenu = [...document.querySelectorAll(".menu-item")].find((b) => b.textContent === "중지");
  check(stopMenu && !stopMenu.disabled, "running Git context menu exposes stop"); stopMenu.click(); await until(() => stops() === 2);
  cmdController.openCommandDialog(gitUse); await until(() => !$("command-save").disabled);
  check($("command-run").textContent === "중지" && !$("command-run").disabled, "running Git dialog exposes stop");
  $("command-run").click(); await until(() => stops() === 3);
  $("command-dialog").close(); gitUse.state = "idle"; graph.renderGraph();

  const drag = async (from, when, target) => {
    const handle = card(from).querySelector(when ? '[data-when="' + when + '"]' : ".gcard-handle");
    const rect = handle.getBoundingClientRect(), dest = typeof target === "string" ? card(target).getBoundingClientRect() : target;
    const start = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 1, button: 0, bubbles: true, cancelable: true };
    handle.dispatchEvent(new PointerEvent("pointerdown", start));
    const end = { ...start, clientX: dest.left + 30, clientY: dest.top + 30 };
    window.dispatchEvent(new PointerEvent("pointermove", end));
    window.dispatchEvent(new PointerEvent("pointerup", end));
    await tick();
  };
  await drag(gitUse.id, "error", shell.id);
  check($("link-dialog").open && $("link-when").value === "error", "failure port opens a failure link");
  check([...$("link-when").options].map((o) => o.value).join() === "success,error,always,manual" && $("link-git-worktree-row").hidden, "Git links expose valid conditions and failure has no worktree transfer");
  $("link-form").querySelector('[value="ok"]').click(); await until(() => !$("link-dialog").open);
  await drag(gitUse.id, "success", shell.id);
  check($("link-when").value === "success" && !$("link-git-worktree-row").hidden && $("link-git-worktree").checked, "branch-use success defaults to the Git worktree");
  $("link-form").querySelector('[value="ok"]').click(); await until(() => !$("link-dialog").open);
  check(data.links.some((l) => l.from === gitUse.id && l.to === shell.id && l.when === "error" && !l.useGitWorktree) && data.links.some((l) => l.from === gitUse.id && l.to === shell.id && l.when === "success" && l.useGitWorktree), "success and failure links to the same node retain separate conditions");
  const paths = [...$("p-graph").querySelectorAll("path.edge")].map((p) => p.getAttribute("d"));
  check(paths.some((d) => d.startsWith("M250,60")) && paths.some((d) => d.startsWith("M250,98")), "saved edges start at the matching output ports");

  await drag(gitUse.id, "error", { left: 1040, top: 500 });
  const menuTexts = [...document.querySelectorAll(".menu-item")].map((b) => b.textContent);
  check(menuTexts.includes("새 GIT") && menuTexts.includes("새 Markdown 출력") && menuTexts.includes("새 결과 모으기") && !menuTexts.includes("새 입력 폼") && !menuTexts.includes("새 파일 감시"), "Git port creation menu offers supported mixed next nodes and excludes source-only nodes");
  [...document.querySelectorAll(".menu-item")].find((b) => b.textContent === "새 세션").click();
  check(newSessionArgs[1].connectWhen === "error", "new session receives the dragged output condition");
  await drag(gitUse.id, "error", { left: 1040, top: 500 });
  [...document.querySelectorAll(".menu-item")].find((b) => b.textContent === "새 명령").click();
  $("command-text").value = "npm test"; $("command-title").value = "실패 분석"; $("command-save").click(); await until(() => !$("command-dialog").open);
  await until(() => data.links.some((l) => l.from === gitUse.id && l.to.startsWith("cmd-new-")));
  check(data.links.find((l) => l.from === gitUse.id && l.to.startsWith("cmd-new-")).when === "error", "new command auto-connects from the selected failure port");

  await drag(button.id, null, { left: 900, top: 700 });
  [...document.querySelectorAll(".menu-item")].find((b) => b.textContent === "새 GIT").click(); await until(() => !$("command-save").disabled);
  $("git-branch").value = "feature/login"; $("git-branch").dispatchEvent(new Event("change")); $("command-save").click(); await until(() => !$("command-dialog").open);
  await until(() => data.links.some((l) => l.from === button.id));
  const buttonGitLink = data.links.find((l) => l.from === button.id);
  check(commandById(buttonGitLink.to)?.kind === "git" && buttonGitLink.when === "success", "button can create and connect a Git node");

  let resolveBranches; deferredBranches = new Promise((resolve) => { resolveBranches = resolve; });
  cmdController.openCommandDialog(gitUse);
  check($("command-save").disabled, "save waits for branch discovery");
  $("command-dialog").close(); cmdController.openCommandDialog(shell);
  resolveBranches({ branches: [], currentBranch: "" }); await tick();
  check($("git-settings").hidden && !$("command-save").disabled && $("command-text").value === shell.command, "late branch response cannot overwrite another node editor");
  $("command-dialog").close();
  check(alerts.length === 0, "all supported interactions finish without alerts");
  data.commands.filter((c) => c.id.startsWith("cmd-new-")).forEach((c, index) => { c.pos = { x: 740, y: 180 + index * 160 }; });
  Object.assign($("p-graph").style, { background: "#0b0f16", zIndex: "99" }); graph.renderGraph();
  window.__gitBrowserPreview = async () => { deferredBranches = null; cmdController.openCommandDialog(gitMerge); await until(() => !$("command-save").disabled); };
  return checks;
}

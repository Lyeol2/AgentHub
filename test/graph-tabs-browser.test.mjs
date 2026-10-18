import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const browserExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";

// The real application talks only to this in-memory server. No CLI, Git command,
// user project, or production AgentHub data store is used by these checks.
test("browser: grid tabs start with one sheet and preserve nodes, state and execution", { timeout: 60000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-graph-tabs-browser-"));
  const requests = [], streams = new Set();
  let holdTabs = true;
  const pendingTabLoads = new Set();
  const releaseTabLoads = () => { holdTabs = false; for (const release of pendingTabLoads) release(); pendingTabLoads.clear(); };
  const project = { path: "C:/graph-tabs-fixture", name: "Graph tabs fixture", registered: true, claude: 0, codex: 0 };
  let tabs = [{ id: "tab-default", projectPath: project.path, title: "기본", order: 0 }], tabSequence = 0;
  const sessions = [
    { id: "session-running", title: "Running legacy session", agent: "codex", projectPath: project.path, cwd: project.path, state: "running", runningStartedAt: "2026-10-16T00:00:00Z", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", events: [], skills: [], queue: [], graphPos: { x: 30, y: 30 } },
    { id: "session-idle", title: "Waiting legacy session", agent: "claude", projectPath: project.path, cwd: project.path, state: "idle", createdAt: "2026-10-15T00:00:01Z", updatedAt: "2026-10-16T00:00:00Z", events: [], skills: [], queue: [], graphPos: { x: 350, y: 30 } },
  ];
  for (const session of sessions) session.projectName = project.name;
  const commands = [{ id: "cmd-legacy", title: "Legacy command", projectPath: project.path, command: "echo fixture", shell: "powershell", state: "idle", pos: { x: 30, y: 230 } }];
  const groups = [];
  const links = [{ id: "legacy-link", from: "session-running", to: "session-idle", enabled: true, when: "success" }];
  const agents = Object.fromEntries(["claude", "codex"].map((name) => [name, { path: null, autoPath: null, models: [{ id: "fixture", label: "Fixture", efforts: ["medium"] }], efforts: ["medium"], permissions: name === "claude" ? ["default"] : ["read-only", "workspace-write"] }]));
  const emit = (type, payload = {}) => { for (const stream of streams) stream.write("event: " + type + "\ndata: " + JSON.stringify(payload) + "\n\n"); };
  const changed = (affectedTabIds) => emit("graph-tabs", { projectPath: project.path, ...(affectedTabIds ? { affectedTabIds } : {}) });
  const contentsChanged = (affectedTabIds) => {
    for (const type of ["sessions", "commands", "node-groups", "skills"]) emit(type, { projectPath: project.path });
    changed(affectedTabIds);
  };
  const moveNodes = (ids, tabId) => {
    const moving = new Set(ids);
    for (const group of groups) if (moving.has(group.id) || group.members.some((id) => moving.has(id))) {
      group.tabId = tabId;
      for (const id of group.members) moving.add(id);
    }
    for (const node of [...sessions, ...commands]) if (moving.has(node.id)) node.tabId = tabId;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n");
        streams.add(res); req.on("close", () => streams.delete(res)); return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      requests.push({ method: req.method, path: url.pathname, search: url.search, body });
      let value;
      if (url.pathname === "/fixture/snapshot") value = { tabs, sessions, commands, groups, links, requests, pendingTabLoads: pendingTabLoads.size };
      else if (url.pathname === "/fixture/release-tabs") { releaseTabLoads(); value = {}; }
      else if (url.pathname === "/fixture/pending-link") { links[0].pending = { preview: "Fixture result awaiting approval" }; emit("links"); value = {}; }
      else if (url.pathname === "/fixture/emit") {
        if (body.type === "state") Object.assign(sessions.find((item) => item.id === body.payload.sessionId), { state: body.payload.state });
        emit(body.type, body.payload); value = {};
      }
      else if (url.pathname === "/api/status") value = { agents, projects: [project], cliOverrides: { claude: "", codex: "" }, cliAutoUpdate: false, linkConditions: [{ id: "success", label: "성공 시" }] };
      else if (url.pathname === "/api/account") value = { installed: false, connected: false };
      else if (url.pathname === "/api/auth") value = { claude: false, codex: false };
      else if (url.pathname === "/api/setup") value = { tools: [], jobs: {} };
      else if (url.pathname === "/api/limits") value = { claude: { windows: [] }, codex: { windows: [] } };
      else if (url.pathname === "/api/update") value = { current: "0.11.1", desktop: false };
      else if (url.pathname === "/api/projects/all") value = [project];
      else if (["/api/projects/discover", "/api/skills", "/api/messages"].includes(url.pathname)) value = [];
      else if (url.pathname === "/api/links") value = links;
      else if (url.pathname === "/api/links/legacy-link/decide" && req.method === "POST") {
        if (!["approve", "reject"].includes(body.action)) throw Error("Unexpected gate decision");
        delete links[0].pending; emit("links"); value = { ok: true };
      }
      else if (url.pathname === "/api/node-groups") value = { groups };
      else if (url.pathname === "/api/sessions") {
        if (req.method === "POST") { value = { ...sessions[1], ...body, id: "session-created-" + sessions.length, graphPos: body.graphPos ?? { x: 30, y: 30 } }; sessions.push(value); }
        else value = sessions;
      }
      else if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
        value = sessions.find((session) => url.pathname.endsWith("/" + session.id));
        if (req.method === "PUT") Object.assign(value, body);
      }
      else if (url.pathname === "/api/commands") {
        if (req.method === "POST") { value = { ...body, id: "cmd-created-" + commands.length, state: "idle" }; commands.push(value); }
        else value = { commands, shells: [{ id: "powershell", label: "PowerShell" }] };
      }
      else if (/^\/api\/commands\/[^/]+$/.test(url.pathname) && req.method === "PUT") { value = commands.find((command) => url.pathname.endsWith("/" + command.id)); Object.assign(value, body); }
      else if (url.pathname === "/api/graph-tabs") {
        if (req.method === "POST") { value = { id: "tab-added-" + ++tabSequence, title: body.title || "시트 " + (tabSequence + 1), projectPath: project.path, order: tabs.length }; tabs.push(value); changed(); }
        else {
          if (holdTabs) await new Promise((resolve) => {
            const release = () => { pendingTabLoads.delete(release); resolve(); };
            pendingTabLoads.add(release); res.once("close", release);
          });
          value = { tabs, defaultTabId: "tab-default" };
        }
      }
      else if (url.pathname === "/api/graph-tabs/reorder") {
        tabs = body.ids.map((id, order) => ({ ...tabs.find((tab) => tab.id === id), order })); value = { tabs }; changed();
      }
      else if (/^\/api\/graph-tabs\/[^/]+\/move$/.test(url.pathname)) {
        const targetId = url.pathname.split("/")[3];
        const sourceIds = [...sessions, ...commands, ...groups].filter((node) => body.nodeIds.includes(node.id)).map((node) => node.tabId ?? "tab-default");
        moveNodes(body.nodeIds, targetId); value = { ok: true }; contentsChanged([...new Set([...sourceIds, targetId])]);
      }
      else if (/^\/api\/graph-tabs\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split("/")[3];
        value = tabs.find((tab) => tab.id === id);
        if (req.method === "PUT") { value.title = body.title; changed(); }
        else if (req.method === "DELETE") {
          const targetId = url.searchParams.get("target");
          const contents = [...sessions, ...commands].filter((node) => (node.tabId ?? "tab-default") === id);
          moveNodes(contents.map((node) => node.id), targetId);
          tabs = tabs.filter((tab) => tab.id !== id).map((tab, order) => ({ ...tab, order })); value = { ok: true };
          contentsChanged(contents.length ? [id, targetId] : [id]);
        }
      }
      else if (url.pathname.startsWith("/api/")) throw Error("Unexpected fixture request " + req.method + " " + req.url);
      else {
        const target = path.resolve(projectRoot, "public", "." + (url.pathname === "/" ? "/index.html" : url.pathname));
        if (!target.startsWith(path.resolve(projectRoot, "public") + path.sep)) throw Error("Unsafe fixture path");
        const content = await fs.readFile(target);
        res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "text/html"); res.end(content); return;
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
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
      port = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").then((text) => Number(text.split("\n")[0]), () => null);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const target = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" }).then((response) => response.json());
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
      const timer = setTimeout(() => reject(Error("DevTools timed out: " + method + "\n" + errors.join("\n") + "\n" + stderr)), 20000);
      pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const navigate = async () => {
      const loaded = new Promise((resolve) => {
        const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } };
        socket.addEventListener("message", listener);
      });
      await command("Page.navigate", { url: "http://127.0.0.1:" + server.address().port }); await loaded;
    };
    const evaluate = async (fn) => {
      const result = await command("Runtime.evaluate", { expression: "(" + fn.toString() + ")()", awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + "\nBrowser errors:\n" + errors.join("\n"));
      return result.result.value;
    };
    await command("Runtime.enable"); await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate();
    const checks = await evaluate(graphTabsBrowserChecks);
    assert.ok(checks.length >= 15, JSON.stringify(checks));
    holdTabs = true;
    await navigate();
    const restored = await evaluate(graphTabsReloadChecks);
    assert.ok(restored.length >= 3, JSON.stringify(restored));
    assert.deepEqual(errors, []);
    assert.ok(!requests.some((request) => request.method === "POST" && /\/(run|stop)$/.test(request.path)), "Tab operations must never run or stop agents or commands");
    assert.equal(sessions.length, 2, "Tab operations keep both sessions alive");
    assert.equal(sessions[0].state, "running", "Tab operations leave the background agent running");
    assert.deepEqual(links, [{ id: "legacy-link", from: "session-running", to: "session-idle", enabled: true, when: "success" }], "Moving nodes between tabs preserves execution connections");
    if (process.env.AGENTHUB_GRAPH_TABS_SCREENSHOT) {
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(process.env.AGENTHUB_GRAPH_TABS_SCREENSHOT, Buffer.from(data, "base64"));
    }
  } finally {
    releaseTabLoads();
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    for (const stream of streams) stream.end();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

async function graphTabsBrowserChecks() {
  const $ = (id) => document.getElementById(id), checks = [], alerts = [];
  const check = (condition, label) => { if (!condition) throw Error(label); checks.push(label); };
  const until = async (predicate) => { const deadline = Date.now() + 7000; while (!await predicate()) { if (Date.now() > deadline) throw Error("Timed out: " + predicate); await new Promise((resolve) => setTimeout(resolve, 20)); } };
  const snapshot = () => fetch("/fixture/snapshot").then((response) => response.json());
  const tabButtons = () => [...$("p-graph-tabs").querySelectorAll("[data-graph-tab]")];
  const tab = (id) => tabButtons().find((button) => button.dataset.graphTab === id);
  const active = (id) => tab(id)?.getAttribute("aria-selected") === "true" || tab(id)?.classList.contains("active");
  const card = (id) => $("p-graph").querySelector('[data-id="' + id + '"]');
  const context = (element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 650, clientY: 350 }));
  const menuItem = (label) => [...document.querySelectorAll(".context-menu button")].find((button) => button.textContent.trim() === label);
  const pointer = (element, type, props = {}) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 4, button: 0, clientX: 400, clientY: 300, ...props }));
  window.alert = (text) => alerts.push(text); window.confirm = () => true; new MutationObserver((records) => { for (const record of records) for (const added of record.addedNodes) if (added.classList?.contains("error-toast")) alerts.push(added.querySelector(".error-report-message")?.textContent ?? added.textContent); }).observe(document.body, { childList: true, subtree: true });
  await until(() => $("project-nav").querySelector("button") && $("kpis").children.length === 4);
  $("project-nav").querySelector("button").click();
  await until(async () => (await snapshot()).pendingTabLoads > 0);
  check(!$("p-graph").querySelector(".gcard, .gcmd, .graph-canvas"), "initial tab metadata delay shows no unscoped project nodes");
  check($("p-relayout").disabled && $("p-flow-assistant-prompt").disabled && $("p-flow-assistant-send").disabled, "automatic layout and AI input wait for the current tab metadata");
  $("p-relayout").click();
  check(!(await snapshot()).requests.some((request) => request.method === "PUT" && /^\/api\/(sessions|commands)\//.test(request.path)), "clicking disabled layout during metadata loading changes no node positions");
  await fetch("/fixture/release-tabs", { method: "POST" });
  await until(() => tabButtons().length === 1 && card("session-running") && card("cmd-legacy"));
  check(!$("p-relayout").disabled && !$("p-flow-assistant-prompt").disabled, "layout and AI input become available when the default tab is ready");
  check(tabButtons().length === 1 && tab("tab-default") && active("tab-default"), "a project starts with exactly one default grid tab");
  check(![...$("p-graph-tabs").childNodes].some((node) => node.nodeType === Node.TEXT_NODE && /null|undefined/.test(node.textContent)), "tab bar contains no accidental placeholder text");
  check(tab("tab-default").querySelector(".graph-tab-running")?.textContent.includes("1"), "tab badge shows the existing running session");
  check(!((await snapshot()).requests.some((request) => request.path === "/api/graph-tabs" && request.method === "POST")), "opening a project does not add tabs automatically");
  check($("p-graph").querySelectorAll(".gcard").length === 2 && $("p-graph").querySelector('[data-link="legacy-link"]'), "legacy nodes and their original connection appear on the default tab");
  context(tab("tab-default"));
  check(!menuItem("탭 삭제") || menuItem("탭 삭제").disabled, "the final remaining tab cannot be deleted");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  $("p-graph").dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, clientX: 550, clientY: 300 }));
  pointer($("p-graph"), "pointerdown", { button: 1 });
  pointer(window, "pointermove", { clientX: 440, clientY: 325 });
  pointer(window, "pointerup", { button: 1, clientX: 440, clientY: 325 });
  const canvas = () => $("p-graph").querySelector(".graph-canvas");
  const viewport = () => ({ transform: canvas()?.style.transform, left: canvas()?.style.left, top: canvas()?.style.top });
  const defaultViewport = viewport();
  const beforeDrag = card("session-idle").getBoundingClientRect();
  pointer(card("session-idle"), "pointerdown", { clientX: beforeDrag.left + 30, clientY: beforeDrag.top + 30 });
  pointer(window, "pointerup", { clientX: beforeDrag.left + 30, clientY: beforeDrag.top + 30 });
  pointer(card("session-idle"), "pointerdown", { clientX: beforeDrag.left + 30, clientY: beforeDrag.top + 30 });
  pointer(window, "pointermove", { clientX: beforeDrag.left + 70, clientY: beforeDrag.top + 55 });
  pointer(window, "pointerup", { clientX: beforeDrag.left + 70, clientY: beforeDrag.top + 55 });
  await until(() => !$("p-undo").disabled);
  check(card("session-idle").classList.contains("selected"), "selection and undo history are recorded on the current tab");

  $("p-graph-tab-add").click();
  await until(() => tabButtons().length === 2 && active("tab-added-1"));
  check(!card("session-running") && !card("session-idle") && !card("cmd-legacy"), "adding a tab creates an empty grid without copying the default nodes");
  check($("p-undo").disabled && $("p-redo").disabled, "new tab has independent undo history");
  check((await snapshot()).sessions.find((session) => session.id === "session-running").state === "running", "switching tabs leaves the hidden session running");
  tab("tab-added-1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await until(() => $("p-graph-tab-dialog")?.open);
  $("p-graph-tab-name").value = "Review";
  $("p-graph-tab-confirm").click();
  await until(() => tab("tab-added-1")?.textContent.includes("Review") && !$("p-graph-tab-dialog")?.open);
  check((await snapshot()).tabs.find((item) => item.id === "tab-added-1").title === "Review", "double-click rename persists the tab title");

  $("p-graph-tab-add").click();
  await until(() => tabButtons().length === 3 && active("tab-added-2"));
  context(tab("tab-added-2")); menuItem("왼쪽으로 이동").click();
  await until(() => tabButtons().map((button) => button.dataset.graphTab).join(",") === "tab-default,tab-added-2,tab-added-1");
  check((await snapshot()).tabs.map((item) => item.id).join(",") === "tab-default,tab-added-2,tab-added-1", "tab order is saved and reflected in the tab bar");
  const transfer = new DataTransfer();
  tab("tab-added-2").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
  tab("tab-added-1").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  await until(() => tabButtons().map((button) => button.dataset.graphTab).join(",") === "tab-default,tab-added-1,tab-added-2" && !$("p-graph-tab-add").disabled);
  check((await snapshot()).tabs.map((item) => item.id).join(",") === "tab-default,tab-added-1,tab-added-2", "dragging a tab saves the new order");
  context(tab("tab-added-2")); menuItem("탭 삭제").click();
  if ($("p-graph-tab-dialog")?.open) $("p-graph-tab-confirm").click();
  await until(() => tabButtons().length === 2 && !tab("tab-added-2"));
  check((await snapshot()).sessions.length === 2 && (await snapshot()).commands.length === 1, "deleting an empty tab preserves all project nodes");

  tab("tab-default").click();
  await until(() => active("tab-default") && card("session-idle"));
  check(JSON.stringify(viewport()) === JSON.stringify(defaultViewport), "returning to a tab restores its zoom and pan");
  check(card("session-idle").classList.contains("selected") && !$("p-undo").disabled, "returning to a tab restores selection and undo history");
  const movedPosition = (await snapshot()).sessions.find((session) => session.id === "session-idle").graphPos;
  $("p-undo").click();
  await until(() => !$("p-redo").disabled);
  check((await snapshot()).sessions.find((session) => session.id === "session-idle").graphPos.x === 350, "undo after a round-trip changes only the original tab's node");
  $("p-redo").click();
  await until(() => $("p-redo").disabled && !$("p-undo").disabled);
  check((await snapshot()).sessions.find((session) => session.id === "session-idle").graphPos.x === movedPosition.x, "redo remains attached to the original tab");

  const runningRect = card("session-running").getBoundingClientRect();
  pointer(card("session-running"), "pointerdown", { clientX: runningRect.left + 30, clientY: runningRect.top + 30 });
  pointer(window, "pointerup", { clientX: runningRect.left + 30, clientY: runningRect.top + 30 });
  context(card("session-running"));
  check(!!menuItem("탭으로 이동: Review"), "node context menu offers the other tab as a destination");
  menuItem("탭으로 이동: Review").click();
  await until(async () => (await snapshot()).sessions.find((session) => session.id === "session-running").tabId === "tab-added-1");
  await until(() => active("tab-added-1") && !$("p-graph-tab-add").disabled);
  check(card("session-running")?.classList.contains("running"), "moving a session opens its destination tab while preserving execution");
  tab("tab-default").click();
  await until(() => active("tab-default") && !card("session-running"));
  check(card("session-idle") && card("cmd-legacy"), "moving a selected session leaves other nodes on the original tab");
  check((await snapshot()).links.length === 1, "moving a node across tabs keeps its existing execution connection");
  const remoteLink = $("p-graph").querySelector('[data-remote-tab="tab-added-1"]');
  check(remoteLink?.textContent.includes("Review"), "a connection crossing tabs has a visible destination shortcut");
  remoteLink.click();
  await until(() => active("tab-added-1") && card("session-running"));
  check(card("session-running").classList.contains("running") && !card("session-idle"), "cross-tab connection shortcut opens the destination with its live running state");
  check(JSON.stringify(viewport()) !== JSON.stringify(defaultViewport), "new tab keeps an independent viewport");
  await fetch("/fixture/pending-link", { method: "POST" });
  await until(() => $("p-graph").querySelector('.graph-remote-gate[data-link="legacy-link"] .gate-btn.no'));
  check($("p-graph").querySelectorAll(".graph-remote-gate .gate-btn").length === 2, "a cross-tab pending connection exposes approve and reject controls");
  $("p-graph").querySelector('.graph-remote-gate[data-link="legacy-link"] .gate-btn.no').click();
  await until(() => !$("p-graph").querySelector(".graph-remote-gate"));
  const decision = (await snapshot()).requests.filter((request) => request.path === "/api/links/legacy-link/decide").at(-1);
  check(decision?.method === "POST" && decision.body.action === "reject", "remote gate rejection uses the original connection decision API");
  check(active("tab-added-1") && !$("link-dialog").open && (await snapshot()).links.length === 1, "remote gate rejection keeps the visible tab and connection intact");
  tab("tab-default").click();
  await until(() => active("tab-default") && !card("session-running"));
  check(!!tab("tab-added-1").querySelector(".graph-tab-running"), "background tab still displays its running badge");
  await fetch("/fixture/emit", { method: "POST", body: JSON.stringify({ type: "state", payload: { sessionId: "session-running", state: "idle" } }) });
  await until(() => !tab("tab-added-1").querySelector(".graph-tab-running"));
  check(active("tab-default") && !card("session-running"), "hidden session completion updates its tab badge without changing the visible tab");
  await fetch("/fixture/emit", { method: "POST", body: JSON.stringify({ type: "state", payload: { sessionId: "session-running", state: "running", runningStartedAt: "2026-10-16T00:00:00Z" } }) });
  await until(() => !!tab("tab-added-1").querySelector(".graph-tab-running"));
  tab("tab-added-1").click();
  await until(() => card("session-running")?.classList.contains("running"));
  check(true, "live execution updates keep arriving while a session's tab is hidden");

  $("p-graph-tab-add").click();
  await until(() => active("tab-added-3") && !$("p-graph-tab-add").disabled);
  const tempTitle = tab("tab-added-3").querySelector(".graph-tab-title").textContent;
  tab("tab-default").click();
  await until(() => card("cmd-legacy"));
  context(card("cmd-legacy")); menuItem("탭으로 이동: " + tempTitle).click();
  await until(() => active("tab-added-3") && card("cmd-legacy") && !$("p-graph-tab-add").disabled);
  context(tab("tab-added-3")); menuItem("탭 삭제").click();
  await until(() => $("p-graph-tab-dialog")?.open);
  check([...$("p-graph-tab-target").options].some((option) => option.value === "tab-added-1"), "deleting a populated tab offers a surviving destination");
  $("p-graph-tab-target").value = "tab-added-1"; $("p-graph-tab-confirm").click();
  await until(() => tabButtons().length === 2 && !$("p-graph-tab-dialog")?.open);
  tab("tab-added-1").click();
  await until(() => card("session-running") && card("cmd-legacy"));
  check((await snapshot()).commands.find((command) => command.id === "cmd-legacy").tabId === "tab-added-1", "deleting a populated tab moves its contents to the chosen destination");
  check((await snapshot()).sessions.length === 2 && (await snapshot()).commands.length === 1, "deleting a populated tab removes no executable nodes");
  check(alerts.length === 0, "tab operations finish without error dialogs: " + alerts.join("; "));
  return checks;
}

async function graphTabsReloadChecks() {
  const $ = (id) => document.getElementById(id), checks = [];
  const check = (condition, label) => { if (!condition) throw Error(label); checks.push(label); };
  const until = async (predicate) => { const deadline = Date.now() + 7000; while (!await predicate()) { if (Date.now() > deadline) throw Error("Timed out: " + predicate); await new Promise((resolve) => setTimeout(resolve, 20)); } };
  await until(() => $("project-nav").querySelector("button") && $("kpis").children.length === 4);
  $("project-nav").querySelector("button").click();
  const tabs = () => [...$("p-graph-tabs").querySelectorAll("[data-graph-tab]")];
  await until(async () => (await fetch("/fixture/snapshot").then((response) => response.json())).pendingTabLoads > 0);
  check(!$("p-graph").querySelector(".gcard, .gcmd, .graph-canvas"), "reloading a multi-tab project never exposes all tabs while metadata is pending");
  check($("p-relayout").disabled && $("p-flow-assistant-prompt").disabled, "reloading cannot edit another tab before the saved tab is resolved");
  await fetch("/fixture/release-tabs", { method: "POST" });
  await until(() => tabs().length === 2 && $("p-graph").querySelector('[data-id="session-running"]') && $("p-graph").querySelector('[data-id="cmd-legacy"]'));
  const active = tabs().find((button) => button.getAttribute("aria-selected") === "true" || button.classList.contains("active"));
  check(active?.dataset.graphTab === "tab-added-1", "reload remembers the last active grid tab for the project");
  check(active.textContent.includes("Review"), "reload restores the renamed tab");
  check(!$("p-graph").querySelector('[data-id="session-idle"]') && $("p-graph").querySelectorAll(".gcard").length === 1, "reload restores each node on its own tab");
  check(!!$("p-graph").querySelector('[data-id="cmd-legacy"]'), "reload restores contents moved during populated-tab deletion");
  check(tabs().map((button) => button.dataset.graphTab).join(",") === "tab-default,tab-added-1", "reload restores saved tab order without recreating the deleted tab");
  return checks;
}

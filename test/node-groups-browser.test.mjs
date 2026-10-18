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
test("browser: mixed node groups, boundary aliases, folding, moving and ungrouping", { timeout: 35000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-node-groups-browser-"));
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
    await command("Emulation.setDeviceMetricsOverride", { width: 1480, height: 920, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => {
      const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } };
      socket.addEventListener("message", listener);
    });
    await command("Page.navigate", { url: "http://127.0.0.1:" + server.address().port }); await loaded;
    const expression = `(${nodeGroupBrowserChecks.toString()})()`;
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    assert.ok(result.result.value.length >= 12, JSON.stringify(result.result.value));
    assert.deepEqual(errors, []);
    if (process.env.AGENTHUB_GROUP_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.AGENTHUB_GROUP_SCREENSHOT_DIR, { recursive: true });
      await command("Runtime.evaluate", { expression: "window.__nodeGroupsPreview(false)", awaitPromise: true });
      const graphShot = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.AGENTHUB_GROUP_SCREENSHOT_DIR, "node-groups.png"), Buffer.from(graphShot.data, "base64"));
      await command("Runtime.evaluate", { expression: "window.__nodeGroupsPreview(true)", awaitPromise: true });
      const foldedShot = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.AGENTHUB_GROUP_SCREENSHOT_DIR, "node-groups-folded.png"), Buffer.from(foldedShot.data, "base64"));
      await command("Runtime.evaluate", { expression: 'window.__nodeGroupsPreview(false).then(() => document.querySelector(".node-group-edit").click())', awaitPromise: true });
      const editorShot = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.AGENTHUB_GROUP_SCREENSHOT_DIR, "node-groups-editor.png"), Buffer.from(editorShot.data, "base64"));
    }
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});

async function nodeGroupBrowserChecks() {
  const { createCommandsController } = await import("/features/commands/controller.js");
  const { createGraphController } = await import("/features/graph/controller.js");
  const $ = (id) => document.getElementById(id);
  const checks = [], requests = [], alerts = [];
  const check = (condition, label) => { if (!condition) throw Error(label); checks.push(label); };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
  const until = async (predicate) => { const end = Date.now() + 7000; while (!predicate()) { if (Date.now() > end) throw Error("Timed out: " + predicate); await tick(); } };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  window.alert = (text) => alerts.push(text); window.confirm = () => true; new MutationObserver((records) => { for (const record of records) for (const added of record.addedNodes) if (added.classList?.contains("error-toast")) alerts.push(added.querySelector(".error-report-message")?.textContent ?? added.textContent); }).observe(document.body, { childList: true, subtree: true });
  const project = "C:/fixture";
  const makeSession = (id, title, x, y) => ({ id, title, agent: "codex", state: "idle", projectPath: project, createdAt: "2026-01-01", updatedAt: new Date().toISOString(), graphPos: { x, y } });
  const inside = makeSession("inside", "개발 세션", 400, 120); inside.waiting = true;
  const external = makeSession("outside", "시작 세션", 20, 120);
  const target = makeSession("target", "완료 세션", 1150, 120);
  const makeCommand = (id, kind, title, x, y) => ({ id: "cmd-" + id, kind, title, command: "npm test", prompt: "작업 시작", branch: "feature/group", gitAction: "merge", targetBranch: "develop", projectPath: project, state: "idle", members: [inside.id], pos: { x, y } });
  const git = makeCommand("git", "git", "브랜치 병합", 700, 120); git.state = "error";
  const shell = makeCommand("shell", "command", "명령줄 검증", 400, 300);
  const button = makeCommand("button", "button", "빌드 시작", 700, 300);
  const markdown = makeCommand("md", "markdown", "보고서 출력", 400, 480);
  const gather = makeCommand("gather", "group", "결과 집계", 700, 480);
  const data = { sessions: [inside, external, target], commands: [git, shell, button, markdown, gather], commandsProject: project, shells: [], links: [{ id: "incoming", from: external.id, to: inside.id, when: "success", keyword: "", enabled: true }, { id: "outgoing", from: git.id, to: target.id, when: "error", keyword: "", enabled: true }, { id: "internal", from: inside.id, to: shell.id, when: "success", enabled: true }], messages: [], status: { linkConditions: [{ id: "success", label: "성공 시" }, { id: "error", label: "실패 시" }, { id: "always", label: "항상" }, { id: "keyword", label: "키워드" }] } };
  const navigation = { project, view: "project" };
  let storedGroups = [], graph, commands;
  const allNodes = () => [...data.sessions, ...data.commands];
  const commandById = (id) => data.commands.find((item) => item.id === id);
  const aliases = (group) => {
    for (const link of data.links) {
      const outgoing = group.members.includes(link.from) && !group.members.includes(link.to);
      const incoming = group.members.includes(link.to) && !group.members.includes(link.from);
      if (!outgoing && !incoming) continue;
      const nodeId = outgoing ? link.from : link.to, direction = outgoing ? "output" : "input";
      if (!group.ports.some((port) => port.nodeId === nodeId && port.direction === direction && (!outgoing || port.when === link.when))) group.ports.push({ id: "port-" + link.id, nodeId, direction, label: direction === "input" ? "개발 입력" : "병합 실패", ...(outgoing ? { when: link.when } : {}) });
    }
  };
  const api = async (method, url, body) => {
    requests.push({ method, url, body: body && clone(body) });
    if (method === "GET" && url.startsWith("/api/node-groups?")) return { groups: clone(storedGroups) };
    if (method === "GET" && url.startsWith("/api/commands?")) return { commands: data.commands, shells: [] };
    if (method === "POST" && url === "/api/commands") { const created = { ...body, id: "cmd-created", state: "idle" }; data.commands.push(created); return created; }
    if (method === "GET" && url === "/api/links") return data.links;
    if (method === "POST" && url === "/api/node-groups") { const created = { ...clone(body), id: "grp-test" }; aliases(created); storedGroups.push(created); return clone(created); }
    if (method === "PUT" && url.startsWith("/api/node-groups/")) {
      const group = storedGroups.find((item) => url.endsWith(item.id));
      if (body.rect) {
        const dx = body.rect.x - group.rect.x, dy = body.rect.y - group.rect.y;
        for (const id of group.members) { const item = allNodes().find((entry) => entry.id === id), key = id.startsWith("cmd-") ? "pos" : "graphPos"; item[key] = { x: item[key].x + dx, y: item[key].y + dy }; }
      }
      Object.assign(group, clone(body)); group.ports = group.ports.filter((port) => group.members.includes(port.nodeId)); aliases(group); return clone(group);
    }
    if (method === "DELETE" && url.startsWith("/api/node-groups/")) { storedGroups = storedGroups.filter((item) => !url.endsWith(item.id)); return {}; }
    if (method === "PUT" && url.startsWith("/api/commands/")) { Object.assign(commandById(url.split("/").at(-1)), body); return {}; }
    if (method === "PUT" && url.startsWith("/api/sessions/")) { Object.assign(data.sessions.find((item) => url.endsWith(item.id)), body); return {}; }
    if (method === "POST" && url.endsWith("/run")) return {};
    if (method === "POST" && url === "/api/links") { data.links.push({ ...body, id: "link-new-" + requests.length }); for (const group of storedGroups) aliases(group); return data.links.at(-1); }
    throw Error("Unexpected API " + method + " " + url);
  };
  commands = createCommandsController({ api, loadLinks: () => graph.loadLinks(), renderGraph: () => graph.renderGraph(), connectCreatedGraphNode: (...args) => graph.connectCreatedGraphNode(...args), commandById, data, navigation });
  graph = createGraphController({ api, data, navigation, commandById, sessionById: (id) => data.sessions.find((item) => item.id === id), nodeTitle: (id) => allNodes().find((item) => item.id === id)?.title ?? id, commandNode: commands.commandNode, openCommandDialog: commands.openCommandDialog, runCommand: commands.runCommand, stopCommand: commands.stopCommand, removeCommand: commands.removeCommand, openCommandOutput: commands.openCommandOutput, skillChips: () => null, restartSession: () => {}, toggleSessionLock: () => {}, openNew: () => {}, openSkillsManager: () => {}, cancelNodeCreation: () => {}, loadCommands: commands.loadCommands, loadSessions: async () => {} });
  $("view-dashboard").hidden = true; $("view-project").hidden = false;
  Object.assign($("p-graph").style, { position: "fixed", left: "20px", top: "20px", width: "1440px", height: "880px", zIndex: "100", backgroundColor: "#10151e" });
  await graph.loadNodeGroups(); graph.renderLinkConditions(); graph.renderGraph();
  const card = (id) => $("p-graph").querySelector('[data-id="' + id + '"]');
  const frame = () => document.querySelector('[data-group-id="grp-test"]');
  const clickCard = (id, additive = false) => {
    const rect = card(id).getBoundingClientRect();
    const event = { clientX: rect.left + 30, clientY: rect.top + 30, pointerId: 1, button: 0, ctrlKey: additive, bubbles: true, cancelable: true };
    card(id).dispatchEvent(new PointerEvent("pointerdown", event)); window.dispatchEvent(new PointerEvent("pointerup", event));
  };
  for (const [index, item] of [inside, git, shell, button, markdown, gather].entries()) clickCard(item.id, index > 0);
  $("p-graph").dispatchEvent(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true }));
  await until(() => frame());
  const fullPreviewGroup = clone(storedGroups[0]), fullPreviewPositions = allNodes().map((item) => ({ id: item.id, pos: clone(item.graphPos ?? item.pos) }));
  check(storedGroups[0].members.length === 6, "Ctrl+G groups sessions, Git, command, button, Markdown and collector together");
  check(frame().querySelectorAll(".node-group-port").length === 2, "existing crossing links are automatically exposed as boundary ports");
  check(data.links.every((link) => !link.from.startsWith("grp-") && !link.to.startsWith("grp-")), "real link endpoints remain unchanged");
  check(frame().querySelector(".node-group-summary").textContent.includes("응답 대기 1") && frame().textContent.includes("오류 1"), "group summarizes member waiting and errors");
  check($("p-graph").querySelectorAll("path.group-boundary").length === 2, "expanded group draws boundary-to-node aliases");

  frame().querySelector(".node-group-toggle").click(); await until(() => frame()?.classList.contains("collapsed"));
  check(!card(inside.id) && !card(git.id) && card(external.id), "folding hides only member cards");
  check(data.sessions.includes(inside) && data.commands.length === 5, "folding keeps source node data intact");
  check(!$("p-graph").querySelector('[data-link="internal"]') && $("p-graph").querySelector('[data-link="incoming"]'), "folding hides internal edges and retains external links");
  const oldLinkCount = data.links.length;
  const drag = async (element, x, y) => {
    const rect = element.getBoundingClientRect();
    const start = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 7, button: 0, bubbles: true, cancelable: true };
    element.dispatchEvent(new PointerEvent("pointerdown", start));
    window.dispatchEvent(new PointerEvent("pointermove", { ...start, clientX: x, clientY: y }));
    window.dispatchEvent(new PointerEvent("pointerup", { ...start, clientX: x, clientY: y })); await tick();
  };
  let targetRect = card(target.id).getBoundingClientRect();
  await drag(frame().querySelector('.node-group-port.output'), targetRect.left + 25, targetRect.top + 25);
  check($("link-dialog").open && $("link-when").value === "error" && $("link-names").textContent.includes(git.title), "folded output port opens original Git endpoint and failure condition");
  $("link-dialog").close();
  const inputRect = frame().querySelector('.node-group-port.input .node-group-port-dot').getBoundingClientRect();
  await drag(card(external.id).querySelector(".gcard-handle"), inputRect.left + inputRect.width / 2, inputRect.top + inputRect.height / 2);
  check($("link-dialog").open && $("link-names").textContent.includes(inside.title), "normal output drops onto exact folded input alias");
  $("link-dialog").close();
  check(data.links.length === oldLinkCount, "opening and canceling alias connections does not change links");
  frame().querySelector(".node-group-buttons button").click();
  await until(() => requests.some((request) => request.method === "POST" && request.url === "/api/commands/cmd-button/run"));
  check(true, "folded group retains access to its internal start button");
  await tick();

  const previous = clone(storedGroups[0].rect), oldPos = clone(inside.graphPos);
  let header = frame().querySelector(".node-group-header").getBoundingClientRect();
  await drag(frame().querySelector(".node-group-header"), header.left + header.width / 2 + 40, header.top + header.height / 2 + 30);
  await until(() => storedGroups[0].rect.x === previous.x + 40);
  check(inside.graphPos.x === oldPos.x + 40 && inside.graphPos.y === oldPos.y + 30, "group drag moves hidden members once through the group API");
  check(!requests.some((request) => request.method === "PUT" && /api\/(sessions|commands)\//.test(request.url)), "group drag does not separately save member position deltas");
  frame().querySelector(".node-group-toggle").click(); await until(() => frame() && !frame().classList.contains("collapsed"));
  check(storedGroups[0].rect.w === previous.w && storedGroups[0].rect.h === previous.h && card(inside.id), "unfolding restores expanded bounds and member cards");
  const beforeResize = clone(storedGroups[0].rect), resize = frame().querySelector(".node-group-resize").getBoundingClientRect();
  await drag(frame().querySelector(".node-group-resize"), resize.left + resize.width / 2 + 50, resize.top + resize.height / 2 + 40);
  await until(() => storedGroups[0].rect.w === beforeResize.w + 50);
  check(storedGroups[0].rect.h === beforeResize.h + 40, "expanded group resizes without changing collapsed geometry");

  frame().querySelector(".node-group-edit").click();
  const dialog = $("node-group-dialog");
  check(dialog.open && dialog.querySelectorAll('.node-group-members input').length === 8, "group editor lists every node type");
  dialog.querySelector('[aria-label="그룹 이름"]').value = "출시 흐름";
  dialog.querySelector('[aria-label="출력 포트 이름"]').value = "통합 실패";
  dialog.querySelector('[aria-label="출력 포트 이름"]').dispatchEvent(new Event("input"));
  const membership = dialog.querySelector('input[type="checkbox"][value="cmd-md"]');
  membership.checked = false; membership.dispatchEvent(new Event("change"));
  const portDirection = dialog.querySelector('[aria-label="포트 방향"]');
  portDirection.value = "output"; portDirection.dispatchEvent(new Event("change"));
  const candidateNode = dialog.querySelector('[aria-label="포트에 연결할 내부 노드"]');
  const portCondition = dialog.querySelector('[aria-label="출력 조건"]');
  candidateNode.value = git.id; candidateNode.dispatchEvent(new Event("change"));
  check(![...portCondition.options].some((option) => option.value === "keyword"), "Git boundary outputs expose only supported structured result conditions");
  candidateNode.value = inside.id; candidateNode.dispatchEvent(new Event("change"));
  portCondition.value = "keyword"; portCondition.dispatchEvent(new Event("change"));
  dialog.querySelector('[aria-label="포트 키워드"]').value = "검증 완료";
  [...dialog.querySelectorAll("button")].find((element) => element.textContent === "포트 추가").click();
  dialog.querySelector('button[type="submit"]').click(); await until(() => !$("node-group-dialog"));
  check(storedGroups[0].title === "출시 흐름" && !storedGroups[0].members.includes(markdown.id), "group editor renames and removes a member without deleting the node");
  check(frame().querySelector('.node-group-port.output').textContent.includes("통합 실패"), "custom boundary port labels persist");
  check(card(markdown.id) && data.commands.includes(markdown), "removed member remains independently available");
  frame().querySelector(".node-group-toggle").click(); await until(() => frame()?.classList.contains("collapsed"));
  await drag(frame().querySelector('.node-group-port[data-when="keyword"]'), 1280, 730);
  const newCommand = [...document.querySelectorAll(".menu-item")].find((element) => element.textContent === "새 명령");
  check(newCommand, "keyword boundary output can create a node in empty canvas space");
  newCommand.click();
  $("command-title").value = "키워드 후속 명령"; $("command-text").value = "npm test"; $("command-save").click();
  await until(() => data.links.some((link) => link.to === "cmd-created"));
  check(data.links.find((link) => link.to === "cmd-created").when === "keyword" && data.links.find((link) => link.to === "cmd-created").keyword === "검증 완료", "boundary keyword condition survives creation of a new command node");
  frame().querySelector(".node-group-toggle").click(); await until(() => frame() && !frame().classList.contains("collapsed"));
  const shellRect = card(shell.id).getBoundingClientRect();
  await drag(card(shell.id), 1280, shellRect.top + shellRect.height / 2);
  await until(() => !storedGroups[0].members.includes(shell.id));
  check(card(shell.id), "dragging a member outside its box removes only group membership");
  await graph.loadNodeGroups();
  check(frame().querySelector(".node-group-title").textContent === "출시 흐름", "server reload restores group presentation");

  window.__nodeGroupsPreview = async (collapsed) => {
    data.commands = data.commands.filter((item) => item.id !== "cmd-created"); data.links = data.links.filter((link) => link.to !== "cmd-created");
    for (const entry of fullPreviewPositions) { const item = allNodes().find((node) => node.id === entry.id); item[item.id.startsWith("cmd-") ? "pos" : "graphPos"] = clone(entry.pos); }
    storedGroups = [{ ...clone(fullPreviewGroup), title: "출시 흐름", collapsed }]; await graph.loadNodeGroups();
  };

  // Delete on a selected group means dissolve, never delete its hidden members.
  const nodeCount = data.sessions.length + data.commands.length, linkCount = data.links.length;
  header = frame().querySelector(".node-group-header").getBoundingClientRect();
  frame().querySelector(".node-group-header").dispatchEvent(new PointerEvent("pointerdown", { clientX: header.left + 100, clientY: header.top + 10, pointerId: 1, button: 0, bubbles: true, cancelable: true }));
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: header.left + 100, clientY: header.top + 10, pointerId: 1, button: 0, bubbles: true, cancelable: true }));
  $("p-graph").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
  await until(() => !frame());
  check(data.sessions.length + data.commands.length === nodeCount && data.links.length === linkCount, "deleting selected group dissolves the box and preserves all nodes and links");
  check(!requests.some((request) => request.method === "DELETE" && /api\/(sessions|commands)\//.test(request.url)), "group deletion never reaches member deletion APIs");
  check(alerts.length === 0, "mixed group interactions produce no error alerts: " + alerts.join("; "));
  return checks;
}


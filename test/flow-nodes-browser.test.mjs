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
test("browser: input, repeat, transform, watch, and mixed collector nodes", { timeout: 35000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-flow-node-browser-"));
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
    const expression = `(${flowBrowserChecks.toString()})()`;
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    assert.ok(result.result.value.length >= 12, JSON.stringify(result.result.value));
    assert.deepEqual(errors, []);
    if (process.env.AGENTHUB_FLOW_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.AGENTHUB_FLOW_SCREENSHOT_DIR, { recursive: true });
      await command("Runtime.evaluate", { expression: "window.__flowBrowserPreview()", awaitPromise: true });
      const shot = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.AGENTHUB_FLOW_SCREENSHOT_DIR, "flow-input-editor.png"), Buffer.from(shot.data, "base64"));
    }

  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});


async function flowBrowserChecks() {
  const { createCommandsController } = await import('/features/commands/controller.js');
  const { createGraphController } = await import('/features/graph/controller.js');
  const $ = (id) => document.getElementById(id);
  const checks = [], requests = [], alerts = [];
  const check = (value, name) => { if (!value) throw Error(name); checks.push(name); };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  const until = async (predicate) => { const deadline = Date.now() + 8000; while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out: ' + predicate); await tick(); } };
  window.alert = (text) => alerts.push(text);
  const project = 'C:/flow-fixture';
  const input = { id: 'cmd-input', kind: 'input', title: '작업 입력', projectPath: project, state: 'idle', fields: [{ key: 'task', label: '작업', type: 'textarea', required: true }, { key: 'count', label: '횟수', type: 'number', defaultValue: 2 }, { key: 'branch', label: '브랜치', type: 'text', defaultValue: 'develop' }], prompt: '{{task}} {{count}}', pos: { x: 20, y: 20 } };
  const repeat = { id: 'cmd-repeat', kind: 'repeat', title: '수정 반복', projectPath: project, state: 'idle', maxIterations: 3, delayMs: 100, pos: { x: 20, y: 180 } };
  const transform = { id: 'cmd-transform', kind: 'transform', title: '실패 추출', projectPath: project, state: 'success', transformMode: 'json', expression: 'results.errors', lastRun: { ok: true, tail: '<img src=x onerror=alert(1)>\n[]', startedAt: new Date().toISOString() }, pos: { x: 400, y: 20 } };
  const watch = { id: 'cmd-watch', kind: 'watch', title: '소스 감시', projectPath: project, state: 'watching', watchPaths: ['src', 'package.json'], debounceMs: 500, prompt: '검증해 주세요', pos: { x: 20, y: 340 } };
  const shell = { id: 'cmd-shell', kind: 'command', title: '테스트', projectPath: project, state: 'idle', command: 'npm test', pos: { x: 400, y: 180 } };
  const git = { id: 'cmd-git', kind: 'git', title: '통합', projectPath: project, state: 'idle', gitAction: 'merge', branch: 'a', targetBranch: 'b' };
  const button = { id: 'cmd-button', kind: 'button', title: '시작', projectPath: project, state: 'idle' };
  const markdown = { id: 'cmd-md', kind: 'markdown', title: '저장', projectPath: project, state: 'idle' };
  const group = { id: 'cmd-group', kind: 'group', title: '검증 모으기', projectPath: project, state: 'idle', members: ['session-1', shell.id, transform.id] };
  const other = { id: 'cmd-other', kind: 'command', title: '다른 프로젝트', projectPath: 'C:/other', state: 'idle' };
  const session = { id: 'session-1', title: '구현', agent: 'codex', projectPath: project, state: 'idle', createdAt: '2026-01-01', updatedAt: new Date().toISOString() };
  const data = { commands: [input, repeat, transform, watch, shell, git, button, markdown, group, other], commandsProject: project, sessions: [session], shells: [{ id: 'powershell', label: 'PowerShell' }], links: [], messages: [], status: { linkConditions: [{ id: 'success', label: '성공 시' }, { id: 'error', label: '실패 시' }, { id: 'always', label: '항상' }, { id: 'manual', label: '수동' }] } };
  const navigation = { project, view: 'project' };
  const byId = (id) => data.commands.find((node) => node.id === id);
  const api = async (method, url, body) => {
    requests.push({ method, url, body });
    if (method === 'GET' && url.startsWith('/api/commands?')) return { commands: data.commands, shells: data.shells };
    if (method === 'GET' && url.startsWith('/api/node-groups?')) return [];
    if (method === 'GET' && url === '/api/links') return data.links;
    if (method === 'POST' && url === '/api/commands') { const node = { ...body, id: 'cmd-created-' + requests.length, state: 'idle' }; data.commands.push(node); return node; }
    if (method === 'PUT' && url.startsWith('/api/commands/')) { Object.assign(byId(url.split('/').at(-1)), body); return {}; }
    if (method === 'POST' && url.endsWith('/run')) return {};
    if (method === 'POST' && url.endsWith('/stop')) { byId(url.split('/')[3]).state = 'idle'; return {}; }
    if (method === 'POST' && url === '/api/links') { const link = { ...body, id: 'link-' + requests.length }; data.links.push(link); return link; }
    throw Error('Unexpected API ' + method + ' ' + url);
  };
  let graph;
  const commands = createCommandsController({ api, loadLinks: () => graph.loadLinks(), renderGraph: () => graph.renderGraph(), connectCreatedGraphNode: (...args) => graph.connectCreatedGraphNode(...args), commandById: byId, data, navigation });
  graph = createGraphController({ api, data, navigation, commandById: byId, sessionById: (id) => data.sessions.find((node) => node.id === id), nodeTitle: (id) => byId(id)?.title ?? session.title, commandNode: commands.commandNode, openCommandDialog: commands.openCommandDialog, runCommand: commands.runCommand, stopCommand: commands.stopCommand, removeCommand: commands.removeCommand, openCommandOutput: commands.openCommandOutput, skillChips: () => null, restartSession: () => {}, toggleSessionLock: () => {}, openNew: () => {}, openSkillsManager: () => {}, cancelNodeCreation: commands.cancelCreation, loadCommands: commands.loadCommands, loadSessions: async () => {} });
  $('view-dashboard').hidden = true; $('view-project').hidden = false;
  Object.assign($('p-graph').style, { position: 'fixed', left: '20px', top: '20px', width: '1300px', height: '800px', zIndex: '1' });
  graph.renderGraph();
  check($('p-graph').querySelector('[data-id="cmd-repeat"]').querySelectorAll('.gcard-handle[data-when]').length === 2, 'repeat exposes body and exhausted output ports');
  check($('p-graph').querySelector('[data-id="cmd-watch"]').textContent.includes('감시 중'), 'watching node displays its monitoring state');
  commands.openCommandDialog(input);
  check(!$('input-settings').hidden && $('command-text-row').hidden && $('input-fields').children.length === 3, 'input editor uses typed field rows');
  $('input-field-add').click();
  const row = $('input-fields').lastElementChild;
  row.querySelector('.flow-field-key').value = 'issue'; row.querySelector('.flow-field-label').value = '이슈 번호'; row.querySelector('.flow-field-type').value = 'number'; row.querySelector('.flow-field-required').checked = true; row.querySelector('.flow-field-default').value = '7';
  $('command-save').click(); await until(() => !$('command-dialog').open);
  const savedInput = requests.find((request) => request.method === 'PUT' && request.url.endsWith(input.id));
  check(savedInput.body.fields.length === 4 && savedInput.body.fields[3].type === 'number' && savedInput.body.fields[3].required, 'input editor saves field schema');
  const pendingRun = commands.runCommand(input); await until(() => $('input-run-dialog').open);
  check($('input-run-fields').querySelector('textarea[name="task"]') && $('input-run-fields').querySelector('input[name="count"]').type === 'number', 'execution renders real textarea and numeric controls');
  $('input-run-fields').querySelector('[name="task"]').value = '결제 테스트'; $('input-run-fields').querySelector('[name="count"]').value = '4'; $('input-run-form').querySelector('[value="run"]').click(); await pendingRun;
  const inputRun = requests.find((request) => request.method === 'POST' && request.url === '/api/commands/' + input.id + '/run');
  check(inputRun.body.values.task === '결제 테스트' && inputRun.body.values.count === 4 && inputRun.body.values.branch === 'develop' && inputRun.body.values.issue === 7, 'input run posts typed values and configured defaults');
  const beforeCancel = requests.length; const cancelledRun = commands.runCommand(input); await until(() => $('input-run-dialog').open); $('input-run-dialog').close(); await cancelledRun;
  check(!requests.slice(beforeCancel).some((request) => request.url.endsWith('/run')), 'cancelling input form does not execute');
  commands.openCommandDialog(repeat); $('repeat-max').value = '5'; $('repeat-delay').value = '250'; $('command-save').click(); await until(() => !$('command-dialog').open);
  const savedRepeat = requests.find((request) => request.method === 'PUT' && request.url.endsWith(repeat.id));
  check(savedRepeat.body.maxIterations === 5 && savedRepeat.body.delayMs === 250, 'repeat editor saves bounded iteration and delay settings');
  commands.openCommandDialog(transform); $('transform-mode').value = 'template'; $('transform-mode').dispatchEvent(new Event('change'));
  check(!$('transform-template-row').hidden && $('transform-expression-row').hidden, 'transform switches mode-specific fields');
  $('transform-template').value = '검사: {{input}} / {{task}}'; $('command-save').click(); await until(() => !$('command-dialog').open);
  check(requests.some((request) => request.method === 'PUT' && request.body?.transformMode === 'template' && request.body.template.includes('{{task}}')), 'transform editor saves template without evaluation');
  await commands.openCommandOutput(transform);
  check($('command-result-dialog').open && $('command-result-raw').textContent === transform.lastRun.tail && !$('command-result-raw').querySelector('img'), 'non-markdown results are inspectable as escaped plain output');
  $('command-result-dialog').close();
  commands.openCommandDialog(watch); $('watch-paths').value = 'src\npackage.json\n'; $('watch-debounce').value = '800'; $('command-save').click(); await until(() => !$('command-dialog').open);
  const savedWatch = requests.find((request) => request.method === 'PUT' && request.url.endsWith(watch.id));
  check(savedWatch.body.watchPaths.length === 2 && savedWatch.body.debounceMs === 800, 'watch editor saves relative paths and debounce');
  await commands.runCommand(watch);
  check(requests.some((request) => request.url === '/api/commands/' + watch.id + '/stop'), 'watch action disarms existing monitoring');
  await commands.runCommand(watch);
  check(requests.some((request) => request.url === '/api/commands/' + watch.id + '/run'), 'watch action arms monitoring when idle');
  commands.openCommandDialog(group);
  const memberIds = [...$('group-members').querySelectorAll('input')].map((node) => node.value);
  check([session.id, input.id, repeat.id, transform.id, shell.id, git.id].every((id) => memberIds.includes(id)), 'collector accepts mixed executable node kinds');
  check([watch.id, button.id, markdown.id, group.id, other.id].every((id) => !memberIds.includes(id)), 'collector excludes incompatible and other-project nodes');
  $('command-dialog').close();
  const card = (id) => $("p-graph").querySelector('[data-id="' + id + '"]');
  const drag = async (from, when, to) => {
    const handle = card(from).querySelector(when ? '[data-when="' + when + '"]' : '.gcard-handle');
    const rect = handle.getBoundingClientRect(), target = card(to).getBoundingClientRect();
    const start = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 41, button: 0, bubbles: true, cancelable: true };
    handle.dispatchEvent(new PointerEvent('pointerdown', start));
    const end = { ...start, clientX: target.left + 40, clientY: target.top + 40 };
    window.dispatchEvent(new PointerEvent('pointermove', end)); window.dispatchEvent(new PointerEvent('pointerup', end)); await tick();
  };
  await drag(repeat.id, 'error', shell.id);
  check($("link-dialog").open && $("link-when").value === 'error', 'repeat exhausted port creates failure condition');
  $("link-form").querySelector('[value="ok"]').click(); await until(() => !$("link-dialog").open);
  check(data.links.some((link) => link.from === repeat.id && link.to === shell.id && link.when === 'error'), 'repeat failure connection is saved');
  check([...$("p-graph").querySelectorAll('path.edge')].some((path) => path.getAttribute('d').startsWith('M250,258')), 'repeat saved edge starts at the exhausted port');
  await drag(transform.id, null, input.id);
  await drag(transform.id, null, watch.id);
  check(alerts.length === 2 && alerts.every((message) => message.includes('시작점')) && !$("link-dialog").open, 'input and watch reject incoming links'); alerts.length = 0;
  check(!card(markdown.id).querySelector('.gcard-handle'), 'markdown remains a terminal node');
  $('p-graph').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 700 }));
  const menu = document.querySelector('.context-menu');
  check(menu && ['새 입력 폼', '새 반복 제어', '새 결과 가공', '새 파일 감시'].every((name) => menu.textContent.includes(name)), 'creation menu offers all new node kinds');
  for (const [kind, label] of [['input', '새 입력 폼'], ['repeat', '새 반복 제어'], ['transform', '새 결과 가공'], ['watch', '새 파일 감시']]) {
    if (!document.querySelector('.context-menu')) $('p-graph').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 700 }));
    [...document.querySelectorAll('.menu-item')].find((button) => button.textContent === label).click();
    check($('command-dialog').open && !$(kind + '-settings').hidden, 'creation opens ' + kind + ' settings');
    $('command-title').value = '새 ' + kind;
    $('command-save').click(); await until(() => !$('command-dialog').open);
    const created = requests.filter((request) => request.method === 'POST' && request.url === '/api/commands').at(-1);
    check(created.body.kind === kind && created.body.projectPath === project && (kind !== 'watch' || created.body.watchPaths[0] === 'src'), 'creation posts ' + kind + ' contract');
    if (kind !== 'watch') $('p-graph').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 700 }));
  }
  window.__flowBrowserPreview = () => { document.querySelector(".context-menu")?.remove(); commands.openCommandDialog(input); };
  check(alerts.length === 0, 'valid feature interactions report no errors');
  return checks;
}

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
test("browser: execution history, scoped stop, resume, templates, and notifications", { timeout: 90000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-execution-browser-"));
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
      // 전체 테스트가 브라우저 테스트를 동시에 돌리면 혼자 2초 걸리는 동작도 20초 넘게 걸린다.
      const timer = setTimeout(() => reject(Error("DevTools timed out: " + method + "\n" + stderr)), 30000);
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
    const expression = `(${executionBrowserChecks.toString()})()`;
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    assert.ok(result.result.value.length >= 30, JSON.stringify(result.result.value));
    assert.deepEqual(errors, []);
    if (process.env.AGENTHUB_EXECUTION_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.AGENTHUB_EXECUTION_SCREENSHOT_DIR, { recursive: true });
      await command("Runtime.evaluate", { expression: "window.__executionBrowserPreview()", awaitPromise: true });
      const shot = await command("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(process.env.AGENTHUB_EXECUTION_SCREENSHOT_DIR, "execution-history.png"), Buffer.from(shot.data, "base64"));
    }

  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});


async function executionBrowserChecks() {
  const { createCommandsController } = await import('/features/commands/controller.js');
  const { createGraphController } = await import('/features/graph/controller.js');
  const { createExecutionControls } = await import('/features/executions/controller.js');
  const { connectLiveUpdates } = await import('/application/live-updates.js');
  const $ = (id) => document.getElementById(id);
  const checks = [], requests = [], alerts = [], notices = [], audioStarts = [];
  const check = (value, name) => { if (!value) throw Error(name); checks.push(name); };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  const until = async (predicate) => { const deadline = Date.now() + 8000; while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out: ' + predicate); await tick(); } };
  window.alert = (text) => alerts.push(text); new MutationObserver((records) => { for (const record of records) for (const added of record.addedNodes) if (added.classList?.contains("error-toast")) alerts.push(added.querySelector(".error-report-message")?.textContent ?? added.textContent); }).observe(document.body, { childList: true, subtree: true });
  localStorage.removeItem('agenthub.flowNotifications');
  let permissionRequests = 0;
  class NotificationMock {
    static permission = 'default';
    static async requestPermission() { permissionRequests++; this.permission = 'granted'; return this.permission; }
    constructor(title, options) { notices.push({ title, options }); }
    close() {}
  }
  window.Notification = NotificationMock;
  window.AudioContext = class {
    currentTime = 0; destination = {};
    resume() { return Promise.resolve(); }
    createOscillator() { return { frequency: {}, connect() {}, start() { audioStarts.push(true); }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  };
  const liveHandlers = {};
  window.EventSource = class { addEventListener(name, handler) { liveHandlers[name] = handler; } close() {} };
  const project = 'C:/execution-fixture', now = '2026-10-16T09:00:00.000Z';
  const notify = { id: 'cmd-notify', kind: 'notify', title: '완료 알림', projectPath: project, state: 'idle', message: '{{input}}', notificationTitle: '검증 완료', level: 'success', sound: true, pos: { x: 430, y: 100 } };
  const shell = { id: 'cmd-shell', kind: 'command', title: '테스트', projectPath: project, state: 'idle', command: 'npm test', pos: { x: 30, y: 100 } };
  const group = { id: 'box-1', title: '검증 흐름', projectPath: project, members: [shell.id, notify.id], ports: [], collapsed: false, rect: { x: 10, y: 10, w: 730, h: 300 } };
  let groupList = [group], templateList = [], refreshes = 0;
  const failed = { id: 'run-failed', projectPath: project, sourceId: shell.id, sourceTitle: '실패한 검증', status: 'error', startedAt: now, endedAt: '2026-10-16T09:00:03.000Z', steps: [
    { id: 'step-good', nodeId: 'session-1', nodeTitle: '구현', status: 'success', input: '기능 추가', output: '완료', startedAt: now, durationMs: 2000 },
    { id: 'step-failed', nodeId: shell.id, nodeTitle: '테스트', status: 'error', input: { task: '<img src=x onerror=alert(1)>' }, output: 'FAIL payment', error: '종료 코드 1', durationMs: 1000 },
  ] };
  const running = { id: 'run-running', projectPath: project, sourceId: shell.id, sourceTitle: '진행 중인 검증', status: 'running', startedAt: now, steps: [{ id: 'step-running', nodeId: shell.id, nodeTitle: '테스트', status: 'running', input: '현재 실행', output: '' }] };
  let runs = [failed, running];
  const data = { commands: [shell, notify], commandsProject: project, sessions: [], shells: [{ id: 'powershell', label: 'PowerShell' }], links: [], messages: [], nodeGroups: groupList, nodeGroupsProject: project, status: { linkConditions: [{ id: 'success', label: '성공 시' }, { id: 'error', label: '실패 시' }, { id: 'always', label: '항상' }] } };
  const navigation = { project, view: 'project' };
  const byId = (id) => data.commands.find((node) => node.id === id);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const api = async (method, url, body) => {
    requests.push({ method, url, body: clone(body ?? null) });
    if (method === 'GET' && url.startsWith('/api/runs?')) return { runs: clone(runs) };
    if (method === 'GET' && url.startsWith('/api/runs/')) return clone(runs.find((run) => run.id === url.split('/')[3]));
    if (method === 'POST' && url.endsWith('/stop') && url.startsWith('/api/runs/')) { const run = runs.find((run) => run.id === url.split('/')[3]); run.status = 'stopped'; run.steps.filter((step) => step.status === 'running').forEach((step) => step.status = 'stopped'); return {}; }
    if (method === 'POST' && url.endsWith('/resume')) { const run = { ...clone(failed), id: 'run-resumed', sourceTitle: '재개한 검증', status: 'running', resumedFrom: failed.id }; run.steps[0].options = { reused: true, sourceRunId: failed.id }; runs.unshift(run); return { run }; }
    if (method === 'GET' && url.startsWith('/api/group-templates?')) return { templates: clone(templateList) };
    if (method === 'POST' && url === '/api/group-templates') { const value = { id: 'template-1', title: body.title, nodeCount: 2, createdAt: now }; templateList.push(value); return { template: value }; }
    if (method === 'DELETE' && url.startsWith('/api/group-templates/')) { templateList = []; return {}; }
    if (method === 'POST' && url.endsWith('/instantiate')) { const next = { ...clone(group), id: 'box-copy', title: '검증 흐름 복사', rect: { ...group.rect, ...(body.pos ?? {}) } }; groupList.push(next); return { group: next, nodes: [] }; }
    if (method === 'GET' && url.startsWith('/api/node-groups?')) return { groups: groupList };
    if (method === 'GET' && url.startsWith('/api/commands?')) return { commands: data.commands, shells: data.shells };
    if (method === 'GET' && url === '/api/links') return data.links;
    if (method === 'PUT' && url.startsWith('/api/commands/')) { Object.assign(byId(url.split('/').at(-1)), body); return {}; }
    if (method === 'POST' && url === '/api/commands') { const value = { ...body, id: 'cmd-created', state: 'idle' }; data.commands.push(value); return value; }
    if (method === 'POST' && url === '/api/links') { const value = { ...body, id: 'link-created' }; data.links.push(value); return value; }
    if (method === 'POST' && url.endsWith('/run')) return {};
    throw Error('Unexpected API ' + method + ' ' + url);
  };
  let graph, controls;
  const commands = createCommandsController({ api, loadLinks: () => graph.loadLinks(), renderGraph: () => graph.renderGraph(), connectCreatedGraphNode: (...args) => graph.connectCreatedGraphNode(...args), commandById: byId, data, navigation });
  graph = createGraphController({ api, data, navigation, commandById: byId, sessionById: () => null, nodeTitle: (id) => byId(id)?.title ?? id, commandNode: commands.commandNode, openCommandDialog: commands.openCommandDialog, runCommand: commands.runCommand, stopCommand: commands.stopCommand, removeCommand: commands.removeCommand, openCommandOutput: commands.openCommandOutput, skillChips: () => null, restartSession: () => {}, toggleSessionLock: () => {}, openNew: () => {}, openSkillsManager: () => {}, cancelNodeCreation: commands.cancelCreation, loadCommands: commands.loadCommands, loadSessions: async () => {}, saveGroupTemplate: (value) => controls.saveTemplate(value), openGroupTemplates: (pos) => controls.openTemplates(pos), clearExecutionControls: () => controls.clear() });
  controls = createExecutionControls({ api, navigation, refreshGraph: async () => { refreshes++; await graph.loadLinks(); } });
  const noop = () => {};
  const stream = connectLiveUpdates({ data, navigation, refreshRuns: controls.refreshRuns, notifyFlow: controls.notify, loadSessions: noop, projectTab: () => 'flow' });
  $('view-dashboard').hidden = true; $('view-project').hidden = false;
  Object.assign($('p-graph').style, { position: 'fixed', left: '20px', top: '160px', width: '1300px', height: '650px', zIndex: '1' });
  graph.renderGraph();
  check($('p-graph').querySelector('[data-id="cmd-notify"] [class="gcard-handle"]'), 'notification node has an ordinary continuation port');
  const handle = $('p-graph').querySelector('[data-id="cmd-notify"] .gcard-handle');
  const from = handle.getBoundingClientRect(), to = $('p-graph').querySelector('[data-id="cmd-shell"]').getBoundingClientRect();
  const pointer = { clientX: from.left + from.width / 2, clientY: from.top + from.height / 2, pointerId: 42, button: 0, bubbles: true, cancelable: true };
  handle.dispatchEvent(new PointerEvent('pointerdown', pointer));
  const endpoint = { ...pointer, clientX: to.left + 40, clientY: to.top + 40 };
  window.dispatchEvent(new PointerEvent('pointermove', endpoint)); window.dispatchEvent(new PointerEvent('pointerup', endpoint));
  check($('link-dialog').open, 'notification continuation can connect to another executable node');
  $('link-form').querySelector('[value="ok"]').click(); await until(() => !$('link-dialog').open);
  check(data.links.some((link) => link.from === notify.id && link.to === shell.id), 'notification continuation saves a real graph connection');
  $('p-execution-history').click(); await until(() => $('execution-step-detail')?.textContent.includes('종료 코드 1'));
  check($('execution-history-dialog').open && document.querySelectorAll('.execution-run-row').length === 2, 'toolbar opens project execution list');
  check(requests.some((request) => request.url === '/api/runs?path=' + encodeURIComponent(project)), 'history list is scoped to the selected project');
  check($('execution-step-detail').textContent.includes('<img src=x onerror=alert(1)>') && !$('execution-step-detail').querySelector('img'), 'step input, output, and error are rendered without executing markup');
  check(!$('execution-history-dialog').textContent.includes('null'), 'optional record metadata does not leak placeholder text');
  check($('execution-step-detail').textContent.includes('FAIL payment'), 'failed step shows captured output');
  check(!$('execution-run-resume').disabled && $('execution-run-stop').hidden, 'failed run selects a resumable step and has no stop action');
  document.querySelector('[data-step-id="step-good"]').click();
  check($('execution-run-resume').disabled, 'successful steps cannot be accidentally retried');
  document.querySelector('[data-step-id="step-failed"]').click(); $('execution-run-resume').click();
  await until(() => document.querySelector('.execution-run-row.selected')?.dataset.runId === 'run-resumed' && $('execution-run-stop'));
  check(requests.some((request) => request.url === '/api/runs/run-failed/resume' && request.body.stepId === 'step-failed'), 'resume posts the explicitly selected failed step');
  check($('execution-run-resume').hidden && !$('execution-run-stop').hidden, 'resumed execution opens its fresh running record');
  check(document.querySelector('[data-step-id="step-good"] .execution-step-reused')?.textContent === '기존 결과 사용', 'resumed run distinguishes reused successful results from executed steps');
  document.querySelector('[data-step-id="step-good"]').click();
  check($('execution-step-detail').textContent.includes('기존 결과 사용') && $('execution-run-resume').hidden, 'reused step detail identifies its existing result without offering a retry');
  document.querySelector('[data-run-id="run-running"]').click(); await until(() => $('execution-run-stop') && !$('execution-run-stop').hidden);
  $('execution-run-stop').click(); await until(() => $('execution-run-stop')?.hidden);
  check(requests.filter((request) => request.url.endsWith('/stop')).length === 1 && requests.some((request) => request.url === '/api/runs/run-running/stop'), 'flow stop targets one run instead of project-wide processes');
  check(runs.find((run) => run.id === 'run-resumed').status === 'running', 'stopping one run preserves other running flows');
  check(!$('execution-run-resume').hidden, 'a stopped step can be resumed from history');
  const beforeRefresh = requests.length; liveHandlers.runs({ data: '{}' }); await until(() => requests.length >= beforeRefresh + 2);
  check(requests.slice(beforeRefresh).some((request) => request.url.startsWith('/api/runs?')), 'live run changes refresh an open history panel');
  $('execution-history-dialog').close(); await tick(); const afterClose = requests.length; liveHandlers.runs({ data: '{}' }); await tick();
  check(requests.length === afterClose, 'closed history does not poll or load records');
  const frame = () => $('p-graph').querySelector('[data-group-id="box-1"]');
  frame().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 200 }));
  const saveItem = [...document.querySelectorAll('.menu-item')].find((button) => button.textContent === '템플릿으로 저장');
  check(saveItem, 'large group context menu offers reusable templates'); saveItem.click();
  $('group-template-title').value = '공통 검증'; $('group-template-save-dialog').querySelector('button[type="submit"]').click(); await until(() => !$('group-template-save-dialog'));
  check(requests.some((request) => request.url === '/api/group-templates' && request.body.groupId === group.id && request.body.title === '공통 검증'), 'saving a template posts a group reference and title');
  $('p-group-templates').click(); await until(() => document.querySelector('.execution-template-row'));
  check($('group-templates-dialog').textContent.includes('공통 검증') && $('group-templates-dialog').textContent.includes('2개 노드'), 'template picker shows saved titles and node counts');
  document.querySelector('.execution-template-row .primary').click(); await until(() => !$('group-templates-dialog'));
  check(requests.some((request) => request.url === '/api/group-templates/template-1/instantiate' && request.body.projectPath === project), 'template picker instantiates in the current project');
  check(refreshes >= 3 && $('p-graph').querySelector('[data-group-id="box-copy"]'), 'template application refreshes the graph with the new group');
  await controls.openTemplates({ x: 800, y: 400 }); document.querySelector('.execution-template-row .primary').click(); await until(() => !$('group-templates-dialog'));
  check(requests.filter((request) => request.url.endsWith('/instantiate')).at(-1).body.pos.x === 800, 'canvas template insertion preserves the chosen placement');
  await controls.openTemplates(); document.querySelector('.execution-template-row .danger').click(); await until(() => !$('group-templates-dialog').querySelector('.execution-template-row'));
  check(requests.some((request) => request.method === 'DELETE' && request.url === '/api/group-templates/template-1'), 'template deletion removes the saved template');
  $('group-templates-dialog').close();
  commands.openCommandDialog(notify);
  check(!$('notify-settings').hidden && $('command-text-row').hidden && $('command-heading').textContent.includes('알림'), 'notification node opens dedicated controls');
  $('notify-message').value = '검사: {{input}} / {{task}}'; $('notify-title').value = '실패 확인'; $('notify-level').value = 'error'; $('notify-sound').checked = false; $('command-save').click(); await until(() => !$('command-dialog').open);
  check(requests.some((request) => request.method === 'PUT' && request.url.endsWith(notify.id) && request.body.message.includes('{{task}}') && request.body.notificationTitle === '실패 확인' && request.body.level === 'error' && request.body.sound === false), 'notification editor saves message templates, title, level, and sound choice');
  notify.lastRun = { ok: true, tail: '<b>알림 내용</b>', startedAt: now }; await commands.openCommandOutput(notify);
  check($('command-result-raw').textContent === '<b>알림 내용</b>' && !$('command-result-raw').querySelector('b'), 'notification results remain inspectable as plain output'); $('command-result-dialog').close();
  $('p-graph').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1000, clientY: 700 }));
  const createItem = [...document.querySelectorAll('.menu-item')].find((button) => button.textContent === '새 알림'); check(createItem, 'graph creation menu offers notification nodes'); createItem.click();
  $('command-title').value = '새 알림'; $('command-save').click(); await until(() => !$('command-dialog').open);
  check(requests.some((request) => request.method === 'POST' && request.url === '/api/commands' && request.body.kind === 'notify' && request.body.notificationTitle === 'AgentHub'), 'notification creation uses the ordinary command node contract');
  liveHandlers.notification({ data: JSON.stringify({ id: 'notice-1', title: '완료', message: '<img src=x onerror=alert(1)>', level: 'success', sound: true }) });
  await tick();
  check($('flow-notification-tray').textContent.includes('<img src=x onerror=alert(1)>') && !$('flow-notification-tray').querySelector('img'), 'live notification displays a safe in-app toast');
  check(permissionRequests === 0 && notices.length === 0 && audioStarts.length === 0, 'incoming events never request permission or play unapproved sounds');
  liveHandlers.notification({ data: JSON.stringify({ id: 'notice-1', message: 'duplicate' }) });
  check($('flow-notification-tray').children.length === 1, 'duplicate notification events are shown once');
  $('p-flow-notifications').click(); check($('flow-notifications-dialog').open && permissionRequests === 0, 'notification preferences open without prompting for permission');
  $('flow-notifications-desktop').click(); await until(() => permissionRequests === 1 && !$('flow-notifications-desktop').disabled);
  check($('flow-notifications-desktop').checked && Notification.permission === 'granted', 'desktop permission is requested only after the user enables it');
  $('flow-notifications-sound').click(); await until(() => audioStarts.length === 1); $('flow-notifications-dialog').close();
  liveHandlers.notification({ data: JSON.stringify({ id: 'notice-2', title: '빌드 완료', message: '테스트 성공', level: 'success', sound: true }) }); await until(() => audioStarts.length === 2);
  check(notices.length === 1 && notices[0].title === '빌드 완료' && notices[0].options.body === '테스트 성공', 'enabled desktop notifications use live titles and messages');
  check(notices[0].options.silent === true && audioStarts.length === 2, 'sound follows both browser preferences and the node sound flag');
  liveHandlers.notification({ data: JSON.stringify({ id: 'notice-3', title: '조용한 알림', message: '내용', sound: false }) }); await tick(); check(audioStarts.length === 2, 'nodes can suppress sound even when sound is allowed');
  $('p-flow-notifications').click(); $('flow-notifications-desktop').click(); Notification.permission = 'denied'; $('flow-notifications-desktop').click(); await tick();
  check(!$('flow-notifications-desktop').checked && permissionRequests === 1 && $('flow-notifications-status').textContent.includes('차단'), 'denied desktop permission remains disabled without repeated permission prompts');
  $('flow-notifications-dialog').close();
  const savedRuns = runs; runs = []; await controls.openHistory();
  check($('execution-history-dialog').textContent.includes('아직 실행 기록이 없습니다'), 'empty execution history explains how records appear');
  $('execution-history-dialog').close(); runs = savedRuns;
  const pendingHistory = controls.openHistory(); await pendingHistory;
  check($('execution-history-dialog')?.open, 'history reopens after other interactions');
  graph.clearGraphTransientState(); await until(() => !$('execution-history-dialog')); check(!$('execution-history-dialog'), 'leaving the graph closes transient execution controls');
  window.__executionBrowserPreview = async () => { await controls.openHistory('run-failed'); };
  check(alerts.length === 0, 'execution control interactions produce no alert errors: ' + alerts.join('; '));
  stream.close();
  return checks;
}

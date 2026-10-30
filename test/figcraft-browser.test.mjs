import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHub } from "../server/bootstrap.mjs";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function withBrowser(temp, url, title, run) {
  const profile = path.join(temp, "profile");
  const child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true });
  let log = "", socket;
  child.stderr.on("data", (data) => log += data);
  const closed = new Promise((resolve) => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 10000;
    let port;
    while (!port) {
      if (Date.now() > deadline) throw Error("Browser launch timed out: " + log);
      port = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").then((text) => +text.split("\n")[0], () => null);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((res) => res.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map(), errors = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id);
        if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result);
      }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error("Browser timeout: " + method + "\n" + errors.join("\n"))); }, 30000);
      pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const evaluate = async (expression, contextId, sessionId) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await command("Runtime.enable"); await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await command("Page.navigate", { url });
    await evaluate(`new Promise((resolve,reject)=>{ const end=Date.now()+10000; const check=()=>{ const link=[...document.querySelectorAll('#session-list button')].find(x=>x.textContent.includes(${JSON.stringify(title)})); if(link){link.click();resolve(true);}else if(Date.now()>end)reject(Error('session not loaded: '+document.querySelector('#session-list')?.outerHTML.slice(0,600)));else setTimeout(check,25); };check(); })`);
    await run({ command, evaluate, errors });
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

const until = (condition) => `new Promise((resolve,reject)=>{const end=Date.now()+20000;const check=async()=>{if(await (${condition}))resolve(true);else if(Date.now()>end)reject(Error('Timed out: '+${JSON.stringify(condition)}));else setTimeout(check,25);};check();})`;

test("browser: FigCraft 노드를 메뉴로 만들어 실행하고, 결과 미리보기와 대화 속 .figcraft 미리보기를 본다", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chrome).then(() => true, () => false)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-figcraft-ui-"));
  const project = path.join(temp, "project");
  await fs.mkdir(project, { recursive: true });
  const fake = path.join(temp, "fake-figcraft-cli.mjs");
  copyFileSync(fileURLToPath(new URL("./fixtures/fake-figcraft-cli.mjs.txt", import.meta.url)), fake);
  const design = path.join(project, "login.figcraft");
  await fs.writeFile(design, JSON.stringify({ frames: ["로그인"] }));
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "디자인", path: project }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  hub.store.add({ id: "s1", title: "화면 담당", agent: "codex", permission: "workspace-write", projectPath: project, projectName: "디자인", cwd: project, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), graphPos: { x: 40, y: 40 },
    events: [{ seq: 0, kind: "user", text: "로그인 화면 만들어 줘" }, { seq: 1, kind: "text", text: "만들었습니다: [로그인 화면](login.figcraft)" }, { seq: 2, kind: "result", text: "완료" }] });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  await fetch(`http://127.0.0.1:${hub.port}/api/figcraft`, { method: "PUT", headers: { "x-agenthub": "1", "Content-Type": "application/json" }, body: JSON.stringify({ cliPath: fake }) });
  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, "화면 담당", async ({ command, evaluate, errors }) => {
    // 대화 속 .figcraft 링크 → PNG로 그린 미리보기와 FigCraft에서 열기
    await evaluate(until("[...document.querySelectorAll('#s-events a.report-ref')].some((a) => a.textContent === '로그인 화면')"));
    await evaluate("[...document.querySelectorAll('#s-events a.report-ref')].find((a) => a.textContent === '로그인 화면').click()");
    await evaluate(until("document.querySelector('dialog.report-preview[open] .report-full-image')?.naturalWidth === 1"));
    assert.match(await evaluate("document.querySelector('dialog.report-preview .report-full-image').getAttribute('src')"), /\/artifact\/figcraft-preview\?path=/);
    assert.ok(await evaluate("[...document.querySelectorAll('dialog.report-preview .report-toolbar button')].some((b) => b.textContent === 'FigCraft에서 열기')"));
    await evaluate("document.querySelector('dialog.report-preview').close()");

    // 그래프 메뉴 → 디자인 → FigCraft 디자인 만들기
    await evaluate(until("[...document.querySelectorAll('#project-nav button')].some((x) => x.textContent.includes('디자인'))"));
    await evaluate("[...document.querySelectorAll('#project-nav button')].find((x) => x.textContent.includes('디자인')).click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    await evaluate(until("document.querySelector('.gcard[data-id=s1]')"));
    await evaluate("document.querySelector('#p-graph').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 800, clientY: 400 }))");
    await evaluate(until("[...document.querySelectorAll('.context-menu .menu-item')].some((b) => b.textContent === 'FigCraft 디자인 만들기')"));
    await evaluate("[...document.querySelectorAll('.context-menu .menu-item')].find((b) => b.textContent === 'FigCraft 디자인 만들기').click()");
    await evaluate(until("document.querySelector('#command-dialog').open && !document.querySelector('#figcraft-settings').hidden"));
    assert.equal(await evaluate("document.querySelector('#figcraft-run-fields').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#figcraft-export-fields').hidden"), true);
    await evaluate(until("document.querySelector('#figcraft-cli-state').textContent.includes('figcraft-cli:')"));
    // 명령 찾기로 한 단계를 넣고 이름을 고친다.
    await evaluate("(() => { const s = document.querySelector('#figcraft-command-search'); s.value = 'frame'; s.dispatchEvent(new Event('input')); })()");
    await evaluate(until("[...document.querySelectorAll('#figcraft-commands button')].some((b) => b.textContent === 'frame.create')"));
    await evaluate("document.querySelector('#figcraft-script').value = ''; [...document.querySelectorAll('#figcraft-commands button')].find((b) => b.textContent === 'frame.create').click()");
    assert.deepEqual(JSON.parse(await evaluate("document.querySelector('#figcraft-script').value")), [{ command: "frame.create", params: {} }]);
    await evaluate(`document.querySelector('#figcraft-script').value = ${JSON.stringify(JSON.stringify([{ command: "frame.create", params: { name: "홈" } }, { command: "frame.create", params: { name: "설정" } }]))}`);
    await evaluate("document.querySelector('#command-title').value = '앱 화면'; document.querySelector('#command-save').click()");
    await evaluate(until("!document.querySelector('#command-dialog').open && [...document.querySelectorAll('.gcmd')].some((c) => c.textContent.includes('앱 화면'))"));
    const id = await evaluate("[...document.querySelectorAll('.gcmd')].find((c) => c.textContent.includes('앱 화면')).dataset.id");
    assert.match(await evaluate(`document.querySelector('.gcmd[data-id="${id}"]').textContent`), /FigCraft.*디자인.*디자인 만들기/);
    // 실행 → 결과 기록의 프레임 미리보기 → 누르면 미리보기 창에서 넘겨 본다
    await evaluate(`document.querySelector('.gcmd[data-id="${id}"] .gcard-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await evaluate(until("document.querySelector('#command-dialog').open"));
    await evaluate("document.querySelector('#command-run').click()");
    await evaluate(until("document.querySelectorAll('#figcraft-history .figcraft-preview img').length === 2 && [...document.querySelectorAll('#figcraft-history .figcraft-preview img')].every((img) => img.naturalWidth === 1)"));
    assert.match(await evaluate("document.querySelector('#figcraft-history .figcraft-run').textContent"), /완료.*프레임 2개.*명령 2개.*design\.figcraft/);
    assert.ok(await evaluate("[...document.querySelectorAll('#figcraft-history button')].some((b) => b.textContent === 'FigCraft에서 열기')"));
    await evaluate(until(`document.querySelector('.gcmd[data-id="${id}"] img.gen3d-card-thumb')?.naturalWidth === 1`));
    if (process.env.AGENTHUB_UI_SCREENSHOT) await fs.writeFile(process.env.AGENTHUB_UI_SCREENSHOT, Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await evaluate("document.querySelector('#figcraft-history .figcraft-preview').click()");
    await evaluate(until("[...document.querySelectorAll('dialog.report-preview')].some((d) => d.open && d.querySelector('.report-full-image')?.naturalWidth === 1)"));
    const viewer = "[...document.querySelectorAll('dialog.report-preview')].find((d) => d.open)";
    assert.equal(await evaluate(`${viewer}.querySelector('.report-position').textContent`), "1 / 2");
    await evaluate(`${viewer}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    await evaluate(until(`${viewer}?.querySelector('.report-position')?.textContent === '2 / 2'`));
    assert.equal(await evaluate(`${viewer}.querySelector('h2').textContent`), "설정.png");
    assert.deepEqual(errors, []);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHub } from "../server/bootstrap.mjs";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

test("browser: 아트 레퍼런스 노드를 만들고 이미지·메모를 넣어 세션에 참고로 잇는다", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chrome).then(() => true, () => false)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-artref-ui-"));
  const project = path.join(temp, "project");
  await fs.mkdir(project, { recursive: true });
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "아트", path: project }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  hub.store.add({ id: "s1", title: "디자이너", agent: "codex", permission: "workspace-write", projectPath: project, projectName: "아트", cwd: project, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], graphPos: { x: 520, y: 60 } });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, "디자이너", async ({ evaluate, errors }) => {
    await evaluate(until("[...document.querySelectorAll('#project-nav button')].some((x) => x.textContent.includes('아트'))"));
    await evaluate("[...document.querySelectorAll('#project-nav button')].find((x) => x.textContent.includes('아트')).click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    await evaluate(until("document.querySelector('.gcard[data-id=s1]')"));
    // 그래프 메뉴 → 시작 → 아트 레퍼런스
    await evaluate("document.querySelector('#p-graph').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 500 }))");
    await evaluate(until("[...document.querySelectorAll('.context-menu .menu-item')].some((b) => b.textContent === '아트 레퍼런스')"));
    await evaluate("[...document.querySelectorAll('.context-menu .menu-item')].find((b) => b.textContent === '아트 레퍼런스').click()");
    await evaluate(until("document.querySelector('#command-dialog').open && !document.querySelector('#artref-settings').hidden"));
    assert.equal(await evaluate("document.querySelector('#command-run').hidden"), true, "레퍼런스는 실행 단추가 없다");
    assert.ok(await evaluate("document.querySelector('#artref-files').disabled"), "저장 전에는 이미지를 넣을 수 없다");
    await evaluate("document.querySelector('#command-title').value = '브랜드 무드'; document.querySelector('#artref-style').value = '따뜻한 파스텔'; document.querySelector('#artref-palette').value = '#F6C453 #2B3A55'; document.querySelector('#command-save').click()");
    await evaluate(until("!document.querySelector('#command-dialog').open && [...document.querySelectorAll('.gcmd')].some((c) => c.textContent.includes('브랜드 무드'))"));
    const id = await evaluate("[...document.querySelectorAll('.gcmd')].find((c) => c.textContent.includes('브랜드 무드')).dataset.id");
    const card = `document.querySelector('.gcmd[data-id="${id}"]')`;
    assert.match(await evaluate(`${card}.textContent`), /아트 레퍼런스.*참고 자료.*따뜻한 파스텔.*이미지 0장 · 세션에 이어 쓰세요.*편집/);
    // 편집 → 이미지 넣기 → 메모 → 저장
    await evaluate(`${card}.querySelector('.gcmd-btn').click()`);
    await evaluate(until("document.querySelector('#command-dialog').open && !document.querySelector('#artref-files').disabled"));
    await evaluate(`(() => { const input = document.querySelector('#artref-files'); const data = Uint8Array.from(atob(${JSON.stringify(PNG)}), (c) => c.charCodeAt(0)); const files = new DataTransfer(); files.items.add(new File([data], 'mood.png', { type: 'image/png' })); input.files = files.files; input.dispatchEvent(new Event('change')); })()`);
    await evaluate(until("document.querySelector('#artref-images .artref-image img')?.naturalWidth === 1"));
    await evaluate("(() => { const row = document.querySelector('#artref-images .artref-image'); row.querySelector('.artref-note').value = '전체 톤'; row.querySelector('.artref-tags').value = '색, 분위기'; document.querySelector('#command-save').click(); })()");
    await evaluate(until("!document.querySelector('#command-dialog').open"));
    const folder = path.join(project, "references", "브랜드-무드");
    const index = readFileSync(path.join(folder, "INDEX.md"), "utf8");
    assert.match(index, /## 스타일\n따뜻한 파스텔/);
    assert.match(index, /- mood\.png — 전체 톤 · \[색, 분위기\] · 1×1/);
    await evaluate(until(`${card}?.querySelector('.artref-card-thumbs img')?.naturalWidth === 1`));
    // 세션에 잇기: 손잡이를 세션 카드에 놓는다.
    await evaluate(`(() => { const handle = ${card}.querySelector('.gcard-handle'); const target = document.querySelector('.gcard[data-id=s1]').getBoundingClientRect(); const from = handle.getBoundingClientRect(); const opts = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }); handle.dispatchEvent(new PointerEvent('pointerdown', opts(from.left + 2, from.top + 2))); window.dispatchEvent(new PointerEvent('pointermove', opts(target.left + 30, target.top + 30))); window.dispatchEvent(new PointerEvent('pointerup', opts(target.left + 30, target.top + 30))); })()`);
    // 연결 설정 창: 레퍼런스에서 나가는 연결은 "참고"만 고를 수 있다.
    await evaluate(until("document.querySelector('#link-dialog').open"));
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#link-when option')].map((o) => o.value)"), ["ref"]);
    await evaluate("document.querySelector('#link-dialog button[value=ok]').click()");
    await evaluate(until("[...document.querySelectorAll('.edge-label')].some((x) => x.textContent === '🎨 참고')"));
    const links = await evaluate("fetch('/api/links').then((r) => r.json())");
    assert.deepEqual(links.map((link) => [link.from, link.to, link.when]), [[id, "s1", "ref"]]);
    await evaluate(until(`${card}.textContent.includes('세션 1개가 참고')`));
    // 세션 머리글에 참고 중인 레퍼런스가 보인다.
    await evaluate("document.querySelector('.gcard[data-id=s1] .gcard-title')?.click(); document.querySelector('.gcard[data-id=s1]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    await evaluate(until("[...document.querySelectorAll('#s-flow .artref-chip')].some((x) => x.textContent === '🎨 브랜드 무드')"));
    assert.deepEqual(errors, []);
  });
});

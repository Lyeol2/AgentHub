import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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

// 그래프 우클릭 메뉴: 묶음은 접힌 하위 메뉴로 보이고, 마우스를 올리거나 →·Enter로 옆에 펼친다.
test("browser: 노드 만들기 메뉴의 묶음은 옆으로 펼치는 하위 메뉴다", { timeout: 90000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chrome).then(() => true, () => false)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-menu-"));
  const project = path.join(temp, "project");
  await fs.mkdir(project, { recursive: true });
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "메뉴", path: project }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  hub.store.add({ id: "s1", title: "디자인", agent: "codex", permission: "workspace-write", projectPath: project, projectName: "메뉴", cwd: project, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], graphPos: { x: 40, y: 40 } });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, "디자인", async ({ command, evaluate, errors }) => {
    await evaluate(until("[...document.querySelectorAll('#project-nav button')].some((x) => x.textContent.includes('메뉴'))"));
    await evaluate("[...document.querySelectorAll('#project-nav button')].find((x) => x.textContent.includes('메뉴')).click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    await evaluate(until("document.querySelector('.gcard[data-id=s1]')"));
    const open = (x, y) => evaluate(`document.querySelector('#p-graph').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }))`);
    const trigger = (label) => `[...document.querySelectorAll('.context-menu .menu-sub-trigger')].find((b) => b.querySelector('.menu-sub-label').textContent === ${JSON.stringify(label)})`;
    const panelOf = (label) => `${trigger(label)}.closest('.menu-sub').querySelector(':scope > .menu-panel')`;
    await open(700, 300);
    await evaluate(until("document.querySelector('.context-menu')"));
    // 처음에는 모두 접혀 있고, 항목이 하나뿐인 "새 세션"만 바로 보인다.
    const top = await evaluate("[...document.querySelectorAll('.context-menu > .menu-item, .context-menu > .menu-sub > .menu-sub-trigger')].map((b) => b.querySelector('.menu-sub-label')?.textContent ?? b.textContent)");
    assert.deepEqual(top, ["새 세션", "시작", "실행", "작업", "흐름 제어", "출력", "3D 생성", "디자인", "그룹 템플릿 추가", "스킬 관리"]);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.context-menu .menu-panel')].map((p) => p.hidden)").then((list) => list.every(Boolean)), true);
    assert.equal(await evaluate(`${trigger("시작")}.querySelector('.menu-sub-count').textContent`), "5");
    assert.equal(await evaluate(`${trigger("3D 생성")}.querySelector('.menu-sub-count').textContent`), "7");
    const menuHeight = await evaluate("document.querySelector('.context-menu').getBoundingClientRect().height");
    assert.ok(menuHeight < 420, `접은 메뉴는 짧다 (${menuHeight}px)`);
    // 마우스를 올리면 오른쪽에 펼치고, 다른 묶음으로 옮기면 바뀐다.
    await evaluate(`${trigger("시작")}.closest('.menu-sub').dispatchEvent(new MouseEvent('mouseenter'))`);
    assert.equal(await evaluate(`${panelOf("시작")}.hidden`), false);
    assert.equal(await evaluate(`${trigger("시작")}.getAttribute('aria-expanded')`), "true");
    assert.ok(await evaluate(`${panelOf("시작")}.getBoundingClientRect().left >= document.querySelector('.context-menu').getBoundingClientRect().right - 1`), "하위 메뉴는 오른쪽에 뜬다");
    assert.deepEqual(await evaluate(`[...${panelOf("시작")}.querySelectorAll('.menu-item')].map((b) => b.textContent)`), ["새 버튼", "새 입력 폼", "새 파일 감시", "새 시간 예약", "새 웹훅 받기"]);
    await evaluate(`${trigger("출력")}.closest('.menu-sub').dispatchEvent(new MouseEvent('mouseenter'))`);
    assert.equal(await evaluate(`${panelOf("시작")}.hidden`), true, "같은 단계의 다른 하위 메뉴는 닫힌다");
    assert.equal(await evaluate(`${panelOf("출력")}.hidden`), false);
    // 3D 생성 안의 "단계 노드"는 한 번 더 펼친다.
    await evaluate(`${trigger("3D 생성")}.click()`);
    await evaluate(`${trigger("단계 노드")}.click()`);
    assert.equal(await evaluate(`${panelOf("단계 노드")}.hidden`), false);
    assert.equal(await evaluate(`${panelOf("단계 노드")}.querySelectorAll('.menu-item').length`), 6);
    if (process.env.AGENTHUB_UI_SCREENSHOT) await fs.writeFile(process.env.AGENTHUB_UI_SCREENSHOT, Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
    // 키보드: ↓로 이동, →로 펼치고 첫 항목, ←로 돌아가기, Enter로 만들기
    await evaluate(`${trigger("3D 생성")}.click()`);
    await evaluate(`${trigger("실행")}.focus()`);
    const key = (name) => evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`);
    await key("ArrowRight");
    assert.equal(await evaluate("document.activeElement.textContent"), "새 명령");
    await key("ArrowDown");
    assert.equal(await evaluate("document.activeElement.textContent"), "새 GIT");
    await key("ArrowLeft");
    assert.equal(await evaluate("document.activeElement.querySelector('.menu-sub-label')?.textContent"), "실행");
    assert.equal(await evaluate(`${panelOf("실행")}.hidden`), true);
    await key("ArrowDown");
    assert.equal(await evaluate("document.activeElement.querySelector('.menu-sub-label')?.textContent"), "작업");
    await key("Escape");
    assert.equal(await evaluate("document.querySelector('.context-menu')"), null);
    // 화면 오른쪽 끝에서 열면 하위 메뉴는 왼쪽에 펼친다. 하위 메뉴 항목을 누르면 노드 설정을 연다.
    await open(1430, 300);
    await evaluate(until("document.querySelector('.context-menu')"));
    await evaluate(`${trigger("출력")}.click()`);
    assert.ok(await evaluate(`${panelOf("출력")}.getBoundingClientRect().right <= document.querySelector('.context-menu').getBoundingClientRect().left + 1`), "오른쪽이 모자라면 왼쪽에 뜬다");
    assert.ok(await evaluate(`${panelOf("출력")}.getBoundingClientRect().left >= 0`));
    await evaluate("[...document.querySelectorAll('.context-menu .menu-item')].find((b) => b.textContent === '새 알림').click()");
    await evaluate(until("document.querySelector('#command-dialog').open && !document.querySelector('#notify-settings').hidden"));
    assert.equal(await evaluate("document.querySelector('.context-menu')"), null);
    await evaluate("document.querySelector('#command-dialog').close()");
    // 연결 손잡이에서 연 메뉴에는 시작점 묶음이 없다.
    await evaluate("(() => { const handle = document.querySelector('.gcard[data-id=s1] .gcard-handle'); const r = handle.getBoundingClientRect(); const opts = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }); handle.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + 2, r.top + 2))); window.dispatchEvent(new PointerEvent('pointermove', opts(900, 600))); window.dispatchEvent(new PointerEvent('pointerup', opts(900, 600))); })()");
    await evaluate(until("document.querySelector('.context-menu .menu-title')?.textContent === '새 노드에 연결'"));
    assert.equal(await evaluate(`${trigger("시작")} ?? null`), null);
    assert.deepEqual(errors, []);
  });
});

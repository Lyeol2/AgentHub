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
      // 전체 테스트가 브라우저 테스트를 동시에 돌리면 혼자 6초 걸리는 확인도 20초 넘게 걸린다.
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
    await evaluate(`new Promise((resolve,reject)=>{ const end=Date.now()+10000; const check=()=>{ const link=[...document.querySelectorAll('#session-list button')].find(x=>x.textContent.includes(${JSON.stringify(title)})); if(link){link.click();resolve(true);}else if(Date.now()>end)reject(Error('session not loaded'));else setTimeout(check,25); };check(); })`);
    await run({ command, evaluate, errors });
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

// 전체 테스트에서는 화면 갱신도 느려지므로 브라우저 명령처럼 넉넉히 기다린다.
const until = (condition) => `new Promise((resolve,reject)=>{const end=Date.now()+20000;const check=()=>{if(${condition})resolve(true);else if(Date.now()>end)reject(Error('Timed out: '+${JSON.stringify(condition)}));else setTimeout(check,25);};check();})`;

test("browser: 세션 메뉴로 요청 시 부르기 연결을 만들고, 연결선·머리글·호출 기록을 보여 준다", { timeout: 90000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chrome).then(() => true, () => false)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-call-"));
  const project = path.join(temp, "project");
  await fs.mkdir(project, { recursive: true });
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "부르기", path: project }] }, deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  const session = (id, title, events = []) => ({ id, title, agent: "codex", permission: "workspace-write", projectPath: project, projectName: "부르기", cwd: project, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events });
  hub.store.add(session("caller", "구현 담당", [
    { seq: 0, kind: "user", text: "릴리즈 세션에 넘겨 줘" },
    { seq: 1, kind: "message", to: "release", toTitle: "릴리즈 담당", text: "develop을 main에 합치고 릴리즈", via: "queue", call: true },
    { seq: 2, kind: "result", text: "완료" },
  ]));
  hub.store.add(session("release", "릴리즈 담당", [
    { seq: 0, kind: "user", text: "[세션 호출] 부른 세션: 구현 담당", from: "caller", fromTitle: "구현 담당", call: true },
  ]));
  await hub.start();
  t.after(async () => {
    await hub.shutdown();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, "구현 담당", async ({ evaluate, errors }) => {
    // 메시지 기록은 접힌 작업 과정 안에 있다.
    await evaluate(until("document.querySelector('#s-events li.ev.work summary')"));
    await evaluate("document.querySelector('#s-events li.ev.work summary').click()");
    await evaluate(until("[...document.querySelectorAll('#s-events li.ev.message summary')].some((x) => x.textContent.includes('릴리즈 담당 세션을 불렀습니다'))"));
    assert.ok(await evaluate("document.querySelector('#s-events li.ev.message summary').textContent.startsWith('📞')"), "the caller sees a call record");
    // 세션 메뉴 → 부를 세션 추가 → 릴리즈 담당
    await evaluate(`(() => { const row = [...document.querySelectorAll('#session-list button')].find((x) => x.textContent.includes('구현 담당')); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); })()`);
    await evaluate(until("[...document.querySelectorAll('.context-menu .menu-item')].some((x) => x.textContent === '부를 세션 추가…')"));
    await evaluate("[...document.querySelectorAll('.context-menu .menu-item')].find((x) => x.textContent === '부를 세션 추가…').click()");
    await evaluate(until("[...document.querySelectorAll('.context-menu .menu-item')].some((x) => x.textContent === '릴리즈 담당')"));
    await evaluate("[...document.querySelectorAll('.context-menu .menu-item')].find((x) => x.textContent === '릴리즈 담당').click()");
    await evaluate(until("[...document.querySelectorAll('#s-flow .flow-chip')].some((x) => x.textContent === '→ 릴리즈 담당 · 요청 시 부르기')"));
    const links = await evaluate("fetch('/api/links').then((r) => r.json())");
    assert.deepEqual(links.map((l) => [l.from, l.to, l.when, l.enabled]), [["caller", "release", "call", true]]);
    // 이미 만든 연결은 메뉴에서 고를 수 없다.
    await evaluate(`(() => { const row = [...document.querySelectorAll('#session-list button')].find((x) => x.textContent.includes('구현 담당')); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); })()`);
    await evaluate("[...document.querySelectorAll('.context-menu .menu-item')].find((x) => x.textContent === '부를 세션 추가…').click()");
    await evaluate(until("[...document.querySelectorAll('.context-menu .menu-item')].some((x) => x.textContent === '릴리즈 담당 · 연결됨' && x.disabled)"));
    await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    // 불린 세션의 기록과 프로젝트 그래프의 연결선
    await evaluate("[...document.querySelectorAll('#session-list button')].find((x) => x.textContent.includes('릴리즈 담당')).click()");
    await evaluate(until("[...document.querySelectorAll('#s-events li.ev.user summary')].some((x) => x.textContent.includes('📞 구현 담당에서 온 호출'))"));
    await evaluate(until("[...document.querySelectorAll('#project-nav button')].some((x) => x.textContent.includes('부르기'))"));
    await evaluate("[...document.querySelectorAll('#project-nav button')].find((x) => x.textContent.includes('부르기')).click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    await evaluate(until("document.querySelector('.graph-edges path.edge.call') && [...document.querySelectorAll('.edge-label')].some((x) => x.textContent === '📞 요청 시 부르기')"));
    assert.equal(await evaluate("document.querySelector('.graph-edges path.edge.call').classList.contains('live')"), false);
    assert.deepEqual(errors, []);
  });
});

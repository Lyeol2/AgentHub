import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHub } from "../server/bootstrap.mjs";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const KEY = "sk-browser-fake";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

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

// 가짜 Meshy: 만든 작업은 두 번째 상태 확인 때 끝난다. 썸네일은 실제 PNG다.
async function fakeMeshy(t) {
  const requests = [], tasks = new Map();
  let next = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null });
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const base = `http://127.0.0.1:${server.address().port}`;
    if (url.pathname.endsWith("/thumb.png")) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
    if (url.pathname.startsWith("/files/")) { res.writeHead(200); return res.end("glb"); }
    if (req.headers.authorization !== `Bearer ${KEY}`) return json({ message: "Invalid API key" }, 401);
    if (url.pathname === "/openapi/v1/balance") return json({ balance: 777 });
    if (req.method === "POST") { const id = `task-${++next}`; tasks.set(id, 0); return json({ result: id }); }
    const id = url.pathname.split("/").pop();
    tasks.set(id, (tasks.get(id) ?? 0) + 1);
    if (tasks.get(id) < 2) return json({ status: "IN_PROGRESS", progress: 30 });
    return json({ status: "SUCCEEDED", progress: 100, model_urls: { glb: `${base}/files/${id}/model.glb` }, thumbnail_url: `${base}/files/${id}/thumb.png` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, base: `http://127.0.0.1:${server.address().port}` };
}

test("browser: 3D 생성 도구 키 설정, 노드 실행과 결과 기록·썸네일, 지난 결과 넘기기, 단계 노드로 펼치기", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chrome).then(() => true, () => false)) return t.skip("Windows Chromium required");
  const meshy = await fakeMeshy(t);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-gen3d-ui-"));
  const project = path.join(temp, "project");
  await fs.mkdir(project, { recursive: true });
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "삼디", path: project }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} }, gen3dSleep: () => new Promise((resolve) => setTimeout(resolve, 5)) } });
  hub.store.add({ id: "s1", title: "디자인", agent: "codex", permission: "workspace-write", projectPath: project, projectName: "삼디", cwd: project, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  const api = (method, route, body) => fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  const shape = await api("POST", "commands", { kind: "gen3d", projectPath: project, provider: "meshy", steps: ["generate"], prompt: "귀여운 두리안", pos: { x: 40, y: 40 } });
  const refine = await api("POST", "commands", { kind: "gen3d", projectPath: project, provider: "meshy", steps: ["refine"], pos: { x: 360, y: 40 } });
  await api("POST", "links", { from: shape.id, to: refine.id, when: "success", enabled: true });
  const whole = await api("POST", "commands", { kind: "gen3d", projectPath: project, provider: "meshy", preset: "prop", prompt: "나무 상자", pos: { x: 40, y: 320 } });
  const card = (id) => `document.querySelector('.gcmd[data-id="${id}"]')`;

  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, "디자인", async ({ command, evaluate, errors }) => {
    // 설정 → 3D 생성 도구: 키와 가짜 서버 주소를 저장하고 연결을 확인한다.
    const row = "document.querySelector('#gen3d-providers [data-provider=meshy]')";
    await evaluate("document.querySelector('#open-settings').click()");
    await evaluate(until(`${row}?.querySelector('input[type=password]')`));
    assert.equal(await evaluate(`${row}.querySelector('span').textContent`), "키 없음");
    await evaluate(`(() => { const r = ${row}; r.querySelector('input[type=password]').value = ${JSON.stringify(KEY)}; r.querySelector('input.mono').value = ${JSON.stringify(meshy.base)}; [...r.querySelectorAll('button')].find((b) => b.textContent === '저장').click(); })()`);
    await evaluate(until(`${row}?.querySelector('span').textContent === '키 있음'`));
    assert.equal(await evaluate(`${row}.querySelector('input[type=password]').value`), "", "저장한 키는 다시 보이지 않는다");
    await evaluate(`[...${row}.querySelectorAll('button')].find((b) => b.textContent === '연결 확인').click()`);
    await evaluate(until(`${row}.querySelector('span').textContent === '남은 크레딧 777'`));
    await evaluate("document.querySelector('#settings-dialog').close()");

    // 프로젝트 흐름 그래프의 카드
    await evaluate(until("[...document.querySelectorAll('#project-nav button')].some((x) => x.textContent.includes('삼디'))"));
    await evaluate("[...document.querySelectorAll('#project-nav button')].find((x) => x.textContent.includes('삼디')).click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    await evaluate(until(card(shape.id)));
    assert.match(await evaluate(`${card(whole.id)}.textContent`), /3D 생성.*Meshy · 통합.*모양 만들기 → 다듬기 → 형태 정리/);

    // 노드 설정 창: 단계·키 상태 → 지금 실행 → 결과 기록과 썸네일
    await evaluate(`${card(shape.id)}.querySelector('.gcard-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await evaluate(until("document.querySelector('#command-dialog').open && !document.querySelector('#gen3d-settings').hidden"));
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#gen3d-steps input:checked')].map((x) => x.value)"), ["generate"]);
    assert.equal(await evaluate("document.querySelector('[data-step=convert]').hidden"), true, "Meshy에는 형식 변환이 없다");
    await evaluate(until("document.querySelector('#gen3d-key-state').textContent.includes('API 키가 설정되어')"));
    assert.equal(await evaluate("document.querySelector('#gen3d-history').textContent"), "아직 실행 기록이 없습니다.");
    await evaluate("document.querySelector('#command-run').click()");
    await evaluate(until("document.querySelectorAll('#gen3d-history .gen3d-run').length === 1 && document.querySelector('#gen3d-history img.gen3d-thumb')?.naturalWidth === 1"));
    assert.match(await evaluate("document.querySelector('#gen3d-history .gen3d-run').textContent"), /완료.*모양 만들기 완료.*model\.glb/);
    if (process.env.AGENTHUB_UI_SCREENSHOT) await fs.writeFile(process.env.AGENTHUB_UI_SCREENSHOT, Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await evaluate(until(`${card(refine.id)}?.textContent.includes('완료')`));
    await evaluate(until(`${card(shape.id)}?.querySelector('img.gen3d-card-thumb')?.naturalWidth === 1`));

    // 다시 만들지 않고 지난 결과를 다음 노드로 넘긴다.
    const creates = meshy.requests.filter((r) => r.method === "POST").length;
    await evaluate("[...document.querySelectorAll('#gen3d-history button')].find((b) => b.textContent === '다음 노드로 넘기기').click()");
    const historyOf = (id) => `fetch('/api/commands?path=' + encodeURIComponent(${JSON.stringify(project)})).then((r) => r.json()).then((v) => v.commands.find((c) => c.id === ${JSON.stringify(id)}).history.length)`;
    await evaluate(until(`${historyOf(refine.id)}.then((n) => n === 2)`));
    assert.equal(meshy.requests.filter((r) => r.method === "POST" && r.body?.mode === "preview").length, 1);
    assert.equal(meshy.requests.filter((r) => r.method === "POST").length, creates + 1, "다듬기만 한 번 더 요청한다");
    await evaluate("document.querySelector('#command-dialog').close()");

    // 통합 노드를 단계 노드로 펼친다.
    await evaluate(`${card(whole.id)}.querySelector('.gcard-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await evaluate(until("document.querySelector('#command-dialog').open && [...document.querySelectorAll('#gen3d-actions button')].some((b) => b.textContent === '단계 노드로 펼치기')"));
    await evaluate("window.confirm = () => true; [...document.querySelectorAll('#gen3d-actions button')].find((b) => b.textContent === '단계 노드로 펼치기').click()");
    await evaluate(until(`!${card(whole.id)} && [...document.querySelectorAll('.gcmd')].filter((c) => /Meshy · (모양 만들기|다듬기|형태 정리)/.test(c.textContent)).length >= 5`));
    assert.deepEqual(errors, []);
  });
});

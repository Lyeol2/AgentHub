// 이미지 미리보기 노드 브라우저 시험. GUIDE_SHOTS=<폴더>를 주면 화면마다 스크린샷을 남긴다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { createHub } from "../server/bootstrap.mjs";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOTS = process.env.GUIDE_SHOTS;

async function withBrowser(temp, url, run) {
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
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error("Browser timeout: " + method + "\n" + errors.join("\n"))); }, 30000);
      pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    };
    await command("Runtime.enable"); await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await command("Page.navigate", { url });
    await run({ evaluate, errors, shot });
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

const until = (condition) => `new Promise((resolve,reject)=>{const end=Date.now()+20000;const check=async()=>{if(await (${condition}))resolve(true);else if(Date.now()>end)reject(Error('Timed out: '+${JSON.stringify(condition)}));else setTimeout(check,25);};check();})`;
const clickText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`;
// 4×4 단색 PNG(색만 다른 두 장)
function PNG(color) {
  const rgb = { red: [220, 40, 40], blue: [40, 80, 220] }[color];
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...rgb, ...rgb, ...rgb, ...rgb])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("browser: 이미지 미리보기 노드 — handoff로 받은 경로의 썸네일·열 수 없는 경로·미리보기 창·받은 기록", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" || !existsSync(chrome)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-image-ui-"));
  const project = path.join(temp, "AgentHub");
  await fs.mkdir(path.join(project, "renders"), { recursive: true });
  writeFileSync(path.join(project, "renders", "red.png"), PNG("red"));
  writeFileSync(path.join(project, "renders", "blue.png"), PNG("blue"));
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "AgentHub", path: project }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  const now = new Date().toISOString();
  hub.store.add({ id: "s1", title: "시안 그리기", agent: "claude", permission: "acceptEdits", projectPath: project, projectName: "AgentHub", cwd: project, state: "idle", worktree: null, skills: [],
    createdAt: now, updatedAt: now, events: [{ seq: 0, kind: "user", text: "시안 그려 줘" }], graphPos: { x: 40, y: 40 } });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  const post = (route, body) => fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method: "POST", headers: { "x-agenthub": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
  const node = await post("commands", { projectPath: project, kind: "image", title: "시안 보기", pos: { x: 400, y: 40 } });
  await post("links", { from: "s1", to: node.id, when: "keyword", keyword: "시안 완료" });

  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, async ({ evaluate, errors, shot }) => {
    await evaluate(until("[...document.querySelectorAll('#session-list button')].some((b) => b.textContent.includes('시안 그리기'))"));
    await evaluate("[...document.querySelectorAll('#session-list button')].find((b) => b.textContent.includes('시안 그리기')).click()");
    await evaluate(until("!document.querySelector('#view-session').hidden"));
    await evaluate("document.querySelector('#s-crumb-project').click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    await evaluate(until(`document.querySelector('.gcmd-image[data-id="${node.id}"]')`));
    assert.match(await evaluate(`document.querySelector('.gcmd-image[data-id="${node.id}"]').textContent`), /이미지 미리보기[\s\S]*시안 보기[\s\S]*handoff 전달 내용에 이미지 경로/);
    assert.equal(await evaluate(`document.querySelector('.gcmd-image[data-id="${node.id}"] .gcard-handle')`), null, "끝 노드라 나가는 손잡이가 없다");
    assert.match(await evaluate(`document.querySelector('#p-graph .edge-label')?.textContent ?? ''`), /판정 "시안 완료"/);
    // handoff로 경로를 넘기고 턴이 끝나면 카드에 썸네일이 뜬다.
    const session = hub.store.get("s1");
    session.events.push({ kind: "text", text: "두 장 그렸다." }, { kind: "handoff", verdict: "시안 완료", content: "renders/red.png\nrenders/blue.png\nrenders/없음.png" });
    await hub.chain.onTurnEnd(session, true);
    await evaluate(until(`document.querySelectorAll('.gcmd-image[data-id="${node.id}"] .image-card-thumb img').length === 2`));
    await evaluate(until(`[...document.querySelectorAll('.gcmd-image[data-id="${node.id}"] .image-card-thumb img')].every((img) => img.complete && img.naturalWidth === 4)`));
    const card = `document.querySelector('.gcmd-image[data-id="${node.id}"]')`;
    assert.match(await evaluate(`${card}.querySelector('.image-card-bad').textContent`), /⚠ 없음\.png/);
    assert.match(await evaluate(`${card}.querySelector('.image-card-bad').title`), /없음\.png: 파일이 없습니다/);
    const overflow = await evaluate(`${card}.getBoundingClientRect().bottom - ${card}.querySelector('.gcmd-foot').getBoundingClientRect().bottom`);
    assert.ok(overflow >= 0, `카드 아래가 넘치지 않는다: ${overflow}`);
    assert.match(await evaluate(`document.querySelector('.gcmd-image[data-id="${node.id}"] .gcmd-result-text').textContent`), /이미지 2개 · ⚠ 1개/);
    await shot("i01-card");
    // 썸네일을 누르면 미리보기 창이 열리고 두 장을 넘겨 본다.
    await evaluate(`document.querySelectorAll('.gcmd-image[data-id="${node.id}"] .image-card-thumb')[1].click()`);
    await evaluate(until("document.querySelector('#report-preview-title')?.textContent === 'blue.png' && document.querySelector('.report-body img')?.naturalWidth === 4"));
    assert.match(await evaluate("document.querySelector('.report-position')?.textContent ?? ''"), /2 \/ 2/);
    await shot("i02-viewer");
    await evaluate("document.querySelector('#report-preview-title').closest('dialog').close()");
    // 결과 보기: 받은 기록
    await evaluate(`document.querySelector('.gcmd-image[data-id="${node.id}"] .gcmd-btn').click()`);
    await evaluate(until("document.querySelector('#command-result-dialog').open && document.querySelectorAll('#command-result-preview .image-run').length === 1"));
    assert.match(await evaluate("document.querySelector('#command-result-preview').textContent"), /이미지 2개[\s\S]*시안 그리기에서[\s\S]*없음\.png · 파일이 없습니다/);
    await shot("i03-history");
    assert.deepEqual(errors, []);
  });
});

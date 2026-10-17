import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHub } from "../server/bootstrap.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";

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
    await evaluate(`new Promise((resolve,reject)=>{ const end=Date.now()+10000; const check=()=>{ const link=[...document.querySelectorAll('#session-list button')].find(x=>x.textContent.includes('보고서 미리보기 QA')); if(link){link.click();resolve(true);}else if(Date.now()>end)reject(Error('session not loaded'));else setTimeout(check,25); };check(); })`);
    await run({ command, evaluate, errors });
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

const until = (condition) => `new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>{if(${condition})resolve(true);else if(Date.now()>end)reject(Error('Timed out: '+${JSON.stringify(condition)}));else setTimeout(check,25);};check();})`;

test("browser: report cards, image gallery, Markdown math, isolated HTML, localhost, mentions and missing files", { timeout: 90000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(chrome).then(() => true, () => false)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-report-"));
  const project = path.join(temp, "project");
  await fs.mkdir(path.join(project, "docs"), { recursive: true });
  const literalMath = String.raw`$literal = \frac{1}{2}$
$$\int_0^1 x\,dx$$`;
  const invalidMath = String.raw`$\notARealMathCommand{x}$`;
  const reportMarkdown = [String.raw`# 검증 결과

**통과**: 링크와 미리보기를 확인했습니다.

[연결 문서](nested.txt:1)

문장 안 수식 $E=mc^2$도 읽을 수 있습니다.

$$
\frac{a+b}{c+d}
$$

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

$$
\begin{bmatrix}
1 & 2 \\
3 & 4
\end{bmatrix}
$$

$$
${Array.from({ length: 30 }, (_, index) => `a_{${index + 1}}`).join(" + ")} = S
$$

| 항목 | 수식 |
|---|---|
| 절댓값 | $|x|$ |`, "```latex", literalMath, "```", `잘못된 수식도 원문으로 남습니다: ${invalidMath}`].join("\n\n");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await Promise.all([
    fs.writeFile(path.join(project, "docs", "화면 (완료).png"), png),
    fs.writeFile(path.join(project, "docs", "두번째.png"), png),
    fs.writeFile(path.join(project, "docs", "result.md"), reportMarkdown),
    fs.writeFile(path.join(project, "docs", "nested.txt"), "연결 문서의 본문"),
    fs.writeFile(path.join(project, "docs", "preview.css"), "#local-result{color:rgb(20, 90, 180)}"),
    fs.writeFile(path.join(project, "docs", "preview.js"), "document.getElementById('local-result').textContent='HTML 스크립트 동작'; document.body.dataset.ran='yes';"),
    fs.writeFile(path.join(project, "docs", "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="preview.css"></head><body><h1 id="local-result">로컬 HTML</h1><script src="preview.js"></script></body></html>'),
  ]);
  const app = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end('<h1 id="live-app">실행 중인 앱</h1><script>document.body.dataset.live="yes"</script>'); });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const liveUrl = `http://127.0.0.1:${app.address().port}/`;
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [project] }, deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  const session = (id, title) => ({ id, title, agent: "codex", permission: "workspace-write", projectPath: project, projectName: "미리보기", cwd: project, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] });
  const first = session("report-qa", "보고서 미리보기 QA"), second = session("report-other", "참조 세션");
  first.events = [
    { seq: 0, kind: "user", text: "@docs/result.md 결과를 확인해 주세요. docs/result.md.map은 별도 파일입니다.", references: [{ label: "result.md", path: "docs/result.md" }] },
    { seq: 1, kind: "text", text: `검증 통과 · [최종 보고서](docs/result.md)\n\n![화면 미리보기](<docs/화면 (완료).png>) · [다음 화면](docs/두번째.png)\n\n[HTML 화면](docs/index.html) · [실행 화면](${liveUrl})\n\n[검증 기록](docs/missing.md)\n\n[참조 세션](agenthub://session/report-other) · [없는 작업](agenthub://task/missing-task)` },
    { seq: 2, kind: "result", text: "완료" },
  ];
  hub.store.add(first); hub.store.add(second);
  await hub.start();
  t.after(async () => {
    await hub.shutdown(); await new Promise((resolve) => app.close(resolve));
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  const output = path.join(root, "data", "report-preview-qa");
  await fs.mkdir(output, { recursive: true });
  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, async ({ command, evaluate, errors }) => {
    await evaluate(until("document.querySelectorAll('#s-events .report-card').length===6"));
    assert.equal(await evaluate("document.querySelector('#s-events .mention-chip').textContent"), "@result.md");
    assert.equal(await evaluate("document.querySelectorAll('#s-events .mention-chip').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('.report-verification.passed').length"), 1);
    await evaluate(until("[...document.querySelectorAll('.report-card-state')].some(x=>x.textContent==='파일을 찾을 수 없음')"));
    await evaluate(until("document.querySelector('.report-thumbnail img').naturalWidth===1"));
    await fs.writeFile(path.join(output, "cards.png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await evaluate("document.querySelector('.report-thumbnail').click()");
    await evaluate(until("document.querySelector('.report-full-image')?.naturalWidth===1"));
    assert.equal(await evaluate("document.querySelector('.report-scale').textContent"), "맞춤");
    await evaluate("document.querySelector('[aria-label=\"이미지 확대\"]').click()");
    assert.equal(await evaluate("document.querySelector('.report-scale').textContent"), "125%");
    await evaluate("[...document.querySelectorAll('.report-toolbar button')].find(x=>x.textContent==='다음').click()");
    await evaluate(until("document.querySelector('.report-preview h2').textContent==='다음 화면'"));
    await evaluate("document.querySelector('.report-preview').close(); document.querySelector('.mention-chip').click()");
    await evaluate(until("document.querySelector('.report-document h1')?.textContent==='검증 결과'"));
    assert.equal(await evaluate("document.querySelector('.report-document strong').textContent"), "통과");
    assert.equal(await evaluate("document.querySelectorAll('.report-document .katex').length"), 6);
    assert.equal(await evaluate("document.querySelectorAll('.report-document .md-math-display .katex').length"), 4);
    assert.equal(await evaluate("document.querySelectorAll('.report-document tbody tr:first-child td').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('.report-document tbody td:last-child .katex').length"), 1);
    assert.equal((await evaluate("document.querySelector('.report-document pre code').textContent")).trim(), literalMath);
    assert.equal(await evaluate("document.querySelectorAll('.report-document pre .katex').length"), 0);
    assert.ok((await evaluate("document.querySelector('.report-document .md-math-error').textContent")).includes(invalidMath.slice(1, -1)));
    assert.ok(await evaluate("Promise.all([document.fonts.load('16px KaTeX_Main'),document.fonts.load('italic 16px KaTeX_Math')]).then(groups=>groups.every(fonts=>fonts.length>0 && fonts.every(font=>font.status==='loaded')))"), "KaTeX fonts load from the local bundle");
    await fs.writeFile(path.join(output, "desktop.png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await evaluate("[...document.querySelectorAll('.report-toolbar button')].find(x=>x.textContent==='원문').click()");
    assert.ok(await evaluate("!document.querySelector('.report-source').hidden && document.querySelector('.report-source').textContent.startsWith('# 검증 결과')"));
    assert.equal(await evaluate("document.querySelector('.report-source').textContent"), reportMarkdown);
    await evaluate("[...document.querySelectorAll('.report-toolbar button')].find(x=>x.textContent==='미리보기').click(); document.querySelector('.report-document a').click()");
    await evaluate(until("document.querySelector('.report-source')?.textContent==='연결 문서의 본문'"));
    assert.equal(await evaluate("document.querySelector('.report-target-line').getAttribute('aria-label')"), "1행");
    await evaluate("document.querySelector('.report-preview').close(); [...document.querySelectorAll('.report-card-open')].find(x=>x.textContent==='HTML 화면').click()");
    await evaluate(until("document.querySelector('.report-frame')?.src.includes('/artifact/preview')"));
    const frameState = async (match, expression) => {
      const attached = new Map();
      for (let attempt = 0; attempt < 50; attempt++) {
        const tree = await command("Page.getFrameTree");
        const frame = tree.frameTree.childFrames?.find((child) => child.frame.url.includes(match));
        if (frame) {
          const world = await command("Page.createIsolatedWorld", { frameId: frame.frame.id, worldName: "report-qa" });
          const value = await evaluate(expression, world.executionContextId);
          if (value) return value;
        }
        // Opaque sandbox origins are separate Chromium targets under site isolation.
        const targets = await command("Target.getTargets");
        const target = targets.targetInfos.find((item) => item.type === "iframe" && item.url.includes(match));
        if (target) {
          if (!attached.has(target.targetId)) {
            const result = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
            attached.set(target.targetId, result.sessionId);
          }
          const value = await evaluate(expression, undefined, attached.get(target.targetId));
          if (value) return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw Error("Frame did not render: " + match + "\n" + JSON.stringify(await command("Page.getFrameTree")) + "\n" + await evaluate("document.querySelector('.report-preview').innerText"));
    };
    const html = await frameState("/artifact/preview", "document.body.dataset.ran==='yes' && ({text:document.querySelector('#local-result').textContent,color:getComputedStyle(document.querySelector('#local-result')).color,isolated:(()=>{try{return !parent.document}catch{return true}})()})");
    assert.equal(html.text, "HTML 스크립트 동작"); assert.equal(html.color, "rgb(20, 90, 180)"); assert.equal(html.isolated, true);
    await evaluate("document.querySelector('.report-preview').close(); [...document.querySelectorAll('.report-card-open')].find(x=>x.textContent==='실행 화면').click()");
    assert.equal(await frameState(liveUrl, "document.body.dataset.live==='yes' && document.querySelector('#live-app').textContent"), "실행 중인 앱");
    await evaluate("document.querySelector('.report-preview').close(); [...document.querySelectorAll('.report-card-open')].find(x=>x.textContent==='검증 기록').click()");
    await evaluate(until("document.querySelector('.report-message').textContent.includes('파일을 찾을 수 없습니다')"));
    assert.ok(await evaluate("document.querySelector('.report-location').textContent.includes('missing.md')"));
    await evaluate("document.querySelector('.report-preview').close(); document.querySelector('[data-report-task]').click()");
    await evaluate(until("document.querySelector('.report-message').textContent.includes('작업을 찾을 수 없습니다')"));
    await evaluate("document.querySelector('.report-preview').close(); document.querySelector('.mention-chip').click()");
    await evaluate(until("document.querySelector('.report-document h1')"));
    await evaluate("document.documentElement.dataset.theme='light'");
    await fs.writeFile(path.join(output, "light.png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.ok(await evaluate("new Promise(resolve=>requestAnimationFrame(()=>{const d=document.querySelector('.report-preview');resolve(d.getBoundingClientRect().right<=innerWidth && d.scrollWidth<=d.clientWidth)}))"));
    assert.ok(await evaluate("(()=>{const body=document.querySelector('.report-body');const blocks=[...document.querySelectorAll('.report-document .md-math-display')];return body.scrollWidth<=body.clientWidth+1 && blocks.every(block=>block.getBoundingClientRect().width<=body.clientWidth) && blocks.some(block=>block.scrollWidth>block.clientWidth && ['auto','scroll'].includes(getComputedStyle(block).overflowX))})()"), "Long formulas scroll inside their own block without widening the mobile document");
    await fs.writeFile(path.join(output, "mobile.png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await evaluate("document.querySelector('.report-preview').close(); document.querySelector('[data-report-session]').click()");
    await evaluate(until("document.querySelector('#s-title').textContent==='참조 세션'"));
    assert.deepEqual(errors, []);
  });
});

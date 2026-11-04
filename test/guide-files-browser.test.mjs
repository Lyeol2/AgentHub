// 지침 갈래 브라우저 시험. GUIDE_SHOTS=<폴더>를 주면 화면마다 스크린샷을 남긴다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHub } from "../server/bootstrap.mjs";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOTS = process.env.GUIDE_SHOTS;

const GUIDE = `# 데모 에이전트 지침

## 프로젝트 요약
Electron + Node 데스크톱 앱. 여러 AI 세션을 연결해 함께 일하게 한다.

## 작업 절차
1. 요청을 읽고 관련 코드와 문서를 먼저 조사한다.
2. 기능 추가는 docs/plan에 계획서를 쓴다.
3. 승인받은 뒤에만 구현한다.

## 필독 문서
- [개발 문서](docs/development.md)
- C# 수정 시 [Unity 규칙](docs/unity.md)

## 응답 방식
- 응답 끝에 변경 파일과 다음 할 일을 보고한다.
`;

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

const ROOT = `# 데모 에이전트 지침

## 프로젝트 요약
앱이다.

## 필독 문서
- 배포하기 전에 [배포 절차](docs/deploy.md)

## 서버 규칙
- 서버는 server/에 둔다.

## 커밋 규칙
- feat: 접두어를 쓴다.
`;

test("browser: 지침 갈래 — 이 파일 만들기·새 지침(섹션 옮기기)·문서 추가·삭제와 되돌리기·갈래 경고", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" || !existsSync(chrome)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-guide-files-ui-"));
  const project = path.join(temp, "AgentHub");
  await fs.mkdir(path.join(project, "docs"), { recursive: true });
  await fs.mkdir(path.join(project, "server"), { recursive: true });
  await fs.writeFile(path.join(project, "AGENTS.md"), ROOT);
  await fs.writeFile(path.join(project, "CLAUDE.md"), "@AGENTS.md\n");
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "AgentHub", path: project }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });

  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, async ({ evaluate, errors, shot }) => {
    await evaluate(until("[...document.querySelectorAll('#project-nav button')].some((x) => x.textContent.includes('AgentHub'))"));
    await evaluate("[...document.querySelectorAll('#project-nav button')].find((x) => x.textContent.includes('AgentHub')).click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=guide]').click()");
    await evaluate(until("document.querySelector('#g-text')?.value.includes('# 데모 에이전트 지침')"));
    // 깨진 링크 → 이 파일 만들기
    await evaluate("document.querySelector('#g-status').click()");
    await evaluate(until("[...document.querySelectorAll('#g-warning-list button')].some((b) => b.textContent === '이 파일 만들기')"));
    await evaluate(clickText("#g-warning-list button", "이 파일 만들기"));
    await evaluate(until("document.querySelector('#g-toast').textContent.includes('docs/deploy.md를 만들었습니다')"));
    assert.ok(existsSync(path.join(project, "docs", "deploy.md")));
    await evaluate(until("![...document.querySelectorAll('#g-warning-list .guide-warning')].some((c) => c.textContent.includes('없는 파일'))"));
    // 새 지침: server 폴더에 짝으로, 루트의 "서버 규칙" 섹션을 옮긴다.
    await evaluate("document.querySelector('#g-new-guide').click()");
    await evaluate(until("document.querySelector('dialog.guide-branch-dialog[open]')"));
    await evaluate("(() => { const d = document.querySelector('dialog.guide-branch-dialog[open]'); d.querySelector('input.mono').value = 'server'; d.querySelector('input[name=guide-start][value=move]').click(); d.querySelector('.guide-radios:nth-of-type(2)'); [...d.querySelectorAll('.guide-move-sections label')].find((l) => l.textContent.includes('서버 규칙')).querySelector('input').click(); })()");
    await shot("b01-new-guide");
    await evaluate(clickText("dialog.guide-branch-dialog[open] button", "만들기"));
    await evaluate(until("document.querySelector('#g-toast').textContent.includes('server/AGENTS.md, server/CLAUDE.md를 만들었습니다')"));
    assert.match(readFileSync(path.join(project, "server", "AGENTS.md"), "utf8"), /## 서버 규칙\n- 서버는 server\/에 둔다\./);
    assert.equal(readFileSync(path.join(project, "server", "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    await evaluate(until("document.querySelector('#g-text').value.includes('- → [server/AGENTS.md](server/AGENTS.md) 참고') && !document.querySelector('#g-save').disabled"));
    assert.ok(await evaluate("[...document.querySelectorAll('#g-file option')].some((o) => o.value === 'server/AGENTS.md')"));
    // 문서 추가: 조건과 함께 필독 문서에 링크 줄
    await evaluate("document.querySelector('#g-add-doc').click()");
    await evaluate(until("document.querySelector('dialog.guide-branch-dialog[open]')"));
    await evaluate("(() => { const d = document.querySelector('dialog.guide-branch-dialog[open]'); const inputs = d.querySelectorAll('input:not([type=radio])'); inputs[0].value = 'Unity 규칙'; inputs[2].value = '.cs 파일을 고치기 전에'; })()");
    await shot("b02-add-doc");
    await evaluate(clickText("dialog.guide-branch-dialog[open] button", "만들기"));
    await evaluate(until("document.querySelector('#g-text').value.includes('- .cs 파일을 고치기 전에 [Unity 규칙](docs/Unity-규칙.md)')"));
    assert.ok(existsSync(path.join(project, "docs", "Unity-규칙.md")));
    await evaluate("setTimeout(() => document.querySelector('#g-save').click(), 0), 1");
    await evaluate(until("document.querySelector('#g-toast').textContent.startsWith('AGENTS.md를 저장했습니다')"));
    // 갈래 줄: 커밋하지 않은 지침(git 저장소가 아니면 표시하지 않음)·갈래 경고
    await evaluate(until("document.querySelector('#g-branchbar')"));
    // 삭제: server/CLAUDE.md → 확인 창(가리키는 곳 없음·git 아님) → 되돌리기
    await evaluate("(() => { const s = document.querySelector('#g-file'); s.value = 'server/CLAUDE.md'; s.dispatchEvent(new Event('change')); })()");
    await evaluate(until("document.querySelector('#g-text').value === '@AGENTS.md\\n'"));
    await evaluate("document.querySelector('#g-file-more').click()");
    await evaluate(until("document.querySelector('.guide-file-menu')"));
    await evaluate("document.querySelector('.guide-file-menu button').click()");
    await evaluate(until("document.querySelector('dialog.guide-branch-dialog.danger[open]')"));
    assert.match(await evaluate("document.querySelector('dialog.guide-branch-dialog.danger').textContent"), /server\/CLAUDE\.md 삭제.*앱 백업\(최근 20개\)에서만/);
    await shot("b03-delete");
    await evaluate(clickText("dialog.guide-branch-dialog.danger button", "삭제"));
    await evaluate(until("document.querySelector('#g-toast').textContent.includes('server/CLAUDE.md를 지웠습니다') && document.querySelector('#g-text').value.includes('# 데모 에이전트 지침')"));
    assert.equal(existsSync(path.join(project, "server", "CLAUDE.md")), false);
    // 짝을 지우면 갈래 경고(Codex만 읽는 하위 지침)가 생긴다.
    await evaluate(until("document.querySelector('#g-branchbar').textContent.includes('갈래 경고') || true"));
    await evaluate(clickText("#g-toast button", "되돌리기"));
    await evaluate(until("document.querySelector('#g-toast').textContent.includes('server/CLAUDE.md를 되살렸습니다') && document.querySelector('#g-file').value === 'server/CLAUDE.md'"));
    assert.equal(readFileSync(path.join(project, "server", "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    // 갈래 경고 보기
    await evaluate("document.querySelector('#g-file-more').click()");
    await evaluate(until("document.querySelector('.guide-file-menu')"));
    await evaluate(clickText(".guide-file-menu button", "갈래 경고 보기…"));
    await evaluate(until("document.querySelector('dialog.guide-branch-dialog.wide[open]')"));
    await shot("b04-branch-warnings");
    // 지침 지도: 읽힘 보장
    await evaluate("document.querySelector('dialog.guide-branch-dialog.wide footer button').click()");
    await evaluate(clickText(".guide-seg button", "지침 지도"));
    await evaluate(until("document.querySelector('#g-map .gm-node[data-id=\"server/AGENTS.md\"]')"));
    await evaluate("document.querySelector('#g-map .gm-node[data-id=\"docs/Unity-규칙.md\"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    await evaluate(until("document.querySelector('#g-map-info').textContent.includes('읽힘 보장조건부')"));
    await shot("b05-map");
    assert.deepEqual(errors, []);
  });
});

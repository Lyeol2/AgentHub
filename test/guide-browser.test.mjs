// 프로젝트 지침 탭: 편집(섹션·검사·제안 적용·저장·CLAUDE.md 연결·AI 초안 비교) → 지침 지도 → 작업 순서도(세션 강조)
// GUIDE_SHOTS=<폴더>를 주면 화면마다 스크린샷을 남긴다.
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

test("browser: 프로젝트 지침 탭 — 편집·검사·제안 적용·저장·CLAUDE.md 연결·AI 초안 비교·지침 지도·작업 순서도", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" || !existsSync(chrome)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-guide-ui-"));
  const project = path.join(temp, "AgentHub");
  await fs.mkdir(path.join(project, "docs"), { recursive: true });
  await fs.writeFile(path.join(project, "docs", "development.md"), "# 개발\n");
  await fs.writeFile(path.join(project, "docs", "sprint3.md"), "# 지난 스프린트\n");
  await fs.writeFile(path.join(project, "AGENTS.md"), GUIDE);
  let releaseFlow = null;
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "AgentHub", path: project }] },
    deps: { cliPaths: () => ({ claude: "claude", codex: null }), discoverProjects: () => [], logger: { log() {} },
      ask: async (request) => {
        if (request.label === "지침 초안") return "```markdown\n" + readFileSync(path.join(project, "AGENTS.md"), "utf8").replace("## 응답 방식", "## 금지 사항\n- 확인 없이 파일을 지우지 않는다.\n\n## 응답 방식") + "```";
        await new Promise((resolve) => { releaseFlow = resolve; });
        return JSON.stringify({ nodes: [
          { id: "a", type: "start", title: "요청" }, { id: "b", type: "step", title: "조사", detail: "관련 코드·문서 읽기", lines: [7, 7] },
          { id: "c", type: "decision", title: "작업 종류?" }, { id: "d", type: "step", title: "계획서", detail: "docs/plan에 계획서", lines: [8, 8] },
          { id: "e", type: "step", title: "승인", detail: "사용자 승인을 받음", lines: [9, 9] }, { id: "f", type: "step", title: "구현", detail: "기존 모듈 재사용" },
          { id: "g", type: "step", title: "보고", detail: "응답 끝에 보고", lines: [19, 19] }, { id: "h", type: "step", title: "수정", detail: "문서만 고침" }, { id: "z", type: "end", title: "끝" }],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d", label: "기능 추가" }, { from: "c", to: "h", label: "문서만" }, { from: "d", to: "e" }, { from: "e", to: "f" }, { from: "f", to: "g" }, { from: "g", to: "z" }, { from: "h", to: "z" }] });
      } } });
  const now = new Date().toISOString();
  hub.store.add({ id: "s1", title: "FigCraft 계획", agent: "claude", permission: "default", projectPath: project, projectName: "AgentHub", cwd: project, state: "idle", worktree: null, skills: [], role: "계획서를 쓴다", createdAt: now, updatedAt: now, events: [] });
  hub.store.add({ id: "s2", title: "지침 검증", agent: "codex", permission: "default", projectPath: project, projectName: "AgentHub", cwd: project, state: "idle", worktree: null, skills: [], createdAt: now, updatedAt: now, events: [] });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  await fetch(`http://127.0.0.1:${hub.port}/api/links`, { method: "POST", headers: { "x-agenthub": "1", "Content-Type": "application/json" }, body: JSON.stringify({ from: "s1", to: "s2", when: "success" }) });

  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, async ({ evaluate, errors, shot }) => {
    await evaluate(until("[...document.querySelectorAll('#project-nav button')].some((x) => x.textContent.includes('AgentHub'))"));
    await evaluate("[...document.querySelectorAll('#project-nav button')].find((x) => x.textContent.includes('AgentHub')).click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=guide]').click()");
    // 편집: 섹션 목록·경고·CLAUDE.md 없음 배너
    await evaluate(until("document.querySelector('#g-text')?.value.includes('# 데모 에이전트 지침')"));
    await evaluate(until("document.querySelectorAll('#g-section-list .guide-section:not(.missing)').length === 4"));
    assert.match(await evaluate("document.querySelector('#g-section-list').textContent"), /프로젝트 요약.*작업 절차.*필독 문서.*응답 방식.*구현 원칙\+ 추가/);
    assert.match(await evaluate("document.querySelector('#g-banner').textContent"), /Claude 세션이 이 지침을 읽지 못합니다/);
    await evaluate(until("document.querySelector('#p-tab-guide').textContent === '3'"));
    assert.match(await evaluate("document.querySelector('#g-status').textContent"), /경고 3/);
    await shot("01-edit");
    // 검사 패널 → 승인 문장에 제안 적용 → 깨진 링크 지우기
    await evaluate("document.querySelector('#g-status').click()");
    await evaluate(until("!document.querySelector('#g-warnings').hidden && document.querySelectorAll('#g-warning-list .guide-warning').length >= 3"));
    await shot("02-warnings");
    await evaluate("[...document.querySelectorAll('#g-warning-list .guide-warning')].find((c) => c.textContent.includes('연결 작업을 멈추게')).querySelector('button.primary').click()");
    await evaluate(until("document.querySelector('#g-text').value.includes('연결로 넘어온 작업은 승인 없이 바로 진행한다')"));
    await evaluate(until("[...document.querySelectorAll('#g-warning-list .guide-warning.fixed')].length === 1 && document.querySelector('#p-tab-guide').textContent === '2'"));
    await evaluate("[...document.querySelectorAll('#g-warning-list .guide-warning')].find((c) => c.textContent.includes('없는 파일')).querySelector('button.primary').click()");
    await evaluate(until("document.querySelector('#g-text').value.includes('- C# 수정 시 Unity 규칙\\n')"));
    // 경고 하나(응답 끝 보고)가 남은 채 저장 → 막고 패널을 연다 → 무시하고 저장
    await evaluate(until("document.querySelector('#p-tab-guide').textContent === '1'"));
    await evaluate("document.querySelector('#g-save').click()");
    await evaluate(until("document.querySelector('#g-toast').textContent.includes('경고 1개')"));
    await evaluate("document.querySelector('#g-save-anyway').click()");
    await evaluate(until("document.querySelector('#g-toast').textContent === 'AGENTS.md를 저장했습니다'"));
    assert.match(readFileSync(path.join(project, "AGENTS.md"), "utf8"), /승인받은 뒤에만 구현한다\. \(사용자가 직접 요청한 작업에만/);
    // CLAUDE.md 연결 만들기
    await evaluate(clickText("#g-banner button", "@AGENTS.md 연결 만들기"));
    await evaluate(until("document.querySelector('#g-toast').textContent.includes('@AGENTS.md를 연결')"));
    assert.equal(readFileSync(path.join(project, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    assert.equal(await evaluate("document.querySelector('#g-banner').textContent"), "");
    // AI 초안: 비교 창에서 항목을 골라 반영
    await evaluate("document.querySelector('#g-draft').click()");
    await evaluate(until("document.querySelector('dialog.guide-diff-dialog[open]')"));
    assert.match(await evaluate("document.querySelector('.guide-diff-summary').textContent"), /바뀌는 곳 1 · 반영 0 \/ 버리기 0 \/ 미정 1/);
    await evaluate("document.querySelector('.guide-diff-item header button.ghost').click()"); // 반영
    await shot("03-diff");
    await evaluate("document.querySelector('.guide-diff-dialog [data-apply]').click()");
    await evaluate(until("document.querySelector('#g-text').value.includes('## 금지 사항\\n- 확인 없이 파일을 지우지 않는다.')"));
    assert.equal(await evaluate("document.querySelector('#g-save').disabled"), false, "반영하면 저장할 변경이 생긴다");
    // 다른 곳에서 바뀐 파일은 덮어쓰지 않는다.
    writeFileSync(path.join(project, "AGENTS.md"), readFileSync(path.join(project, "AGENTS.md"), "utf8") + "\n- 밖에서 덧붙임\n");
    await evaluate("document.querySelector('#g-save').click()");
    await evaluate(until("document.querySelector('#g-save-anyway') && !document.querySelector('#g-warnings').hidden"));
    await evaluate("document.querySelector('#g-save-anyway').click()");
    await evaluate(until("!document.querySelector('#g-save-error').hidden && document.querySelector('#g-save-error').textContent.includes('다른 곳에서 바뀌었습니다')"));
    await shot("04-save-error");
    await evaluate(clickText("#g-save-error button", "덮어쓰기"));
    await evaluate(until("document.querySelector('#g-toast').textContent === 'AGENTS.md를 저장했습니다'"));
    assert.ok(!readFileSync(path.join(project, "AGENTS.md"), "utf8").includes("밖에서 덧붙임"));

    // 지침 지도
    await evaluate(clickText(".guide-seg button", "지침 지도"));
    await evaluate(until("document.querySelectorAll('#g-map .gm-node').length >= 6"));
    const nodes = await evaluate("[...document.querySelectorAll('#g-map .gm-node')].map((n) => n.dataset.id)");
    for (const id of ["AGENTS.md", "CLAUDE.md", "docs/development.md", "role:s1", "role:s2", "inject:handoff"]) assert.ok(nodes.includes(id), `${id} in ${nodes}`);
    assert.ok(!nodes.includes("docs/sprint3.md"), "참조 없는 문서는 기본으로 숨긴다");
    assert.match(await evaluate("document.querySelector('#g-map-info').textContent"), /AGENTS\.md.*루트 지침.*둘 다 \(Claude · Codex\)/);
    await shot("05-map");
    await evaluate("document.querySelector('#g-hide-dim').click()");
    await evaluate(until("[...document.querySelectorAll('#g-map .gm-node')].some((n) => n.dataset.id === 'docs/sprint3.md' && n.classList.contains('orphan'))"));
    await evaluate("document.querySelector('#g-map .gm-node[data-id=\"role:s2\"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    await evaluate(until("document.querySelector('#g-map-info').textContent.includes('지침 검증') && document.querySelector('#g-map-info').textContent.includes('연결로 넘어온 작업')"));

    // 작업 순서도: 그리기(진행 중 → 결과) → 세션 고르면 멈추는 칸 강조
    await evaluate(clickText(".guide-seg button", "작업 순서도"));
    await evaluate(until("document.querySelector('#g-flow .guide-state.empty')"));
    await evaluate(clickText("#g-flow button", "순서도 그리기"));
    await evaluate(until("document.querySelector('#g-flow .guide-state.loading') && document.querySelector('#g-flow-draw').textContent.includes('중지')"));
    for (let i = 0; i < 100 && !releaseFlow; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFlow();
    await evaluate(until("document.querySelectorAll('#g-flow .gf-node').length === 9"));
    assert.ok(await evaluate("document.querySelector('#g-flow .gf-node.guess[data-id=f]') !== null"), "근거 없는 칸은 추정");
    await evaluate("document.querySelector('#g-flow .gf-node[data-id=e]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    await evaluate(until("document.querySelector('#g-flow-info pre')?.textContent.includes('승인받은 뒤에만 구현한다')"));
    await shot("06-flow");
    await evaluate("(() => { const s = document.querySelector('#g-session'); s.value = 's2'; s.dispatchEvent(new Event('change')); })()");
    await evaluate(until("document.querySelector('#g-flow-notice').textContent.includes('이 세션이 연결로 받은 작업은')"));
    // 저장한 지침에서는 승인 문장에 예외를 적었으므로 멈추지 않고, 응답 끝 보고만 판정 줄과 부딪힌다.
    assert.match(await evaluate("document.querySelector('#g-flow-notice').textContent"), /멈추지 않습니다.*판정 줄과 부딪히는 칸 1개/);
    assert.ok(await evaluate("document.querySelector('#g-flow .gf-node.conflict[data-id=g]') !== null"));
    await evaluate("document.querySelector('#g-flow-info button.primary').click()");
    await evaluate(until("!document.querySelector('[data-view-panel=edit]').hidden && !document.querySelector('#g-warnings').hidden"));
    await shot("07-back-to-edit");
    assert.deepEqual(errors, []);
  });
});

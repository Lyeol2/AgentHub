// 세션 화면과 세션 지침 브라우저 시험. GUIDE_SHOTS=<폴더>를 주면 화면마다 스크린샷을 남긴다.
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

test("browser: 세션 화면 정리와 세션 지침 — 한 줄 머리·⋯ 메뉴·상태 칩·정보 패널·역할 옮기기·지침 탭·판정과 연결 경고", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" || !existsSync(chrome)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-session-guide-ui-"));
  const project = path.join(temp, "AgentHub");
  await fs.mkdir(project, { recursive: true });
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "AgentHub", path: project }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  const now = new Date().toISOString();
  hub.store.add({ id: "s1", title: "계획서 작성", agent: "claude", permission: "acceptEdits", projectPath: project, projectName: "AgentHub", cwd: project, state: "idle", worktree: null, skills: [], roleName: "기획",
    role: "계획서를 쓴다.\n- 끝나면 마지막 줄에 '자원 준비 완료'만 쓴다.", createdAt: now, updatedAt: now, events: [{ seq: 0, kind: "user", text: "계획 세워 줘" }, { seq: 1, kind: "text", text: "계획을 세웠습니다.\n자원 준비 완료" }], graphPos: { x: 40, y: 40 } });
  hub.store.add({ id: "s2", title: "이미지 생성", agent: "codex", projectPath: project, projectName: "AgentHub", cwd: project, state: "idle", worktree: null, skills: [], createdAt: now, updatedAt: now, events: [], graphPos: { x: 400, y: 40 } });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  await fetch(`http://127.0.0.1:${hub.port}/api/links`, { method: "POST", headers: { "x-agenthub": "1", "Content-Type": "application/json" }, body: JSON.stringify({ from: "s1", to: "s2", when: "keyword", keyword: "자원 대기" }) });

  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, async ({ evaluate, errors, shot }) => {
    await evaluate(until("[...document.querySelectorAll('#session-list button')].some((b) => b.textContent.includes('계획서 작성'))"));
    await evaluate("[...document.querySelectorAll('#session-list button')].find((b) => b.textContent.includes('계획서 작성')).click()");
    await evaluate(until("!document.querySelector('#view-session').hidden && document.querySelector('#s-title').textContent === '계획서 작성'"));
    // 한 줄 머리: 쉴 때는 중지가 보이지 않고, 나머지 단추는 ⋯ 메뉴에 있다.
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#s-stop')).display"), "none");
    assert.equal(await evaluate("document.querySelector('#s-menu').hidden"), true);
    const headerHeight = await evaluate("document.querySelector('.session-top').getBoundingClientRect().height + document.querySelector('#s-meta').getBoundingClientRect().height");
    assert.ok(headerHeight < 110, `머리와 칩 줄이 낮다: ${headerHeight}`);
    // 상태 칩: 예전 역할
    await evaluate(until("document.querySelector('#s-meta').textContent.includes('역할 (옮기기 전)')"));
    assert.match(await evaluate("document.querySelector('#s-meta').textContent"), /원본 폴더[\s\S]*편집 자동 허용|원본 폴더[\s\S]*acceptEdits/);
    assert.match(await evaluate("document.querySelector('#s-info').textContent"), /세션 지침[\s\S]*예전 역할을 쓰고 있습니다[\s\S]*연결[\s\S]*이미지 생성[\s\S]*스킬[\s\S]*수명/);
    await shot("g01-session-role");
    // ⋯ 메뉴
    await evaluate("document.querySelector('#s-more').click()");
    await evaluate(until("!document.querySelector('#s-menu').hidden"));
    assert.match(await evaluate("document.querySelector('#s-menu').textContent"), /보기[\s\S]*도구 펼치기[\s\S]*로그 보기[\s\S]*새 창으로[\s\S]*작업[\s\S]*다시 시작[\s\S]*기록[\s\S]*기록 내보내기[\s\S]*기록 가져오기[\s\S]*설정[\s\S]*세션 설정[\s\S]*역할 \(예전\)[\s\S]*삭제/);
    await shot("g02-menu");
    await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    await evaluate(until("document.querySelector('#s-menu').hidden"));
    // 정보 패널 접기는 기억한다.
    await evaluate("document.querySelector('#s-info-toggle').click()");
    assert.equal(await evaluate("document.querySelector('#s-info').hidden"), true);
    assert.equal(await evaluate("localStorage.getItem('agenthub.sessionInfo')"), "closed");
    await evaluate("document.querySelector('#s-info-toggle').click()");
    // 지침 → 역할을 세션 지침으로 옮기기 → 지침 탭에서 연다
    await evaluate("document.querySelector('#s-guide').click()");
    await evaluate(until("document.querySelector('dialog.guide-branch-dialog[open]')"));
    assert.ok(await evaluate("document.querySelector('dialog.guide-branch-dialog input[value=role]').checked"));
    await evaluate(clickText("dialog.guide-branch-dialog[open] button", "확인"));
    await evaluate(until("!document.querySelector('#view-project').hidden && document.querySelector('#g-file')?.value === '.agenthub/sessions/기획.md'"));
    assert.match(readFileSync(path.join(project, ".agenthub", "sessions", "기획.md"), "utf8"), /name: 기획[\s\S]*## 판정\n- 끝나면 판정 '자원 준비 완료'\./);
    await evaluate(until("document.querySelector('#g-branchbar').textContent.includes('쓰는 세션 계획서 작성')"));
    // 판정과 연결 검사: 연결 키워드 '자원 대기'가 지침에 없다.
    await evaluate(until("document.querySelector('#p-tab-guide').textContent !== '' || document.querySelector('#g-status').textContent.includes('경고')"));
    await evaluate("document.querySelector('#g-status').click()");
    await evaluate(until("[...document.querySelectorAll('#g-warning-list .guide-warning')].some((c) => c.textContent.includes(\"연결 키워드 '자원 대기'가 지침에 없습니다\"))"));
    await shot("g03-guide-tab");
    // 지침을 고쳐 판정을 더하고 저장 → 세션 칩과 카드가 바뀐다.
    await evaluate("(() => { const t = document.querySelector('#g-text'); t.value = t.value.replace(\"'자원 준비 완료'.\", \"'자원 준비 완료'.\\n- 아직 없으면 '자원 대기'\"); t.dispatchEvent(new Event('input')); })()");
    await evaluate("setTimeout(() => document.querySelector('#g-save').click(), 0), 1");
    await evaluate(until("document.querySelector('#g-toast').textContent.startsWith('.agenthub/sessions/기획.md를 저장했습니다')"));
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    // 카드에는 지침 글을 싣지 않는다. 이름·요약은 마우스를 올리면 보이고, 문제가 있을 때만 ⚠가 뜬다.
    await evaluate(until("document.querySelector('.gcard[data-id=s1]')?.title.includes('지침 기획')"));
    assert.equal(await evaluate("document.querySelectorAll('.gcard-role').length"), 0, "카드에 지침·역할 줄이 없다");
    assert.equal(await evaluate("document.querySelector('.gcard[data-id=s1] .gcard-guide-warn')"), null, "판정을 더하면 경고가 사라진다");
    assert.equal(await evaluate("document.querySelector('.gcard[data-id=s2] .gcard-guide-warn')"), null, "지침이 없어도 '지침 없음'이나 ⚠를 띄우지 않는다");
    assert.match(await evaluate("document.querySelector('#p-graph .edge-label')?.textContent ?? ''"), /판정 "자원 대기"/);
    await shot("g04-graph");
    await evaluate("[...document.querySelectorAll('#session-list button')].find((b) => b.textContent.includes('계획서 작성')).click()");
    await evaluate(until("document.querySelector('#s-meta').textContent.includes('기획 · ⟳ 다음 요청에 전달')"));
    assert.match(await evaluate("document.querySelector('#s-info-guide').textContent"), /기획[\s\S]*판정[\s\S]*자원 준비 완료[\s\S]*자원 대기/);
    assert.equal(await evaluate("document.querySelector('#s-role').hidden"), true, "옮긴 뒤에는 예전 역할 단추를 숨긴다");
    await shot("g05-session-guide");
    // 요청에 붙는다(서버)
    assert.match(hub.services.sessions.composeInput(hub.store.get("s1"), "일해"), /\[이 세션의 지침: 기획\][\s\S]*'자원 대기'/);
    // 지침에 없는 판정어로 연결하면 카드에 ⚠가 뜨고, 누르면 그 지침을 연다.
    const kw = hub.links.list().find((l) => l.from === "s1" && l.to === "s2");
    const changed = await fetch(`http://127.0.0.1:${hub.port}/api/links/${kw.id}`, { method: "PUT", headers: { "x-agenthub": "1", "Content-Type": "application/json" }, body: JSON.stringify({ when: "keyword", keyword: "외부 확인" }) });
    assert.ok(changed.ok, await changed.text());
    await evaluate("document.querySelector('#s-crumb-project').click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    await evaluate(until("document.querySelector('.gcard[data-id=s1] .gcard-guide-warn')"));
    assert.match(await evaluate("document.querySelector('.gcard[data-id=s1] .gcard-guide-warn').title"), /판정에 없습니다/);
    await evaluate("document.querySelector('.gcard[data-id=s1] .gcard-guide-warn').click()");
    await evaluate(until("!document.querySelector('[data-panel=guide]').hidden && document.querySelector('#g-file')?.value === '.agenthub/sessions/기획.md'"));
    assert.deepEqual(errors, []);
  });
});

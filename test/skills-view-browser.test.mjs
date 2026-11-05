// 스킬 보기 브라우저 시험. GUIDE_SHOTS=<폴더>를 주면 화면마다 스크린샷을 남긴다.
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
// 시험이 HOME을 임시 폴더로 바꿔도 브라우저는 원래 환경으로 띄운다.
const BASE_ENV = { ...process.env };

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
  const child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true, env: BASE_ENV });
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
    const pending = new Map(), errors = [], dialogs = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id);
        if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result);
      }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      // 확인 창이 뜨면 기록하고 닫는다(창이 떠 있으면 페이지가 멈춘다).
      if (message.method === "Page.javascriptDialogOpening") {
        dialogs.push(message.params.message);
        socket.send(JSON.stringify({ id: ++id, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      }
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
    await run({ evaluate, errors, shot, dialogs });
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

const until = (condition) => `new Promise((resolve,reject)=>{const end=Date.now()+20000;const check=async()=>{if(await (${condition}))resolve(true);else if(Date.now()>end)reject(Error('Timed out: '+${JSON.stringify(condition)}));else setTimeout(check,25);};check();})`;
const clickText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`;

// 스킬 보기: 목록 그룹·필터 → 긴 스킬과 참고 파일 탭 → 검사 패널 → 잠긴 공용 스킬 합치기 → 건너뜀 고치기 → 새 스킬 AI 초안 → 발동 시험 → 장착 창
test("browser: 스킬 보기 — 목록·편집·참고 파일·검사·잠김 합치기·건너뜀 고치기·AI 초안·발동 시험·장착 창", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" || !existsSync(chrome)) return t.skip("Windows Chromium required");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-skills-ui-"));
  const home = path.join(temp, "home");
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
  const project = path.join(temp, "AgentHub");
  const other = path.join(temp, "GBS");
  const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
  const skill = (name, description, body = "# 본문\n1. 한다.") => `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`;
  put(path.join(project, ".agenthub", "skills", "idea-discussion", "SKILL.md"), skill("idea-discussion", "게임 아이디어를 토론하고 릴리스 계획을 세울 때 쓴다", "# 토론\n- [템플릿](references/template.md)\n- 작업마다 완료 보고서를 쓴다."));
  put(path.join(project, ".claude", "skills", "unity-cli", "SKILL.md"), skill("unity-cli", "Unity CLI를 다룰 때 쓴다", "# Unity CLI\n\n1. 먼저 `unity --version`으로 설치를 확인한다.\n" + "- 명령 설명 줄\n".repeat(40)));
  put(path.join(project, ".claude", "skills", "unity-cli", "references", "cli-commands.md"), "# 명령 목록\n- build\n");
  put(path.join(project, ".claude", "skills", "unity-cli", "scripts", "probe.sh"), "echo probe\n");
  put(path.join(project, ".agents", "skills", "Bad_Name", "SKILL.md"), "---\nname: Bad_Name\ndescription: 이름이 틀린 스킬\n---\n본문\n");
  put(path.join(home, ".claude", "skills", "git-commit", "SKILL.md"), skill("git-commit", "변경을 커밋할 때 쓴다", "# 커밋\n- feat: 형식"));
  put(path.join(home, ".agents", "skills", "git-commit", "SKILL.md"), skill("git-commit", "변경을 커밋할 때 쓴다", "# 커밋\n- fix: 형식"));
  put(path.join(home, ".claude", "skills", "release", "SKILL.md"), skill("release", "새 버전을 릴리스할 때 쓴다. 릴리스 계획도 세운다"));
  put(path.join(home, ".agents", "skills", "release", "SKILL.md"), skill("release", "새 버전을 릴리스할 때 쓴다. 릴리스 계획도 세운다"));
  put(path.join(home, ".codex", "skills", "codex-review", "SKILL.md"), skill("codex-review", "Codex로 리뷰할 때 쓴다"));
  put(path.join(other, ".agenthub", "skills", "idea-discussion", "SKILL.md"), skill("idea-discussion", "다른 프로젝트의 토론 스킬", "# 다른 토론"));
  const hub = createHub({ port: 0, dataDir: path.join(temp, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "AgentHub", path: project }, { name: "GBS", path: other }] },
    deps: { cliPaths: () => ({ claude: "claude", codex: "codex" }), discoverProjects: () => [], logger: { log() {} },
      ask: async (request) => {
        if (request.label === "발동 시험") return JSON.stringify({ results: [{ name: "release", score: 86, reason: "‘새 버전을 릴리스할 때’와 맞음" }, { name: "idea-discussion", score: 41, reason: "‘릴리스 계획’이 겹침" }] });
        await new Promise((resolve) => setTimeout(resolve, 600));
        return "```markdown\n---\nname: deploy-check\ndescription: \"배포 전에 바뀐 설정을 확인할 때 쓴다. 배포 자체는 하지 않는다\"\n---\n\n# 배포 확인\n1. 바뀐 설정 파일을 본다.\n2. 결과를 표로 쓴다.\n```";
      } } });
  const now = new Date().toISOString();
  hub.store.add({ id: "s1", title: "Unity 작업", agent: "claude", permission: "default", projectPath: project, projectName: "AgentHub", cwd: project, state: "idle", worktree: null, skills: ["idea-discussion"], createdAt: now, updatedAt: now, events: [], graphPos: { x: 60, y: 60 } });
  await hub.start();
  t.after(async () => {
    await hub.shutdown();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });

  await withBrowser(temp, `http://127.0.0.1:${hub.port}/`, async ({ evaluate, errors, shot, dialogs }) => {
    await evaluate(until("[...document.querySelectorAll('#project-nav button')].some((x) => x.textContent.includes('AgentHub'))"));
    await evaluate("[...document.querySelectorAll('#project-nav button')].find((x) => x.textContent.includes('AgentHub')).click()");
    await evaluate(until("!document.querySelector('#view-project').hidden"));
    // 상단바 "스킬" 버튼은 스킬 보기로 바로 온다.
    await evaluate("document.querySelector('#p-skills').click()");
    await evaluate(until("!document.querySelector('#g-skills').hidden && document.querySelectorAll('#gs-rows .gs-row:not(.skeleton)').length === 6"));
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#gs-rows .gs-group')].map((g) => g.textContent)"), ["AgentHub만", "Claude 자동", "Codex 자동", "공용", "건너뜀"]);
    assert.match(await evaluate("document.querySelector('#gs-filters').textContent"), /전체 6.*AgentHub만 1.*Claude 자동 1.*Codex 자동 1.*공용 2/);
    await evaluate(until("document.querySelector('#g-skills-count').textContent === '4'"));
    // 긴 스킬 · 참고 파일 탭
    await evaluate("document.querySelector('.gs-row[data-name=\"unity-cli\"]').click()");
    await evaluate(until("document.querySelector('.gs-head h3')?.textContent === 'unity-cli' && document.querySelector('.gs-reader strong')?.textContent === 'Claude가 저절로 읽음'"));
    assert.match(await evaluate("document.querySelector('#gs-info').textContent"), /참고 파일 2.*cli-commands\.md.*probe\.sh.*읽는 세션 1 · 저절로.*Unity 작업/);
    await evaluate("[...document.querySelectorAll('#gs-info .gs-tree button')].find((b) => b.textContent.startsWith('cli-commands.md')).click()");
    await evaluate(until("document.querySelector('.gs-tab.active') && document.querySelector('.gs-text').value.startsWith('# 명령 목록')"));
    await evaluate("(() => { const t = document.querySelector('.gs-text'); t.value += '- test\\n'; t.dispatchEvent(new Event('input')); })()");
    await evaluate(until("!document.querySelector('#gs-save').disabled"));
    await shot("s01-default");
    await evaluate("setTimeout(() => document.querySelector('#gs-save').click(), 0), 1");
    await evaluate(until("document.querySelector('#g-toast').textContent === 'unity-cli을 저장했습니다'"));
    assert.equal(readFileSync(path.join(project, ".claude", "skills", "unity-cli", "references", "cli-commands.md"), "utf8"), "# 명령 목록\n- build\n- test\n");
    // 검사 패널(idea-discussion): 발동 충돌·깨진 링크·연결 충돌 → 제안 적용
    await evaluate("document.querySelector('.gs-row[data-name=\"idea-discussion\"]').click()");
    await evaluate(until("document.querySelector('.gs-head h3')?.textContent === 'idea-discussion' && document.querySelector('#gs-status').textContent.includes('경고')"));
    assert.match(await evaluate("document.querySelector('#gs-info').textContent"), /다른 프로젝트 1곳에 같은 이름 · 1곳 다름/);
    await evaluate("document.querySelector('#gs-status').click()");
    await evaluate(until("document.querySelectorAll('#gs-info .guide-warning').length >= 3"));
    const titles = await evaluate("[...document.querySelectorAll('#gs-info .guide-warning strong')].map((s) => s.textContent).join(' | ')");
    assert.match(titles, /release와 발동 조건이 겹칩니다/);
    assert.match(titles, /없는 파일을 가리킵니다/);
    assert.match(titles, /작업마다 커밋·완료보고서/);
    await shot("s02-check");
    await evaluate("[...document.querySelectorAll('#gs-info .guide-warning')].find((c) => c.textContent.includes('작업마다 커밋')).querySelector('button.primary').click()");
    await evaluate(until("document.querySelector('.gs-text').value.includes('작업마다 완료 보고서를 쓴다. (사용자가 직접 요청한 작업에만 적용한다.)')"));
    // 잠긴 공용 스킬: 배너 → 두 위치 비교 → 합치고 잠김 풀기
    // 고친 내용을 저장하지 않고 다른 스킬로 가면 버릴지 묻는다(여기서는 버린다).
    await evaluate("window.confirm = () => true");
    await evaluate("document.querySelector('.gs-row[data-name=\"git-commit\"]').click()");
    await evaluate(until("document.querySelector('#gs-banner').textContent.includes('두 위치의 내용이 다릅니다')"));
    assert.equal(await evaluate("document.querySelector('.gs-text').readOnly"), true);
    await shot("s03-locked");
    await evaluate(clickText("#gs-banner button", "비교해서 합치기"));
    await evaluate(until("document.querySelector('dialog.guide-diff-dialog[open]')"));
    await evaluate("document.querySelector('.guide-diff-item header button.ghost').click()");
    await evaluate("document.querySelector('.guide-diff-dialog [data-apply]').click()");
    await evaluate(until("document.querySelector('#g-toast').textContent.includes('git-commit을 합쳤습니다')"));
    await evaluate(until("!document.querySelector('#gs-banner').textContent && document.querySelector('.gs-text') && !document.querySelector('.gs-text').readOnly"));
    assert.equal(readFileSync(path.join(home, ".claude", "skills", "git-commit", "SKILL.md"), "utf8"), readFileSync(path.join(home, ".agents", "skills", "git-commit", "SKILL.md"), "utf8"));
    // 건너뛴 스킬 고치기
    await evaluate("document.querySelector('.gs-row[data-name=\"Bad_Name\"]').click()");
    await evaluate(until("document.querySelector('.gs-skip-card')?.textContent.includes('Bad_Name → bad-name')"));
    await shot("s04-skipped");
    await evaluate("document.querySelector('.gs-skip-card button').click()");
    await evaluate(until("document.querySelector('.gs-head h3')?.textContent === 'bad-name'"));
    assert.ok(existsSync(path.join(project, ".agents", "skills", "bad-name", "SKILL.md")));
    // 새 스킬 → AI 초안 → 저장
    await evaluate("document.querySelector('#gs-new').click()");
    await evaluate(until("document.querySelector('dialog.gs-new[open]')"));
    await evaluate("(() => { const d = document.querySelector('dialog.gs-new'); const n = d.querySelector('input.mono'); n.value = 'unity-cli'; n.dispatchEvent(new Event('input')); })()");
    assert.match(await evaluate("document.querySelector('dialog.gs-new .gs-hint').textContent"), /이미 있는 이름/);
    await evaluate("(() => { const d = document.querySelector('dialog.gs-new'); const n = d.querySelector('input.mono'); n.value = 'deploy-check'; n.dispatchEvent(new Event('input')); d.querySelector('textarea').value = '배포 전에 확인할 때'; })()");
    await shot("s05-new");
    await evaluate(clickText("dialog.gs-new button", "AI 초안 만들기"));
    await evaluate(until("document.querySelector('.gs-progress')"));
    await shot("s06-draft");
    await evaluate(until("!document.querySelector('.gs-progress') && document.querySelector('#gs-description')?.value.startsWith('배포 전에 바뀐 설정')"));
    assert.match(await evaluate("document.querySelector('.gs-text').value"), /# 배포 확인/);
    await evaluate("setTimeout(() => document.querySelector('#gs-save').click(), 0), 1");
    await evaluate(until("document.querySelector('#g-toast').textContent === 'deploy-check 스킬을 만들었습니다'"));
    assert.ok(existsSync(path.join(project, ".agenthub", "skills", "deploy-check", "SKILL.md")));
    // 발동 시험
    await evaluate("document.querySelector('#gs-trigger').click()");
    await evaluate("(() => { const p = document.querySelector('.gs-trigger-pop'); p.querySelector('textarea').value = '릴리스 노트 정리하고 태그 달아줘'; [...p.querySelectorAll('button')].find((b) => b.textContent === '시험').click(); })()");
    await evaluate(until("document.querySelectorAll('.gs-trigger-pop .gs-rank').length === 1"));
    assert.match(await evaluate("document.querySelector('.gs-trigger-pop').textContent"), /release.*86%.*새 버전을 릴리스할 때/);
    await shot("s07-trigger");
    await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    // 장착 창: 세션 카드의 스킬 칩
    await evaluate("document.querySelector('#p-tabs [data-tab=flow]').click()");
    await evaluate(until("document.querySelector('.gcard[data-id=s1] .gcard-skills')"));
    await evaluate("document.querySelector('.gcard[data-id=s1] .gcard-skills').click()");
    await evaluate(until("document.querySelector('#equip-dialog').open && document.querySelectorAll('#equip-list .equip-tabs button').length === 3"));
    assert.match(await evaluate("document.querySelector('#equip-list .equip-tabs').textContent"), /AgentHub가 붙임 \d.*저절로 읽힘 \d.*건너뜀 0/);
    await evaluate("(() => { const s = document.querySelector('#equip-list .equip-search'); s.value = 'deploy'; s.dispatchEvent(new Event('input')); })()");
    await evaluate(until("[...document.querySelectorAll('#equip-list label.equip-item')].length === 1"));
    await evaluate("document.querySelector('#equip-list label.equip-item input').click()");
    await shot("s08-equip");
    await evaluate("document.querySelector('#equip-form button[value=ok]').click()");
    await evaluate(until("!document.querySelector('#equip-dialog').open"));
    for (let i = 0; i < 50 && !hub.store.get("s1").skills.includes("deploy-check"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(hub.store.get("s1").skills.sort(), ["deploy-check", "idea-discussion"], "검색으로 가려진 장착도 유지된다");
    assert.deepEqual(dialogs, [], "저장하는 중에 다른 스킬을 열어도 확인 창이 끼어들지 않는다");
    assert.deepEqual(errors, []);
  });
});

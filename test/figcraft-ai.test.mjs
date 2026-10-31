// FigCraft AI 배치. 실제 AI 대신, 프롬프트대로 `node fc.mjs`만 써서 배치하고 렌더하는 가짜 AI로 시험한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkFigcraftNode, runFigcraft, FigcraftSettings, parsePlan, imageSize } from "../server/figcraft.mjs";
import { oneShotArgs } from "../server/one-shot.mjs";
import { createHub } from "../server/bootstrap.mjs";

const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-fake-figcraft-ai-"));
const FAKE = path.join(FAKE_DIR, "fake-figcraft-cli.mjs");
fs.copyFileSync(fileURLToPath(new URL("./fixtures/fake-figcraft-cli.mjs.txt", import.meta.url)), FAKE);
test.after(() => fs.rmSync(FAKE_DIR, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-figcraft-ai-"));
  const log = path.join(root, "calls.jsonl");
  const before = process.env.FAKE_FIGCRAFT_LOG;
  process.env.FAKE_FIGCRAFT_LOG = log;
  t.after(() => { if (before === undefined) delete process.env.FAKE_FIGCRAFT_LOG; else process.env.FAKE_FIGCRAFT_LOG = before; fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "logo.png"), PNG);
  fs.writeFileSync(path.join(root, "assets", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>');
  return { root, log };
}
const node = (fields) => ({ id: "n1", ...checkFigcraftNode(fields) });
const PLAN = `# 디자인 계획서
화면: 로그인 (360×640)
로그인:
  - 위: [logo] 가운데, 너비 120
  - 제목: "다시 오신 걸 환영해요"

\`\`\`agenthub-images
[{ "role": "logo", "source": "assets/logo.png", "note": "가운데 로고" }, { "role": "icon", "source": "assets/icon.svg" }]
\`\`\``;

// 가짜 AI: 작업 폴더에서 `node fc.mjs`만 써서 프레임을 만들고 리소스를 넣고 렌더한다.
function fakeAi(calls = []) {
  return async (options) => {
    calls.push(options);
    const { cwd } = options;
    const fc = (...args) => spawnSync(process.execPath, ["fc.mjs", ...args], { cwd, encoding: "utf8" });
    const step = calls.length;
    fs.writeFileSync(path.join(cwd, `edit-${step}.json`), JSON.stringify([{ command: "frame.create", params: { name: `로그인${step}`, width: 360, height: 640 } },
      { command: "image.place", params: { path: "resources/logo.png", x: 120, y: 40, width: 120, height: 120 } }]));
    const edit = fc("run", `edit-${step}.json`, "--in", "design.figcraft", "--out", "design.figcraft");
    if (edit.status !== 0) throw new Error(`run 실패: ${edit.stdout}${edit.stderr}`);
    const shot = fc("render", "design.figcraft", "-o", `renders/round-${step}.png`);
    if (shot.status !== 0) throw new Error(`render 실패: ${shot.stderr}`);
    return `로그인${step} 화면에 로고를 배치하고 렌더해서 확인했습니다.`;
  };
}

test("figcraft ai: 작업 모드 AI는 작업 폴더 안 쓰기와 정한 명령만 허용하고 MCP는 붙이지 않는다", () => {
  const claude = oneShotArgs({ agent: "claude", cwd: "C:/w", work: { commands: ["node fc.mjs"] } });
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(claude[claude.indexOf("--allowedTools") + 1], "Read,Glob,Grep,Write,Edit,Bash(node fc.mjs:*)");
  assert.ok(claude.includes("--strict-mcp-config"));
  const codex = oneShotArgs({ agent: "codex", cwd: "C:/w", work: { commands: ["node fc.mjs"] }, mcpServers: ["figcraft"] });
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(codex.includes("mcp_servers.figcraft.enabled=false"));
  const readOnly = oneShotArgs({ agent: "codex", cwd: "C:/w", mcpServers: [] });
  assert.equal(readOnly[readOnly.indexOf("--sandbox") + 1], "read-only", "기존 한 번 요청은 그대로 읽기 전용");
});

test("figcraft ai: 계획서에서 이미지 블록이나 글 속 이미지 경로를 꺼내고, 이미지 크기를 읽는다", (t) => {
  const { root } = project(t);
  const parsed = parsePlan(PLAN, root);
  assert.deepEqual(parsed.images.map((image) => [image.role, image.source]), [["logo", "assets/logo.png"], ["icon", "assets/icon.svg"]]);
  assert.ok(!parsed.plan.includes("agenthub-images"), "계획서 본문에서 이미지 블록은 뺀다");
  const loose = parsePlan(`로고는 assets/logo.png 를 쓰고, 없는 파일 assets/nope.png 는 무시한다.`, root);
  assert.deepEqual(loose.images.map((image) => image.role), ["logo"]);
  assert.throws(() => parsePlan("```agenthub-images\n[{\"role\": \"hero\", \"prompt\": \"blue sky\"}]\n```", root), /source\(파일 경로\)가 없습니다/);
  assert.throws(() => parsePlan("```agenthub-images\n{깨짐\n```", root), /JSON 형식이 아닙니다/);
  assert.deepEqual(imageSize(path.join(root, "assets", "logo.png")), { width: 1, height: 1, alpha: true });
  assert.deepEqual(imageSize(path.join(root, "assets", "icon.svg")), { width: 24, height: 24, alpha: true });
});

test("figcraft ai: 계획서·이미지를 실행 폴더로 모아 배치만 시키고, FigCraft는 실행 폴더만 읽고 쓴다", async (t) => {
  const { root, log } = project(t);
  const calls = [];
  const settings = node({ action: "ai", prompt: "{{input}}", maxRounds: 2, agent: "codex" });
  const first = await runFigcraft(settings, { input: PLAN, render: (template) => template.replace("{{input}}", PLAN), projectPath: root, cli: FAKE, ask: fakeAi(calls) });
  const record = first.record;
  const prompt = calls[0].prompt;
  assert.equal(calls[0].agent, "codex");
  assert.deepEqual(calls[0].work, { commands: ["node fc.mjs"] });
  assert.match(prompt, /너는 배치만 한다/);
  assert.match(prompt, /문구를 새로 쓰거나 바꾸지 않고, 이미지를 새로 만들거나 고르지 않는다/);
  assert.match(prompt, /\[계획서\][\s\S]*다시 오신 걸 환영해요/);
  assert.match(prompt, /- logo: resources\/logo\.png \(1×1, 투명 배경\) · 가운데 로고/);
  assert.match(prompt, /- icon: resources\/icon\.svg/);
  assert.match(prompt, /image\.place[\s\S]*file\.import/);
  assert.ok(!prompt.includes("[추가 지시]"), "{{input}}만 적힌 칸은 추가 지시가 아니다");
  // 리소스 묶음
  assert.deepEqual(fs.readdirSync(path.join(record.outputDir, "resources")).sort(), ["icon.svg", "logo.png"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(record.outputDir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.resources.map((item) => item.role), ["logo", "icon"]);
  assert.ok(!fs.readFileSync(path.join(record.outputDir, "plan.md"), "utf8").includes("agenthub-images"));
  assert.deepEqual(record.resources.map((item) => item.role), ["logo", "icon"]);
  assert.deepEqual(record.warnings, []);
  assert.equal(record.summary, "로그인1 화면에 로고를 배치하고 렌더해서 확인했습니다.");
  assert.deepEqual(record.renders.map((file) => path.basename(file)), ["round-1.png"]);
  assert.deepEqual(record.frames.map((frame) => frame.name), ["로그인1"]);
  // fc.mjs: 읽기·쓰기 모두 실행 폴더만, 허용한 명령만, 화면 확인 횟수 제한
  const runs = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((call) => call.args[0] === "run" && call.args[1] === "edit-1.json");
  const reads = runs[0].args.flatMap((arg, index, all) => (all[index - 1] === "--automation-read-root" ? [arg] : []));
  assert.deepEqual(reads, [record.outputDir], "프로젝트 전체가 아니라 실행 폴더만 읽는다");
  assert.equal(runs[0].args[runs[0].args.indexOf("--automation-write-root") + 1], record.outputDir);
  const fc = (...args) => spawnSync(process.execPath, ["fc.mjs", ...args], { cwd: record.outputDir, encoding: "utf8" });
  assert.equal(fc("plugin", "publish", "x").status, 2);
  assert.equal(fc("render", "design.figcraft", "-o", "renders/round-2.png").status, 0);
  assert.equal(fc("render", "design.figcraft", "-o", "renders/round-3.png").status, 3);
  // 이어서 고치기: 앞 실행의 계획서·리소스를 그대로 쓰고, 적은 내용은 추가 지시가 된다.
  const second = await runFigcraft(settings, { input: "", projectPath: root, cli: FAKE, ask: fakeAi(calls), edit: { file: record.file, request: "로고를 더 크게" } });
  assert.match(calls[1].prompt, /\[추가 지시\]\n로고를 더 크게/);
  assert.match(calls[1].prompt, /다시 오신 걸 환영해요/);
  assert.match(calls[1].prompt, /- logo: resources\/logo\.png/);
  assert.equal(second.record.base, record.file);
  assert.deepEqual(second.record.frames.map((frame) => frame.name), ["로그인1", "로그인2"], "앞 결과 위에 고친다");
  // 계획서를 앞 노드에서 받으면 노드 칸은 추가 지시가 된다.
  await runFigcraft(node({ action: "ai", prompt: "여백을 넉넉히" }), { input: PLAN, render: (template) => template, projectPath: root, cli: FAKE, ask: fakeAi(calls) });
  assert.match(calls[2].prompt, /\[추가 지시\]\n여백을 넉넉히/);
});

test("figcraft ai: 계획서가 없거나 이미지 파일이 없으면 AI를 부르지 않고 실패한다", async (t) => {
  const { root } = project(t);
  const calls = [];
  await assert.rejects(runFigcraft(node({ action: "ai", prompt: "{{input}}" }), { input: "", render: () => "", projectPath: root, cli: FAKE, ask: fakeAi(calls) }), /배치할 계획서가 없습니다/);
  const missing = "화면: 홈\n```agenthub-images\n[{ \"role\": \"hero\", \"source\": \"assets/hero.png\" }]\n```";
  await assert.rejects(runFigcraft(node({ action: "ai" }), { input: missing, projectPath: root, cli: FAKE, ask: fakeAi(calls) }), /이미지 파일을 찾을 수 없습니다: assets\/hero\.png/);
  const twice = "화면: 홈\n```agenthub-images\n[{ \"role\": \"logo\", \"source\": \"assets/logo.png\" }, { \"role\": \"LOGO\", \"source\": \"assets/icon.svg\" }]\n```";
  await assert.rejects(runFigcraft(node({ action: "ai" }), { input: twice, projectPath: root, cli: FAKE, ask: fakeAi(calls) }), /두 번 쓰였습니다/);
  assert.equal(calls.length, 0);
  // 계획서가 [hero]를 가리키는데 받지 못하면 경고만 남기고 배치한다.
  const partial = await runFigcraft(node({ action: "ai" }), { input: `화면: 홈\n위: [hero] 배경\n로고는 assets/logo.png`, projectPath: root, cli: FAKE, ask: fakeAi(calls) });
  assert.deepEqual(partial.record.warnings, ["계획서가 가리키는 이미지 [hero]를 받지 못했습니다."]);
});

test("figcraft ai: 세션 → AI 배치 → 내보내기로 이어 실행하고 기록에서 이어서 고친다", { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-figcraft-ai-hub-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(path.join(projectPath, "assets"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, "assets", "logo.png"), PNG);
  fs.writeFileSync(path.join(projectPath, "assets", "icon.svg"), "<svg/>");
  const hub = createHub({ port: 0, dataDir: path.join(root, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "p", path: projectPath }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} }, figcraftAsk: fakeAi() } });
  // 계획서를 쓴 세션(답변이 끝난 상태)
  hub.store.add({ id: "planner", title: "계획서", agent: "codex", permission: "workspace-write", projectPath, projectName: "p", cwd: projectPath, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [{ seq: 0, kind: "user", text: "로그인 화면 계획서 써 줘" }, { seq: 1, kind: "text", text: PLAN }, { seq: 2, kind: "result", text: "완료" }] });
  await hub.start();
  t.after(async () => { await hub.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  await api("PUT", "figcraft", { cliPath: FAKE });
  const layout = await api("POST", "commands", { kind: "figcraft", projectPath, action: "ai" });
  const pdf = await api("POST", "commands", { kind: "figcraft", projectPath, action: "export", format: "pdf" });
  assert.equal(layout.title, "FigCraft AI 배치");
  const toLayout = await api("POST", "links", { from: "planner", to: layout.id, when: "success", enabled: true });
  await api("POST", "links", { from: layout.id, to: pdf.id, when: "success", enabled: true });
  // 세션 → 배치 연결을 지금 넘기기로 실행한다(세션의 마지막 답변 = 계획서).
  await api("POST", `links/${toLayout.id}/run`);
  const list = async () => (await api("GET", `commands?path=${encodeURIComponent(projectPath)}`)).commands;
  const wait = async (id, count) => {
    const end = Date.now() + 20000;
    for (;;) {
      const item = (await list()).find((command) => command.id === id);
      if ((item.history ?? []).length >= count && item.state !== "running") return item;
      if (Date.now() > end) throw new Error(JSON.stringify(item.lastRun));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const placed = await wait(layout.id, 1);
  assert.equal(placed.state, "success", JSON.stringify(placed.lastRun));
  assert.deepEqual(placed.history[0].resources.map((item) => item.role), ["logo", "icon"]);
  const exported = await wait(pdf.id, 1);
  assert.equal(exported.state, "success", JSON.stringify(exported.lastRun));
  assert.equal(exported.history[0].file, placed.history[0].file, "내보내기는 배치 결과 파일을 받는다");
  await assert.rejects(api("POST", `commands/${layout.id}/run`, { edit: { runId: "nope", request: "x" } }), { status: 404 });
  await api("POST", `commands/${layout.id}/run`, { edit: { runId: placed.history[0].runId, request: "로고 위로" } });
  const edited = await wait(layout.id, 2);
  assert.equal(edited.history[0].request, "로고 위로");
  assert.deepEqual(edited.history[0].resources.map((item) => item.role), ["logo", "icon"], "이어서 고쳐도 같은 리소스를 쓴다");
});

test("figcraft ai: 설치된 실제 figcraft-cli로 리소스 이미지를 배치하고 렌더한다", { timeout: 120000 }, async (t) => {
  const cli = new FigcraftSettings({ dataDir: os.tmpdir() }).cli();
  if (!cli) return t.skip("FigCraft가 설치되어 있지 않다");
  const { root } = project(t);
  const result = await runFigcraft(node({ action: "ai" }), { input: PLAN, projectPath: root, cli, ask: fakeAi() });
  assert.deepEqual(result.record.frames.map((frame) => frame.name), ["로그인1"]);
  assert.equal(fs.readFileSync(result.record.renders[0]).subarray(1, 4).toString(), "PNG", "AI가 본 화면은 실제 PNG다");
  assert.equal(fs.readFileSync(result.record.previews[0]).subarray(1, 4).toString(), "PNG");
});

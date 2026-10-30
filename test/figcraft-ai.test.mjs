// FigCraft AI 디자인. 실제 AI 대신, 프롬프트대로 `node fc.mjs`만 써서 보고·고치고·렌더하는 가짜 AI로 시험한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkFigcraftNode, runFigcraft, FigcraftSettings } from "../server/figcraft.mjs";
import { oneShotArgs } from "../server/one-shot.mjs";
import { createHub } from "../server/bootstrap.mjs";

const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-fake-figcraft-ai-"));
const FAKE = path.join(FAKE_DIR, "fake-figcraft-cli.mjs");
fs.copyFileSync(fileURLToPath(new URL("./fixtures/fake-figcraft-cli.mjs.txt", import.meta.url)), FAKE);
test.after(() => fs.rmSync(FAKE_DIR, { recursive: true, force: true }));

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-figcraft-ai-"));
  const log = path.join(root, "calls.jsonl");
  const before = process.env.FAKE_FIGCRAFT_LOG;
  process.env.FAKE_FIGCRAFT_LOG = log;
  t.after(() => { if (before === undefined) delete process.env.FAKE_FIGCRAFT_LOG; else process.env.FAKE_FIGCRAFT_LOG = before; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, log };
}
const node = (fields) => ({ id: "n1", ...checkFigcraftNode(fields) });

// 가짜 AI: 작업 폴더에서 `node fc.mjs`만 써서 구조를 보고 → 프레임을 더하고 → 렌더한다.
function fakeAi(calls = []) {
  return async (options) => {
    calls.push(options);
    const { cwd } = options;
    const fc = (...args) => spawnSync(process.execPath, ["fc.mjs", ...args], { cwd, encoding: "utf8" });
    const info = fc("info", "design.figcraft", "--json");
    if (info.status !== 0) throw new Error(`info 실패: ${info.stderr}`);
    const step = calls.length;
    fs.writeFileSync(path.join(cwd, `edit-${step}.json`), JSON.stringify([{ command: "frame.create", params: { name: `화면${step}`, x: step * 240, y: 0, width: 200, height: 120 } },
      { command: "node.create", params: { type: "text", x: 10, y: 10, text: options.prompt.includes("버튼") ? "버튼" : "제목" } }]));
    const edit = fc("run", `edit-${step}.json`, "--in", "design.figcraft", "--out", "design.figcraft");
    if (edit.status !== 0) throw new Error(`run 실패: ${edit.stdout}${edit.stderr}`);
    const shot = fc("render", "design.figcraft", "-o", `renders/round-${step}.png`);
    if (shot.status !== 0) throw new Error(`render 실패: ${shot.stderr}`);
    return `화면${step}을 만들고 렌더해서 확인했습니다.`;
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

test("figcraft ai: AI가 fc.mjs로 고치고 렌더해 본 결과를 기록하고, 이어서 고치기는 그 결과 파일에서 시작한다", async (t) => {
  const { root, log } = project(t);
  const calls = [];
  const settings = node({ action: "ai", prompt: "{{input}}", maxRounds: 2, agent: "codex" });
  const first = await runFigcraft(settings, { input: "모바일 로그인 화면", render: (template) => template.replace("{{input}}", "모바일 로그인 화면"), projectPath: root, cli: FAKE, ask: fakeAi(calls) });
  const record = first.record;
  assert.equal(calls[0].agent, "codex");
  assert.deepEqual(calls[0].work, { commands: ["node fc.mjs"] });
  assert.equal(calls[0].cwd, record.outputDir);
  assert.match(calls[0].prompt, /요청:\n모바일 로그인 화면/);
  assert.match(calls[0].prompt, /node fc\.mjs render design\.figcraft -o renders\/round-1\.png/);
  assert.match(calls[0].prompt, /최대 2번/);
  assert.match(calls[0].prompt, /MCP나 다른 프로그램은 쓰지 않는다/);
  assert.equal(record.summary, "화면1을 만들고 렌더해서 확인했습니다.");
  assert.equal(record.rounds, 1);
  assert.deepEqual(record.renders.map((file) => path.basename(file)), ["round-1.png"]);
  assert.deepEqual(record.frames.map((frame) => frame.name), ["화면1"]);
  assert.equal(record.previews.length, 1);
  assert.match(first.text, /AI 디자인[\s\S]*화면1을 만들고/);
  // fc.mjs는 허용한 명령만 실행하고, 쓰기를 실행 폴더로 제한하고, 화면 확인 횟수를 넘기면 거절한다.
  const fc = (...args) => spawnSync(process.execPath, ["fc.mjs", ...args], { cwd: record.outputDir, encoding: "utf8" });
  assert.equal(fc("plugin", "publish", "x").status, 2);
  assert.equal(fc("render", "design.figcraft", "-o", "renders/round-2.png").status, 0);
  const over = fc("render", "design.figcraft", "-o", "renders/round-3.png");
  assert.equal(over.status, 3);
  assert.match(over.stderr, /최대 2번/);
  const runs = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((call) => call.args[0] === "run" && call.args[1].startsWith("edit-"));
  assert.equal(runs[0].args[runs[0].args.indexOf("--automation-write-root") + 1], record.outputDir);
  // 이어서 고치기: 앞 결과를 복사한 새 실행 폴더에서 새 요청을 적용한다.
  const second = await runFigcraft(settings, { input: "", projectPath: root, cli: FAKE, ask: fakeAi(calls), edit: { file: record.file, request: "버튼을 더 크게" } });
  assert.match(calls[1].prompt, /요청:\n버튼을 더 크게/);
  assert.match(calls[1].prompt, /design\.figcraft를 복사한 파일이다/);
  assert.equal(second.record.base, record.file);
  assert.deepEqual(second.record.frames.map((frame) => frame.name), ["화면1", "화면2"], "앞 결과 위에 고친다");
  assert.notEqual(second.record.file, record.file, "원래 결과는 그대로 둔다");
  await assert.rejects(runFigcraft(node({ action: "ai", prompt: "{{input}}" }), { input: "", render: () => "", projectPath: root, cli: FAKE, ask: fakeAi() }), /디자인 요청을 적으세요/);
});

test("figcraft ai: 그래프 노드 실행과 기록에서 이어서 고치기", { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-figcraft-ai-hub-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const hub = createHub({ port: 0, dataDir: path.join(root, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "p", path: projectPath }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} }, figcraftAsk: fakeAi() } });
  await hub.start();
  t.after(async () => { await hub.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  await api("PUT", "figcraft", { cliPath: FAKE });
  const design = await api("POST", "commands", { kind: "figcraft", projectPath, action: "ai", prompt: "대시보드 카드" });
  assert.equal(design.title, "FigCraft AI 디자인");
  assert.equal(design.timeoutSec, 900);
  const wait = async (count) => {
    const end = Date.now() + 20000;
    for (;;) {
      const item = (await api("GET", `commands?path=${encodeURIComponent(projectPath)}`)).commands.find((command) => command.id === design.id);
      if ((item.history ?? []).length >= count && item.state !== "running") return item;
      if (Date.now() > end) throw new Error(JSON.stringify(item.lastRun));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  await api("POST", `commands/${design.id}/run`, {});
  const done = await wait(1);
  assert.equal(done.state, "success", JSON.stringify(done.lastRun));
  assert.equal(done.history[0].summary, "화면1을 만들고 렌더해서 확인했습니다.");
  await assert.rejects(api("POST", `commands/${design.id}/run`, { edit: { runId: "nope", request: "x" } }), { status: 404 });
  await assert.rejects(api("POST", `commands/${design.id}/run`, { edit: { runId: done.history[0].runId, request: " " } }), { status: 400 });
  await api("POST", `commands/${design.id}/run`, { edit: { runId: done.history[0].runId, request: "버튼 추가" } });
  const edited = await wait(2);
  assert.equal(edited.history[0].request, "버튼 추가");
  assert.equal(edited.history[0].base, done.history[0].file);
  assert.equal(edited.history[0].frames.length, 2);
});

test("figcraft ai: 설치된 실제 figcraft-cli로 fc.mjs 보기·고치기·렌더", { timeout: 120000 }, async (t) => {
  const cli = new FigcraftSettings({ dataDir: os.tmpdir() }).cli();
  if (!cli) return t.skip("FigCraft가 설치되어 있지 않다");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-figcraft-ai-real-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runFigcraft(node({ action: "ai", prompt: "카드 하나" }), { projectPath: root, cli, ask: fakeAi() });
  assert.deepEqual(result.record.frames.map((frame) => frame.name), ["화면1"]);
  assert.equal(fs.readFileSync(result.record.renders[0]).subarray(1, 4).toString(), "PNG", "AI가 본 화면은 실제 PNG다");
  assert.equal(fs.readFileSync(result.record.previews[0]).subarray(1, 4).toString(), "PNG");
});

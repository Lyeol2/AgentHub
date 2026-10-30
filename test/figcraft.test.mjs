// FigCraft 노드. 가짜 figcraft-cli로 규칙을, 이 PC에 설치된 실제 CLI로 결과 형식을 시험한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFigcraftNode, runFigcraft, parseScript, parseResult, FigcraftSettings, checkFigcraft, listFigcraftCommands, figcraftPreview } from "../server/figcraft.mjs";
import { createHub } from "../server/bootstrap.mjs";

const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-fake-figcraft-"));
const FAKE = path.join(FAKE_DIR, "fake-figcraft-cli.mjs");
fs.copyFileSync(fileURLToPath(new URL("./fixtures/fake-figcraft-cli.mjs.txt", import.meta.url)), FAKE);
test.after(() => fs.rmSync(FAKE_DIR, { recursive: true, force: true }));

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-figcraft-"));
  const log = path.join(root, "calls.jsonl");
  const before = process.env.FAKE_FIGCRAFT_LOG;
  process.env.FAKE_FIGCRAFT_LOG = log;
  t.after(() => { if (before === undefined) delete process.env.FAKE_FIGCRAFT_LOG; else process.env.FAKE_FIGCRAFT_LOG = before; fs.rmSync(root, { recursive: true, force: true }); });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { root, calls };
}
const node = (fields) => ({ id: "n1", ...checkFigcraftNode(fields) });
const SCRIPT = JSON.stringify([{ command: "frame.create", params: { name: "로그인" } }, { command: "frame.create", params: { name: "가입" } }]);

test("figcraft: 노드 설정과 스크립트 읽기", () => {
  assert.equal(checkFigcraftNode({}).title, "FigCraft 실행");
  assert.equal(checkFigcraftNode({ action: "export" }).inputFile, "{{input}}");
  assert.throws(() => checkFigcraftNode({ format: "gif" }), /PNG·JPG·WebP·SVG·PDF/);
  assert.throws(() => checkFigcraftNode({ scale: 9 }), /0\.1~8/);
  assert.throws(() => checkFigcraftNode({ outputDir: "../x" }), /프로젝트 안/);
  assert.equal(parseScript(SCRIPT).length, 2);
  assert.equal(parseScript('{"commands": [{"command": "a.b"}]}').length, 1);
  assert.equal(parseScript('{"command": "a.b"}\n{"command": "c.d"}').length, 2, "JSON 줄");
  assert.equal(parseScript("디자인 명령입니다.\n```json\n" + SCRIPT + "\n```\n끝").length, 2, "AI 답변 속 json 블록");
  assert.throws(() => parseScript("그냥 글"), /명령 스크립트를 찾지 못했습니다/);
});

test("figcraft: 디자인 만들기는 스크립트를 실행하고 프레임마다 PNG 미리보기를 만들며, 쓰기 폴더를 실행 폴더로 제한한다", async (t) => {
  const { root, calls } = project(t);
  const ai = "로그인 화면입니다.\n```json\n" + SCRIPT + "\n```";
  const result = await runFigcraft(node({ action: "run" }), { input: ai, render: (template) => template.replace("{{input}}", ai), projectPath: root, cli: FAKE });
  const record = result.record;
  assert.ok(record.file.endsWith(`${path.sep}design.figcraft`));
  assert.deepEqual(record.previews.map((file) => path.basename(file)), ["로그인.png", "가입.png"]);
  assert.deepEqual(record.frames.map((frame) => frame.name), ["로그인", "가입"]);
  assert.equal(record.steps, 2);
  const run = calls().find((call) => call.args[0] === "run");
  assert.equal(run.args[run.args.indexOf("--automation-write-root") + 1], record.outputDir);
  assert.equal(run.args[run.args.indexOf("--automation-read-root") + 1], root);
  assert.ok(!run.args.includes("--in"), "파일을 정하지 않으면 새 문서로 시작한다");
  assert.equal(JSON.parse(fs.readFileSync(path.join(record.outputDir, "script.json"), "utf8")).length, 2, "실행한 스크립트를 남긴다");
  const parsed = parseResult(result.text);
  assert.equal(parsed.file, record.file);
  assert.equal(parsed.previews.length, 2);
});

test("figcraft: 실패한 명령은 몇 번째 명령인지 알리고, 내보내기는 앞 노드의 결과 파일을 받아 형식·레이어대로 쓴다", async (t) => {
  const { root, calls } = project(t);
  const failed = await runFigcraft(node({ script: '[{"command":"frame.create"},{"command":"nope"}]' }), { projectPath: root, cli: FAKE }).then(() => null, (error) => error);
  assert.match(failed.message, /2번째 명령\(nope\)이 실패했습니다: unknown command `nope` · 스크립트의 변경은 되돌렸습니다/);
  assert.equal(failed.record.ok, false);
  const made = await runFigcraft(node({ script: SCRIPT }), { projectPath: root, cli: FAKE });
  const exported = await runFigcraft({ id: "n2", ...checkFigcraftNode({ action: "export", format: "pdf", scale: 2 }) }, { input: made.text, render: (template) => template.replace("{{input}}", made.text), projectPath: root, cli: FAKE });
  assert.deepEqual(exported.record.exports.map((file) => path.basename(file)), ["로그인.pdf", "가입.pdf"]);
  assert.equal(exported.record.file, made.record.file);
  assert.equal(exported.record.previews.length, 2, "PDF로 내보내도 PNG 미리보기를 만든다");
  const exportCall = calls().filter((call) => call.args[0] === "export").at(-2);
  assert.deepEqual([exportCall.args[exportCall.args.indexOf("--format") + 1], exportCall.args[exportCall.args.indexOf("--scale") + 1]], ["pdf", "2"]);
  const one = await runFigcraft({ id: "n3", ...checkFigcraftNode({ action: "export", format: "png", target: "가입" }) }, { input: made.text, render: () => "", projectPath: root, cli: FAKE });
  assert.deepEqual(one.record.exports.map((file) => path.basename(file)), ["가입.png"]);
  assert.deepEqual(one.record.previews, one.record.exports, "PNG로 내보내면 그 파일이 미리보기다");
  await assert.rejects(runFigcraft({ id: "n4", ...checkFigcraftNode({ action: "export" }) }, { input: "", render: () => "", projectPath: root, cli: FAKE }), /내보낼 디자인 파일을 정하세요/);
  await assert.rejects(runFigcraft(node({ script: SCRIPT }), { projectPath: root, cli: null }), /figcraft-cli\)를 찾지 못했습니다/);
});

test("figcraft: 설정은 CLI 경로를 저장하고 연결 확인·명령 찾기·미리보기 그리기를 한다", async (t) => {
  const { root } = project(t);
  const settings = new FigcraftSettings({ dataDir: root, env: { PATH: "" }, platform: "linux" });
  assert.equal(settings.view().found, false);
  assert.throws(() => settings.set({ cliPath: path.join(root, "nope") }), /파일이 없습니다/);
  assert.equal(settings.set({ cliPath: FAKE }).found, true);
  assert.equal(await checkFigcraft(settings), "figcraft-cli 0.10.0-fake");
  assert.deepEqual((await listFigcraftCommands(settings, "frame")).map((command) => command.id), ["frame.create"]);
  const design = path.join(root, "a.figcraft");
  fs.writeFileSync(design, JSON.stringify({ frames: ["A"] }));
  const png = await figcraftPreview(settings, design);
  assert.ok(fs.existsSync(png));
  assert.equal(await figcraftPreview(settings, design), png, "바뀌지 않은 파일은 다시 그리지 않는다");
});

test("figcraft: 그래프에서 디자인 만들기 → 내보내기로 이어 실행하고, 결과 파일·대화 속 .figcraft 미리보기를 연다", { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-figcraft-hub-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const hub = createHub({ port: 0, dataDir: path.join(root, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "p", path: projectPath }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  hub.store.add({ id: "s1", title: "디자인", agent: "codex", permission: "workspace-write", projectPath, projectName: "p", cwd: projectPath, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] });
  await hub.start();
  // 서버를 먼저 끄고 폴더를 지운다(열린 파일이 남아 있으면 Windows가 지우지 못한다).
  t.after(async () => { await hub.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  const base = `http://127.0.0.1:${hub.port}`;
  const api = async (method, route, body) => {
    const response = await fetch(`${base}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  await api("PUT", "figcraft", { cliPath: FAKE });
  assert.deepEqual(await api("POST", "figcraft/check"), { ok: true, message: "figcraft-cli 0.10.0-fake" });
  const make = await api("POST", "commands", { kind: "figcraft", projectPath, action: "run", script: SCRIPT });
  const pdf = await api("POST", "commands", { kind: "figcraft", projectPath, action: "export", format: "pdf" });
  await api("POST", "links", { from: make.id, to: pdf.id, when: "success", enabled: true });
  await api("POST", `commands/${make.id}/run`, {});
  const list = async () => (await api("GET", `commands?path=${encodeURIComponent(projectPath)}`)).commands;
  const end = Date.now() + 20000;
  let items;
  while (Date.now() < end) { items = await list(); if (items.find((item) => item.id === pdf.id)?.state === "success") break; await new Promise((resolve) => setTimeout(resolve, 30)); }
  const first = items.find((item) => item.id === make.id), second = items.find((item) => item.id === pdf.id);
  assert.equal(first.state, "success", JSON.stringify(first.lastRun));
  assert.equal(second.state, "success", JSON.stringify(second.lastRun));
  assert.equal(second.history[0].exports.length, 2);
  const preview = await fetch(`${base}/api/commands/${make.id}/gen3d/file?path=${encodeURIComponent(first.history[0].previews[0])}`);
  assert.equal(preview.headers.get("content-type"), "image/png");
  await api("POST", `commands/${make.id}/gen3d/forward`, { runId: first.history[0].runId });
  // 다시 넘긴 결과로 내보내기 노드가 한 번 더 실행된다(디자인 만들기는 다시 실행하지 않는다).
  const again = Date.now() + 20000;
  while (Date.now() < again && (await list()).find((item) => item.id === pdf.id).history.length < 2) await new Promise((resolve) => setTimeout(resolve, 30));
  const latest = await list();
  assert.equal(latest.find((item) => item.id === pdf.id).history.length, 2);
  assert.equal(latest.find((item) => item.id === make.id).history.length, 1);
  // 대화에서 AI가 언급한 .figcraft 파일은 PNG로 그려 보여 준다.
  const design = first.history[0].file;
  hub.store.get("s1").events.push({ kind: "text", text: `[로그인 화면](${design.replaceAll("\\", "/")})` });
  assert.equal((await api("GET", `sessions/s1/artifact?path=${encodeURIComponent(design)}`)).kind, "figcraft");
  const drawn = await fetch(`${base}/api/sessions/s1/artifact/figcraft-preview?path=${encodeURIComponent(design)}`);
  assert.equal(drawn.status, 200);
  assert.equal(drawn.headers.get("content-type"), "image/png");
  const text = path.join(projectPath, "note.txt");
  fs.writeFileSync(text, "x");
  assert.equal((await fetch(`${base}/api/sessions/s1/artifact/figcraft-preview?path=${encodeURIComponent(text)}`)).status, 415);
});

// 설치된 실제 figcraft-cli로 만든 결과(크레딧·네트워크 없이 이 PC에서만 실행)
test("figcraft: 설치된 실제 figcraft-cli로 디자인 만들기와 SVG 내보내기", { timeout: 120000 }, async (t) => {
  const cli = new FigcraftSettings({ dataDir: os.tmpdir() }).cli();
  if (!cli) return t.skip("FigCraft가 설치되어 있지 않다");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-figcraft-real-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const made = await runFigcraft(node({ script: JSON.stringify([{ command: "frame.create", params: { name: "카드", x: 0, y: 0, width: 320, height: 200 } }, { command: "node.create", params: { type: "text", x: 20, y: 20, text: "AgentHub" } }]) }), { projectPath: root, cli });
  assert.deepEqual(made.record.frames.map((frame) => frame.name), ["카드"]);
  assert.equal(fs.readFileSync(made.record.previews[0]).subarray(1, 4).toString(), "PNG");
  const svg = await runFigcraft({ id: "n2", ...checkFigcraftNode({ action: "export", format: "svg" }) }, { input: made.text, render: (template) => template.replace("{{input}}", made.text), projectPath: root, cli });
  assert.match(fs.readFileSync(svg.record.exports[0], "utf8"), /<svg/);
});

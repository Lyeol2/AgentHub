// FigCraft 노드. 창 없는 figcraft-cli로 디자인 명령 스크립트를 실행하거나(run) 디자인 파일을 내보낸다(export).
// 결과는 프로젝트 출력 폴더에 두고, 맨 위 프레임마다 PNG 미리보기를 만들어 노드 기록과 미리보기 창에서 본다.
// CLI가 쓸 수 있는 폴더는 이번 실행 폴더로 제한한다(--automation-write-root).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export const FIGCRAFT_FORMATS = ["png", "jpg", "webp", "svg", "pdf"];
const DESIGN_EXT = new Set([".figcraft", ".fig", ".json", ".svg"]);
const PREVIEW_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TAG = "agenthubFigcraft";
const fail = (message) => { throw new Error(message); };
const str = (value, label, max = 2000) => {
  const result = String(value ?? "");
  if (result.length > max) fail(`${label}은 ${max}자까지 입력할 수 있습니다.`);
  return result;
};

// ── CLI 찾기·설정 ──────────────────────────────────────────────
// 설정 파일(data/figcraft.json)의 cliPath → FIGCRAFT_CLI → 기본 설치 위치 → PATH 순으로 찾는다.
export class FigcraftSettings {
  constructor({ dataDir, env = process.env, platform = process.platform }) {
    this.file = path.join(dataDir, "figcraft.json");
    this.env = env;
    this.platform = platform;
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")) ?? {}; } catch { return {}; }
  }

  cli() {
    const saved = this.read().cliPath;
    const candidates = [saved, this.env.FIGCRAFT_CLI,
      ...(this.platform === "win32" ? [path.join(this.env.ProgramFiles ?? "C:\\Program Files", "FigCraft", "figcraft-cli.exe")] : ["/Applications/FigCraft.app/Contents/MacOS/figcraft-cli", "/usr/local/bin/figcraft-cli"]),
      ...String(this.env.PATH ?? this.env.Path ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, this.platform === "win32" ? "figcraft-cli.exe" : "figcraft-cli"))];
    return candidates.find((file) => file && fs.existsSync(file)) ?? null;
  }

  // 앱(figcraft.exe)은 CLI와 같은 폴더에 있다.
  app() {
    const cli = this.cli();
    if (!cli) return null;
    const app = path.join(path.dirname(cli), this.platform === "win32" ? "figcraft.exe" : "figcraft");
    return fs.existsSync(app) ? app : null;
  }

  view() {
    const cli = this.cli();
    return { cliPath: this.read().cliPath ?? "", found: !!cli, cli, app: this.app() };
  }

  set({ cliPath } = {}) {
    const value = String(cliPath ?? "").trim();
    if (value.length > 1000 || /[\r\n]/.test(value)) fail("CLI 경로가 올바르지 않습니다.");
    if (value && !fs.existsSync(value)) fail(`CLI 경로에 파일이 없습니다: ${value}`);
    const next = { ...this.read() };
    if (value) next.cliPath = value; else delete next.cliPath;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return this.view();
  }
}

const missing = () => fail("FigCraft CLI(figcraft-cli)를 찾지 못했습니다. FigCraft를 설치하거나 설정 → FigCraft에서 figcraft-cli 경로를 정하세요.");

// CLI 한 번 실행. 실행 파일이 .js·.mjs면 node로 실행한다(시험용 가짜 CLI).
export function runFigcraftCli(cli, args, { signal, timeoutMs = 300_000, cwd, spawnProcess = spawn } = {}) {
  if (!cli) missing();
  const [command, prefix] = /\.(?:c|m)?js$/i.test(cli) ? [process.execPath, [cli]] : [cli, []];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, [...prefix, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
    let stdout = "", stderr = "";
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`FigCraft CLI를 실행하지 못했습니다: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(new Error("중지했습니다."));
      resolve({ code, stdout, stderr });
    });
  });
}

// ── 노드 설정 ─────────────────────────────────────────────────
export function checkFigcraftNode(body, current = {}) {
  const action = body.action ?? current.action ?? "run";
  if (!["ai", "run", "export"].includes(action)) fail("FigCraft 노드는 AI 디자인·명령 실행·내보내기 중 하나입니다.");
  const format = body.format ?? current.format ?? "png";
  if (!FIGCRAFT_FORMATS.includes(format)) fail("내보낼 형식은 PNG·JPG·WebP·SVG·PDF 중 하나입니다.");
  const scale = Number(body.scale ?? current.scale ?? 1);
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 8) fail("배율은 0.1~8 사이로 입력하세요.");
  const timeoutSec = Number(body.timeoutSec ?? current.timeoutSec ?? (action === "ai" ? 900 : 300));
  if (!Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > 3600) fail("최대 실행 시간은 10~3600초 사이 정수로 입력하세요.");
  const agent = body.agent ?? current.agent ?? "";
  if (!["", "claude", "codex"].includes(agent)) fail("AI는 Claude 또는 Codex입니다.");
  const maxRounds = Number(body.maxRounds ?? current.maxRounds ?? 5);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) fail("화면 확인 횟수는 1~20 사이 정수로 입력하세요.");
  const outputDir = str(body.outputDir ?? current.outputDir ?? "output/figcraft", "출력 폴더", 300).trim().replaceAll("\\", "/") || "output/figcraft";
  if (path.posix.isAbsolute(outputDir) || path.win32.isAbsolute(outputDir) || outputDir.split("/").includes("..")) fail("출력 폴더는 프로젝트 안의 상대 경로로 입력하세요.");
  const builtinFonts = body.builtinFonts ?? current.builtinFonts ?? false;
  if (typeof builtinFonts !== "boolean") fail("내장 글꼴 설정이 올바르지 않습니다.");
  const title = str(body.title ?? current.title, "이름", 100).trim();
  return {
    kind: "figcraft", title: title || { ai: "FigCraft AI 디자인", run: "FigCraft 명령 실행", export: "FigCraft 내보내기" }[action], action,
    // AI 디자인: 요청 글, 맡길 AI, 모델, 화면 확인(렌더) 최대 횟수
    prompt: str(body.prompt ?? current.prompt ?? "{{input}}", "요청", 20_000), agent, model: str(body.model ?? current.model ?? "", "모델", 200).trim(), maxRounds,
    script: str(body.script ?? current.script ?? "{{input}}", "명령 스크립트", 200_000),
    inputFile: str(body.inputFile ?? current.inputFile ?? (action === "export" ? "{{input}}" : ""), "디자인 파일", 2000).trim(),
    format, scale, page: str(body.page ?? current.page ?? "", "페이지", 200).trim(), target: str(body.target ?? current.target ?? "", "레이어", 200).trim(),
    builtinFonts, outputDir, timeoutSec,
  };
}

// ── 입력 읽기 ─────────────────────────────────────────────────
// 명령 스크립트: JSON 배열, { commands: [...] }, JSON 줄, 또는 그런 JSON이 든 ```json 블록(AI 답변)
export function parseScript(text) {
  const source = String(text ?? "").trim();
  const asSteps = (value) => {
    const list = Array.isArray(value) ? value : Array.isArray(value?.commands) ? value.commands : value?.command ? [value] : null;
    return list?.length && list.every((step) => step && typeof step.command === "string") ? list : null;
  };
  const tryParse = (candidate) => {
    try { return asSteps(JSON.parse(candidate)); } catch { /* 줄 단위로 */ }
    const lines = candidate.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    try { return lines.length ? asSteps(lines.map((line) => JSON.parse(line))) : null; } catch { return null; }
  };
  const found = tryParse(source) ?? [...source.matchAll(/```(?:json|jsonl)?\s*\n([\s\S]*?)```/g)].map((match) => tryParse(match[1].trim())).find(Boolean);
  if (!found) fail("FigCraft 명령 스크립트를 찾지 못했습니다. [{\"command\": \"frame.create\", \"params\": {...}}] 형식의 JSON을 넘기세요.");
  if (found.length > 5000) fail("명령은 5000개까지 실행할 수 있습니다.");
  return found;
}

// 앞 노드가 넘긴 FigCraft 결과 정보
export function parseResult(text) {
  for (const match of [String(text ?? ""), ...[...String(text ?? "").matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((item) => item[1])]) {
    try {
      const value = JSON.parse(match.trim());
      if (value?.[TAG] === 1) return value;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

export function resultText(result) {
  const main = result.file ?? result.exports?.[0] ?? "";
  const title = { ai: "AI 디자인", run: "명령 실행", export: "내보내기" }[result.action] ?? result.action;
  return `FigCraft · ${title}${main ? `\n${main}` : ""}${result.summary ? `\n\n${result.summary}` : ""}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

// ── AI 디자인 ─────────────────────────────────────────────────
// AI(Claude·Codex)가 figcraft-cli로 구조를 보고 → 고치고 → 렌더한 PNG를 직접 보며 다듬는다. MCP 없이 CLI만 쓴다.
// AI는 실행 폴더에서 `node fc.mjs …`로만 FigCraft를 부른다. fc.mjs가 읽기·쓰기 폴더 제한과 화면 확인 횟수를 강제한다.
export const FIGCRAFT_SHIM = "fc.mjs";
const SHIM_COMMANDS = ["info", "export", "convert", "render", "run", "commands", "--version", "help", "--help"];

function writeShim(runDir, { cli, readRoots, maxRounds, builtinFonts }) {
  const config = { cli, readRoots, writeRoot: runDir, maxRounds, builtinFonts, allowed: SHIM_COMMANDS };
  fs.writeFileSync(path.join(runDir, FIGCRAFT_SHIM), `// AgentHub가 만든 FigCraft 작업 명령. figcraft-cli를 감싸 이 폴더 밖 쓰기와 화면 확인 횟수를 막는다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
const [command] = args;
if (!config.allowed.includes(command)) {
  console.error("이 작업에서는 " + config.allowed.filter((name) => !name.startsWith("-")).join(", ") + " 명령만 쓸 수 있다.");
  process.exit(2);
}
if (command === "render") {
  const counter = path.join(config.writeRoot, ".renders");
  const count = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  if (count > config.maxRounds) {
    console.error("화면 확인은 최대 " + config.maxRounds + "번이다. 더 렌더하지 말고 지금 결과로 마무리하라.");
    process.exit(3);
  }
  fs.writeFileSync(counter, String(count));
  const out = args[args.indexOf("-o") + 1];
  if (out) fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
}
const confined = ["info", "export", "convert", "render", "run"].includes(command);
const extra = confined ? [...config.readRoots.flatMap((dir) => ["--automation-read-root", dir]), "--automation-write-root", config.writeRoot, ...(config.builtinFonts ? ["--no-system-fonts"] : [])] : [];
const [file, prefix] = /\.(?:c|m)?js$/i.test(config.cli) ? [process.execPath, [config.cli]] : [config.cli, []];
const result = spawnSync(file, [...prefix, ...args, ...extra], { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
}

export function aiPrompt({ request, rounds, fresh, base }) {
  return `[FigCraft 디자인 작업]
요청:
${request}

현재 폴더가 작업 폴더다. 디자인 파일은 design.figcraft 하나다${fresh ? "(빈 문서로 시작한다)" : base ? `(${base}를 복사한 파일이다. 이 파일을 고친다)` : ""}.
FigCraft는 반드시 \`node ${FIGCRAFT_SHIM} …\`로만 실행한다. figcraft-cli를 감싼 명령이며 이 폴더 밖에는 쓰지 못한다. MCP나 다른 프로그램은 쓰지 않는다.

- 명령 찾기: node ${FIGCRAFT_SHIM} commands --filter <말>   (명령 id와 params 형식이 나온다. 예: frame, text, fill, autolayout)
- 구조 보기(파일은 바뀌지 않는다): [{"command": "page.list", "params": {}}, {"command": "node.get", "params": {"id": 2}}]를 query.json에 쓰고
  node ${FIGCRAFT_SHIM} run query.json --in design.figcraft      (node.get은 자식 레이어·위치·크기·글자를 모두 돌려준다)
- 맨 위 프레임 목록: node ${FIGCRAFT_SHIM} info design.figcraft --json
- 고치기: [{"command": "...", "params": {...}}, …]를 edit-1.json, edit-2.json …에 쓰고
  node ${FIGCRAFT_SHIM} run edit-1.json --in design.figcraft --out design.figcraft
  (한 명령이라도 실패하면 그 스크립트의 변경은 모두 되돌려진다. 결과 줄의 error를 읽고 고쳐 다시 실행한다)
- 눈으로 확인: node ${FIGCRAFT_SHIM} render design.figcraft -o renders/round-1.png 를 실행한 뒤 그 PNG 파일을 열어 직접 본다. 최대 ${rounds}번.

작업 순서: 구조를 확인하고 → 고치고 → 렌더해서 보고 → 겹침·잘림·정렬·간격·글자 넘침·대비를 고치고 → 다시 본다.
만족하거나 확인 횟수를 다 쓰면 멈춘다. design.figcraft 말고 다른 디자인 파일을 만들지 않는다.
마지막 답에는 무엇을 만들거나 고쳤는지, 렌더해서 무엇을 확인하고 고쳤는지를 3~6줄로 요약한다.`;
}

async function runAiDesign(node, { render, input, upstream, edit, pickFile, projectPath, runDir, cli, ask, signal, timeoutMs, record }) {
  if (!ask) fail("AI 실행기를 준비하지 못했습니다.");
  // 요청: "이어서 고치기"의 요청 → 노드의 요청 글(앞 노드의 글로 채움)
  const request = (edit?.request ?? render(node.prompt || "{{input}}")).trim();
  if (!request || parseResult(request)) fail("AI에게 맡길 디자인 요청을 적으세요.");
  // 시작 파일: 이어서 고치기 → 노드에 정한 파일 → 앞 노드의 FigCraft 결과 → 빈 문서
  const base = edit?.file ?? pickFile();
  const design = path.join(runDir, "design.figcraft");
  if (base && path.extname(base).toLowerCase() === ".figcraft") fs.copyFileSync(base, design);
  else {
    const empty = path.join(runDir, "empty.json");
    fs.writeFileSync(empty, "[]");
    const start = await runFigcraftCli(cli, ["run", empty, ...(base ? ["--in", base] : []), "--out", design, "--automation-read-root", projectPath,
      ...(base ? ["--automation-read-root", path.dirname(base)] : []), "--automation-write-root", runDir], { signal, timeoutMs: 120_000, cwd: runDir });
    fs.rmSync(empty, { force: true });
    if (start.code !== 0 || !fs.existsSync(design)) fail(`디자인 파일을 준비하지 못했습니다: ${start.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ""}`);
  }
  writeShim(runDir, { cli, readRoots: [...new Set([projectPath, runDir, ...(base ? [path.dirname(base)] : [])])], maxRounds: node.maxRounds ?? 5, builtinFonts: !!node.builtinFonts });
  fs.mkdirSync(path.join(runDir, "renders"), { recursive: true });
  record.request = request.slice(0, 2000);
  record.base = base ?? null;
  const summary = await ask({ prompt: aiPrompt({ request, rounds: node.maxRounds ?? 5, fresh: !base, base: base && path.basename(base) }), cwd: runDir,
    agent: node.agent || undefined, model: node.model || undefined, timeoutMs, signal, label: "FigCraft AI 디자인", work: { commands: [`node ${FIGCRAFT_SHIM}`] } });
  record.summary = String(summary ?? "").trim().slice(0, 4000);
  record.renders = filesIn(path.join(runDir, "renders")).filter((file) => PREVIEW_EXT.has(path.extname(file).toLowerCase())).sort();
  record.rounds = Number(fs.existsSync(path.join(runDir, ".renders")) ? fs.readFileSync(path.join(runDir, ".renders"), "utf8") : 0) || 0;
  record.agent = node.agent || null;
  if (!fs.existsSync(design)) fail("AI가 디자인 파일을 지웠습니다.");
  return design;
}

// CLI가 쓴 파일 목록(한 줄에 하나, 실행 폴더 기준 또는 절대 경로)
const listed = (stdout, dir) => stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  .map((line) => path.resolve(dir, line)).filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
const filesIn = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)).filter((file) => fs.statSync(file).isFile()) : [];

// ── 실행 ──────────────────────────────────────────────────────
// ask: AI 작업 모드 실행(one-shot의 askOnce). edit: { file, request } 결과 기록에서 "이어서 고치기"
export async function runFigcraft(node, { input = "", render = (template) => template, projectPath, cli, signal, now = Date.now, runId = String(now()), ask = null, edit = null }) {
  if (!cli) missing();
  const outputRoot = path.resolve(projectPath, node.outputDir || "output/figcraft");
  if (path.relative(projectPath, outputRoot).startsWith("..")) fail("출력 폴더는 프로젝트 안이어야 합니다.");
  const runDir = path.join(outputRoot, `${new Date(now()).toISOString().replace(/[:.]/g, "-").slice(0, 23)}-${node.id ?? "node"}`);
  fs.mkdirSync(runDir, { recursive: true });
  const record = { runId, at: new Date(now()).toISOString(), action: node.action, outputDir: runDir, ok: false, file: null, previews: [], exports: [], frames: [], missingFonts: [], log: [] };
  const upstream = parseResult(input);
  const fonts = node.builtinFonts ? ["--no-system-fonts"] : [];
  const timeoutMs = (node.timeoutSec ?? 300) * 1000;
  // 입력 파일: 노드에 적은 경로(변수 사용 가능) → 앞 노드의 FigCraft 결과 파일
  const pickFile = () => {
    const written = render(node.inputFile || "").trim();
    const value = written && !parseResult(written) ? written : upstream?.file ?? upstream?.exports?.[0] ?? "";
    if (!value) return null;
    const file = path.resolve(projectPath, value);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`디자인 파일을 찾을 수 없습니다: ${file}`);
    if (!DESIGN_EXT.has(path.extname(file).toLowerCase()) && !PREVIEW_EXT.has(path.extname(file).toLowerCase())) fail("FigCraft로 열 수 없는 파일입니다(.figcraft·.fig·.json·.svg·이미지).");
    return file;
  };
  // 읽기는 프로젝트와 입력 파일 폴더, 쓰기는 이번 실행 폴더로 제한한다.
  const roots = (file) => [...new Set([projectPath, ...(file ? [path.dirname(file)] : [])])].flatMap((dir) => ["--automation-read-root", dir]).concat(["--automation-write-root", runDir]);
  const exec = async (args) => {
    const result = await runFigcraftCli(cli, args, { signal, timeoutMs, cwd: runDir });
    record.log.push({ args: args.filter((arg) => !arg.startsWith("--automation")).slice(0, 6), code: result.code });
    return result;
  };
  try {
    let design;
    if (node.action === "ai") {
      design = await runAiDesign(node, { render, input, upstream, edit, pickFile, projectPath, runDir, cli, ask, signal, timeoutMs, record });
      record.file = design;
    } else if (node.action === "run") {
      const steps = parseScript(render(node.script || "{{input}}"));
      const base = pickFile();
      const script = path.join(runDir, "script.json");
      fs.writeFileSync(script, JSON.stringify(steps, null, 2));
      design = path.join(runDir, "design.figcraft");
      const run = await exec(["run", script, ...(base ? ["--in", base] : []), "--out", design, ...fonts, ...roots(base)]);
      const results = run.stdout.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((item) => item && typeof item.step === "number");
      const failed = results.find((item) => item.ok === false);
      record.steps = results.length;
      if (failed || run.code !== 0 || !fs.existsSync(design)) {
        fail(failed ? `${failed.step + 1}번째 명령(${failed.command})이 실패했습니다: ${failed.error ?? "알 수 없는 오류"}${failed.rolledBack ? " · 스크립트의 변경은 되돌렸습니다." : ""}`
          : `FigCraft 실행 실패 (종료 코드 ${run.code}): ${run.stderr.trim().split(/\r?\n/).slice(-2).join(" ")}`);
      }
      record.file = design;
    } else {
      design = pickFile();
      if (!design) fail("내보낼 디자인 파일을 정하세요. 앞에 FigCraft 실행 노드를 연결하거나 파일 경로를 적습니다.");
      record.file = design;
      // 레이어 하나를 고르면 파일 하나, 아니면 맨 위 프레임마다 파일 하나를 폴더에 쓴다.
      const exportDir = path.join(runDir, "export");
      fs.mkdirSync(exportDir, { recursive: true });
      const target = node.target ? path.join(exportDir, `${node.target.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80) || "layer"}.${node.format}`) : exportDir;
      const out = await exec(["export", design, "-o", target, "--format", node.format, "--scale", String(node.scale ?? 1),
        ...(node.page ? ["--page", node.page] : []), ...(node.target ? ["--node", node.target] : []), ...fonts, ...roots(design)]);
      if (out.code !== 0) fail(`내보내기 실패 (종료 코드 ${out.code}): ${out.stderr.trim().split(/\r?\n/).slice(-2).join(" ")}`);
      record.exports = listed(out.stdout, runDir).length ? listed(out.stdout, runDir).filter((file) => file.startsWith(exportDir)) : filesIn(exportDir);
      if (!record.exports.length) fail("내보낸 파일이 없습니다. 페이지·레이어 이름을 확인하세요.");
    }
    // 미리보기: 맨 위 프레임마다 PNG. 프레임이 없으면 페이지 전체를 그린다.
    if (node.action === "export" && ["png", "jpg", "webp"].includes(node.format)) record.previews = record.exports.filter((file) => PREVIEW_EXT.has(path.extname(file).toLowerCase()));
    if (!record.previews.length) {
      const previewDir = path.join(runDir, "preview");
      const out = await exec(["export", design, "-o", previewDir, "--format", "png", "--scale", "1", ...(node.page ? ["--page", node.page] : []), ...fonts, ...roots(design)]);
      record.previews = out.code === 0 ? (listed(out.stdout, runDir).length ? listed(out.stdout, runDir) : filesIn(previewDir)) : [];
      if (!record.previews.length) {
        const page = path.join(previewDir, "page.png");
        fs.mkdirSync(previewDir, { recursive: true });
        const drawn = await exec(["render", design, "-o", page, ...(node.page ? ["--page", node.page] : []), ...fonts, ...roots(design)]);
        if (drawn.code === 0 && fs.existsSync(page)) record.previews = [page];
      }
    }
    // 프레임 목록과 빠진 글꼴
    const info = await exec(["info", design, "--json", ...roots(design)]).catch(() => null);
    try {
      const value = JSON.parse(info?.stdout ?? "");
      record.frames = (value.pages ?? []).flatMap((page) => (page.frames ?? []).map((frame) => ({ page: page.name, id: frame.id, name: frame.name, width: frame.width, height: frame.height })));
      record.missingFonts = value.missingFonts ?? [];
    } catch { /* 정보가 없어도 결과는 쓴다. */ }
    record.ok = true;
    const result = { [TAG]: 1, action: node.action, file: record.file, previews: record.previews, exports: record.exports, frames: record.frames, missingFonts: record.missingFonts,
      ...(record.summary ? { summary: record.summary } : {}) };
    return { ok: true, text: resultText(result), record };
  } catch (error) {
    record.error = error.message;
    error.record = record;
    throw error;
  }
}

// 설정의 "연결 확인"
export async function checkFigcraft(settings) {
  const cli = settings.cli();
  if (!cli) missing();
  const out = await runFigcraftCli(cli, ["--version"], { timeoutMs: 20000 });
  if (out.code !== 0) fail(`FigCraft CLI가 응답하지 않았습니다 (종료 코드 ${out.code}).`);
  return out.stdout.trim() || "FigCraft CLI";
}

// 명령 찾기(노드 설정 창의 도움말)
export async function listFigcraftCommands(settings, filter = "") {
  const out = await runFigcraftCli(settings.cli(), ["commands", "--json", ...(filter ? ["--filter", String(filter).slice(0, 100)] : [])], { timeoutMs: 20000 });
  try { return JSON.parse(out.stdout).slice(0, 200).map(({ id, label, params }) => ({ id, label, params })); }
  catch { fail("FigCraft 명령 목록을 읽지 못했습니다."); }
}

// FigCraft 앱으로 파일을 연다.
export function openInFigcraft(settings, file, { spawnProcess = spawn } = {}) {
  const app = settings.app();
  if (!app) fail("FigCraft 앱(figcraft.exe)을 찾지 못했습니다.");
  const child = spawnProcess(app, [file], { detached: true, stdio: "ignore" });
  child.unref?.();
  return { ok: true };
}

// 대화 속 .figcraft 파일 미리보기. 파일 경로와 수정 시각이 같으면 그린 PNG를 다시 쓴다.
const PREVIEW_CACHE = path.join(os.tmpdir(), "agenthub-figcraft-preview");
export async function figcraftPreview(settings, file) {
  const stat = fs.statSync(file);
  const key = createHash("sha256").update(`${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 24);
  const target = path.join(PREVIEW_CACHE, `${key}.png`);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(PREVIEW_CACHE, { recursive: true });
  const out = await runFigcraftCli(settings.cli(), ["render", file, "-o", target, "--automation-read-root", path.dirname(file), "--automation-write-root", PREVIEW_CACHE], { timeoutMs: 120_000 });
  if (out.code !== 0 || !fs.existsSync(target)) fail(`FigCraft 미리보기를 그리지 못했습니다: ${out.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ""}`);
  return target;
}

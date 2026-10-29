// Meshy 공식 CLI(meshy-cli)로 3D 생성 단계를 실행한다. API 키 대신 `meshy auth login`으로 저장한 계정을 쓴다.
// 단계마다 `meshy <리소스> create … --format json -o <폴더>`를 실행한다. create는 작업이 끝날 때까지 기다리고,
// 결과 파일을 폴더에 받은 뒤 meshy.cli/v1 봉투(JSON) 하나를 stdout에 쓴다. 진행 상황은 stderr에 줄로 나온다.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_BASE = "https://api.meshy.ai";
const MODEL_EXT = new Set(["glb", "fbx", "obj", "usdz", "stl", "3mf", "blend"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp"]);
const fail = (message) => { throw new Error(message); };

// 실행할 CLI를 찾는다. cliPath를 정했으면 그것을, 아니면 PATH의 meshy를 쓴다.
// npm 전역 설치(Windows의 meshy.cmd)는 셸을 거치지 않도록 그 옆의 meshy-cli/dist/index.js를 node로 직접 실행한다.
export function findMeshyCli(cliPath = "", { env = process.env, platform = process.platform } = {}) {
  const viaNode = (file) => ({ command: process.execPath, prefix: [file], path: file });
  if (cliPath) {
    if (!fs.existsSync(cliPath)) return null;
    return /\.(?:c|m)?js$/i.test(cliPath) ? viaNode(cliPath) : { command: cliPath, prefix: [], path: cliPath };
  }
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const entry = path.join(dir, "node_modules", "meshy-cli", "dist", "index.js");
    if (fs.existsSync(entry) && (fs.existsSync(path.join(dir, "meshy.cmd")) || fs.existsSync(path.join(dir, "meshy")))) return viaNode(entry);
    if (platform !== "win32") {
      const bin = path.join(dir, "meshy");
      if (fs.existsSync(bin)) {
        try { const real = fs.realpathSync(bin); return /\.(?:c|m)?js$/i.test(real) ? viaNode(real) : { command: bin, prefix: [], path: bin }; } catch { /* 다음 폴더 */ }
      }
    }
  }
  return null;
}

const missing = () => fail("Meshy CLI를 찾지 못했습니다. 터미널에서 npm install -g meshy-cli 로 설치하고 meshy auth login 으로 로그인하세요. 설정 → 3D 생성 도구에서 CLI 경로를 직접 정하거나 API 키 방식으로 바꿀 수도 있습니다.");

// CLI 한 번 실행. 봉투가 ok가 아니면 그 오류 문구로 실패한다. onLine: stderr 진행 줄
export function runMeshyCli(settings, args, { signal, onLine, timeoutMs = 0, spawnProcess = spawn } = {}) {
  const cli = findMeshyCli(settings.cliPath);
  if (!cli) missing();
  const base = (settings.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const urls = base === DEFAULT_BASE ? [] : ["--base-url-v1", `${base}/openapi/v1`, "--base-url-v2", `${base}/openapi/v2`];
  const env = { ...process.env, MESHY_CLI_NO_BROWSER: "1", MESHY_CLI_NO_UPDATE_NOTIFIER: "1", MESHY_CLI_CLIENT: "AgentHub",
    // 저장한 API 키가 있으면 그 키를 쓰고, 없으면 CLI에 로그인한 계정을 쓴다.
    ...(settings.apiKey ? { MESHY_API_KEY: settings.apiKey } : {}) };
  return new Promise((resolve, reject) => {
    const child = spawnProcess(cli.command, [...cli.prefix, ...args, "--format", "json", "--no-update-check", ...urls], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", partial = "";
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop, { once: true });
    const timer = timeoutMs ? setTimeout(stop, timeoutMs + 30_000) : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
      partial += chunk;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop();
      for (const line of lines) if (line.trim()) onLine?.(line.trim());
    });
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`Meshy CLI를 실행하지 못했습니다: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(new Error("중지했습니다."));
      let envelope = null;
      try { envelope = JSON.parse(stdout.trim()); } catch { /* 아래에서 알린다. */ }
      if (!envelope || envelope.schema_version !== "meshy.cli/v1") {
        return reject(new Error(`Meshy CLI가 결과를 돌려주지 않았습니다 (종료 코드 ${code}).${stderr.trim() ? ` ${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}` : ""}`));
      }
      if (!envelope.ok) {
        const message = envelope.error?.message ?? `종료 코드 ${code}`;
        const auth = code === 3 || /auth|login|credential|unauthori/i.test(envelope.error?.code ?? "");
        const error = new Error(auth ? `Meshy CLI 로그인이 필요합니다. 설정 → 3D 생성 도구에서 "CLI 로그인"을 누르거나 터미널에서 meshy auth login 을 실행하세요. (${message})` : `Meshy CLI: ${message}`);
        error.envelope = envelope;
        return reject(error);
      }
      resolve(envelope);
    });
  });
}

// 브라우저 로그인을 연다. 로그인은 CLI가 브라우저에서 끝내며 AgentHub는 기다리지 않는다.
export function openMeshyLogin(settings, { spawnProcess = spawn } = {}) {
  const cli = findMeshyCli(settings.cliPath);
  if (!cli) missing();
  const child = spawnProcess(cli.command, [...cli.prefix, "auth", "login", "--no-update-check"], { detached: true, stdio: "ignore", windowsHide: false, env: { ...process.env, MESHY_CLI_NO_UPDATE_NOTIFIER: "1" } });
  child.unref?.();
  return "브라우저에서 Meshy 로그인을 마친 뒤 \"연결 확인\"을 누르세요.";
}

const extension = (file) => path.extname(file).slice(1).toLowerCase();
const taskIdOf = (envelope) => envelope.result?.task?.task_id ?? envelope.result?.submission?.task_id ?? envelope.result?.task_id ?? null;

// 봉투의 다운로드 목록을 형식별 파일로 나눈다. 뼈대에 함께 오는 기본 걷기·달리기 동작은 따로 모은다.
function collect(envelope) {
  const written = (envelope.result?.downloads?.files ?? []).filter((file) => file.status !== "failed" && file.path && fs.existsSync(file.path));
  const files = {}, clips = {};
  let thumbnail = null;
  for (const file of written) {
    const ext = extension(file.path);
    const key = String(file.key ?? "");
    const clip = key.match(/(walking|running)/i)?.[1]?.toLowerCase();
    if (clip && MODEL_EXT.has(ext)) clips[`${clip}_${ext}`] = file.path;
    else if (MODEL_EXT.has(ext)) files[ext] ??= file.path;
    else if (IMAGE_EXT.has(ext) && (!thumbnail || /thumbnail/i.test(key + file.path))) thumbnail = file.path;
  }
  return { files, clips, thumbnail };
}

function checkTask(envelope) {
  const task = envelope.result?.task;
  if (task && task.status && task.status !== "SUCCEEDED") fail(task.task_error?.message ? `작업 실패: ${task.task_error.message}` : `작업이 ${task.status} 상태로 끝났습니다.`);
  return task;
}

const formats = (options) => [...new Set([options.format, "glb"])].join(",");

export const MESHY_CLI = {
  // 연결 확인: 로그인 상태와 남은 크레딧
  async check(tools) {
    const envelope = await tools.cli(["auth", "status"]);
    const result = envelope.result ?? {};
    if (!result.authenticated) fail("Meshy CLI에 로그인하지 않았습니다. \"CLI 로그인\"을 누르거나 터미널에서 meshy auth login 을 실행하세요.");
    return `CLI 로그인됨 · 남은 크레딧 ${result.balance?.balance ?? "?"}`;
  },
  async step(step, ctx, tools) {
    const { model, options } = ctx;
    const run = async (args, extra = []) => {
      const envelope = await tools.cli([...args, "-o", ctx.dir, "--timeout", String(Math.round(tools.timeoutMs / 1000)), ...extra]);
      checkTask(envelope);
      const taskId = taskIdOf(envelope);
      if (!taskId) fail("Meshy CLI가 작업 ID를 돌려주지 않았습니다.");
      return { taskId, ...collect(envelope) };
    };
    const data = options.aiModel ? ["--data", JSON.stringify({ ai_model: options.aiModel })] : [];
    if (step === "generate") {
      if (ctx.image) {
        const result = await run(["image-to-3d", "create", "--image-url", ctx.image.path, "--should-texture", String(ctx.steps.includes("refine")), "--target-formats", formats(options), ...data]);
        return { ...result, stage: "textured" };
      }
      const result = await run(["text-to-3d", "create", "--mode", "preview", "--prompt", ctx.prompt, "--target-formats", formats(options), ...data]);
      return { ...result, stage: "preview" };
    }
    if (step === "refine") {
      if (model.stage !== "preview") return { skipped: "Meshy 이미지→3D는 모양 만들기에서 질감까지 입혀 다듬기를 건너뜁니다." };
      const result = await run(["text-to-3d", "create", "--mode", "refine", "--preview-task-id", model.taskId, "--target-formats", formats(options),
        ...(options.texturePrompt ? ["--texture-prompt", options.texturePrompt] : [])]);
      return { ...result, stage: "textured" };
    }
    if (step === "texture") {
      const style = options.texturePrompt || (ctx.steps[0] === "generate" ? ctx.prompt : "");
      if (!style) fail("질감 단계에 입힐 질감 설명을 입력하세요.");
      return { ...(await run(["retexture", "create", "--input-task-id", model.taskId, "--text-style-prompt", style, "--target-formats", formats(options)])), stage: "textured" };
    }
    if (step === "remesh") return run(["remesh", "create", "--input-task-id", model.taskId, "--target-polycount", String(options.polycount), "--target-formats", formats(options)]);
    if (step === "rig") {
      // 기본 걷기·달리기 동작과 FBX도 함께 받는다(움직임 단계에서 크레딧 없이 쓴다).
      const result = await run(["rigging", "create", "--input-task-id", model.taskId, "--height-meters", String(options.heightMeters)], ["--all-assets"]);
      return { ...result, rigged: true, extra: { basicAnimationFiles: result.clips } };
    }
    if (step === "animate") {
      if (!model.taskIds.rig) fail("움직임은 뼈대를 넣은 Meshy 모델에만 입힐 수 있습니다.");
      const name = { walk: "walking", run: "running" }[options.animation];
      const clips = model.basicAnimationFiles ?? {};
      if (name && Object.keys(clips).some((key) => key.startsWith(name))) {
        // 뼈대 단계에서 받은 기본 동작을 이 단계 폴더로 복사해 쓴다.
        fs.mkdirSync(ctx.dir, { recursive: true });
        const files = {};
        for (const [key, file] of Object.entries(clips)) {
          if (!key.startsWith(name)) continue;
          const target = path.join(ctx.dir, `model.${key.slice(name.length + 1)}`);
          fs.copyFileSync(file, target);
          files[key.slice(name.length + 1)] = target;
        }
        return { taskId: model.taskIds.rig, files, thumbnail: null, rigged: true, animated: true };
      }
      if (!/^\d+$/.test(options.animation)) fail("Meshy 움직임은 walk·run 또는 동작 번호(action_id)로 입력하세요. 번호는 meshy animation-catalog list 로 찾습니다.");
      return { ...(await run(["animate", "create", "--rig-task-id", model.taskIds.rig, "--action-id", options.animation], ["--all-assets"])), rigged: true, animated: true };
    }
    fail(`Meshy는 ${step} 단계를 지원하지 않습니다.`);
  },
};

// runGen3d에 넘길 도구 묶음
export function meshyCliTools(settings, { signal, timeoutMs, onProgress }) {
  return {
    timeoutMs,
    // 진행 줄에서 "45%" 같은 값을 읽어 진행률로 알린다.
    cli: (args) => runMeshyCli(settings, args, { signal, timeoutMs, onLine: (line) => {
      const percent = line.match(/(\d{1,3})\s*%/);
      onProgress?.({ progress: percent ? Math.min(100, Number(percent[1])) : null, line });
    } }),
  };
}

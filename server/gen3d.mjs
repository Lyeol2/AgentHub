// 3D 생성 노드(Meshy·Tripo). 단계 하나만 실행하는 단계 노드와, 여러 단계를 이어 실행하는 통합 노드를 같은 노드 종류로 다룬다.
// 단계마다 서비스에 작업을 만들고, 끝날 때까지 상태를 확인하고, 결과 파일을 프로젝트 출력 폴더에 받는다.
// 다음 노드에는 "3D 모델" 정보(JSON)를 넘긴다. 같은 서비스의 다음 단계는 파일을 다시 올리지 않고 작업 ID로 이어 간다.
// API 키는 data 폴더의 별도 파일(gen3d-keys.json)에만 두고 화면·기록·노드 설정에는 남기지 않는다.
import fs from "node:fs";
import path from "node:path";

// 화면에 보이는 단계 이름. 실행 순서도 이 순서다.
export const GEN3D_STEPS = {
  generate: "모양 만들기",
  refine: "다듬기",
  texture: "질감",
  remesh: "형태 정리",
  rig: "뼈대",
  animate: "움직임",
  convert: "형식 변환",
};
const ORDER = Object.keys(GEN3D_STEPS);

export const GEN3D_PROVIDERS = {
  meshy: { label: "Meshy", baseUrl: "https://api.meshy.ai", env: "MESHY_API_KEY", steps: ["generate", "refine", "texture", "remesh", "rig", "animate"] },
  // Tripo는 V2 OpenAPI 기준이다. V3 주소를 쓰려면 설정에서 주소를 바꾼다.
  tripo: { label: "Tripo", baseUrl: "https://api.tripo3d.ai/v2/openapi", env: "TRIPO_API_KEY", steps: ["generate", "refine", "texture", "remesh", "rig", "animate", "convert"] },
};

// 통합 노드의 바로 쓰는 묶음. 고른 서비스가 지원하지 않는 단계는 빠진다.
export const GEN3D_PRESETS = {
  draft: { label: "빠른 시안", steps: ["generate"] },
  prop: { label: "게임 소품", steps: ["generate", "refine", "remesh"], options: { format: "glb" } },
  character: { label: "캐릭터", steps: ["generate", "refine", "rig", "animate"], options: { format: "fbx" } },
  unity: { label: "Unity용", steps: ["generate", "refine", "remesh", "convert"], options: { format: "fbx" } },
};

export const GEN3D_FORMATS = ["glb", "fbx", "obj", "usdz"];
const MODEL_TAG = "agenthub3d";
const DOWNLOAD_MAX = 1024 * 1024 * 1024;
const IMAGE_MAX = 20 * 1024 * 1024;
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const fail = (message) => { throw new Error(message); };
const int = (value, min, max, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(`${label}은 ${min}~${max} 사이 정수로 입력하세요.`);
  return number;
};
const str = (value, label, max = 2000) => {
  const result = String(value ?? "");
  if (result.length > max) fail(`${label}은 ${max}자까지 입력할 수 있습니다.`);
  return result;
};

// 노드 설정 검사. flow-nodes의 checkFlowNode가 kind "gen3d"일 때 부른다.
export function checkGen3dNode(body, current = {}) {
  const provider = body.provider ?? current.provider ?? "meshy";
  if (!GEN3D_PROVIDERS[provider]) fail("3D 생성 도구는 Meshy 또는 Tripo입니다.");
  const preset = body.preset ?? null;
  if (preset !== null && !GEN3D_PRESETS[preset]) fail("알 수 없는 묶음입니다.");
  const supported = GEN3D_PROVIDERS[provider].steps;
  let steps = body.steps ?? (preset ? GEN3D_PRESETS[preset].steps.filter((step) => supported.includes(step)) : current.steps) ?? ["generate"];
  if (!Array.isArray(steps) || !steps.length) fail("실행할 단계를 하나 이상 고르세요.");
  if (steps.some((step) => !ORDER.includes(step))) fail("알 수 없는 단계가 있습니다.");
  const missing = steps.filter((step) => !supported.includes(step));
  if (missing.length) fail(`${GEN3D_PROVIDERS[provider].label}은(는) ${missing.map((step) => GEN3D_STEPS[step]).join(", ")} 단계를 지원하지 않습니다.`);
  steps = ORDER.filter((step) => steps.includes(step));
  if (steps.includes("animate") && !steps.includes("rig") && steps[0] === "generate") fail("움직임 단계는 뼈대 단계 뒤에 실행합니다.");
  const inputMode = body.inputMode ?? current.inputMode ?? "text";
  if (!["text", "image"].includes(inputMode)) fail("입력은 글 또는 이미지입니다.");
  const outputDir = str(body.outputDir ?? current.outputDir ?? "output/3d", "출력 폴더", 300).trim().replaceAll("\\", "/") || "output/3d";
  if (path.posix.isAbsolute(outputDir) || path.win32.isAbsolute(outputDir) || outputDir.split("/").includes("..")) fail("출력 폴더는 프로젝트 안의 상대 경로로 입력하세요.");
  const raw = { ...(current.options ?? {}), ...(preset ? GEN3D_PRESETS[preset].options ?? {} : {}), ...(body.options ?? {}) };
  const format = raw.format ?? "glb";
  if (!GEN3D_FORMATS.includes(format)) fail("출력 형식은 glb·fbx·obj·usdz 중 하나입니다.");
  const options = {
    format,
    aiModel: str(raw.aiModel ?? "", "모델 버전", 60).trim(),
    polycount: int(raw.polycount ?? 30000, 100, 300000, "폴리곤 수"),
    texturePrompt: str(raw.texturePrompt ?? "", "질감 설명"),
    animation: str(raw.animation ?? "walk", "동작", 60).trim() || "walk",
    heightMeters: Number(raw.heightMeters ?? 1.7),
  };
  if (!Number.isFinite(options.heightMeters) || options.heightMeters <= 0 || options.heightMeters > 50) fail("캐릭터 키는 0~50m 사이로 입력하세요.");
  const title = str(body.title ?? current.title, "이름", 100).trim();
  return {
    kind: "gen3d",
    title: title || `${GEN3D_PROVIDERS[provider].label} · ${steps.length === 1 ? GEN3D_STEPS[steps[0]] : steps.map((step) => GEN3D_STEPS[step]).join(" → ")}`,
    provider, steps, inputMode,
    prompt: str(body.prompt ?? current.prompt ?? "{{input}}", "요청", 20000),
    imagePath: str(body.imagePath ?? current.imagePath ?? "", "이미지 경로", 2000).trim(),
    options, outputDir,
    pollSec: int(body.pollSec ?? current.pollSec ?? 5, 1, 60, "상태 확인 간격(초)"),
    timeoutMin: int(body.timeoutMin ?? current.timeoutMin ?? 30, 1, 180, "최대 대기 시간(분)"),
  };
}

// ── API 키 ─────────────────────────────────────────────────────
export class Gen3dKeys {
  constructor({ dataDir, env = process.env }) {
    this.file = path.join(dataDir, "gen3d-keys.json");
    this.env = env;
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")) ?? {}; } catch { return {}; }
  }

  get(id) {
    const provider = GEN3D_PROVIDERS[id];
    if (!provider) fail("알 수 없는 3D 생성 도구입니다.");
    const saved = this.read()[id] ?? {};
    return { apiKey: saved.apiKey || this.env[provider.env] || "", baseUrl: saved.baseUrl || provider.baseUrl };
  }

  // 화면에는 키가 있는지와 주소만 보인다.
  list() {
    return Object.entries(GEN3D_PROVIDERS).map(([id, provider]) => {
      const { apiKey, baseUrl } = this.get(id);
      return { id, label: provider.label, configured: !!apiKey, baseUrl, defaultBaseUrl: provider.baseUrl, steps: provider.steps };
    });
  }

  // apiKey: 빈 문자열이면 지운다. undefined면 그대로 둔다. baseUrl: 빈 문자열이면 기본 주소로 되돌린다.
  set(id, { apiKey, baseUrl } = {}) {
    if (!GEN3D_PROVIDERS[id]) fail("알 수 없는 3D 생성 도구입니다.");
    const all = this.read();
    const next = { ...(all[id] ?? {}) };
    if (apiKey !== undefined) {
      const key = String(apiKey).trim();
      if (key.length > 500 || /\s/.test(key)) fail("API 키 형식이 올바르지 않습니다.");
      if (key) next.apiKey = key; else delete next.apiKey;
    }
    if (baseUrl !== undefined) {
      const value = String(baseUrl).trim().replace(/\/+$/, "");
      if (value) {
        let url;
        try { url = new URL(value); } catch { fail("서비스 주소를 http:// 또는 https://로 시작하는 URL로 입력하세요."); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail("서비스 주소를 http:// 또는 https://로 시작하는 URL로 입력하세요.");
        next.baseUrl = value;
      } else delete next.baseUrl;
    }
    all[id] = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
    return this.list().find((item) => item.id === id);
  }
}

// ── 3D 모델 정보 ───────────────────────────────────────────────
// 다음 노드에 넘길 글. 사람이 읽는 줄과 노드가 읽는 JSON을 함께 둔다.
export function modelText(model) {
  const main = model.files[model.format] ?? Object.values(model.files)[0] ?? "";
  return `3D 모델 · ${GEN3D_PROVIDERS[model.provider]?.label ?? model.provider} · ${GEN3D_STEPS[model.step] ?? model.step}${main ? `\n${main}` : ""}\n\n\`\`\`json\n${JSON.stringify(model, null, 2)}\n\`\`\``;
}

// 앞 노드가 넘긴 글에서 3D 모델 정보를 찾는다. 없으면 null.
export function parseModel(text) {
  const source = String(text ?? "");
  for (const candidate of [source, ...[...source.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1])]) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && value[MODEL_TAG] === 1 && GEN3D_PROVIDERS[value.provider] && value.taskIds && typeof value.taskIds === "object") return value;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

// ── 서비스별 단계 ──────────────────────────────────────────────
// tools: { post(path, body), get(path), upload(file), wait(path, read), log(text) }
// 단계는 { taskId, outputs: { glb, fbx, ... } (주소), thumbnail, extra }를 돌려준다.
const meshyStatus = (task) => task.status === "SUCCEEDED" ? "success" : ["FAILED", "CANCELED", "EXPIRED"].includes(task.status) ? "failed" : "running";
const meshyUrls = (task) => ({ ...(task.model_urls ?? {}) });
const MESHY_POLL = { generateText: "/openapi/v2/text-to-3d/", generateImage: "/openapi/v1/image-to-3d/", refine: "/openapi/v2/text-to-3d/", texture: "/openapi/v1/retexture/", remesh: "/openapi/v1/remesh/", rig: "/openapi/v1/rigging/", animate: "/openapi/v1/animations/" };

const MESHY = {
  check: async (tools) => { const value = await tools.get("/openapi/v1/balance"); return `남은 크레딧 ${value.balance ?? "?"}`; },
  async step(step, ctx, tools) {
    const { model, options } = ctx;
    const read = (task) => ({ status: meshyStatus(task), progress: task.progress, error: task.task_error?.message, task });
    const run = async (kind, post, body) => {
      const created = await tools.post(post, body);
      const taskId = created.result ?? created.id;
      if (!taskId) fail("Meshy가 작업 ID를 돌려주지 않았습니다.");
      const task = await tools.wait(MESHY_POLL[kind] + taskId, read);
      return { taskId, task };
    };
    if (step === "generate") {
      if (ctx.image) {
        const { taskId, task } = await run("generateImage", "/openapi/v1/image-to-3d", { image_url: ctx.image.dataUri, should_texture: ctx.steps.includes("refine"), ...(options.aiModel ? { ai_model: options.aiModel } : {}) });
        return { taskId, outputs: meshyUrls(task), thumbnail: task.thumbnail_url, stage: "textured" };
      }
      const { taskId, task } = await run("generateText", "/openapi/v2/text-to-3d", { mode: "preview", prompt: ctx.prompt, ...(options.aiModel ? { ai_model: options.aiModel } : {}) });
      return { taskId, outputs: meshyUrls(task), thumbnail: task.thumbnail_url, stage: "preview" };
    }
    if (step === "refine") {
      // 이미지로 만든 모델은 만들 때 질감까지 입혔으므로 다듬기를 건너뛴다.
      if (model.stage !== "preview") return { skipped: "Meshy 이미지→3D는 모양 만들기에서 질감까지 입혀 다듬기를 건너뜁니다." };
      const { taskId, task } = await run("refine", "/openapi/v2/text-to-3d", { mode: "refine", preview_task_id: model.taskId, ...(options.texturePrompt ? { texture_prompt: options.texturePrompt } : {}) });
      return { taskId, outputs: meshyUrls(task), thumbnail: task.thumbnail_url, stage: "textured" };
    }
    if (step === "texture") {
      const { taskId, task } = await run("texture", "/openapi/v1/retexture", { input_task_id: model.taskId, text_style_prompt: options.texturePrompt || ctx.prompt });
      return { taskId, outputs: meshyUrls(task), thumbnail: task.thumbnail_url, stage: "textured" };
    }
    if (step === "remesh") {
      const { taskId, task } = await run("remesh", "/openapi/v1/remesh", { input_task_id: model.taskId, target_polycount: options.polycount, target_formats: [...new Set([options.format, "glb"])] });
      return { taskId, outputs: meshyUrls(task), thumbnail: task.thumbnail_url ?? model.thumbnailUrl };
    }
    if (step === "rig") {
      const { taskId, task } = await run("rig", "/openapi/v1/rigging", { input_task_id: model.taskId, height_meters: options.heightMeters });
      const result = task.result ?? {};
      return { taskId, outputs: { glb: result.rigged_character_glb_url, fbx: result.rigged_character_fbx_url }, thumbnail: model.thumbnailUrl, rigged: true,
        extra: { basicAnimations: result.basic_animations ?? null } };
    }
    if (step === "animate") {
      if (!model.taskIds.rig) fail("움직임은 뼈대를 넣은 Meshy 모델에만 입힐 수 있습니다.");
      // 뼈대를 넣을 때 함께 나온 기본 걷기·달리기는 새 작업(크레딧) 없이 쓴다.
      const name = { walk: "walking", run: "running" }[options.animation];
      if (name && (model.basicAnimations?.[`${name}_glb_url`] || model.basicAnimations?.[`${name}_fbx_url`])) {
        return { taskId: model.taskIds.rig, outputs: { glb: model.basicAnimations[`${name}_glb_url`], fbx: model.basicAnimations[`${name}_fbx_url`] }, thumbnail: model.thumbnailUrl, rigged: true, animated: true };
      }
      if (!/^\d+$/.test(options.animation)) fail("Meshy 움직임은 walk·run 또는 동작 번호(action_id)로 입력하세요.");
      const { taskId, task } = await run("animate", "/openapi/v1/animations", { rig_task_id: model.taskIds.rig, action_id: Number(options.animation) });
      const result = task.result ?? {};
      return { taskId, outputs: { glb: result.animation_glb_url, fbx: result.animation_fbx_url }, thumbnail: model.thumbnailUrl, rigged: true, animated: true };
    }
    fail(`Meshy는 ${GEN3D_STEPS[step]} 단계를 지원하지 않습니다.`);
  },
};

const tripoStatus = (data) => data.status === "success" ? "success" : ["failed", "cancelled", "banned", "expired", "unknown"].includes(data.status) ? "failed" : "running";
const TRIPO = {
  check: async (tools) => { const value = await tools.get("/user/balance"); return `남은 크레딧 ${value.balance ?? "?"}`; },
  async step(step, ctx, tools) {
    const { model, options } = ctx;
    const run = async (body) => {
      const created = await tools.post("/task", body);
      const taskId = created.task_id;
      if (!taskId) fail("Tripo가 작업 ID를 돌려주지 않았습니다.");
      const data = await tools.wait(`/task/${taskId}`, (value) => ({ status: tripoStatus(value), progress: value.progress, error: value.error_msg ?? value.message, task: value }));
      const output = data.output ?? {};
      return { taskId, output, outputs: { [options.format]: output.pbr_model ?? output.model ?? output.base_model }, thumbnail: output.rendered_image };
    };
    const original = { original_model_task_id: model?.taskId };
    if (step === "generate") {
      if (ctx.image) {
        const token = await tools.upload(ctx.image);
        return run({ type: "image_to_model", file: { type: ctx.image.extension, file_token: token }, ...(options.aiModel ? { model_version: options.aiModel } : {}) });
      }
      return run({ type: "text_to_model", prompt: ctx.prompt, ...(options.aiModel ? { model_version: options.aiModel } : {}) });
    }
    if (step === "refine") return run({ type: "refine_model", draft_model_task_id: model.taskId });
    if (step === "texture") return run({ type: "texture_model", ...original, ...(options.texturePrompt ? { texture_prompt: { text: options.texturePrompt } } : {}) });
    if (step === "remesh") return run({ type: "highpoly_to_lowpoly", ...original, face_limit: options.polycount });
    if (step === "rig") {
      // 먼저 리깅할 수 있는 모델인지 확인한다(사람·동물 형태). 안 되면 실패로 끝내 실패 연결로 넘긴다.
      const check = await run({ type: "animate_prerigcheck", ...original });
      if (check.output.riggable === false) fail("Tripo가 이 모델은 뼈대를 넣을 수 없다고 판단했습니다(사람·동물 형태가 아님).");
      const rigged = await run({ type: "animate_rig", ...original, out_format: options.format, ...(check.output.rig_type ? { rig_type: check.output.rig_type } : {}) });
      return { ...rigged, rigged: true };
    }
    if (step === "animate") {
      if (!model.taskIds.rig) fail("움직임은 뼈대를 넣은 Tripo 모델에만 입힐 수 있습니다.");
      const animation = options.animation.includes(":") ? options.animation : `preset:${options.animation}`;
      return { ...(await run({ type: "animate_retarget", original_model_task_id: model.taskIds.rig, animation, out_format: options.format })), rigged: true, animated: true };
    }
    if (step === "convert") return run({ type: "convert_model", ...original, format: options.format.toUpperCase() });
    fail(`Tripo는 ${GEN3D_STEPS[step]} 단계를 지원하지 않습니다.`);
  },
};

const ADAPTERS = { meshy: MESHY, tripo: TRIPO };

// ── HTTP ───────────────────────────────────────────────────────
function client(provider, { apiKey, baseUrl }, { fetch, signal, sleep, now, pollMs, timeoutMs, onProgress }) {
  if (!apiKey) fail(`${GEN3D_PROVIDERS[provider].label} API 키가 없습니다. 설정 → 3D 생성 도구에서 키를 넣으세요.`);
  const headers = { Authorization: `Bearer ${apiKey}` };
  // Tripo는 { code, data }로 감싸 돌려준다. 오류 문구에 키가 섞이지 않게 응답 본문만 쓴다.
  const unwrap = async (response) => {
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : {}; } catch { body = null; }
    if (!response.ok || (provider === "tripo" && body && body.code !== undefined && body.code !== 0)) {
      const detail = body?.message ?? body?.msg ?? body?.error ?? (body ? "" : text.slice(0, 200));
      const error = new Error(`${GEN3D_PROVIDERS[provider].label} 요청 실패 (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      error.status = response.status;
      throw error;
    }
    if (!body) fail(`${GEN3D_PROVIDERS[provider].label}가 JSON이 아닌 응답을 돌려주었습니다.`);
    return provider === "tripo" && body.data !== undefined ? body.data : body;
  };
  const call = async (method, route, body) => unwrap(await fetch(baseUrl + route, {
    method, signal, headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  return {
    post: (route, body) => call("POST", route, body),
    get: (route) => call("GET", route),
    async upload(image) {
      const form = new FormData();
      form.append("file", new Blob([image.bytes], { type: image.mimeType }), image.name);
      const data = await unwrap(await fetch(baseUrl + "/upload", { method: "POST", signal, headers, body: form }));
      return data.image_token ?? data.file_token ?? fail("Tripo가 업로드 토큰을 돌려주지 않았습니다.");
    },
    // 끝날 때까지 상태를 확인한다. 진행률은 onProgress로 알린다.
    async wait(route, read) {
      const deadline = now() + timeoutMs;
      for (;;) {
        const state = read(await call("GET", route));
        onProgress?.(state);
        if (state.status === "success") return state.task;
        if (state.status === "failed") fail(state.error ? `작업 실패: ${state.error}` : "작업이 실패했습니다.");
        if (now() > deadline) fail(`작업이 ${Math.round(timeoutMs / 60000)}분 안에 끝나지 않았습니다. 서비스 화면에서 상태를 확인하세요.`);
        await sleep(pollMs, signal);
      }
    },
  };
}

const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("중지했습니다."));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("중지했습니다.")); }, { once: true });
});

const extensionOf = (url, fallback) => {
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
  } catch { /* 주소가 아니면 기본 형식 */ }
  return fallback;
};

async function download(url, dir, name, { fetch, signal }) {
  if (!/^https?:\/\//i.test(String(url))) fail("결과 파일 주소가 올바르지 않습니다.");
  const response = await fetch(url, { signal });
  if (!response.ok) fail(`결과 파일을 받지 못했습니다 (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > DOWNLOAD_MAX) fail("결과 파일이 1 GB를 넘습니다.");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

// 이미지 입력: 프로젝트 기준 경로(또는 절대 경로)의 PNG·JPEG·WebP.
function readImage(value, projectPath) {
  const file = path.resolve(projectPath, value);
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) fail("이미지는 PNG·JPEG·WebP 파일이어야 합니다.");
  let stat;
  try { stat = fs.statSync(file); } catch { fail(`이미지를 찾을 수 없습니다: ${file}`); }
  if (!stat.isFile() || stat.size > IMAGE_MAX) fail("이미지는 20 MB 이하의 파일이어야 합니다.");
  const bytes = fs.readFileSync(file);
  return { path: file, name: path.basename(file), mimeType: type, extension: path.extname(file).slice(1).toLowerCase().replace("jpeg", "jpg"), bytes, dataUri: `data:${type};base64,${bytes.toString("base64")}` };
}

// ── 실행 ───────────────────────────────────────────────────────
// input: 앞 노드가 넘긴 글(3D 모델 정보 또는 요청 글). render(template): {{input}} 같은 변수를 채운다.
// resume: 앞선 실행의 단계 결과. 성공한 단계는 다시 만들지 않고 이어서 실행한다.
export async function runGen3d(node, { input = "", render = (template) => template, projectPath, keys, fetch = globalThis.fetch, signal, sleep = abortableSleep, now = Date.now, onProgress = () => {}, resume = null, runId = String(now()) }) {
  const provider = node.provider;
  const adapter = ADAPTERS[provider];
  const upstream = parseModel(input);
  const steps = node.steps;
  const outputRoot = path.resolve(projectPath, node.outputDir || "output/3d");
  if (path.relative(projectPath, outputRoot).startsWith("..")) fail("출력 폴더는 프로젝트 안이어야 합니다.");
  const runDir = path.join(outputRoot, `${new Date(now()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${node.id ?? "node"}`);
  const record = { runId, at: new Date(now()).toISOString(), provider, steps: [], outputDir: runDir, ok: false };
  let model = upstream;
  if (steps[0] !== "generate") {
    if (!model) fail(`${GEN3D_STEPS[steps[0]]} 단계는 앞 노드에서 3D 모델을 받아야 합니다. 앞에 모양 만들기 노드를 연결하세요.`);
    if (model.provider !== provider) fail(`${GEN3D_PROVIDERS[model.provider].label}에서 만든 모델은 아직 ${GEN3D_PROVIDERS[provider].label} 단계로 이어 쓸 수 없습니다.`);
  }
  const prompt = render(node.prompt || "{{input}}").trim();
  const ctx = { prompt, steps, options: node.options ?? {}, image: null, model };
  if (steps[0] === "generate") {
    if (node.inputMode === "image") {
      const image = render(node.imagePath || "{{input}}").trim();
      if (!image) fail("이미지 경로를 입력하세요.");
      ctx.image = readImage(image, projectPath);
    } else if (!prompt) fail("만들 모델을 설명하는 글을 입력하세요.");
  }
  let current = steps[0];
  const tools = client(provider, keys.get(provider), {
    fetch, signal, sleep, now, pollMs: (node.pollSec ?? 5) * 1000, timeoutMs: (node.timeoutMin ?? 30) * 60_000,
    onProgress: (state) => onProgress({ step: current, progress: state.progress ?? null }),
  });
  try {
    for (const step of steps) {
      current = step;
      const reused = resume?.steps?.find((item) => item.step === step && item.status === "success" && item.model);
      if (reused) {
        model = reused.model;
        ctx.model = model;
        record.steps.push({ ...reused, reused: true });
        onProgress({ step, progress: 100, reused: true });
        continue;
      }
      onProgress({ step, progress: 0 });
      const result = await adapter.step(step, ctx, tools);
      if (result.skipped) {
        record.steps.push({ step, status: "skipped", note: result.skipped, model });
        continue;
      }
      const dir = path.join(runDir, `${ORDER.indexOf(step) + 1}-${step}`);
      const files = {};
      for (const [format, url] of Object.entries(result.outputs ?? {})) {
        if (!url) continue;
        const ext = GEN3D_FORMATS.includes(format) ? format : extensionOf(url, format);
        files[format] = await download(url, dir, `model.${ext}`, { fetch, signal });
      }
      if (!Object.keys(files).length) fail(`${GEN3D_STEPS[step]} 결과에 받을 파일이 없습니다.`);
      let thumbnail = null;
      if (result.thumbnail) {
        try { thumbnail = await download(result.thumbnail, dir, `thumbnail.${extensionOf(result.thumbnail, "png")}`, { fetch, signal }); }
        catch { /* 썸네일이 없어도 모델은 쓴다. */ }
      }
      model = {
        [MODEL_TAG]: 1, provider, step, taskId: result.taskId,
        taskIds: { ...(model?.taskIds ?? {}), [step]: result.taskId },
        stage: result.stage ?? model?.stage ?? null,
        format: files[node.options?.format] ? node.options.format : Object.keys(files)[0],
        files, thumbnail: thumbnail ?? model?.thumbnail ?? null, thumbnailUrl: result.thumbnail ?? model?.thumbnailUrl ?? null,
        rigged: !!(result.rigged || model?.rigged), animated: !!(result.animated || model?.animated),
        ...(result.extra?.basicAnimations ? { basicAnimations: result.extra.basicAnimations } : model?.basicAnimations ? { basicAnimations: model.basicAnimations } : {}),
      };
      ctx.model = model;
      record.steps.push({ step, status: "success", taskId: result.taskId, files, thumbnail, model });
      onProgress({ step, progress: 100 });
    }
    record.ok = true;
    record.model = model;
    return { ok: true, text: modelText(model), record };
  } catch (error) {
    record.steps.push({ step: current, status: "failed", error: error.message });
    record.error = `${GEN3D_STEPS[current]}: ${error.message}`;
    error.record = record;
    error.message = record.error;
    throw error;
  }
}

// 설정의 "연결 확인": 키와 주소로 남은 크레딧을 묻는다.
export async function checkGen3dProvider(id, keys, { fetch = globalThis.fetch } = {}) {
  const adapter = ADAPTERS[id];
  if (!adapter) fail("알 수 없는 3D 생성 도구입니다.");
  const tools = client(id, keys.get(id), { fetch, signal: AbortSignal.timeout(15000), sleep: abortableSleep, now: Date.now, pollMs: 1000, timeoutMs: 15000 });
  return adapter.check(tools);
}

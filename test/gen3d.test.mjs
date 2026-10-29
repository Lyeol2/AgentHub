// 3D 생성 노드(Meshy·Tripo). 실제 서비스 대신 같은 모양으로 답하는 가짜 서버로만 시험한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { checkGen3dNode, runGen3d, parseModel, Gen3dKeys, checkGen3dProvider, GEN3D_PRESETS } from "../server/gen3d.mjs";
import { createHub } from "../server/bootstrap.mjs";

const KEY = "sk-test-secret-key";
const tick = () => Promise.resolve();

// 가짜 Meshy·Tripo. 작업은 만들고 나서 두 번째 상태 확인 때 끝난다. fail: { [단계 경로]: 횟수 } 만큼 실패로 끝낸다.
async function fakeServer(t, { fail = {}, riggable = true } = {}) {
  const requests = [], tasks = new Map();
  let next = 0;
  const server = http.createServer(async (req, res) => {
    let raw = Buffer.alloc(0);
    for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
    const url = new URL(req.url, "http://x");
    const body = (req.headers["content-type"] ?? "").includes("json") && raw.length ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization, multipart: (req.headers["content-type"] ?? "").startsWith("multipart/") ? raw.toString("latin1") : null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/files/")) { res.writeHead(200); return res.end(`FILE ${url.pathname}`); }
    if (req.headers.authorization !== `Bearer ${KEY}`) return json({ message: "Invalid API key" }, 401);
    const create = (kind, extra = {}) => {
      const id = `${kind}-${++next}`;
      const failing = fail[kind] > 0 && fail[kind]--;
      tasks.set(id, { kind, polls: 0, failing, ...extra });
      return id;
    };
    // ── Meshy ──
    if (url.pathname === "/openapi/v1/balance") return json({ balance: 1234 });
    const meshyCreate = { "/openapi/v2/text-to-3d": () => body.mode, "/openapi/v1/image-to-3d": () => "image", "/openapi/v1/retexture": () => "retexture", "/openapi/v1/remesh": () => "remesh", "/openapi/v1/rigging": () => "rigging", "/openapi/v1/animations": () => "animations" }[url.pathname];
    if (req.method === "POST" && meshyCreate) return json({ result: create(`meshy-${meshyCreate()}`) });
    const meshyTask = url.pathname.match(/^\/openapi\/v[12]\/[a-z0-9-]+\/(meshy-[a-z]+-\d+)$/);
    if (meshyTask) {
      const task = tasks.get(meshyTask[1]);
      task.polls++;
      if (task.polls < 2) return json({ id: meshyTask[1], status: "IN_PROGRESS", progress: 50 });
      if (task.failing) return json({ id: meshyTask[1], status: "FAILED", task_error: { message: "서버 혼잡" } });
      const file = (name) => `${base}/files/${meshyTask[1]}/${name}`;
      const result = task.kind === "meshy-rigging"
        ? { result: { rigged_character_glb_url: file("rigged.glb"), rigged_character_fbx_url: file("rigged.fbx"), basic_animations: { walking_glb_url: file("walking.glb"), walking_fbx_url: file("walking.fbx") } } }
        : task.kind === "meshy-animations" ? { result: { animation_glb_url: file("anim.glb"), animation_fbx_url: file("anim.fbx") } }
        : { model_urls: { glb: file("model.glb"), fbx: file("model.fbx") }, thumbnail_url: file("thumb.png") };
      return json({ id: meshyTask[1], status: "SUCCEEDED", progress: 100, ...result });
    }
    // ── Tripo (V2: { code, data }) ──
    if (url.pathname === "/v2/openapi/user/balance") return json({ code: 0, data: { balance: 99 } });
    if (url.pathname === "/v2/openapi/upload") return json({ code: 0, data: { image_token: "img-token-1" } });
    if (req.method === "POST" && url.pathname === "/v2/openapi/task") return json({ code: 0, data: { task_id: create(`tripo-${body.type}`) } });
    const tripoTask = url.pathname.match(/^\/v2\/openapi\/task\/(tripo-[a-z_]+-\d+)$/);
    if (tripoTask) {
      const task = tasks.get(tripoTask[1]);
      task.polls++;
      if (task.polls < 2) return json({ code: 0, data: { task_id: tripoTask[1], status: "running", progress: 40 } });
      if (task.failing) return json({ code: 0, data: { task_id: tripoTask[1], status: "failed" } });
      if (task.kind === "tripo-animate_prerigcheck") return json({ code: 0, data: { status: "success", output: { riggable, rig_type: "biped" } } });
      return json({ code: 0, data: { status: "success", progress: 100, output: { pbr_model: `${base}/files/${tripoTask[1]}/model.glb`, rendered_image: `${base}/files/${tripoTask[1]}/render.webp` } } });
    }
    json({ message: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { requests, base, meshy: base, tripo: `${base}/v2/openapi` };
}

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-gen3d-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const keysFor = (server) => ({ get: (id) => ({ apiKey: KEY, baseUrl: server[id] }) });
const node = (fields) => ({ id: "n1", ...checkGen3dNode(fields) });
const fast = { sleep: () => tick() };

test("gen3d: 노드 설정은 서비스가 지원하는 단계만 실행 순서대로 받고, 묶음을 펼친다", () => {
  assert.deepEqual(checkGen3dNode({ provider: "meshy", steps: ["remesh", "generate"] }).steps, ["generate", "remesh"]);
  assert.throws(() => checkGen3dNode({ provider: "meshy", steps: ["convert"] }), /Meshy은\(는\) 형식 변환 단계를 지원하지 않습니다/);
  assert.throws(() => checkGen3dNode({ provider: "nope" }), /Meshy 또는 Tripo/);
  assert.throws(() => checkGen3dNode({ steps: ["generate", "animate"] }), /뼈대 단계 뒤/);
  assert.throws(() => checkGen3dNode({ outputDir: "../outside" }), /프로젝트 안/);
  // Meshy에는 형식 변환이 없어 Unity용 묶음에서 빠진다.
  const unity = checkGen3dNode({ provider: "meshy", preset: "unity" });
  assert.deepEqual(unity.steps, ["generate", "refine", "remesh"]);
  assert.equal(unity.options.format, "fbx");
  assert.deepEqual(checkGen3dNode({ provider: "tripo", preset: "unity" }).steps, GEN3D_PRESETS.unity.steps);
  assert.equal(checkGen3dNode({ provider: "tripo", steps: ["rig"] }).title, "Tripo · 뼈대");
});

test("gen3d: Meshy 통합 노드는 모양→다듬기→형태 정리→뼈대→기본 걷기를 이어 실행하고 파일을 받는다", async (t) => {
  const server = await fakeServer(t);
  const root = project(t);
  const progress = [];
  const result = await runGen3d(node({ provider: "meshy", steps: ["generate", "refine", "remesh", "rig", "animate"], prompt: "{{input}} 캐릭터", options: { format: "fbx", polycount: 5000 } }), {
    input: "귀여운 두리안", render: (template) => template.replace("{{input}}", "귀여운 두리안"), projectPath: root, keys: keysFor(server), ...fast, onProgress: (item) => progress.push(item),
  });
  const posts = server.requests.filter((request) => request.method === "POST");
  assert.deepEqual(posts.map((request) => request.path), ["/openapi/v2/text-to-3d", "/openapi/v2/text-to-3d", "/openapi/v1/remesh", "/openapi/v1/rigging"], "기본 걷기는 새 작업 없이 쓴다");
  assert.deepEqual(posts[0].body, { mode: "preview", prompt: "귀여운 두리안 캐릭터" });
  assert.deepEqual(posts[1].body, { mode: "refine", preview_task_id: "meshy-preview-1" });
  assert.deepEqual(posts[2].body, { input_task_id: "meshy-refine-2", target_polycount: 5000, target_formats: ["fbx", "glb"] });
  assert.equal(posts[3].body.input_task_id, "meshy-remesh-3");
  assert.ok(server.requests.filter((request) => !request.path.startsWith("/files/")).every((request) => request.auth === `Bearer ${KEY}`));
  assert.ok(server.requests.filter((request) => request.path.startsWith("/files/")).every((request) => !request.auth), "결과 파일 주소에는 키를 보내지 않는다");
  const model = parseModel(result.text);
  assert.equal(model.step, "animate");
  assert.equal(model.rigged, true); assert.equal(model.animated, true);
  assert.deepEqual(model.taskIds, { generate: "meshy-preview-1", refine: "meshy-refine-2", remesh: "meshy-remesh-3", rig: "meshy-rigging-4", animate: "meshy-rigging-4" });
  assert.equal(fs.readFileSync(model.files.fbx, "utf8"), "FILE /files/meshy-rigging-4/walking.fbx");
  assert.ok(model.files.fbx.startsWith(path.join(root, "output", "3d")));
  assert.match(model.files.fbx, /6-animate[\\/]model\.fbx$/);
  assert.ok(fs.existsSync(result.record.steps[0].thumbnail));
  assert.deepEqual(result.record.steps.map((step) => step.status), ["success", "success", "success", "success", "success"]);
  assert.ok(!JSON.stringify(result.record).includes(KEY), "실행 기록에 키가 남지 않는다");
  assert.ok(progress.some((item) => item.step === "refine" && item.progress === 50));
});

test("gen3d: 단계 노드끼리는 작업 ID로 이어 가고, 다른 서비스나 모델 없는 입력은 거절한다", async (t) => {
  const server = await fakeServer(t);
  const root = project(t);
  const shape = await runGen3d(node({ provider: "tripo", steps: ["generate"] }), { input: "의자", render: () => "의자", projectPath: root, keys: keysFor(server), ...fast });
  const lowpoly = await runGen3d(node({ provider: "tripo", steps: ["remesh"], options: { polycount: 800 } }), { input: shape.text, projectPath: root, keys: keysFor(server), ...fast });
  const posts = server.requests.filter((request) => request.method === "POST").map((request) => request.body);
  assert.deepEqual(posts, [{ type: "text_to_model", prompt: "의자" }, { type: "highpoly_to_lowpoly", original_model_task_id: "tripo-text_to_model-1", face_limit: 800 }]);
  assert.equal(parseModel(lowpoly.text).taskIds.generate, "tripo-text_to_model-1");
  await assert.rejects(runGen3d(node({ provider: "meshy", steps: ["remesh"] }), { input: shape.text, projectPath: root, keys: keysFor(server), ...fast }), /Tripo에서 만든 모델은 아직 Meshy/);
  await assert.rejects(runGen3d(node({ provider: "tripo", steps: ["refine"] }), { input: "그냥 글", projectPath: root, keys: keysFor(server), ...fast }), /앞 노드에서 3D 모델을 받아야/);
});

test("gen3d: Tripo 이미지 입력은 올린 뒤 만들고, 뼈대 전에 리깅 가능 여부를 확인한다", async (t) => {
  const server = await fakeServer(t);
  const root = project(t);
  fs.writeFileSync(path.join(root, "ref.png"), Buffer.from([137, 80, 78, 71]));
  const result = await runGen3d(node({ provider: "tripo", inputMode: "image", imagePath: "ref.png", steps: ["generate", "rig", "animate"], options: { animation: "run" } }), { input: "", render: (template) => template, projectPath: root, keys: keysFor(server), ...fast });
  const upload = server.requests.find((request) => request.path === "/v2/openapi/upload");
  assert.match(upload.multipart, /filename="ref\.png"/);
  const posts = server.requests.filter((request) => request.path === "/v2/openapi/task").map((request) => request.body);
  assert.deepEqual(posts.map((body) => body.type), ["image_to_model", "animate_prerigcheck", "animate_rig", "animate_retarget"]);
  assert.deepEqual(posts[0].file, { type: "png", file_token: "img-token-1" });
  assert.equal(posts[2].rig_type, "biped");
  assert.deepEqual(posts[3], { type: "animate_retarget", original_model_task_id: "tripo-animate_rig-3", animation: "preset:run", out_format: "glb" });
  assert.equal(parseModel(result.text).animated, true);

  const unrig = await fakeServer(t, { riggable: false });
  await assert.rejects(runGen3d(node({ provider: "tripo", steps: ["generate", "rig"] }), { input: "탁자", render: () => "탁자", projectPath: root, keys: keysFor(unrig), ...fast }), /뼈대: .*뼈대를 넣을 수 없다고/);
  assert.ok(!unrig.requests.some((request) => request.body?.type === "animate_rig"));
});

test("gen3d: 실패한 단계부터 이어 하면 앞서 성공한 단계는 다시 만들지 않는다", async (t) => {
  const server = await fakeServer(t, { fail: { "meshy-refine": 1 } });
  const root = project(t);
  const settings = node({ provider: "meshy", steps: ["generate", "refine"] });
  const options = { input: "나무", render: () => "나무", projectPath: root, keys: keysFor(server), ...fast };
  const failed = await runGen3d(settings, options).then(() => null, (error) => error);
  assert.match(failed.message, /^다듬기: 작업 실패: 서버 혼잡/);
  assert.deepEqual(failed.record.steps.map((step) => [step.step, step.status]), [["generate", "success"], ["refine", "failed"]]);
  const again = await runGen3d(settings, { ...options, resume: failed.record });
  assert.equal(again.record.steps[0].reused, true);
  assert.equal(server.requests.filter((request) => request.method === "POST" && request.body?.mode === "preview").length, 1, "모양 만들기는 한 번만 요청한다");
  assert.equal(parseModel(again.text).step, "refine");
});

test("gen3d: 키가 없거나 틀리면 실행 전에·응답 문구로 알리고, 키 파일은 화면에 키를 내주지 않는다", async (t) => {
  const server = await fakeServer(t);
  const root = project(t);
  await assert.rejects(runGen3d(node({}), { input: "a", render: () => "a", projectPath: root, keys: { get: () => ({ apiKey: "", baseUrl: server.meshy }) }, ...fast }), /Meshy API 키가 없습니다/);
  await assert.rejects(runGen3d(node({}), { input: "a", render: () => "a", projectPath: root, keys: { get: () => ({ apiKey: "wrong", baseUrl: server.meshy }) }, ...fast }), /HTTP 401\): Invalid API key/);
  const keys = new Gen3dKeys({ dataDir: root, env: {} });
  assert.deepEqual(keys.list().map((item) => [item.id, item.configured]), [["meshy", false], ["tripo", false]]);
  const saved = keys.set("meshy", { apiKey: KEY, baseUrl: server.meshy + "/" });
  assert.equal(saved.configured, true);
  assert.equal(saved.baseUrl, server.meshy);
  assert.ok(!JSON.stringify(keys.list()).includes(KEY));
  assert.equal(await checkGen3dProvider("meshy", keys), "남은 크레딧 1234");
  keys.set("tripo", { apiKey: KEY, baseUrl: server.tripo });
  assert.equal(await checkGen3dProvider("tripo", keys), "남은 크레딧 99");
  assert.throws(() => keys.set("meshy", { baseUrl: "ftp://x" }), /http:\/\//);
  keys.set("meshy", { apiKey: "" });
  assert.equal(keys.list()[0].configured, false);
  assert.equal(new Gen3dKeys({ dataDir: root, env: { MESHY_API_KEY: "from-env" } }).get("meshy").apiKey, "from-env");
});

test("gen3d: 그래프에서 모양 노드 → 다듬기 노드로 이어 실행되고 노드마다 결과 기록이 쌓인다", { timeout: 30000 }, async (t) => {
  const server = await fakeServer(t);
  const root = project(t);
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const hub = createHub({ port: 0, dataDir: path.join(root, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "p", path: projectPath }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} }, gen3dSleep: () => new Promise((resolve) => setTimeout(resolve, 5)) } });
  await hub.start();
  t.after(() => hub.shutdown());
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  assert.equal((await api("GET", "gen3d")).providers[0].configured, false);
  await api("PUT", "gen3d/meshy", { apiKey: KEY, baseUrl: server.meshy });
  assert.ok(!JSON.stringify(await api("GET", "gen3d")).includes(KEY));
  assert.deepEqual(await api("POST", "gen3d/meshy/check"), { ok: true, message: "남은 크레딧 1234" });
  const shape = await api("POST", "commands", { kind: "gen3d", projectPath, provider: "meshy", steps: ["generate"], prompt: "의자" });
  const refine = await api("POST", "commands", { kind: "gen3d", projectPath, provider: "meshy", steps: ["refine"] });
  await api("POST", "links", { from: shape.id, to: refine.id, when: "success", enabled: true });
  await assert.rejects(api("POST", "commands", { kind: "gen3d", projectPath, provider: "meshy", steps: ["convert"] }), /지원하지 않습니다/);
  await api("POST", `commands/${shape.id}/run`, {});
  const commands = async () => (await api("GET", `commands?path=${encodeURIComponent(projectPath)}`)).commands;
  const end = Date.now() + 20000;
  let list;
  while (Date.now() < end) {
    list = await commands();
    if (list.find((item) => item.id === refine.id)?.state === "success") break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const first = list.find((item) => item.id === shape.id), second = list.find((item) => item.id === refine.id);
  assert.equal(first.state, "success", JSON.stringify(first.lastRun));
  assert.equal(second.state, "success", JSON.stringify(second.lastRun));
  assert.equal(first.history.length, 1);
  assert.equal(second.history[0].steps[0].step, "refine");
  assert.equal(parseModel(second.lastRun.outputText).taskIds.generate, "meshy-preview-1");
  assert.ok(fs.existsSync(parseModel(second.lastRun.outputText).files.glb));

  // 결과 파일: 이 노드 기록의 출력 폴더 안만 연다.
  const thumb = first.history[0].steps[0].thumbnail;
  const image = await fetch(`http://127.0.0.1:${hub.port}/api/commands/${shape.id}/gen3d/file?path=${encodeURIComponent(thumb)}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(await image.text(), "FILE /files/meshy-preview-1/thumb.png");
  const outside = path.join(projectPath, "secret.txt");
  fs.writeFileSync(outside, "x");
  assert.equal((await fetch(`http://127.0.0.1:${hub.port}/api/commands/${shape.id}/gen3d/file?path=${encodeURIComponent(outside)}`)).status, 403);

  // 지난 결과를 다시 만들지 않고 다음 노드로 넘긴다.
  const postsBefore = server.requests.filter((request) => request.method === "POST" && request.body?.mode === "preview").length;
  await api("POST", `commands/${shape.id}/gen3d/forward`, { runId: first.history[0].runId });
  const end2 = Date.now() + 20000;
  while (Date.now() < end2 && (await commands()).find((item) => item.id === refine.id).history.length < 2) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await commands()).find((item) => item.id === refine.id).history.length, 2);
  assert.equal(server.requests.filter((request) => request.method === "POST" && request.body?.mode === "preview").length, postsBefore, "모양은 다시 만들지 않는다");
  await assert.rejects(api("POST", `commands/${shape.id}/gen3d/forward`, { runId: "nope" }), { status: 404 });

  // 통합 노드를 단계 노드로 펼치면 연결이 첫·마지막 단계로 옮겨지고 단계 사이가 성공 연결로 이어진다.
  const whole = await api("POST", "commands", { kind: "gen3d", projectPath, provider: "meshy", preset: "prop", prompt: "나무 상자", pos: { x: 100, y: 200 } });
  await api("POST", "links", { from: whole.id, to: refine.id, when: "success", enabled: true });
  const { nodes } = await api("POST", `commands/${whole.id}/gen3d/expand`);
  assert.deepEqual(nodes.map((item) => item.steps), [["generate"], ["refine"], ["remesh"]]);
  assert.deepEqual(nodes.map((item) => item.pos), [{ x: 100, y: 200 }, { x: 380, y: 200 }, { x: 660, y: 200 }]);
  assert.equal(nodes[0].prompt, "나무 상자");
  const links = await api("GET", "links");
  assert.ok(!links.some((link) => link.from === whole.id || link.to === whole.id));
  assert.ok(links.some((link) => link.from === nodes[0].id && link.to === nodes[1].id && link.when === "success"));
  assert.ok(links.some((link) => link.from === nodes[2].id && link.to === refine.id));
  assert.ok(!(await commands()).some((item) => item.id === whole.id));
  await assert.rejects(api("POST", `commands/${nodes[0].id}/gen3d/expand`), /펼칠 것이 없습니다/);
});

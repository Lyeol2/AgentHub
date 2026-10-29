// Meshy를 CLI(meshy-cli)로 실행하는 경로. 실제 CLI 대신 같은 봉투를 쓰는 가짜 스크립트로 시험한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkGen3dNode, runGen3d, parseModel, Gen3dKeys, checkGen3dProvider } from "../server/gen3d.mjs";
import { findMeshyCli } from "../server/gen3d-meshy-cli.mjs";

// 가짜 CLI는 테스트 실행기가 테스트로 집지 않게 .txt로 두고, 실행할 때 임시 폴더에 .mjs로 복사한다.
const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-fake-meshy-"));
const FAKE = path.join(FAKE_DIR, "fake-meshy-cli.mjs");
fs.copyFileSync(fileURLToPath(new URL("./fixtures/fake-meshy-cli.mjs.txt", import.meta.url)), FAKE);
test.after(() => fs.rmSync(FAKE_DIR, { recursive: true, force: true }));

function setup(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-meshy-cli-"));
  const log = path.join(root, "calls.jsonl");
  const saved = {};
  for (const [key, value] of Object.entries({ FAKE_MESHY_LOG: log, FAKE_MESHY_FAIL: "", FAKE_MESHY_AUTH: "", ...env })) { saved[key] = process.env[key]; process.env[key] = value; }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const keys = (extra = {}) => ({ get: () => ({ apiKey: "", baseUrl: "https://api.meshy.ai", mode: "cli", cliPath: FAKE, ...extra }) });
  return { root, calls, keys };
}
const node = (fields) => ({ id: "n1", ...checkGen3dNode({ provider: "meshy", ...fields }) });
const flag = (args, name) => args[args.indexOf(name) + 1];

test("meshy cli: 통합 노드는 단계마다 CLI를 실행해 작업 ID로 잇고, 받은 파일과 기본 걷기 동작을 쓴다", async (t) => {
  const { root, calls, keys } = setup(t);
  const progress = [];
  const result = await runGen3d(node({ steps: ["generate", "refine", "remesh", "rig", "animate"], prompt: "귀여운 두리안", options: { format: "fbx", polycount: 5000, heightMeters: 1.2 } }), {
    input: "", render: (template) => template, projectPath: root, keys: keys(), onProgress: (item) => progress.push(item),
  });
  const runs = calls().map((call) => call.args);
  assert.deepEqual(runs.map((args) => args.slice(0, 2).join(" ")), ["text-to-3d create", "text-to-3d create", "remesh create", "rigging create"], "기본 걷기는 새 작업 없이 쓴다");
  assert.equal(flag(runs[0], "--mode"), "preview");
  assert.equal(flag(runs[0], "--prompt"), "귀여운 두리안");
  assert.equal(flag(runs[0], "--target-formats"), "fbx,glb");
  assert.equal(flag(runs[1], "--preview-task-id"), "text-to-3d-preview-1");
  assert.equal(flag(runs[2], "--input-task-id"), "text-to-3d-refine-2");
  assert.equal(flag(runs[2], "--target-polycount"), "5000");
  assert.equal(flag(runs[3], "--height-meters"), "1.2");
  assert.ok(runs[3].includes("--all-assets"), "뼈대 단계는 기본 동작 파일도 받는다");
  for (const args of runs) {
    assert.equal(flag(args, "--format"), "json");
    assert.ok(args.includes("--no-update-check"));
    assert.equal(flag(args, "--timeout"), "1800");
    assert.ok(!args.includes("--base-url-v1"), "기본 주소면 주소를 넘기지 않는다");
  }
  assert.ok(flag(runs[0], "-o").endsWith(`${path.sep}1-generate`));
  assert.ok(calls().every((call) => call.key === null), "키를 넣지 않으면 CLI 로그인 계정을 쓴다");
  const model = parseModel(result.text);
  assert.deepEqual(model.taskIds, { generate: "text-to-3d-preview-1", refine: "text-to-3d-refine-2", remesh: "remesh-3", rig: "rigging-4", animate: "rigging-4" });
  assert.equal(model.animated, true);
  assert.match(fs.readFileSync(model.files.fbx, "utf8"), /walking\.fbx/);
  assert.match(model.files.fbx, /6-animate[\\/]model\.fbx$/);
  assert.match(result.record.steps[0].thumbnail, /preview\.png$/);
  assert.ok(progress.some((item) => item.step === "generate" && item.progress === 50), "CLI 진행 줄의 퍼센트를 읽는다");
});

test("meshy cli: 실패한 작업은 오류 문구로 알리고, 이어 하면 성공한 단계를 다시 실행하지 않는다", async (t) => {
  const { root, calls, keys } = setup(t, { FAKE_MESHY_FAIL: "text-to-3d:refine" });
  const settings = node({ steps: ["generate", "refine"], prompt: "나무" });
  const failed = await runGen3d(settings, { input: "", render: (x) => x, projectPath: root, keys: keys() }).then(() => null, (error) => error);
  assert.match(failed.message, /^다듬기: 작업 실패: 서버 혼잡/);
  process.env.FAKE_MESHY_FAIL = "";
  const again = await runGen3d(settings, { input: "", render: (x) => x, projectPath: root, keys: keys(), resume: failed.record });
  assert.equal(again.record.steps[0].reused, true);
  assert.equal(calls().filter((call) => flag(call.args, "--mode") === "preview").length, 1);
});

test("meshy cli: 로그인하지 않았거나 CLI가 없으면 할 일을 알려 주고, 키·주소를 정하면 CLI에 넘긴다", async (t) => {
  const { root, calls, keys } = setup(t, { FAKE_MESHY_AUTH: "0" });
  await assert.rejects(runGen3d(node({ prompt: "a" }), { input: "", render: (x) => x, projectPath: root, keys: keys() }), /로그인이 필요합니다.*meshy auth login/);
  const store = new Gen3dKeys({ dataDir: root, env: {} });
  store.set("meshy", { cliPath: FAKE });
  assert.equal(store.list()[0].configured, true);
  assert.match(await checkGen3dProvider("meshy", store).then(() => "", (error) => error.message), /로그인하지 않았습니다/);
  process.env.FAKE_MESHY_AUTH = "";
  assert.equal(await checkGen3dProvider("meshy", store), "CLI 로그인됨 · 남은 크레딧 1206");
  await assert.rejects(runGen3d(node({ prompt: "a" }), { input: "", render: (x) => x, projectPath: root, keys: keys({ cliPath: path.join(root, "nope.js") }) }), /Meshy CLI를 찾지 못했습니다.*npm install -g meshy-cli/);
  assert.throws(() => store.set("meshy", { cliPath: path.join(root, "nope.js") }), /파일이 없습니다/);
  // 저장한 키와 다른 주소는 CLI의 환경 변수·옵션으로 넘긴다.
  await runGen3d(node({ prompt: "의자" }), { input: "", render: (x) => x, projectPath: root, keys: keys({ apiKey: "msy_test", baseUrl: "http://127.0.0.1:9" }) });
  const last = calls().at(-1);
  assert.equal(last.key, "msy_test");
  assert.equal(flag(last.args, "--base-url-v1"), "http://127.0.0.1:9/openapi/v1");
  assert.equal(flag(last.args, "--base-url-v2"), "http://127.0.0.1:9/openapi/v2");
});

test("meshy cli: PATH의 npm 전역 설치(meshy.cmd 옆 meshy-cli)를 찾아 셸 없이 node로 실행한다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-meshy-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, "node_modules", "meshy-cli", "dist", "index.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "");
  assert.equal(findMeshyCli("", { env: { PATH: root } }), null, "meshy 실행 파일이 없으면 찾지 않는다");
  fs.writeFileSync(path.join(root, "meshy.cmd"), "");
  assert.deepEqual(findMeshyCli("", { env: { PATH: root } }), { command: process.execPath, prefix: [entry], path: entry });
  assert.equal(findMeshyCli("", { env: { PATH: "" } }), null);
  assert.deepEqual(findMeshyCli(FAKE), { command: process.execPath, prefix: [FAKE], path: FAKE });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
// 실제 CLI는 받은 GLB의 머리를 검사하므로 JSON 덩어리 하나뿐인 최소 GLB를 만든다.
function glb(label) {
  let json = Buffer.from(JSON.stringify({ asset: { version: "2.0", generator: label } }));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}

// 이 PC에 설치된 실제 meshy-cli를 가짜 Meshy 서버에 붙여 봉투·다운로드 형식이 맞는지 본다(크레딧을 쓰지 않는다).
test("meshy cli: 설치된 실제 meshy-cli로 가짜 서버에서 모양 만들기 → 다듬기", { timeout: 120000 }, async (t) => {
  if (!findMeshyCli()) return t.skip("meshy-cli가 설치되어 있지 않다");
  const http = await import("node:http");
  const requests = [], tasks = new Map();
  let next = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization });
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.endsWith(".png")) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
    if (url.pathname.startsWith("/files/")) { res.writeHead(200, { "Content-Type": "model/gltf-binary" }); return res.end(glb(url.pathname)); }
    if (req.method === "POST" && url.pathname === "/openapi/v2/text-to-3d") { const id = `real-${JSON.parse(raw).mode}-${++next}`; tasks.set(id, 0); return json({ result: id }); }
    const match = url.pathname.match(/^\/openapi\/v2\/text-to-3d\/([\w-]+)$/);
    if (match && tasks.has(match[1])) {
      const id = match[1];
      return json({ id, type: "text-to-3d", status: "SUCCEEDED", progress: 100, created_at: 1, started_at: 1, finished_at: 2, model_urls: { glb: `${base}/files/${id}/model.glb` }, thumbnail_url: `${base}/files/${id}/preview.png`, texture_urls: [], task_error: { message: "" } });
    }
    json({ message: `not found ${req.method} ${url.pathname}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-meshy-real-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = { get: () => ({ apiKey: "msy_fake_for_tests", baseUrl: `http://127.0.0.1:${server.address().port}`, mode: "cli", cliPath: "" }) };
  const result = await runGen3d(node({ steps: ["generate", "refine"], prompt: "테스트 의자" }), { input: "", render: (x) => x, projectPath: root, keys });
  const model = parseModel(result.text);
  assert.deepEqual(model.taskIds, { generate: "real-preview-1", refine: "real-refine-2" });
  assert.match(fs.readFileSync(model.files.glb).toString("latin1"), /^glTF[\s\S]*\/files\/real-refine-2\/model\.glb/);
  assert.ok(fs.existsSync(result.record.steps[0].thumbnail), "썸네일도 받는다");
  const posts = requests.filter((request) => request.method === "POST");
  assert.equal(posts[0].body.mode, "preview");
  assert.equal(posts[0].body.prompt, "테스트 의자");
  assert.equal(posts[1].body.preview_task_id, "real-preview-1");
  assert.ok(posts.every((request) => request.auth === "Bearer msy_fake_for_tests"));
});

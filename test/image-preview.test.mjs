// 이미지 미리보기 노드: 넘어온 글에서 이미지 경로를 찾고, 허용 폴더 안의 파일만 보여 준다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractImagePaths, checkImage, imageRun, openRecordedImage, IMAGE_PREVIEW_MAX } from "../server/image-preview.mjs";
import { createHub } from "../server/bootstrap.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("image preview: 글에서 이미지 경로를 찾는다(목록·링크·공백 든 경로·중복·주소 제외)", () => {
  const text = [
    "결과 이미지:",
    "- C:\\work\\out\\hero shot.png",
    "./renders/a.png",
    "![시안](docs/img/b.webp) 그리고 [c](<C:/x y/c.jpg>)",
    "만든 파일은 out/d.jpeg 와 `e.gif` 입니다.",
    "https://example.com/x.png",
    "c:\\WORK\\out\\hero shot.png",
    "file:///C:/z/f.png",
    "notes.txt",
  ].join("\n");
  assert.deepEqual(extractImagePaths(text), ["C:\\work\\out\\hero shot.png", "./renders/a.png", "docs/img/b.webp", "C:/x y/c.jpg", "out/d.jpeg", "e.gif", "C:/z/f.png"]);
  assert.equal(extractImagePaths(Array.from({ length: 30 }, (_, i) => `img/${i}.png`).join("\n")).length, IMAGE_PREVIEW_MAX);
  assert.deepEqual(extractImagePaths("그림 없음"), []);
});

test("image preview: 허용 폴더 안의 이미지 파일만 받고, 이유를 남긴다", (t) => {
  const root = tempRoot(t);
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "out"), { recursive: true });
  fs.writeFileSync(path.join(project, "out", "a.png"), PNG);
  fs.writeFileSync(path.join(project, "out", "note.txt"), "x");
  fs.writeFileSync(path.join(root, "outside.png"), PNG);
  const options = { base: project, roots: [project] };
  const ok = checkImage("out/a.png", options);
  assert.equal(ok.error, undefined);
  assert.equal(ok.mimeType, "image/png");
  assert.equal(ok.size, PNG.length);
  assert.match(checkImage("out/missing.png", options).error, /파일이 없습니다/);
  assert.match(checkImage("../outside.png", options).error, /밖의 파일/);
  assert.match(checkImage(path.join(root, "outside.png"), options).error, /밖의 파일/);
  assert.match(checkImage("out/note.txt", options).error, /이미지 형식/);
  const run = imageRun("out/a.png\nout/missing.png", { ...options, origin: { id: "s1", title: "디자인" } });
  assert.equal(run.ok, true);
  assert.equal(run.originTitle, "디자인");
  assert.deepEqual(run.images.map((image) => !!image.error), [false, true]);
  assert.equal(openRecordedImage(run, 0).mimeType, "image/png");
  assert.equal(openRecordedImage(run, 1), null, "열 수 없던 경로는 열지 않는다");
  assert.equal(openRecordedImage(run, 9), null);
  fs.rmSync(path.join(project, "out", "a.png"));
  assert.match(openRecordedImage(run, 0).error, /파일이 없습니다/, "나중에 지워진 파일");
  const none = imageRun("이미지 없음", options);
  assert.equal(none.ok, false);
  assert.match(none.error, /찾지 못했습니다/);
  assert.equal(none.text, "이미지 없음");
});

test("image preview api: handoff 전달 내용의 경로를 받아 보이고, 기록에 있는 이미지만 열며, 끝 노드로만 쓴다", { timeout: 30000 }, async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "renders"), { recursive: true });
  fs.writeFileSync(path.join(root, "renders", "a.png"), PNG);
  fs.writeFileSync(path.join(root, "renders", "b.png"), PNG);
  const hub = createHub({ port: 0, dataDir: path.join(root, ".data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "demo", path: root }] },
    deps: { cliPaths: () => ({ claude: "claude", codex: "codex" }), discoverProjects: () => [], logger: { log() {} } } });
  await hub.start();
  t.after(() => hub.shutdown());
  const base = `http://127.0.0.1:${hub.port}/api/`;
  const api = async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  const s = await api("POST", "sessions", { projectPath: root, agent: "claude", title: "디자인" });
  const node = await api("POST", "commands", { projectPath: root, kind: "image", title: "" });
  assert.equal(node.kind, "image");
  assert.equal(node.title, "이미지 미리보기");
  await api("POST", "links", { from: s.id, to: node.id, when: "keyword", keyword: "시안 완료" });
  await assert.rejects(api("POST", "links", { from: node.id, to: s.id }), /마지막 노드/);
  await assert.rejects(api("POST", `commands/${node.id}/run`, {}), /이미지 경로를 보여/);
  // 세션에 붙는 안내와 handoff 도구 설명이 경로 쓰는 법을 알린다.
  assert.match(hub.services.sessions.composeInput(hub.store.get(s.id), "그려 줘"), /이미지 미리보기 노드로 넘길 때는 content에 보여 줄 이미지 파일 경로를 한 줄에 하나씩/);

  const session = hub.store.get(s.id);
  session.events.push({ kind: "user", text: "그려 줘" }, { kind: "text", text: "다 그렸다. renders/zzz.png는 버렸다." },
    { kind: "handoff", verdict: "시안 완료", content: "renders/a.png\nrenders/b.png\n../밖.png" });
  await hub.chain.onTurnEnd(session, true);
  const stored = hub.commands.get(node.id);
  assert.equal(stored.state, "success");
  assert.equal(stored.history.length, 1);
  assert.deepEqual(stored.history[0].images.map((image) => [image.name, !!image.error]), [["a.png", false], ["b.png", false], ["밖.png", true]]);
  assert.equal(stored.history[0].originTitle, "디자인");
  assert.match(stored.lastRun.tail, /이미지 2개 · 열 수 없음 1개/);
  assert.ok(session.events.some((e) => e.kind === "status" && /이미지 2개를 보냈습니다/.test(e.text)));

  const image = await fetch(`${base}commands/${node.id}/image?run=0&index=1`, { headers: { "x-agenthub": "1" } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}commands/${node.id}/image?run=0&index=2`, { headers: { "x-agenthub": "1" } })).status, 404, "열 수 없던 경로");
  assert.equal((await fetch(`${base}commands/${node.id}/image?run=3&index=0`, { headers: { "x-agenthub": "1" } })).status, 404);

  // 경로가 없으면 실패로 남기고, 기록은 최근 10번까지 둔다.
  for (let i = 0; i < 11; i++) {
    session.events.push({ kind: "user", text: "다시" }, { kind: "text", text: i === 10 ? "이번에는 그림이 없다" : `renders/a.png` }, { kind: "handoff", verdict: "시안 완료" });
    await hub.chain.onTurnEnd(session, true);
  }
  const latest = hub.commands.get(node.id);
  assert.equal(latest.history.length, 10);
  assert.equal(latest.state, "error");
  assert.match(latest.history[0].error, /찾지 못했습니다/);
  assert.equal(latest.history[1].images[0].name, "a.png", "전달 내용이 없으면 답변에서 찾는다");
});

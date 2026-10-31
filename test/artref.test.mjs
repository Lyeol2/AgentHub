// 아트 레퍼런스 노드: 폴더·INDEX.md 관리, 세션에만 잇는 참고 연결, 세션 요청에 붙는 안내(매 요청·전체·대화 요약 직후).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkArtrefNode, syncArtref, addArtrefImage, listArtrefImages, artrefNotice } from "../server/artref.mjs";
import { buildArgs } from "../server/agents/claude.mjs";
import { createHub } from "../server/bootstrap.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("artref: 노드 설정·폴더·INDEX.md·이미지 넣기", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-artref-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fields = checkArtrefNode({ title: "브랜드 무드", style: "따뜻한 파스텔\n둥근 모서리", palette: "#F6C453, #2B3A55", items: { "button.png": { note: "버튼 모양", tags: "UI, 색" } } });
  assert.equal(fields.folder, "references/브랜드-무드");
  assert.deepEqual(fields.palette, ["#F6C453", "#2B3A55"]);
  assert.deepEqual(fields.items["button.png"], { note: "버튼 모양", tags: ["UI", "색"] });
  assert.throws(() => checkArtrefNode({ palette: "빨강" }), /색 코드/);
  assert.throws(() => checkArtrefNode({ folder: "../밖" }), /올바르지 않습니다/);
  const node = { id: "cmd-1", projectPath: root, ...fields };
  assert.equal(addArtrefImage(node, { name: "button.png", data: PNG }), "button.png");
  assert.equal(addArtrefImage(node, { name: "button.png", data: PNG }), "button-2.png", "같은 이름은 번호를 붙인다");
  assert.throws(() => addArtrefImage(node, { name: "note.txt", data: PNG }), /이미지만/);
  fs.mkdirSync(path.join(root, "references", "브랜드-무드", "chars"));
  fs.writeFileSync(path.join(root, "references", "브랜드-무드", "chars", "hero.png"), Buffer.from(PNG, "base64"));
  assert.deepEqual(listArtrefImages(node), ["button-2.png", "button.png", "chars/hero.png"]);
  const first = syncArtref(node);
  const index = fs.readFileSync(first.index, "utf8");
  assert.match(index, /# 아트 레퍼런스 · 브랜드 무드/);
  assert.match(index, /## 스타일\n따뜻한 파스텔\n둥근 모서리/);
  assert.match(index, /## 팔레트\n#F6C453 #2B3A55/);
  assert.match(index, /- button\.png — 버튼 모양 · \[UI, 색\] · 1×1/);
  assert.match(index, /- chars\/hero\.png — 1×1/);
  assert.equal(syncArtref(node).key, first.key, "바뀐 것이 없으면 같은 지문");
  node.items["chars/hero.png"] = { note: "주인공", tags: [] };
  assert.notEqual(syncArtref(node).key, first.key, "메모가 바뀌면 지문이 바뀐다");
});

test("artref: 짧은 안내와 전체 안내의 문구", () => {
  const refs = [{ title: "브랜드", folder: "D:/refs/brand", images: ["a.png"], style: "따뜻한 파스텔\n둘째 줄" }];
  const short = artrefNotice(refs);
  assert.match(short, /^\[아트 레퍼런스\]/);
  assert.match(short, /- 브랜드: D:\/refs\/brand \(먼저 INDEX\.md\) · 이미지 1장 · 따뜻한 파스텔/);
  assert.match(short, /색·형태를 지금 구체적으로 말할 수 없으면 INDEX\.md와 관련 이미지를 다시 연다/);
  assert.match(short, /참고한 레퍼런스: 파일 이름/);
  assert.ok(!short.includes("둘째 줄"));
  assert.match(artrefNotice(refs, { full: true, reason: "레퍼런스가 바뀌었다." }), /^\[아트 레퍼런스 안내\] 레퍼런스가 바뀌었다\.\n[\s\S]*먼저 각 폴더의 INDEX\.md를 읽고/);
  assert.equal(artrefNotice([]), "");
});

test("artref: 세션에만 참고로 잇고, 연결된 세션의 요청마다 안내를 붙이며, 대화 요약 직후 다시 열라고 알린다", { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-artref-hub-"));
  const projectPath = path.join(root, "project");
  const outside = path.join(root, "shared-refs");
  fs.mkdirSync(projectPath);
  const hub = createHub({ port: 0, dataDir: path.join(root, "data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "p", path: projectPath }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  const session = { id: "s1", title: "디자인", agent: "claude", permission: "default", projectPath, projectName: "p", cwd: projectPath, state: "idle", worktree: null, skills: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
  hub.store.add(session);
  await hub.start();
  t.after(async () => { await hub.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  const ref = await api("POST", "commands", { kind: "artref", projectPath, title: "브랜드 무드", style: "따뜻한 파스텔" });
  assert.ok(fs.existsSync(path.join(projectPath, "references", "브랜드-무드", "INDEX.md")), "만들면 폴더와 INDEX.md가 생긴다");
  const uploaded = await api("POST", `commands/${ref.id}/artref/images`, { name: "mood.png", data: PNG });
  assert.deepEqual(uploaded.images, ["mood.png"]);
  const image = await fetch(`http://127.0.0.1:${hub.port}/api/commands/${ref.id}/artref/image?name=mood.png`);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal((await fetch(`http://127.0.0.1:${hub.port}/api/commands/${ref.id}/artref/image?name=..%2F..%2Fx.png`)).status, 404);
  const listed = (await api("GET", `commands?path=${encodeURIComponent(projectPath)}`)).commands.find((item) => item.id === ref.id);
  assert.deepEqual(listed.images, ["mood.png"]);
  // 참고 연결: 세션에만, 실행하지 않음
  const cmd = await api("POST", "commands", { kind: "command", projectPath, command: "echo hi" });
  await assert.rejects(api("POST", "links", { from: ref.id, to: cmd.id }), /프로젝트 세션에만/);
  await assert.rejects(api("POST", "links", { from: "s1", to: ref.id, when: "success" }), /들어오는 연결은 만들 수 없습니다/);
  await assert.rejects(api("POST", "links", { from: "s1", to: cmd.id, when: "ref" }), /아트 레퍼런스 노드에서 세션으로만/);
  const link = await api("POST", "links", { from: ref.id, to: "s1", when: "success" });
  assert.equal(link.when, "ref", "레퍼런스에서 나가는 연결은 늘 참고 연결이다");
  await assert.rejects(api("POST", `links/${link.id}/run`), /넘길 결과가 없습니다/);
  await assert.rejects(api("POST", `commands/${ref.id}/run`, {}), /실행하지 않습니다/);
  // 세션 요청에 붙는 안내
  const compose = (prompt) => hub.services.sessions.composeInput(session, prompt);
  const first = compose("로그인 화면 계획서 써 줘");
  assert.match(first, /\[아트 레퍼런스 안내\]\n[\s\S]*브랜드 무드: .*브랜드-무드 \(먼저 INDEX\.md\) · 이미지 1장 · 따뜻한 파스텔[\s\S]*로그인 화면 계획서 써 줘/, "새 대화는 전체 안내");
  session.agentSessionId = "conversation-1";
  const second = compose("버튼 색 바꿔 줘");
  assert.match(second, /^\[아트 레퍼런스\] 디자인·이미지 작업이면 참고한다/, "이어지는 대화는 짧은 안내");
  assert.ok(!second.includes("[아트 레퍼런스 안내]"));
  await api("PUT", `commands/${ref.id}`, { items: { "mood.png": { note: "전체 톤", tags: ["색"] } } });
  assert.match(fs.readFileSync(path.join(projectPath, "references", "브랜드-무드", "INDEX.md"), "utf8"), /mood\.png — 전체 톤 · \[색\]/);
  assert.match(compose("다음 화면"), /\[아트 레퍼런스 안내\] 레퍼런스가 바뀌었다\./, "메모가 바뀌면 전체 안내");
  assert.match(compose("또 다음"), /^\[아트 레퍼런스\] /);
  // 작업 중 대화 요약: 진행 중인 작업에 끼워 넣고, 다음 요청에는 전체 안내
  const injected = [];
  hub.runner.canInject = () => true;
  hub.runner.inject = (target, text, meta) => injected.push({ target: target.id, text, meta });
  session.referencesCompacted = true;
  hub.runner.emit("compacted", session);
  assert.equal(injected.length, 1);
  assert.match(injected[0].text, /^\[대화가 요약되었다\] 아트 레퍼런스의 INDEX\.md를 다시 읽고, 지금 작업에 관련된 이미지를 다시 열어 본 뒤/);
  assert.match(compose("이어서"), /\[아트 레퍼런스 안내\] 대화가 요약되어 다시 알린다\./);
  // 작업 폴더 밖의 레퍼런스 폴더는 Claude가 읽을 수 있게 연다.
  await api("PUT", `commands/${ref.id}`, { folder: outside.replaceAll("\\", "/") });
  compose("밖 폴더");
  assert.deepEqual(session.referenceDirs, [outside]);
  assert.ok(buildArgs(session).join(" ").includes(`--add-dir ${outside}`));
  // 연결을 끄면 안내도 사라진다.
  await api("PUT", `links/${link.id}`, { enabled: false });
  const off = compose("연결 끔");
  assert.ok(!off.includes("아트 레퍼런스"));
  assert.deepEqual(session.referenceDirs, []);
});

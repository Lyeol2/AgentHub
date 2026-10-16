import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeGroupStore, createNodeGroupService } from "../server/node-groups.mjs";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-node-groups-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const projectPath = path.join(dataDir, "project");
  const otherPath = path.join(dataDir, "other");
  const sessions = new Map([
    ["s-a", { id: "s-a", title: "개발", projectPath, createdAt: "2026-01-01", graphPos: { x: 100, y: 100 } }],
    ["s-b", { id: "s-b", title: "검토", projectPath, createdAt: "2026-01-02", graphPos: { x: 450, y: 100 } }],
    ["s-out", { id: "s-out", title: "외부", projectPath, createdAt: "2026-01-03", graphPos: { x: 900, y: 100 } }],
    ["s-chat", { id: "s-chat", title: "채팅", projectPath, chat: true }],
    ["s-other", { id: "s-other", title: "다른 프로젝트", projectPath: otherPath }],
  ]);
  const commandNodes = ["command", "git", "button", "markdown", "group"].map((kind, i) => ({
    id: `cmd-${kind}`, kind, title: kind, projectPath, pos: { x: 100 + i * 300, y: 300 },
    ...(kind === "group" ? { members: ["s-a", "s-b"] } : {}),
  }));
  const touched = [], notifications = [], wires = [];
  const store = { get: (id) => sessions.get(id), list: () => [...sessions.values()], touch: (session) => touched.push(session.id) };
  const commands = {
    get: (id) => commandNodes.find((item) => item.id === id),
    list: () => commandNodes,
    update: (command, fields) => Object.assign(command, fields),
  };
  const links = { list: () => wires };
  const groups = new NodeGroupStore({ dataDir });
  const ensureCalls = [];
  const projects = { ensureProject: (value) => { ensureCalls.push(value); return { path: value }; } };
  const service = createNodeGroupService({ groups, store, commands, links, projects, notify: (kind) => notifications.push(kind) });
  const create = (members = ["s-a", "cmd-git"], extra = {}) => service.create({ projectPath, members, ...extra });
  return { dataDir, projectPath, otherPath, sessions, commandNodes, touched, notifications, wires, groups, service, create, ensureCalls };
}

test("노드 그룹: 모든 노드 종류를 포함하고 접힘·포트·위치를 재시작 후 복원한다", (t) => {
  const f = fixture(t);
  const members = ["s-a", "cmd-command", "cmd-git", "cmd-button", "cmd-markdown", "cmd-group"];
  const group = f.create(members, { title: "개발 과정", collapsed: true, ports: [
    { id: "start", direction: "input", nodeId: "s-a", label: "시작" },
    { id: "merged", direction: "output", nodeId: "cmd-git", label: "병합 완료", when: "success" },
  ] });
  assert.match(group.id, /^grp-/);
  assert.equal(group.title, "개발 과정");
  assert.equal(group.collapsed, true);
  assert.deepEqual(group.members, members);
  assert.ok(group.rect.x <= 100 && group.rect.y <= 100);
  assert.ok(group.rect.x + group.rect.w >= 1300 + 230);
  assert.deepEqual(new NodeGroupStore({ dataDir: f.dataDir }).get(group.id), group);
  assert.deepEqual(f.commandNodes.at(-1).members, ["s-a", "s-b"], "기존 결과 모으기의 멤버는 별개로 유지한다");
});

test("노드 그룹: 중복 소속·중첩·다른 프로젝트·일반 채팅을 거절한다", (t) => {
  const f = fixture(t);
  const group = f.create();
  assert.throws(() => f.create(["s-a"]), { status: 409 });
  for (const id of ["s-chat", "s-other", "missing", group.id]) assert.throws(() => f.create([id]), { status: 400 });
  assert.throws(() => f.create([]), /하나 이상/);
  assert.equal(f.groups.list().length, 1);
  f.service.update(group.id, { members: ["s-a", "s-a"] });
  assert.deepEqual(group.members, ["s-a"]);
});

test("노드 그룹: 경계를 넘는 연결만 입출력으로 자동 노출하며 실행 연결은 유지한다", (t) => {
  const f = fixture(t);
  f.wires.push(
    { id: "incoming", from: "s-out", to: "s-a", when: "success", enabled: true },
    { id: "internal", from: "s-a", to: "cmd-git", when: "success", enabled: true },
    { id: "ok", from: "cmd-git", to: "s-out", when: "success", enabled: true },
    { id: "err", from: "cmd-git", to: "s-out", when: "error", enabled: true },
  );
  const original = structuredClone(f.wires);
  const group = f.create();
  assert.equal(group.ports.length, 3);
  assert.deepEqual(group.ports.filter((port) => port.direction === "input").map((port) => port.nodeId), ["s-a"]);
  assert.deepEqual(group.ports.filter((port) => port.direction === "output").map((port) => port.when), ["success", "error"]);
  const output = group.ports.find((port) => port.when === "error");
  assert.equal(f.service.resolvePort(group.id, output.id, "output").nodeId, "cmd-git");
  assert.throws(() => f.service.resolvePort(group.id, output.id, "input"), { status: 400 });
  f.service.update(group.id, { ports: [] });
  assert.deepEqual(f.wires, original, "포트 별칭을 삭제해도 실제 연결·조건은 변경하지 않는다");
  assert.equal(group.ports.length, 3, "실제 경계 연결에 필요한 별칭은 자동 유지한다");
  let saves = 0;
  const save = f.groups.save.bind(f.groups);
  f.groups.save = () => { saves++; save(); };
  f.service.list(f.projectPath);
  f.service.list(f.projectPath);
  assert.equal(saves, 0, "변경 없는 반복 조회는 파일을 저장하지 않는다");
  assert.equal(f.ensureCalls.length, 1, "조회는 프로젝트를 다시 등록하지 않는다");
});

test("노드 그룹: 멤버 이동은 세션과 모든 명령 위치를 함께 옮기고 크기 조절은 보존한다", (t) => {
  const f = fixture(t);
  const group = f.create(["s-a", "cmd-command", "cmd-git", "cmd-button", "cmd-markdown", "cmd-group"]);
  const initial = structuredClone(group.rect);
  f.service.update(group.id, { rect: { ...initial, x: initial.x + 50, y: initial.y + 70 } });
  assert.deepEqual(f.sessions.get("s-a").graphPos, { x: 150, y: 170 });
  for (let i = 0; i < f.commandNodes.length; i++) assert.deepEqual(f.commandNodes[i].pos, { x: 150 + i * 300, y: 370 });
  assert.deepEqual(f.sessions.get("s-b").graphPos, { x: 450, y: 100 }, "그룹 외부 세션은 그대로다");
  const positions = f.commandNodes.map((item) => structuredClone(item.pos));
  f.service.update(group.id, { rect: { ...group.rect, w: group.rect.w + 100, h: group.rect.h + 100 } });
  assert.deepEqual(f.commandNodes.map((item) => item.pos), positions);
  assert.ok(f.notifications.includes("sessions") && f.notifications.includes("commands"));
});

test("노드 그룹: 잘못된 수정은 위치·이름·소속·저장 파일을 부분 변경하지 않는다", (t) => {
  const f = fixture(t);
  const group = f.create();
  const before = structuredClone(group), sessionPos = structuredClone(f.sessions.get("s-a").graphPos);
  const disk = fs.readFileSync(f.groups.file, "utf8");
  assert.throws(() => f.service.update(group.id, { title: "바뀌면 안 됨", rect: { ...group.rect, x: group.rect.x + 80 }, ports: [{ id: "bad", direction: "output", nodeId: "s-out" }] }), { status: 400 });
  assert.deepEqual(group, before);
  assert.deepEqual(f.sessions.get("s-a").graphPos, sessionPos);
  assert.equal(fs.readFileSync(f.groups.file, "utf8"), disk);
  for (const patch of [{ members: ["s-other"] }, { members: null }, { collapsed: "yes" }, { rect: { x: 0, y: 0, w: 1, h: 1 } }]) assert.throws(() => f.service.update(group.id, patch), { status: 400 });
});

test("노드 그룹: 버튼 입력·Markdown 출력·잘못된 Git 조건·중복 포트를 거절한다", (t) => {
  const f = fixture(t);
  const members = ["s-a", "cmd-button", "cmd-markdown", "cmd-git"];
  for (const port of [
    { direction: "input", nodeId: "cmd-button" },
    { direction: "output", nodeId: "cmd-markdown" },
    { direction: "output", nodeId: "cmd-git", when: "keyword", keyword: "완료" },
    { direction: "output", nodeId: "s-a", when: "keyword" },
    { direction: "output", nodeId: "s-a", when: "unknown" },
  ]) assert.throws(() => f.create(members, { ports: [port] }), { status: 400 });
  assert.throws(() => f.create(members, { ports: [{ id: "one", direction: "input", nodeId: "s-a" }, { id: "two", direction: "input", nodeId: "s-a" }] }), /중복/);
  assert.equal(f.groups.list().length, 0);
});

test("노드 그룹: 세션 재생성 시 소속·포트 별칭을 새 ID로 옮기고 삭제 시 정리한다", (t) => {
  const f = fixture(t);
  const group = f.create(["s-a"], { ports: [{ id: "result", direction: "output", nodeId: "s-a", when: "keyword", keyword: "완료", label: "완료" }] });
  f.sessions.set("s-new", { ...f.sessions.get("s-a"), id: "s-new" });
  f.sessions.delete("s-a");
  f.service.replaceNode("s-a", "s-new");
  assert.deepEqual(group.members, ["s-new"]);
  assert.deepEqual(group.ports[0], { id: "result", direction: "output", nodeId: "s-new", when: "keyword", keyword: "완료", label: "완료" });
  f.service.pruneNode("s-new");
  assert.deepEqual(group.members, []);
  assert.deepEqual(group.ports, []);
  f.service.update(group.id, { members: ["s-b"] });
  f.sessions.delete("s-b");
  f.service.list(f.projectPath);
  assert.deepEqual(group.members, [], "조회 중 누락 노드도 정리한다");
});

test("노드 그룹: 해제는 노드와 실행 연결을 보존하고 프로젝트 정리는 해당 박스만 제거한다", (t) => {
  const f = fixture(t);
  f.wires.push({ id: "l1", from: "s-a", to: "cmd-git", when: "success", enabled: true });
  const group = f.create();
  const wire = structuredClone(f.wires);
  f.service.remove(group.id);
  assert.ok(f.sessions.has("s-a"));
  assert.ok(f.commandNodes.some((item) => item.id === "cmd-git"));
  assert.deepEqual(f.wires, wire);
  assert.throws(() => f.service.remove(group.id), { status: 404 });
  f.create();
  const other = f.service.create({ projectPath: f.otherPath, members: ["s-other"] });
  const calls = f.ensureCalls.length;
  f.service.removeProject(f.projectPath);
  assert.deepEqual(f.groups.list().map((item) => item.id), [other.id]);
  assert.equal(f.ensureCalls.length, calls);
});

test("노드 그룹: 자동 배치 위치를 그룹 생성 때 고정하고 이후 상자와 함께 이동한다", (t) => {
  const f = fixture(t);
  f.sessions.get("s-a").graphPos = null;
  f.commandNodes.find((item) => item.id === "cmd-git").pos = null;
  f.wires.push({ id: "l1", from: "s-a", to: "cmd-git", when: "success" });
  const group = f.create();
  assert.deepEqual(f.sessions.get("s-a").graphPos, { x: 20, y: 20 });
  assert.deepEqual(f.commandNodes.find((item) => item.id === "cmd-git").pos, { x: 346, y: 20 });
  f.service.update(group.id, { rect: { ...group.rect, x: group.rect.x + 40, y: group.rect.y + 30 }, collapsed: true });
  assert.deepEqual(f.sessions.get("s-a").graphPos, { x: 60, y: 50 });
  assert.deepEqual(f.commandNodes.find((item) => item.id === "cmd-git").pos, { x: 386, y: 50 });
});

test("노드 그룹: 바깥 노드를 추가하면 좌표를 움직이지 않고 상자를 자동 확장한다", (t) => {
  const f = fixture(t);
  f.sessions.get("s-a").graphPos = { x: 20, y: 10 };
  const git = f.commandNodes.find((item) => item.id === "cmd-git");
  git.pos = { x: 1500, y: 900 };
  const group = f.create(["s-b"]);
  const before = structuredClone(group.rect);
  assert.equal(f.service.hasNode("s-b"), true);
  assert.equal(f.service.hasNode("s-a"), false);
  f.service.update(group.id, { members: ["s-b", "s-a", "cmd-git"] });
  assert.ok(group.rect.x < before.x && group.rect.y < before.y);
  assert.ok(group.rect.x <= 20 && group.rect.y <= 10);
  assert.ok(group.rect.x + group.rect.w >= 1730 && group.rect.y + group.rect.h >= 1008);
  assert.deepEqual(f.sessions.get("s-b").graphPos, { x: 450, y: 100 });
  assert.deepEqual(f.sessions.get("s-a").graphPos, { x: 20, y: 10 });
  assert.deepEqual(git.pos, { x: 1500, y: 900 });
  assert.equal(f.service.hasNode("s-a"), true);
  assert.equal(f.service.hasNode("cmd-git"), true);
  const expanded = structuredClone(group.rect);
  f.service.update(group.id, { members: ["s-b"] });
  assert.deepEqual(group.rect, expanded, "노드를 꺼내는 것만으로는 상자를 줄이지 않는다");
  assert.equal(f.service.hasNode("s-a"), false);
});

test("노드 그룹: 입력·감시는 시작점이며 반복 출력 조건을 유지한다", (t) => {
  const f = fixture(t);
  for (const kind of ["input", "watch", "repeat", "transform"]) f.commandNodes.push({ id: "cmd-" + kind, kind, title: kind, projectPath: f.projectPath, pos: { x: 100, y: 100 } });
  const group = f.create(["cmd-input", "cmd-watch", "cmd-repeat", "cmd-transform"], { ports: [
    { direction: "output", nodeId: "cmd-repeat", when: "success" },
    { direction: "output", nodeId: "cmd-repeat", when: "error" },
    { direction: "input", nodeId: "cmd-transform" },
  ] });
  for (const nodeId of ["cmd-input", "cmd-watch"]) assert.throws(() => f.service.update(group.id, { ports: [{ direction: "input", nodeId }] }), { status: 400 });
  assert.throws(() => f.service.update(group.id, { ports: [{ direction: "output", nodeId: "cmd-repeat", when: "keyword", keyword: "실패" }] }), { status: 400 });
  assert.equal(f.groups.get(group.id).ports.length, 3);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createCreationController } from "../public/features/creation/controller.js";

function element() {
  return {
    value: "", checked: false, disabled: false, hidden: false, required: false, handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelectorAll() { return []; },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ""; },
    setCustomValidity(message) { this.validationMessage = message; },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    close() { this.open = false; this.handlers.close?.(); },
  };
}
function setup() {
  const nodes = new Map(), calls = [], roles = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  globalThis.document = { getElementById: get };
  globalThis.FormData = class extends Map { constructor(form) { super(form.fields); } };
  const data = { status: { agents: { claude: { permissions: ["default", "acceptEdits"] }, codex: { permissions: ["read-only", "workspace-write"] } } } };
  const navigation = { view: "project", project: "C:/repo" };
  const service = { api: async (...args) => { calls.push(args); return { id: "created" }; } };
  const controller = createCreationController({
    data, navigation,
    api: (...args) => service.api(...args),
    loadStatus: async () => {}, loadSessions: async () => {}, loadProjects: async () => {},
    sortedProjects: () => [{ path: "C:/repo", name: "repo" }],
    loadHub: async () => ({ roles }), fillModels: () => {}, fillEfforts: () => {},
    connectCreatedGraphNode: async (...args) => calls.push(["connect", ...args]),
    openChat: () => {}, openSettings: () => {},
  });
  // The view's element helper uses the same minimal DOM as the real controller.
  document.createElement = (_tag) => ({ ...element(), setAttribute(key, value) { this[key] = value; }, append() {} });
  get("new-agent").value = "codex";
  return { data, navigation, calls, roles, get, controller, service };
}
function submit(h, fields) {
  return h.get("new-form").handlers.submit({ submitter: { value: "ok" }, preventDefault() {}, target: { fields, reset() {} } });
}

test("새 세션은 취소 후 다시 열거나 오케스트레이터를 만들어도 원본 폴더가 기본이다", async () => {
  const h = setup();
  h.get("new-isolate").checked = true;
  h.get("new-worktree-name").value = "previous";
  await h.controller.openNew("C:/repo");
  assert.equal(h.get("new-isolate").checked, false);
  assert.equal(h.get("new-worktree-name").value, "");
  assert.equal(h.get("new-worktree-name").disabled, true);
  h.get("new-isolate").checked = true;
  h.get("new-worktree-name").value = "another";
  await h.controller.openNew("C:/repo", { orchestrator: true });
  assert.equal(h.get("new-orchestrator").checked, true);
  assert.equal(h.get("new-isolate").checked, false);
  assert.equal(h.get("new-worktree-name").value, "");
});

test("워크트리를 선택해야 이름 입력이 필수이며 채팅으로 바꾸면 해제한다", () => {
  const h = setup();
  h.get("new-isolate").checked = true;
  h.get("new-worktree-name").handlers.input();
  assert.equal(h.get("new-worktree-row").hidden, false);
  assert.equal(h.get("new-worktree-name").disabled, false);
  assert.equal(h.get("new-worktree-name").required, true);
  assert.match(h.get("new-worktree-name").validationMessage, /입력/);
  h.get("new-worktree-name").value = "bag-ui";
  h.get("new-worktree-name").handlers.input();
  assert.equal(h.get("new-worktree-name").validationMessage, "");
  h.get("new-agent").value = "codex-chat";
  h.get("new-agent").handlers.change();
  assert.equal(h.get("new-isolate").checked, false);
  assert.equal(h.get("new-isolate").disabled, true);
  assert.equal(h.get("new-worktree-name").required, false);
  assert.equal(h.get("new-worktree-name").disabled, true);
  assert.equal(h.get("new-worktree-name").validationMessage, "");
});

test("역할 템플릿의 이전 분리 설정이 워크트리를 자동 선택하지 않는다", async () => {
  const h = setup();
  h.roles.push(...[{ name: "구현", agent: "codex", model: "", permission: "workspace-write", body: "구현한다", isolate: true }]);
  await h.controller.openNew("C:/repo");
  await Promise.resolve();
  h.get("new-template").value = "구현";
  h.get("new-template").handlers.change();
  assert.equal(h.get("new-isolate").checked, false);
  assert.equal(h.get("new-worktree-name").required, false);
  h.get("new-isolate").checked = true;
  h.get("new-worktree-name").value = "chosen";
  h.get("new-template").handlers.change();
  assert.equal(h.get("new-isolate").checked, true);
  assert.equal(h.get("new-worktree-name").value, "chosen");
});

test("워크트리 이름이 없거나 안전하지 않으면 세션을 만들지 않는다", async () => {
  const h = setup();
  for (const name of ["", " ", "../escape", "-leading", "has space", "a".repeat(65), "CON", "lpt1"]) {
    await submit(h, [["projectPath", "C:/repo"], ["isolate", "on"], ["worktreeName", name]]);
    assert.equal(h.calls.length, 0, name);
    assert.ok(h.get("new-error").textContent, name);
  }
});

test("직접 입력한 워크트리 이름만 trim하여 명시적 boolean과 함께 보낸다", async () => {
  const h = setup();
  await submit(h, [["projectPath", "C:/repo"], ["isolate", "on"], ["worktreeName", " 한글-ui_2 "]]);
  assert.equal(h.calls[0][2].isolate, true);
  assert.equal(h.calls[0][2].worktreeName, "한글-ui_2");
  h.calls.length = 0;
  await submit(h, [["projectPath", "C:/repo"], ["worktreeName", "stale-name"]]);
  assert.equal(h.calls[0][2].isolate, false);
  assert.equal(Object.hasOwn(h.calls[0][2], "worktreeName"), false);
  h.calls.length = 0;
  h.get("new-agent").value = "codex-chat";
  await submit(h, [["projectPath", "C:/repo"], ["isolate", "on"], ["worktreeName", "stale-name"]]);
  assert.equal(h.calls[0][2].isolate, false);
  assert.equal(Object.hasOwn(h.calls[0][2], "worktreeName"), false);
  assert.equal(Object.hasOwn(h.calls[0][2], "projectPath"), false);
});

test("그래프에서 만든 세션은 저장한 위치와 원본 노드 연결을 한 번 적용한다", async () => {
  const h = setup();
  const pos = { x: 120, y: 160 };
  await h.controller.openNew("C:/repo", { pos, connectFrom: "source" });
  await submit(h, [["projectPath", "C:/repo"]]);
  assert.deepEqual(h.calls.map((call) => call[0]), ["POST", "PUT", "connect"]);
  assert.equal(h.calls[1][1], "/api/sessions/created");
  assert.deepEqual(h.calls[1][2], { graphPos: pos });
  assert.equal(h.calls[2][1].connectFrom, "source");
  assert.equal(h.calls[2][2], "created");
  assert.equal(h.get("new-dialog").open, false);
});

test("화면 이동으로 생성 창을 취소한 뒤 새로 만든 세션은 이전 위치와 연결을 물려받지 않는다", async () => {
  const h = setup();
  await h.controller.openNew("C:/repo", { pos: { x: 12, y: 34 }, connectFrom: "stale" });
  h.controller.cancelCreation();
  await h.controller.openNew("C:/repo");
  await submit(h, [["projectPath", "C:/repo"]]);
  assert.deepEqual(h.calls.map((call) => call[0]), ["POST"]);
});

test("생성 요청 실패는 같은 창에 오류를 남기고 생성 성공 후 닫힌 창에서는 중복 연결하지 않는다", async () => {
  const h = setup();
  let fail = true;
  h.service.api = async (...args) => {
    if (fail && args[0] === "POST") throw Error("create failed");
    h.calls.push(args);
    return { id: "created" };
  };
  await h.controller.openNew("C:/repo", { pos: { x: 12, y: 34 }, connectFrom: "source" });
  await submit(h, [["projectPath", "C:/repo"]]);
  assert.equal(h.get("new-error").textContent, "create failed");
  assert.equal(h.get("new-dialog").open, true);
  fail = false;
  await submit(h, [["projectPath", "C:/repo"]]);
  assert.equal(h.get("new-dialog").open, false);
  assert.equal(h.calls.filter((call) => call[0] === "connect").length, 1);
});

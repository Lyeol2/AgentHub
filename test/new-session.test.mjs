import test from "node:test";
import assert from "node:assert/strict";
import { createCreationController } from "../public/features/creation/controller.js";
import { workBranchType } from "../public/shared/workbranches.js";

function element() {
  return {
    value: "", textContent: "", children: [], checked: false, disabled: false, hidden: false, required: false, handlers: {}, dataset: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelectorAll() { return []; },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ""; },
    append(...children) { this.children.push(...children); },
    setCustomValidity(message) { this.validationMessage = message; },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    close() { this.open = false; this.handlers.close?.(); },
  };
}
function setup() {
  const nodes = new Map(), calls = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  globalThis.document = { getElementById: get };
  globalThis.FormData = class extends Map { constructor(form) { super(form.fields); } };
  const data = { status: { agents: {
    claude: { permissions: ["default", "plan", "acceptEdits", "bypassPermissions"] },
    codex: { permissions: ["read-only", "workspace-write", "auto-review", "danger-full-access"] },
  } } };
  const navigation = { view: "project", project: "C:/repo" };
  const service = { api: async (...args) => { calls.push(args); return { id: "created" }; } };
  const controller = createCreationController({
    data, navigation,
    api: (...args) => service.api(...args),
    loadStatus: async () => {}, loadSessions: async () => {}, loadProjects: async () => {},
    sortedProjects: () => [{ path: "C:/repo", name: "repo" }],
    fillModels: () => {}, fillEfforts: () => {},
    connectCreatedGraphNode: async (...args) => calls.push(["connect", ...args]),
    openChat: () => {}, openSettings: () => {},
  });
  // The view's element helper uses the same minimal DOM as the real controller.
  document.createElement = (_tag) => ({ ...element(), setAttribute(key, value) { this[key] = value; } });
  get("new-agent").value = "codex";
  get("new-isolate").value = "false";
  return { data, navigation, calls, get, controller, service };
}
function submit(h, fields) {
  return h.get("new-form").handlers.submit({ submitter: { value: "ok" }, preventDefault() {}, target: { fields, reset() {} } });
}

const flushPicker = () => new Promise(resolve => setImmediate(resolve));

test("기존 작업 유형은 GitFlow 접두사와 슬래시를 함께 확인한다", () => {
  for (const name of ["hotfix", "release", "agenthub/legacy", "topic"]) assert.equal(workBranchType(name), "feature", name);
  assert.equal(workBranchType("hotfix/login"), "hotfix");
  assert.equal(workBranchType("release/0.5.0"), "release");
  assert.equal(workBranchType("feature/login"), "feature");
});

async function chooseExistingMode(h) {
  await h.controller.openNew("C:/repo");
  h.get("new-isolate").value = "true";
  h.get("new-isolate").handlers.change();
  h.get("new-worktree-mode").value = "existing";
  h.get("new-worktree-mode").handlers.change();
  await flushPicker();
}

test("권한 목록에 자동 검토·전체 접근이 있어도 새 세션은 기존 수정 권한이 기본이다", async () => {
  const h = setup();
  await h.controller.openNew("C:/repo");
  assert.equal(h.get("new-permission").value, "workspace-write");
  const options = h.get("new-permission").children;
  assert.deepEqual(options.map((option) => option.value), ["read-only", "workspace-write", "auto-review", "danger-full-access"]);
  assert.match(options.find((option) => option.value === "auto-review").children.join(""), /자동 검토.*AI/);
  assert.match(options.find((option) => option.value === "danger-full-access").children.join(""), /전체 접근.*승인 없이.*샌드박스/);
  h.get("new-agent").value = "claude";
  h.get("new-agent").handlers.change();
  assert.equal(h.get("new-permission").value, "acceptEdits");
  await h.controller.openNew("C:/repo", { kind: "codex", orchestrator: true });
  assert.equal(h.get("new-permission").value, "read-only");
});

test("새 Codex 권한은 선택한 ID 그대로 세션 생성에 전달한다", async () => {
  const h = setup();
  for (const permission of ["auto-review", "danger-full-access"]) {
    await h.controller.openNew("C:/repo", { kind: "codex" });
    h.get("new-permission").value = permission;
    await submit(h, [["projectPath", "C:/repo"], ["permission", h.get("new-permission").value]]);
    assert.equal(h.calls.at(-1)[2].permission, permission);
  }
});

test("새 세션은 취소 후 다시 열거나 오케스트레이터를 만들어도 원본 폴더가 기본이다", async () => {
  const h = setup();
  h.get("new-isolate").value = "true";
  h.get("new-worktree-name").value = "previous";
  await h.controller.openNew("C:/repo");
  assert.equal(h.get("new-isolate").value, "false");
  assert.equal(h.get("new-worktree-name").value, "");
  assert.equal(h.get("new-worktree-name").disabled, true);
  h.get("new-isolate").value = "true";
  h.get("new-worktree-name").value = "another";
  await h.controller.openNew("C:/repo", { orchestrator: true });
  assert.equal(h.get("new-orchestrator").checked, true);
  assert.equal(h.get("new-isolate").value, "false");
  assert.equal(h.get("new-worktree-name").value, "");
});

test("워크트리를 선택해야 이름 입력이 필수이며 채팅으로 바꾸면 해제한다", () => {
  const h = setup();
  h.get("new-isolate").value = "true";
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
  assert.equal(h.get("new-isolate").value, "false");
  assert.equal(h.get("new-isolate").disabled, true);
  assert.equal(h.get("new-worktree-name").required, false);
  assert.equal(h.get("new-worktree-name").disabled, true);
  assert.equal(h.get("new-worktree-name").validationMessage, "");
});

test("워크트리 이름이 없거나 안전하지 않으면 세션을 만들지 않는다", async () => {
  const h = setup();
  for (const name of ["", " ", "../escape", "-leading", "has space", "a".repeat(65), "CON", "lpt1"]) {
    await submit(h, [["projectPath", "C:/repo"], ["isolate", "true"], ["worktreeName", name]]);
    assert.equal(h.calls.length, 0, name);
    assert.ok(h.get("new-error").textContent, name);
  }
});

test("워크트리 사용 안 함을 명시하면 남아 있는 이름과 브랜치를 보내지 않는다", async () => {
  const h = setup();
  await h.controller.openNew("C:/repo");
  h.get("new-isolate").value = "true";
  h.get("new-isolate").handlers.change();
  h.get("new-worktree-name").value = "stale-name";
  h.get("new-isolate").value = "false";
  h.get("new-isolate").handlers.change();
  assert.equal(h.get("new-worktree-mode-row").hidden, true);
  assert.equal(h.get("new-worktree-row").hidden, true);
  assert.equal(h.get("new-worktree-branch-row").hidden, true);
  assert.equal(h.get("new-worktree-name").disabled, true);
  assert.equal(h.get("new-worktree-name").required, false);
  assert.equal(h.get("new-worktree-name").validationMessage, "");
  assert.equal(h.get("new-submit").disabled, false);
  await submit(h, [["projectPath", "C:/repo"], ["isolate", "false"], ["worktreeName", "stale-name"], ["workBranch", "feature/stale"]]);
  assert.equal(h.calls[0][2].isolate, false);
  assert.equal(Object.hasOwn(h.calls[0][2], "worktreeName"), false);
  assert.equal(Object.hasOwn(h.calls[0][2], "workBranch"), false);
});

test("직접 입력한 워크트리 이름만 trim하여 명시적 boolean과 함께 보낸다", async () => {
  const h = setup();
  await submit(h, [["projectPath", "C:/repo"], ["isolate", "true"], ["worktreeName", " 한글-ui_2 "]]);
  assert.equal(h.calls[0][2].isolate, true);
  assert.equal(h.calls[0][2].worktreeName, "한글-ui_2");
  h.calls.length = 0;
  await submit(h, [["projectPath", "C:/repo"], ["worktreeName", "stale-name"]]);
  assert.equal(h.calls[0][2].isolate, false);
  assert.equal(Object.hasOwn(h.calls[0][2], "worktreeName"), false);
  h.calls.length = 0;
  h.get("new-agent").value = "codex-chat";
  await submit(h, [["projectPath", "C:/repo"], ["isolate", "true"], ["worktreeName", "stale-name"]]);
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

test("원본과 새 작업 브랜치 모드에서는 기존 브랜치 목록을 요청하지 않는다", async () => {
  const h = setup();
  await h.controller.openNew("C:/repo");
  assert.equal(h.get("new-worktree-mode").value, "new");
  h.get("new-isolate").value = "true";
  h.get("new-isolate").handlers.change();
  assert.equal(h.get("new-worktree-mode-row").hidden, false);
  assert.equal(h.get("new-worktree-name").required, true);
  assert.equal(h.get("new-worktree-branch-row").hidden, true);
  assert.equal(h.calls.length, 0);
  h.get("new-worktree-mode").value = "existing";
  h.controller.cancelCreation();
  await h.controller.openNew("C:/repo");
  assert.equal(h.get("new-worktree-mode").value, "new");
  assert.equal(h.get("new-isolate").value, "false");
  assert.equal(h.calls.length, 0);
});

test("기존 작업 브랜치는 선택 가능 상태를 확인하고 이름 생성 없이 세션에 전달한다", async () => {
  const h = setup();
  h.service.api = async (...args) => {
    h.calls.push(args);
    if (args[0] === "GET") return { branches: [
      { name: "main", selectable: false },
      { name: "feature/original", original: true },
      { name: "feature/locked", locked: true },
      { name: "feature/missing", missing: true },
      { name: "feature/task", taskId: "task-a", selectableForTask: false, selectableForSession: true, cwd: "C:/repo.agenthub/task" },
    ] };
    return { id: "created" };
  };
  await chooseExistingMode(h);
  assert.equal(h.calls[0][1], "/api/workbranches?path=C%3A%2Frepo");
  assert.equal(h.get("new-worktree-name").disabled, true);
  assert.equal(h.get("new-worktree-name").required, false);
  assert.equal(h.get("new-worktree-branch").required, true);
  assert.equal(h.get("new-submit").disabled, true);
  const options = h.get("new-worktree-branch").children;
  assert.deepEqual(options.slice(1).map(option => option.disabled), [true, true, true, true, false]);
  h.get("new-worktree-branch").value = "main";
  h.get("new-worktree-branch").handlers.change();
  await submit(h, [["projectPath", "C:/repo"], ["isolate", "true"], ["worktreeMode", "existing"], ["workBranch", "main"]]);
  assert.equal(h.calls.filter(call => call[0] === "POST").length, 0);
  h.get("new-worktree-branch").value = "feature/task";
  h.get("new-worktree-branch").handlers.change();
  assert.equal(h.get("new-submit").disabled, false);
  assert.match(h.get("new-worktree-branch-status").textContent, /C:\/repo.agenthub\/task/);
  await submit(h, [["projectPath", "C:/repo"], ["isolate", "true"], ["worktreeMode", "existing"], ["workBranch", "feature/task"], ["worktreeName", "stale-name"]]);
  const body = h.calls.find(call => call[0] === "POST")[2];
  assert.equal(body.isolate, false);
  assert.equal(body.workBranch, "feature/task");
  assert.equal(Object.hasOwn(body, "worktreeName"), false);
  assert.equal(Object.hasOwn(body, "worktreeMode"), false);
});

test("기존 브랜치 조회 실패 중에는 제출을 차단하고 명시적인 목록 재조회로 복구한다", async () => {
  const h = setup();
  let fail = true;
  h.service.api = async (...args) => {
    h.calls.push(args);
    if (args[0] === "GET") {
      if (fail) throw Error("branch lookup failed");
      return { branches: [{ name: "agenthub/existing", selectable: true }] };
    }
    return { id: "created" };
  };
  await chooseExistingMode(h);
  assert.equal(h.get("new-submit").disabled, true);
  assert.equal(h.get("new-worktree-branch").disabled, true);
  assert.equal(h.get("new-worktree-branch-status").textContent, "branch lookup failed");
  await submit(h, [["projectPath", "C:/repo"], ["isolate", "true"], ["worktreeMode", "existing"]]);
  assert.equal(h.calls.filter(call => call[0] === "POST").length, 0);
  fail = false;
  h.get("new-worktree-branch-refresh").handlers.click();
  await flushPicker();
  h.get("new-worktree-branch").value = "agenthub/existing";
  h.get("new-worktree-branch").handlers.change();
  assert.equal(h.get("new-submit").disabled, false);
});

test("취소 뒤 같은 프로젝트에서 새 창을 열어도 이전 브랜치 응답은 반영하지 않는다", async () => {
  const h = setup();
  let resolveBranches;
  h.service.api = async (...args) => {
    h.calls.push(args);
    return new Promise(resolve => { resolveBranches = resolve; });
  };
  await chooseExistingMode(h);
  assert.equal(h.get("new-submit").disabled, true);
  h.controller.cancelCreation();
  await h.controller.openNew("C:/repo");
  resolveBranches({ branches: [{ name: "feature/stale", selectable: true }] });
  await flushPicker();
  assert.equal(h.get("new-isolate").value, "false");
  assert.equal(h.get("new-worktree-mode").value, "new");
  assert.deepEqual(h.get("new-worktree-branch").children.map(option => option.value), [""]);
});

test("기존 브랜치 조회 중 프로젝트를 바꾸면 새 프로젝트 응답만 선택할 수 있다", async () => {
  const h = setup();
  const pending = [];
  h.service.api = async (...args) => {
    h.calls.push(args);
    return new Promise(resolve => pending.push(resolve));
  };
  await chooseExistingMode(h);
  h.get("new-project").value = "C:/other";
  h.get("new-project").handlers.change();
  pending[0]({ branches: [{ name: "feature/stale", selectable: true }] });
  await flushPicker();
  assert.equal(h.get("new-worktree-branch").disabled, true);
  pending[1]({ branches: [{ name: "feature/current", selectable: true }] });
  await flushPicker();
  assert.equal(h.calls[1][1], "/api/workbranches?path=C%3A%2Fother");
  assert.deepEqual(h.get("new-worktree-branch").children.map(option => option.value), ["", "feature/current"]);
});

test("생성 요청이 진행 중이면 반복 제출해도 세션을 한 번만 만든다", async () => {
  const h = setup();
  let resolveCreate;
  h.service.api = (...args) => {
    h.calls.push(args);
    return new Promise(resolve => { resolveCreate = resolve; });
  };
  await h.controller.openNew("C:/repo");
  const creating = submit(h, [["projectPath", "C:/repo"]]);
  assert.equal(h.get("new-submit").disabled, true);
  await submit(h, [["projectPath", "C:/repo"]]);
  assert.equal(h.calls.length, 1);
  resolveCreate({ id: "created" });
  await creating;
  assert.equal(h.get("new-dialog").open, false);
});

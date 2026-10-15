import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function source(name) {
  const found = app.match(new RegExp("^(?:async )?function " + name + "\\(", "m"));
  assert.ok(found, name);
  return app.slice(found.index, app.indexOf("\n}", found.index) + 2);
}
function element() {
  return {
    value: "", checked: false, disabled: false, hidden: false, required: false, handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelectorAll() { return []; },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ""; },
    setCustomValidity(message) { this.validationMessage = message; },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}
function setup() {
  const nodes = new Map();
  const calls = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const state = { view: "project", project: "C:/repo", templateRoles: [] };
  const context = vm.createContext({
    state, console, Promise, $: get,
    FormData: class extends Map { constructor(form) { super(form.fields); } },
    el: (_tag, props) => ({ ...element(), ...props }),
    sortedProjects: () => [{ path: "C:/repo", name: "repo" }],
    samePath: (a, b) => a === b,
    loadStatus: async () => {}, fillTemplates: () => {},
    fillPermissions: () => {}, fillModels: () => {}, fillEfforts: () => {},
    loadSessions: async () => {}, loadProjects: async () => {},
    api: async (...args) => { calls.push(args); return { id: "created" }; },
  });
  vm.runInContext(app.match(/const newKind = \(\) => \{[\s\S]*?\n\};/)[0], context);
  for (const name of ["worktreeNameError", "syncNewWorktree", "syncNewKind", "syncOrchestrator", "applyTemplate", "openNew"]) vm.runInContext(source(name), context);
  const start = app.indexOf('$("new-form").addEventListener("submit",');
  vm.runInContext(app.slice(start, app.indexOf("\n});", start) + 4), context);
  get("new-agent").value = "codex";
  return { state, calls, get, context, run: (code) => vm.runInContext(code, context) };
}
function submit(h, fields) {
  return h.get("new-form").handlers.submit({ submitter: { value: "ok" }, preventDefault() {}, target: { fields, reset() {} } });
}

test("새 세션은 취소 후 다시 열거나 오케스트레이터를 만들어도 원본 폴더가 기본이다", async () => {
  const h = setup();
  h.get("new-isolate").checked = true;
  h.get("new-worktree-name").value = "previous";
  await h.run('openNew("C:/repo")');
  assert.equal(h.get("new-isolate").checked, false);
  assert.equal(h.get("new-worktree-name").value, "");
  assert.equal(h.get("new-worktree-name").disabled, true);
  h.get("new-isolate").checked = true;
  h.get("new-worktree-name").value = "another";
  await h.run('openNew("C:/repo", { orchestrator: true })');
  assert.equal(h.get("new-orchestrator").checked, true);
  assert.equal(h.get("new-isolate").checked, false);
  assert.equal(h.get("new-worktree-name").value, "");
});

test("워크트리를 선택해야 이름 입력이 필수이며 채팅으로 바꾸면 해제한다", () => {
  const h = setup();
  h.get("new-isolate").checked = true;
  h.run("syncNewWorktree()");
  assert.equal(h.get("new-worktree-row").hidden, false);
  assert.equal(h.get("new-worktree-name").disabled, false);
  assert.equal(h.get("new-worktree-name").required, true);
  assert.match(h.get("new-worktree-name").validationMessage, /입력/);
  h.get("new-worktree-name").value = "bag-ui";
  h.run("syncNewWorktree()");
  assert.equal(h.get("new-worktree-name").validationMessage, "");
  h.get("new-agent").value = "codex-chat";
  h.run("syncNewKind()");
  assert.equal(h.get("new-isolate").checked, false);
  assert.equal(h.get("new-isolate").disabled, true);
  assert.equal(h.get("new-worktree-name").required, false);
  assert.equal(h.get("new-worktree-name").disabled, true);
  assert.equal(h.get("new-worktree-name").validationMessage, "");
});

test("역할 템플릿의 이전 분리 설정이 워크트리를 자동 선택하지 않는다", () => {
  const h = setup();
  h.state.templateRoles = [{ name: "구현", agent: "codex", model: "", permission: "workspace-write", body: "구현한다", isolate: true }];
  h.get("new-template").value = "구현";
  h.run("applyTemplate()");
  assert.equal(h.get("new-isolate").checked, false);
  assert.equal(h.get("new-worktree-name").required, false);
  h.get("new-isolate").checked = true;
  h.get("new-worktree-name").value = "chosen";
  h.run("applyTemplate()");
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

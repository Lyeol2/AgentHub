import test from "node:test";
import assert from "node:assert/strict";
import { createFlowAssistant } from "../public/features/graph/flow-assistant.js";
import { createRecordsController } from "../public/features/records/controller.js";
import { createCommandsController } from "../public/features/commands/controller.js";
import { createProjectsController } from "../public/features/projects/controller.js";

function dom(t) {
  const original = globalThis.document;
  const nodes = new Map();
  const element = () => ({
    value: "", textContent: "", hidden: false, disabled: false, checked: false, open: false,
    style: {}, children: [], handlers: {}, classList: { toggle() {} },
    querySelectorAll() { return []; },
    addEventListener(type, listener) { this.handlers[type] = listener; },
    setAttribute(key, value) { this[key] = value; },
    removeAttribute(key) { delete this[key]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ""; },
    focus() {}, showModal() { this.open = true; },
    close() { this.open = false; this.handlers.close?.(); },
  });
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  globalThis.document = {
    getElementById: get, createElement: element,
    querySelector: query => get(query), querySelectorAll: () => [],
  };
  t.after(() => { globalThis.document = original; });
  return get;
}
const event = { preventDefault() {} };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("flow assistant ignores delayed plans and failed requests after switching tabs", async t => {
  const get = dom(t), calls = [];
  const navigation = { project: "C:/repo", graphTabId: "tab-a" };
  let response = deferred();
  const assistant = createFlowAssistant({ navigation, getSelected: () => ["session-a"], onApplied: async () => {},
    api: async (...args) => { calls.push(args); return response.promise; } });
  get("p-flow-assistant-prompt").value = "검토 세션 추가";
  const old = get("p-flow-assistant").handlers.submit(event);
  assert.equal(calls[0][2].tabId, "tab-a");
  navigation.graphTabId = "tab-b";
  assistant.reset();
  response.resolve({ summary: "이전 탭 응답", actions: [{ text: "검토 추가" }] });
  await old;
  assert.equal(get("p-flow-assistant-plan").hidden, true);
  assert.equal(get("p-flow-assistant-apply").disabled, true);
  response = deferred();
  const rejected = get("p-flow-assistant").handlers.submit(event);
  navigation.graphTabId = "tab-a";
  assistant.reset();
  response.reject(Error("이전 탭 실패"));
  await rejected;
  assert.equal(get("p-flow-assistant-error").textContent, "");
});

test("flow assistant applies only to its plan's tab and never selects late results in another tab", async t => {
  const get = dom(t), calls = [], selected = [];
  const navigation = { project: "C:/repo", graphTabId: "tab-a" };
  const applied = deferred();
  const assistant = createFlowAssistant({ navigation, getSelected: () => [], onApplied: async ids => { selected.push(...ids); },
    api: async (...args) => { calls.push(args); return args[1].endsWith("/plan") ? { actions: [{ text: "추가" }] } : applied.promise; } });
  get("p-flow-assistant-prompt").value = "세션 추가";
  await get("p-flow-assistant").handlers.submit(event);
  navigation.graphTabId = "tab-b";
  await get("p-flow-assistant-apply").handlers.click();
  assert.equal(calls.length, 1, "a preview cannot be applied after moving tabs");
  navigation.graphTabId = "tab-a";
  await get("p-flow-assistant").handlers.submit(event);
  const pending = get("p-flow-assistant-apply").handlers.click();
  assert.equal(calls.at(-1)[2].tabId, "tab-a");
  navigation.graphTabId = "tab-b";
  assistant.reset();
  applied.resolve({ created: ["new-session"], done: ["created"] });
  await pending;
  assert.deepEqual(selected, []);
  assert.equal(get("p-flow-assistant-status").textContent, "");
});

test("record import keeps its captured tab and ignores completion after moving to another tab", async t => {
  const get = dom(t), calls = [], selected = [];
  const navigation = { project: "C:/repo", view: "project", graphTabId: "tab-a" };
  const imported = deferred();
  const controller = createRecordsController({ navigation, data: {}, loadSessions: async () => {}, selectSession: async id => { selected.push(id); },
    api: async (...args) => { calls.push(args); return args[0] === "GET" ? [{ title: "기록", fileName: "record.md" }] : imported.promise; } });
  await controller.openRecordImport("C:/repo");
  const pending = get("record-form").handlers.submit({ ...event, submitter: { value: "ok" } });
  assert.equal(calls.at(-1)[2].tabId, "tab-a");
  navigation.graphTabId = "tab-b";
  controller.cancelCreation();
  imported.resolve({ id: "imported-session" });
  await pending;
  assert.deepEqual(selected, []);
  assert.equal(get("record-dialog").open, false);
});

test("record picker ignores stale same-project results after reopening on another tab", async t => {
  const get = dom(t);
  const navigation = { project: "C:/repo", view: "project", graphTabId: "tab-a" };
  const first = deferred();
  let request = 0;
  const controller = createRecordsController({ navigation, data: {}, loadSessions: async () => {}, selectSession: async () => {},
    api: async () => ++request === 1 ? first.promise : [{ title: "최신 기록", fileName: "new.md" }] });
  const old = controller.openRecordImport("C:/repo");
  navigation.graphTabId = "tab-b";
  controller.cancelCreation();
  await controller.openRecordImport("C:/repo");
  first.resolve([{ title: "이전 기록", fileName: "old.md" }]);
  await old;
  assert.equal(get("record-title").placeholder, "최신 기록");
});

test("command creation retains its original tab and history scope when a save finishes after a tab switch", async t => {
  const get = dom(t), calls = [], history = [];
  const navigation = { project: "C:/repo", view: "project", graphTabId: "tab-a" };
  const made = deferred();
  const controller = createCommandsController({ navigation, data: { commands: [], sessions: [] },
    commandById: () => undefined, loadLinks: async () => {}, renderGraph() {}, connectCreatedGraphNode: async () => {},
    history: { record: (projectPath, entry) => history.push({ projectPath, entry }) },
    api: async (...args) => { calls.push(args); return args[0] === "POST" ? made.promise : { commands: [], shells: [] }; } });
  controller.openCommandDialog(null, { x: 10, y: 20 });
  get("command-text").value = "npm test";
  const pending = get("command-form").handlers.submit({ ...event, submitter: { value: "ok" } });
  assert.equal(calls[0][2].tabId, "tab-a");
  navigation.graphTabId = "tab-b";
  controller.cancelCreation();
  made.resolve({ id: "cmd-created", ...calls[0][2] });
  await pending;
  assert.equal(history[0].entry.tabId, "tab-a");
  assert.equal(get("command-dialog").open, false);
});

test("discovered CLI sessions import into the selected tab without reopening after navigation", async t => {
  const get = dom(t), calls = [], selected = [];
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => "flow", setItem() {} };
  t.after(() => { globalThis.localStorage = originalStorage; });
  const navigation = { project: "C:/repo", view: "project", graphTabId: "tab-b", viewRevision: 1 };
  const project = { path: navigation.project, name: "Repo" };
  const data = { sessions: [], projects: [project], current: null };
  let response;
  const noop = () => {};
  const controller = createProjectsController({ data, navigation, selectSession: async id => selected.push(id),
    api: async (...args) => {
      calls.push(args);
      if (args[0] === "POST") return response.promise;
      if (args[1].startsWith("/api/projects/discover")) return [{ agent: "codex", agentSessionId: "cli-record", title: "CLI 기록", turns: 1 }];
      if (args[1] === "/api/projects/all") return [project];
      return [];
    }, sessionOpener: () => noop, goDashboard: noop, goProject: noop, loadGit: noop, loadIssues: noop, renderIssueCount: noop,
    loadTasks: noop, loadLinks: noop, renderGraph: noop, loadMessages: noop, loadCommands: noop, loadSkills: noop,
    openSessionMenu: noop, toggleSessionLock: noop, openNew: noop,
  });
  await controller.renderProject();
  const descendants = node => typeof node === "object" ? [node, ...node.children.flatMap(descendants)] : [];
  const button = descendants(get("p-found")).find(node => node.children.includes("가져오기"));
  assert.ok(button);
  response = deferred();
  const first = button.handlers.click({ target: button });
  assert.equal(calls.find(call => call[0] === "POST")[2].tabId, "tab-b");
  response.resolve({ id: "new-cli-session" });
  await first;
  assert.deepEqual(selected, ["new-cli-session"]);
  response = deferred();
  const late = button.handlers.click({ target: button });
  navigation.graphTabId = "tab-c";
  navigation.viewRevision++;
  response.resolve({ id: "late-cli-session" });
  await late;
  assert.deepEqual(selected, ["new-cli-session"], "a late import does not reopen a session after switching tabs");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createSessionsController } from "../public/features/sessions/controller.js";

function element() {
  return {
    value: "", textContent: "", children: [], handlers: {}, dataset: {}, checked: false,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(key, value) { this[key] = value; },
    removeAttribute(key) { delete this[key]; },
    append(...children) { this.children.push(...children); },
    before() {},
    replaceChildren(...children) { this.children = children; },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function setup(t, { agent = "codex", permission = "workspace-write" } = {}) {
  const nodes = new Map(), calls = [], selected = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const original = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage, ResizeObserver: globalThis.ResizeObserver };
  globalThis.document = { getElementById: get, createElement: element, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem: () => null };
  globalThis.ResizeObserver = class { observe() {} };
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const data = {
    current: { id: "s1", title: "권한 설정", agent, permission, model: "", effort: "", state: "idle", events: [], queue: [] },
    links: [],
    status: { agents: {
      claude: { permissions: ["default", "plan", "acceptEdits", "bypassPermissions"] },
      codex: { permissions: ["read-only", "workspace-write", "auto-review", "danger-full-access"] },
    } },
  };
  const controller = createSessionsController({
    data, navigation: { view: "session" },
    api: async (method, url, body) => { calls.push([method, url, body]); return { ...data.current, ...body }; },
    loadStatus: async () => {}, loadSessions: async () => {},
    fillModels() {}, fillEfforts() {},
    selectSession: async (id) => selected.push(id),
    sessionById: () => data.current,
    eventsList: () => get("s-events"),
  });
  return { get, data, calls, selected, controller };
}

const nodeText = (node) => typeof node === "string" ? node : [node.textContent, ...node.children.map(nodeText)].join("");
const save = (h) => h.get("config-form").handlers.submit({ submitter: { value: "ok" }, preventDefault() {} });

test("세션 설정은 새 Codex 권한의 설명을 표시하고 선택한 ID를 저장·다시 표시한다", async (t) => {
  const h = setup(t);
  for (const permission of ["auto-review", "danger-full-access"]) {
    await h.get("s-config").handlers.click();
    const options = h.get("config-permission").children;
    assert.match(nodeText(options.find((option) => option.value === "auto-review")), /자동 검토.*AI/);
    assert.match(nodeText(options.find((option) => option.value === "danger-full-access")), /전체 접근.*승인 없이.*샌드박스/);
    h.get("config-permission").value = permission;
    await save(h);
    assert.deepEqual(h.calls.at(-1), ["PUT", "/api/sessions/s1", { title: "권한 설정", model: "", effort: "", permission }]);
    assert.equal(h.data.current.permission, permission);
    assert.equal(h.get("config-error").textContent, "");
    assert.equal(h.get("config-dialog").open, false);
    await h.get("s-config").handlers.click();
    assert.equal(h.get("config-permission").value, permission);
  }
});

test("설정에서 AI를 바꾸면 자동 검토·전체 접근과 기존 권한을 대응하여 저장한다", async (t) => {
  const h = setup(t);
  const cases = [
    ["codex", "read-only", "claude", "plan"],
    ["codex", "workspace-write", "claude", "acceptEdits"],
    ["codex", "auto-review", "claude", "acceptEdits"],
    ["codex", "danger-full-access", "claude", "bypassPermissions"],
    ["claude", "default", "codex", "read-only"],
    ["claude", "plan", "codex", "read-only"],
    ["claude", "acceptEdits", "codex", "workspace-write"],
    ["claude", "bypassPermissions", "codex", "danger-full-access"],
  ];
  for (const [agent, permission, target, mapped] of cases) {
    Object.assign(h.data.current, { agent, permission });
    await h.get("s-config").handlers.click();
    h.get("config-agent").value = target;
    h.get("config-agent").handlers.change();
    assert.equal(h.get("config-permission").value, mapped, `${agent} ${permission} -> ${target}`);
    await save(h);
    assert.equal(h.calls.at(-1)[2].agent, target);
    assert.equal(h.calls.at(-1)[2].permission, mapped);
    assert.equal(h.get("config-error").textContent, "");
  }
  assert.equal(h.selected.length, cases.length);
});

test("알 수 없는 저장 권한은 설정에서 전체 접근 대신 각 AI의 수정 권한으로 돌아간다", async (t) => {
  const h = setup(t, { permission: "legacy-unknown" });
  await h.get("s-config").handlers.click();
  assert.equal(h.get("config-permission").value, "workspace-write");
  h.data.current.agent = "claude";
  await h.get("s-config").handlers.click();
  assert.equal(h.get("config-permission").value, "acceptEdits");
});

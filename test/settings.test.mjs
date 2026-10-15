import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSystemService } from "../server/application/system.mjs";
import { systemRoutes } from "../server/transport/routes/system.mjs";
import { createSettingsController } from "../public/features/settings/controller.js";
import { createSettingsView } from "../public/features/settings/view.js";

function service(setup = { status: () => ({}) }) {
  const config = { cli: { claude: "before-claude", codex: "before-codex" }, projects: [] };
  let saves = 0;
  const system = createSystemService({ config, setup, cliPaths: () => ({}), saveConfig: () => saves++, version: "test", getUpdater: () => null, limits: {} });
  return { config, system, saves: () => saves };
}

test("CLI 재확인 API는 status·auth·setup 모두 fresh=1만 강제 갱신한다", async () => {
  const calls = [];
  const routes = systemRoutes(Object.fromEntries(["status", "auth", "setupStatus"].map((name) => [name, (fresh) => calls.push([name, fresh])])));
  for (const endpoint of ["status", "auth", "setup"]) {
    const handler = routes.find(([method, route]) => method === "GET" && route === endpoint)[2];
    for (const query of ["", "fresh=0", "fresh=1"]) await handler({ query: new URLSearchParams(query) });
  }
  assert.deepEqual(calls, [
    ["status", false], ["status", false], ["status", true],
    ["auth", false], ["auth", false], ["auth", true],
    ["setupStatus", false], ["setupStatus", false], ["setupStatus", true],
  ]);
});

test("시스템 서비스는 설치 상태의 fresh 요청을 Setup에 전달한다", async () => {
  const calls = [];
  const { system } = service({ status: (options) => { calls.push(options); return { tools: [], jobs: {} }; } });
  await system.setupStatus();
  await system.setupStatus(true);
  assert.deepEqual(calls, [{ fresh: false }, { fresh: true }]);
});

test("CLI 설정은 따옴표를 정리하고 두 실행 파일 검증이 끝나야 저장한다", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-cli-settings-"));
  try {
    const file = path.join(temp, "chosen CLI.cmd");
    await fs.writeFile(file, "@echo off\r\n");
    const h = service();
    assert.throws(() => h.system.settings({ cli: { claude: file, codex: temp } }), /실행 파일/);
    assert.deepEqual(h.config.cli, { claude: "before-claude", codex: "before-codex" });
    assert.equal(h.saves(), 0);
    h.system.settings({ cli: { claude: '  "' + file + '"  ', codex: "" } });
    assert.deepEqual(h.config.cli, { claude: file, codex: "" });
    assert.equal(h.saves(), 1);
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

function element(tag = "div") {
  return {
    tag, value: "", textContent: "", children: [], handlers: {}, disabled: false, open: false,
    classList: { toggle() {} },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(key, value) { this[key] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
  };
}
function ui(t) {
  const nodes = new Map(), calls = [], alerts = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const original = { document: globalThis.document, window: globalThis.window, alert: globalThis.alert };
  globalThis.document = { getElementById: get, createElement: element };
  globalThis.window = { addEventListener() {}, agenthubTheme: { get: () => "system" } };
  globalThis.alert = (text) => alerts.push(text);
  t.mock.method(globalThis, "setInterval", () => 0);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const status = { agents: { claude: { path: null, autoPath: null, version: null }, codex: { path: null, autoPath: null, version: null } }, cliOverrides: { claude: "", codex: "" }, projects: [] };
  const data = { status };
  const request = { api: async (method, url) => {
    calls.push([method, url]);
    if (url.startsWith("/api/status")) return status;
    if (url.startsWith("/api/auth")) return { claude: null, codex: null };
    if (url.startsWith("/api/setup")) return { tools: [], jobs: {} };
    return {};
  } };
  const controller = createSettingsController({ api: (...args) => request.api(...args), data, navigation: {}, goDashboard() {}, loadProjects() {}, renderProjectNav() {}, currentProject() {}, renderLinkConditions() {} });
  return { get, calls, alerts, data, request, controller };
}
const text = (node) => typeof node === "string" ? node : [node.textContent, ...node.children.map(text)].join("");

test("설치 창의 다시 확인은 경로·버전·인증 캐시를 모두 갱신한다", async (t) => {
  const h = ui(t);
  await h.get("setup-refresh").handlers.click();
  assert.deepEqual(h.calls, [["GET", "/api/status?fresh=1"], ["GET", "/api/auth?fresh=1"], ["GET", "/api/setup?fresh=1"]]);
  assert.equal(h.get("setup-refresh").disabled, false);
});

test("재확인 API가 실패해도 오류를 보이고 버튼을 다시 사용할 수 있다", async (t) => {
  const h = ui(t);
  h.request.api = async () => { throw Error("연결 확인 실패"); };
  await h.get("setup-refresh").handlers.click();
  assert.deepEqual(h.alerts, ["연결 확인 실패"]);
  assert.equal(h.get("setup-refresh").disabled, false);
  const status = h.data.status;
  h.request.api = async (_method, url) => { if (url.startsWith("/api/status")) return status; throw Error("인증 확인 실패"); };
  await h.get("setup-refresh").handlers.click();
  assert.equal(h.alerts.at(-1), "인증 확인 실패");
  assert.equal(h.get("setup-refresh").disabled, false);
});

test("CLI 경로 저장 후 새 경로의 버전·로그인 상태를 다시 읽는다", async (t) => {
  const h = ui(t);
  await h.get("settings-form").handlers.submit({ submitter: { value: "ok" }, preventDefault() {} });
  assert.deepEqual(h.calls, [["PUT", "/api/settings"], ["GET", "/api/status?fresh=1"], ["GET", "/api/auth?fresh=1"], ["GET", "/api/setup?fresh=1"]]);
});

test("CLI 실행 실패와 로그인 확인 실패는 정상 연결로 표시하지 않는다", (t) => {
  const h = ui(t);
  const view = createSettingsView({});
  h.data.status.agents.codex = { path: "C:/chosen/codex.cmd", autoPath: "C:/chosen/codex.cmd", version: null };
  view.renderCliStatus(h.data.status, { codex: true }, { tools: [], jobs: {} });
  const row = h.get("cli-status").children[1];
  assert.match(row.children[0].className, /error/);
  assert.match(row.title, /실행 파일은 찾았지만/);
  view.renderSetup({ tools: [{ id: "codex", label: "Codex", path: "C:/chosen/codex.cmd", version: null, loggedIn: true }], jobs: {} });
  assert.match(text(h.get("setup-list")), /실행 확인 실패/);
  assert.match(text(h.get("setup-list")), /C:\/chosen\/codex.cmd/);
  assert.doesNotMatch(text(h.get("setup-list")), /로그인됨/);
  assert.equal(h.get("setup-list").children[0].children[0].children.filter((node) => node.tag === "button").length, 0);
  h.data.status.agents.codex.version = "1.0";
  view.renderCliStatus(h.data.status, { codex: null }, { tools: [], jobs: {} });
  assert.doesNotMatch(h.get("cli-status").children[1].children[0].className, /ok/);
  assert.match(h.get("cli-status").children[1].title, /로그인 상태를 확인하지 못/);
});

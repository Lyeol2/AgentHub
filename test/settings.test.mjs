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

const descendants = (node) => typeof node === "string" ? [] : [node, ...node.children.flatMap(descendants)];

test("winget 카드는 인증 없이 설치·복구하고 진행 중 작업을 취소한다", (t) => {
  const h = ui(t), calls = [];
  const view = createSettingsView({ setupAction: (...args) => calls.push(args) });
  const winget = { id: "winget", label: "Windows 패키지 관리자 (winget)", path: "C:/WindowsApps/winget.exe", version: "v1.12.0", installable: true };
  view.renderSetup({ winget, tools: [], jobs: {} });
  const item = h.get("setup-list").children[0];
  assert.match(item.className, /ok/);
  assert.doesNotMatch(text(item), /로그인/);
  assert.match(text(item), /winget이 없으면 CLI 설치 전에 자동으로 준비/);
  const repair = descendants(item).find((node) => node.tag === "button" && text(node) === "설치·복구");
  repair.handlers.click();
  assert.deepEqual(calls, [["winget", "install"]]);

  view.renderSetup({ winget, tools: [], jobs: { winget: { kind: "install", state: "running", log: "" } } });
  const buttons = descendants(h.get("setup-list")).filter((node) => node.tag === "button");
  assert.equal(buttons.find((node) => text(node) === "설치·복구").disabled, "");
  buttons.find((node) => text(node) === "취소").handlers.click();
  assert.deepEqual(calls.at(-1), ["winget", "cancel"]);

  view.renderSetup({ tools: [], jobs: {} });
  assert.equal(h.get("setup-list").children.length, 0);
});

test("자동 설치가 없어도 공식 수동 설치 안내와 명령 복사를 사용할 수 있다", async (t) => {
  const h = ui(t), copied = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value) => copied.push(value) } } });
  t.after(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  });
  const command = "winget install --id GitHub.cli --exact";
  createSettingsView({}).renderSetup({
    tools: [{ id: "gh", label: "GitHub CLI", path: null, installable: false,
      manual: { links: [{ label: "공식 설치 페이지", url: "https://cli.github.com/" }], command, note: "PowerShell에서 실행하세요." } }], jobs: {},
  });
  const nodes = descendants(h.get("setup-list"));
  assert.equal(nodes.filter((node) => node.tag === "button" && text(node) === "설치").length, 0);
  assert.ok(nodes.some((node) => node.tag === "summary" && text(node) === "수동 설치"));
  const link = nodes.find((node) => node.tag === "a");
  assert.equal(link.href, "https://cli.github.com/");
  assert.equal(link.target, "_blank");
  assert.match(link.rel, /noopener/);
  assert.match(text(h.get("setup-list")), /상단의 ‘다시 확인’/);
  assert.ok(nodes.some((node) => node.tag === "pre" && text(node) === command));
  const copy = nodes.find((node) => node.tag === "button" && text(node) === "명령 복사");
  await copy.handlers.click();
  assert.deepEqual(copied, [command]);
  assert.equal(copy.textContent, "복사됨");
});

test("CLI 실행이나 자동 설치가 실패하면 재설치와 열린 수동 설치 안내를 보여 준다", (t) => {
  const h = ui(t), calls = [];
  createSettingsView({ setupAction: (...args) => calls.push(args) }).renderSetup({
    tools: [{ id: "codex", label: "Codex", path: "C:/chosen/codex.cmd", version: null, installable: true,
      manual: { links: [{ label: "공식 설치 안내", url: "https://developers.openai.com/codex/cli/" }], note: "직접 설치하세요." } }],
    jobs: { codex: { kind: "install", state: "error", log: "설치 실패" } },
  });
  const nodes = descendants(h.get("setup-list"));
  const reinstall = nodes.find((node) => node.tag === "button" && text(node) === "다시 설치");
  reinstall.handlers.click();
  assert.deepEqual(calls, [["codex", "install"]]);
  const manual = nodes.find((node) => node.tag === "details" && text(node.children[0]) === "수동 설치");
  assert.equal(manual.open, "");
  assert.match(text(manual), /자동 설치에 실패했습니다/);
  assert.match(text(manual), /상단의 ‘다시 확인’/);
});

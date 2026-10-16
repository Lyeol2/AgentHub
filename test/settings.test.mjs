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

test("자동 업데이트만 저장하면 CLI 경로를 유지하고 boolean만 허용한다", () => {
  const h = service();
  h.system.settings({ cliAutoUpdate: false });
  assert.equal(h.config.cliAutoUpdate, false);
  assert.deepEqual(h.config.cli, { claude: "before-claude", codex: "before-codex" });
  assert.equal(h.saves(), 1);
  assert.throws(() => h.system.settings({ cliAutoUpdate: "false" }), { status: 400 });
  assert.equal(h.config.cliAutoUpdate, false);
  assert.equal(h.saves(), 1);
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
  assert.match(text(h.get("setup-list")), /연결 확인 실패/);
  assert.deepEqual(h.alerts, []);
  assert.equal(h.get("setup-refresh").disabled, false);
  const status = h.data.status;
  h.request.api = async (_method, url) => { if (url.startsWith("/api/status")) return status; throw Error("인증 확인 실패"); };
  await h.get("setup-refresh").handlers.click();
  assert.match(text(h.get("setup-list")), /인증 확인 실패/);
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
  assert.match(text(h.get("setup-list")), /‘새로고침’/);
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
  assert.match(text(manual), /‘새로고침’/);
});

test("처음 CLI 조회가 실패해도 새로고침으로 설치 창을 복구할 수 있다", async (t) => {
  const h = ui(t);
  const request = h.request.api;
  h.request.api = async (method, url) => {
    if (url.startsWith("/api/setup")) throw Error("설치 상태 연결 실패");
    return request(method, url);
  };
  await h.controller.openSetup();
  assert.equal(h.get("setup-dialog").open, true);
  assert.match(text(h.get("setup-list")), /설치 상태 연결 실패/);
  const retry = descendants(h.get("setup-list")).find(node => node.tag === "button" && text(node) === "새로고침");
  assert.ok(retry);
  h.request.api = request;
  await retry.handlers.click();
  assert.doesNotMatch(text(h.get("setup-list")), /연결 실패/);
  assert.equal(h.get("setup-refresh").disabled, false);
});

test("CLI 새로고침은 일부 조회 실패에도 나머지 조회를 끝내고 중복 요청을 막는다", async (t) => {
  const h = ui(t), calls = [];
  let resolveAuth;
  h.request.api = async (_method, url) => {
    calls.push(url);
    if (url.startsWith("/api/status")) throw Error("버전 조회 실패");
    if (url.startsWith("/api/auth")) return new Promise(resolve => { resolveAuth = resolve; });
    return { tools: [{ id: "codex", label: "Codex", path: "C:/codex.cmd", version: "2.0", loggedIn: true, updatable: true }], jobs: {} };
  };
  const checking = h.get("setup-refresh").handlers.click();
  await h.get("setup-refresh").handlers.click();
  assert.equal(calls.length, 3);
  assert.equal(h.get("setup-refresh").disabled, true);
  resolveAuth({ codex: true });
  await checking;
  assert.match(text(h.get("setup-list")), /버전 조회 실패/);
  assert.match(text(h.get("setup-list")), /2\.0/);
  assert.equal(h.get("setup-refresh").disabled, false);
});

test("CLI 업데이트 작업을 구분하고 실패 후 새로고침과 업데이트 재시도를 제공한다", async (t) => {
  const h = ui(t), calls = [];
  const view = createSettingsView({ setupAction: (...args) => calls.push(args), refreshSetup: () => calls.push(["refresh"]) });
  const tool = { id: "codex", label: "Codex", path: "C:/codex.cmd", version: "1.0", loggedIn: true, updatable: true };
  const setup = { tools: [tool], jobs: { codex: { kind: "update", automatic: true, state: "error", error: "네트워크 오류", log: "download failed" } } };
  view.renderSetup(setup);
  assert.match(text(h.get("setup-list")), /자동 업데이트 실패/);
  const buttons = descendants(h.get("setup-list")).filter(node => node.tag === "button");
  await buttons.find(node => text(node) === "새로고침").handlers.click();
  await buttons.find(node => text(node) === "업데이트 다시 시도").handlers.click();
  assert.deepEqual(calls, [["refresh"], ["codex", "update"]]);
  setup.jobs.codex.state = "running";
  view.renderSetup(setup);
  view.renderCliStatus(h.data.status, {}, setup);
  assert.match(text(h.get("cli-status")), /Codex 업데이트 중/);
  const runningButtons = descendants(h.get("setup-list")).filter(node => node.tag === "button");
  assert.equal(runningButtons.find(node => text(node) === "업데이트").disabled, "");
  assert.ok(runningButtons.find(node => text(node) === "취소"));
});

test("업데이트 API 오류는 카드에 남으며 요청 중에는 같은 도구를 중복 실행하지 않는다", async (t) => {
  const h = ui(t);
  const tool = { id: "codex", label: "Codex", path: "C:/codex.cmd", version: "1.0", loggedIn: true, updatable: true };
  let rejectUpdate, posts = 0;
  h.request.api = async (method) => {
    if (method === "POST") { posts++; return new Promise((_resolve, reject) => { rejectUpdate = reject; }); }
    return { tools: [tool], jobs: {} };
  };
  await h.controller.openSetup();
  const update = descendants(h.get("setup-list")).find(node => node.tag === "button" && text(node) === "업데이트");
  const pending = update.handlers.click();
  await update.handlers.click();
  assert.equal(posts, 1);
  rejectUpdate(Error("업데이트 연결 실패"));
  await pending;
  assert.match(text(h.get("setup-list")), /업데이트 연결 실패/);
  assert.ok(descendants(h.get("setup-list")).some(node => node.tag === "button" && text(node) === "새로고침"));
  assert.deepEqual(h.alerts, []);
});

test("자동 업데이트 설정은 저장된 값을 표시하고 CLI 경로와 함께 저장한다", async (t) => {
  const h = ui(t), writes = [];
  h.data.status.cliAutoUpdate = false;
  const api = h.request.api;
  h.request.api = async (method, url, body) => {
    if (method === "PUT") writes.push(body);
    return api(method, url);
  };
  await h.controller.openSettings();
  assert.equal(h.get("cli-auto-update").checked, false);
  h.get("cli-auto-update").checked = true;
  await h.get("settings-form").handlers.submit({ submitter: { value: "ok" }, preventDefault() {} });
  assert.deepEqual(writes, [{ cli: { claude: "", codex: "" }, cliAutoUpdate: true }]);
});

test("늦은 업데이트 응답과 새로고침 실패가 먼저 도착한 완료 상태를 되돌리지 않는다", async (t) => {
  const h = ui(t);
  const tool = { id: "codex", label: "Codex", path: "C:/codex.cmd", version: "1.0", loggedIn: true, updatable: true };
  let resolveUpdate, setupReads = 0;
  h.request.api = async (method) => {
    if (method === "POST") return new Promise(resolve => { resolveUpdate = resolve; });
    if (++setupReads > 1) throw Error("상태 재조회 실패");
    return { tools: [tool], jobs: {} };
  };
  await h.controller.openSetup();
  const update = descendants(h.get("setup-list")).find(node => node.tag === "button" && text(node) === "업데이트");
  const pending = update.handlers.click();
  h.controller.applySetupJobs({ codex: { kind: "update", state: "done", log: "updated" } });
  resolveUpdate({ kind: "update", state: "running", log: "starting" });
  await pending;
  assert.match(text(h.get("setup-list")), /업데이트 완료/);
  assert.doesNotMatch(text(h.get("setup-list")), /업데이트 진행 중/);
  assert.match(text(h.get("setup-list")), /상태 재조회 실패/);
});

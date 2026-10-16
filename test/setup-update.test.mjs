import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Setup, updateInstallation, updatePlan } from "../server/setup.mjs";
import { createSystemService } from "../server/application/system.mjs";
import { systemRoutes } from "../server/transport/routes/system.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, { mode = "npm", tool = "codex", updateTimeoutMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-update-"));
  const write = (relative, content = "fixture executable") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  let file;
  const prefix = path.join(root, "npm prefix");
  if (mode === "npm") {
    write("npm prefix/node_modules/@openai/codex/package.json", JSON.stringify({ name: "@openai/codex" }));
    file = write("npm prefix/codex.cmd", '@echo off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
  } else if (mode === "winget") file = write(`Microsoft/WinGet/Packages/${tool === "codex" ? "OpenAI.Codex" : "Anthropic.ClaudeCode"}_Microsoft.Winget.Source_fixture/${tool}.exe`);
  else if (mode === "native") file = write(".local/bin/claude.exe");
  else file = write(`custom/${tool}.exe`);
  const state = { file, busy: false, installedVersion: "CLI 1.0.0", winget: "C:/fixture/winget.exe", npm: "C:/fixture/npm.cmd" };
  const calls = [], finished = [], versions = [];
  const launch = t.mock.method(childProcess, "spawn", (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null)); return true; };
    calls.push({ file, args, options, child });
    return child;
  });
  const registry = t.mock.method(childProcess, "execFileSync", () => "");
  syncBuiltinESMExports();
  const setup = new Setup({
    cliPath: (id) => id === tool ? state.file : null,
    npmPath: () => state.npm, wingetPath: () => state.winget, wingetPackages: async () => [],
    version: async (file, options) => { versions.push({ file, options }); return file?.endsWith("winget.exe") ? "v1.0.0" : file ? state.installedVersion : null; },
    auth: async () => true, platform: "win32", homeDir: root, isBusy: () => state.busy, updateTimeoutMs,
  });
  setup.on("finished", (tool, job) => finished.push({ tool, job }));
  t.after(() => {
    for (const id of setup.jobs.keys()) setup.cancel(id);
    launch.mock.restore(); registry.mock.restore(); syncBuiltinESMExports();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { setup, root, write, file, prefix, state, calls, finished, versions,
    complete: (index = 0, code = 0) => calls[index].child.emit("close", code) };
}

test("CLI update: npm shim and vendor executable retain the installed prefix", (t) => {
  const f = fixture(t);
  const installation = updateInstallation("codex", f.file, { windows: true });
  assert.deepEqual(installation, { how: "npm", prefix: f.prefix });
  const plan = updatePlan("codex", f.file, { installation, npm: "npm.cmd", winget: "winget.exe" });
  assert.deepEqual(plan.args, ["install", "-g", "@openai/codex@latest", "--prefix", f.prefix]);
  const vendor = f.write("npm prefix/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe");
  assert.deepEqual(updateInstallation("codex", vendor, { windows: true }), installation);
  const optional = f.write("npm prefix/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe");
  assert.deepEqual(updateInstallation("codex", optional, { windows: true }), installation);
  fs.writeFileSync(path.join(f.prefix, "node_modules/@openai/codex/package.json"), JSON.stringify({ name: "other" }));
  assert.match(updateInstallation("codex", f.file, { windows: true }).reason, /설치 방식/);
  assert.equal(f.calls.length, 0);
});

test("CLI update: winget links use their real package owner; native Claude retains its channel", (t) => {
  const f = fixture(t, { mode: "winget", tool: "claude" });
  const link = f.write("Microsoft/WinGet/Links/claude.exe");
  const realpath = fs.realpathSync;
  t.mock.method(fs, "realpathSync", (file, ...args) => file === link ? f.file : realpath(file, ...args));
  const installation = updateInstallation("claude", link, { windows: true });
  assert.equal(installation.how, "winget");
  assert.deepEqual(updatePlan("claude", link, { installation, winget: "winget.exe", npm: null }).args,
    ["upgrade", "--id", "Anthropic.ClaudeCode", "--exact", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"]);
  assert.match(updatePlan("claude", link, { installation, winget: null, npm: "npm.cmd" }).reason, /winget/);
  const native = f.write(".local/bin/claude.exe");
  assert.deepEqual(updatePlan("claude", native, { installation: updateInstallation("claude", native, { windows: true, homeDir: f.root }), winget: "winget.exe", npm: "npm.cmd" }),
    { how: "native", file: native, args: ["update"] });
});

test("CLI update: status explains supported and unknown installations without launching updates", async (t) => {
  const f = fixture(t);
  let tool = (await f.setup.status()).tools.find((item) => item.id === "codex");
  assert.equal(tool.updatable, true); assert.equal(tool.updateReason, null);
  f.state.file = f.write("custom/codex.exe");
  tool = (await f.setup.status({ fresh: true })).tools.find((item) => item.id === "codex");
  assert.equal(tool.updatable, false); assert.match(tool.updateReason, /설치 방식/);
  assert.throws(() => f.setup.update("codex"), /설치 방식/);
  assert.throws(() => f.setup.update("gh"), /Claude Code와 Codex/);
  assert.equal(f.calls.length, 0);
});

test("CLI update: npm update verifies the selected CLI and serializes all per-tool work", async (t) => {
  const f = fixture(t);
  const job = f.setup.update("codex", { automatic: true });
  assert.equal(job.kind, "update"); assert.equal(job.automatic, true); assert.equal(f.setup.isUpdating("codex"), true);
  assert.match(f.calls[0].args.join(" "), /@openai\/codex@latest.*--prefix/);
  assert.throws(() => f.setup.update("codex"), /이미 진행 중/);
  assert.throws(() => f.setup.install("codex"), /이미 진행 중/);
  assert.throws(() => f.setup.login("codex"), /이미 진행 중/);
  f.state.installedVersion = "CLI 2.0.0"; f.complete(); await tick();
  assert.equal(f.setup.jobList().codex.state, "done");
  assert.equal(f.setup.jobList().codex.version, "CLI 2.0.0");
  assert.deepEqual(f.versions.at(-1), { file: f.file, options: { fresh: true } });
  assert.equal(f.setup.isUpdating("codex"), false); assert.equal(f.finished.length, 1);
  assert.ok(f.calls[0].options.windowsHide);
});

test("CLI update: native Claude invokes update without overriding configured channel", async (t) => {
  const f = fixture(t, { mode: "native", tool: "claude" });
  f.setup.update("claude");
  assert.equal(f.calls[0].file, f.file); assert.deepEqual(f.calls[0].args, ["update"]);
  f.complete(); await tick(); assert.equal(f.setup.jobList().claude.state, "done");
});

test("CLI update: verified Claude npm installs use the selected CLI updater without switching managers", async (t) => {
  const f = fixture(t, { mode: "native", tool: "claude" });
  f.write("npm prefix/node_modules/@anthropic-ai/claude-code/package.json", JSON.stringify({ name: "@anthropic-ai/claude-code" }));
  f.state.file = f.write("npm prefix/claude.cmd", '@echo off\r\nnode "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*');
  assert.equal(updateInstallation("claude", f.state.file, { windows: true }).how, "claude");
  f.setup.update("claude");
  assert.match(f.calls[0].args.join(" "), /claude\.cmd.*update/);
  assert.doesNotMatch(f.calls[0].args.join(" "), /winget|install|latest|stable/);
  f.complete(); await tick(); assert.equal(f.setup.jobList().claude.state, "done");
  const desktop = f.write("AppData/Roaming/Claude/claude-code/1.0/claude.exe");
  assert.match(updateInstallation("claude", desktop, { windows: true, homeDir: f.root }).reason, /설치 방식/);
});

test("CLI update: arbitrary nonzero exits stay errors even when the old CLI still runs", async (t) => {
  const f = fixture(t);
  f.setup.update("codex"); f.complete(0, 1); await tick();
  const job = f.setup.jobList().codex;
  assert.equal(job.state, "error"); assert.equal(job.exitCode, 1); assert.match(job.error, /종료 코드 1/);
  assert.equal(f.versions.length, 0); assert.equal(f.finished[0].job.error, job.error);
});

test("CLI update: only winget no-applicable-upgrade HRESULT can succeed after a failed exit", async (t) => {
  const f = fixture(t, { mode: "winget" });
  for (const code of [-1978335189, 0x8a15002b]) {
    f.setup.update("codex"); await tick(); f.complete(f.calls.length - 1, code); await tick();
    assert.equal(f.setup.jobList().codex.state, "done");
    assert.equal(f.versions.at(-1).file, f.file);
  }
  f.setup.update("codex"); await tick(); f.complete(f.calls.length - 1, -1978335188); await tick();
  assert.equal(f.setup.jobList().codex.state, "error");
  assert.equal(f.calls.length, 3);
});

test("CLI update: success requires a runnable CLI, and missing manager never changes installation method", async (t) => {
  const f = fixture(t);
  f.setup.update("codex"); f.state.installedVersion = null; f.complete(); await tick();
  assert.equal(f.setup.jobList().codex.state, "error"); assert.match(f.setup.jobList().codex.error, /실행을 확인/);
  f.state.npm = null; f.setup.update("codex"); await tick();
  assert.equal(f.setup.jobList().codex.state, "error"); assert.match(f.setup.jobList().codex.error, /npm/);
  assert.equal(f.calls.length, 1);
});

test("CLI update: busy sessions are rejected initially and again immediately before spawn", async (t) => {
  const f = fixture(t, { mode: "winget" });
  f.state.busy = true;
  assert.throws(() => f.setup.update("codex"), { code: "CLI_BUSY" });
  f.state.busy = false;
  let release;
  f.setup.version = () => new Promise((resolve) => { release = resolve; });
  f.setup.update("codex"); f.state.busy = true; release("v1.0.0"); await tick();
  assert.equal(f.setup.jobList().codex.state, "error"); assert.equal(f.setup.jobList().codex.errorCode, "CLI_BUSY");
  assert.equal(f.calls.length, 0);
});

test("CLI update: cancel during manager detection prevents spawn and emits one final event", async (t) => {
  const f = fixture(t, { mode: "winget" });
  let release;
  f.setup.version = () => new Promise((resolve) => { release = resolve; });
  f.setup.update("codex"); f.setup.cancel("codex"); release("v1.0.0"); await tick();
  assert.equal(f.setup.jobList().codex.state, "canceled"); assert.equal(f.calls.length, 0); assert.equal(f.finished.length, 1);
});

test("CLI update: changing the selected executable during detection prevents the old update", async (t) => {
  const f = fixture(t, { mode: "winget" });
  let release;
  f.setup.version = () => new Promise((resolve) => { release = resolve; });
  f.setup.update("codex"); f.state.file = f.write("custom/codex.exe"); release("v1.0.0"); await tick();
  assert.equal(f.setup.jobList().codex.state, "error"); assert.match(f.setup.jobList().codex.error, /경로가 변경/);
  assert.equal(f.calls.length, 0);
});

test("CLI update: timeout and spawn errors finish cleanly and permit retry", async (t) => {
  const f = fixture(t, { updateTimeoutMs: 1000 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.setup.update("codex"); t.mock.timers.tick(1000); await tick();
  assert.equal(f.setup.jobList().codex.state, "error"); assert.match(f.setup.jobList().codex.error, /시간이 초과/);
  f.setup.update("codex"); f.calls[1].child.emit("error", new Error("spawn failed")); f.complete(1); await tick();
  assert.equal(f.setup.jobList().codex.state, "error"); assert.match(f.setup.jobList().codex.error, /spawn failed/);
  f.setup.update("codex"); f.setup.cancel("codex"); f.complete(2); await tick();
  assert.equal(f.setup.jobList().codex.state, "canceled"); assert.equal(f.finished.length, 3);
});

test("CLI update API: route and service allow only supported tools and do not trust automatic flag", () => {
  const calls = [];
  const system = createSystemService({ setup: { update: (...args) => { calls.push(args); return { kind: "update", state: "running" }; } } });
  const route = systemRoutes(system).find(([method, route]) => method === "POST" && route === "setup/:tool/update");
  assert.ok(route);
  assert.equal(route[2]({ params: { tool: "codex" }, body: { automatic: true } }).kind, "update");
  system.setupAction("claude", "update"); assert.deepEqual(calls, [["codex"], ["claude"]]);
  for (const tool of ["gh", "winget", "unknown"]) assert.throws(() => system.setupAction(tool, "update"));
  const failing = createSystemService({ setup: { update: () => { throw new Error("busy"); } } });
  assert.throws(() => failing.setupAction("codex", "update"), { status: 409 });
});

test("CLI update settings: toggle-only requests preserve manual paths and validate before saving", async () => {
  const config = { cli: { claude: "manual-claude", codex: "manual-codex" }, projects: [] };
  let saves = 0;
  const system = createSystemService({ config, cliPaths: () => ({}), saveConfig: () => saves++ });
  assert.equal((await system.status()).cliAutoUpdate, true);
  system.settings({ cliAutoUpdate: false });
  assert.deepEqual(config.cli, { claude: "manual-claude", codex: "manual-codex" });
  assert.equal((await system.status()).cliAutoUpdate, false); assert.equal(saves, 1);
  for (const value of [null, "false", 1]) assert.throws(() => system.settings({ cliAutoUpdate: value }), { status: 400 });
  assert.equal(saves, 1);
});

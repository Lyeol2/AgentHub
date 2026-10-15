import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parseLoginOutput, TOOLS, Setup, MANUAL_INSTALL } from "../server/setup.mjs";
import { createSystemService } from "../server/application/system.mjs";

test("setup: 로그인 출력에서 주소와 일회용 코드를 꺼낸다", () => {
  const gh = parseLoginOutput("! One-time code (AB12-CD34) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n");
  assert.deepEqual(gh, { url: "https://github.com/login/device", code: "AB12-CD34", waitsForCode: false });

  const codex = parseLoginOutput("Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?a=1&b=2\n");
  assert.equal(codex.url, "https://auth.openai.com/oauth/authorize?a=1&b=2"); // localhost 콜백 주소는 건너뛴다.
  assert.equal(codex.code, null);

  const device = parseLoginOutput("1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code\n   \x1b[94mWXYZ-12345\x1b[0m\n");
  assert.equal(device.url, "https://auth.openai.com/codex/device");
  assert.equal(device.code, "WXYZ-12345");

  const claude = parseLoginOutput("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted > ");
  assert.equal(claude.waitsForCode, true);
});

test("setup: winget 패키지 ID", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, t.winget])),
    { claude: "Anthropic.ClaudeCode", codex: "OpenAI.Codex", gh: "GitHub.cli" });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

// 실제 설치·네트워크·브라우저 실행 없이 설치 단계와 종료 상태만 검증한다.
function installer(t, { available = false, healthy = available, npm = true, platform = "win32", installTimeoutMs } = {}) {
  const calls = [], finished = [];
  const state = { available, healthy, installed: new Set() };
  const launch = t.mock.method(childProcess, "spawn", (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    child.unref = () => {};
    calls.push({ file, args, options, child });
    return child;
  });
  const registry = t.mock.method(childProcess, "execFileSync", () => "");
  syncBuiltinESMExports();
  t.after(() => { launch.mock.restore(); registry.mock.restore(); syncBuiltinESMExports(); });
  const setup = new Setup({
    cliPath: (tool) => state.installed.has(tool) ? `C:/fixture/${tool}.exe` : null,
    wingetPath: () => state.available ? "C:/fixture/winget.exe" : null,
    npmPath: () => npm ? "C:/fixture/npm.cmd" : null,
    version: async (file) => file?.endsWith("winget.exe") ? state.healthy ? "v1.12.0" : null
      : file && state.installed.has(file.split("/").at(-1).replace(".exe", "")) ? "CLI 1.0.0" : null,
    platform, installTimeoutMs,
  });
  setup.on("finished", (tool, job) => finished.push({ tool, job }));
  return { setup, calls, state, finished, complete(index, code = 0) { calls[index].child.emit("close", code); } };
}

test("setup: Windows에서는 winget과 모든 CLI의 자동·수동 설치 경로를 제공한다", async (t) => {
  const f = installer(t, { npm: false });
  const status = await f.setup.status();
  assert.equal(status.winget.id, "winget");
  assert.equal(status.winget.path, null);
  assert.equal(status.winget.installable, true);
  assert.equal(status.winget.manual, MANUAL_INSTALL.winget);
  for (const tool of status.tools) {
    assert.equal(tool.installable, true);
    assert.ok(tool.manual.links.every((link) => link.url.startsWith("https://")));
  }
  f.setup.windows = false;
  const other = await f.setup.status();
  assert.equal(other.winget, null);
  assert.equal(other.tools.find((tool) => tool.id === "gh").installable, false);
  assert.equal(other.tools.find((tool) => tool.id === "gh").manual.links[0].url, "https://cli.github.com/");
  assert.equal(f.calls.length, 0);
});

test("setup: winget이 없으면 준비를 마치고 CLI를 설치한 뒤 실행을 검증한다", async (t) => {
  const f = installer(t);
  assert.equal(f.setup.install("codex").state, "running");
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].args.includes("-EncodedCommand"));
  assert.equal(f.setup.jobList().winget.state, "running");
  f.state.available = f.state.healthy = true;
  f.complete(0); await tick();
  assert.equal(f.setup.jobList().winget.state, "done");
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].args.join(" "), /--id OpenAI\.Codex/);
  f.state.installed.add("codex"); f.complete(1); await tick();
  assert.equal(f.setup.jobList().codex.state, "done");
  assert.match(f.setup.jobList().codex.log, /실행 확인: CLI 1\.0\.0/);
  assert.ok(f.calls.every((call) => call.options.windowsHide));
});

test("setup: winget 경로가 있어도 실행되지 않으면 먼저 복구한다", async (t) => {
  const f = installer(t, { available: true, healthy: false });
  f.setup.install("gh"); await tick();
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].args.includes("-EncodedCommand"));
  f.state.healthy = true; f.complete(0); await tick();
  assert.match(f.calls[1].args.join(" "), /--id GitHub\.cli/);
  f.state.installed.add("gh"); f.complete(1); await tick();
  assert.equal(f.setup.jobList().gh.state, "done");
});

test("setup: winget 준비 실패 뒤 Codex는 npm으로 설치한다", async (t) => {
  const f = installer(t);
  f.setup.install("codex"); f.complete(0, 1); await tick();
  assert.equal(f.setup.jobList().winget.state, "error");
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].args.join(" "), /npm\.cmd.*install -g @openai\/codex/);
  f.state.installed.add("codex"); f.complete(1); await tick();
  assert.equal(f.setup.jobList().codex.state, "done");
  assert.match(f.setup.jobList().codex.log, /winget 준비 실패/);
});

test("setup: 다른 자동 설치 방법이 없으면 실패와 수동 설치 경로를 남긴다", async (t) => {
  const f = installer(t, { npm: false });
  f.setup.install("gh"); f.complete(0, 1); await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.setup.jobList().gh.state, "error");
  assert.match(f.setup.jobList().gh.log, /수동 설치/);
  assert.equal((await f.setup.status()).tools.find((tool) => tool.id === "gh").manual.links[0].url, "https://cli.github.com/");
});

test("setup: winget 설치 명령이 실패하면 공식 대체 경로를 사용한다", async (t) => {
  const f = installer(t, { available: true });
  f.setup.install("claude"); await tick();
  assert.match(f.calls[0].args.join(" "), /Anthropic\.ClaudeCode/);
  f.complete(0, 1); await tick();
  assert.match(f.calls[1].file, /powershell\.exe$/i);
  assert.match(f.calls[1].args.join(" "), /https:\/\/claude\.ai\/install\.ps1/);
  f.state.installed.add("claude"); f.complete(1); await tick();
  assert.equal(f.setup.jobList().claude.state, "done");
});

test("setup: 종료 코드가 0이어도 실행 파일을 확인하지 못하면 설치 성공으로 표시하지 않는다", async (t) => {
  const f = installer(t, { available: true });
  f.setup.install("codex"); await tick(); f.complete(0); await tick();
  assert.equal(f.setup.jobList().codex.state, "error");
  assert.match(f.setup.jobList().codex.log, /실행을 확인하지 못/);
  assert.equal(f.calls.length, 1);
});

test("setup: 여러 CLI가 winget 준비를 공유하고 대기 중 취소한 작업은 설치하지 않는다", async (t) => {
  const f = installer(t);
  f.setup.install("codex"); f.setup.install("gh");
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.setup.install("gh"), /이미 진행 중/);
  assert.equal(f.setup.cancel("codex"), true);
  assert.equal(f.setup.jobList().codex.state, "canceled");
  f.state.available = f.state.healthy = true;
  f.complete(0); await tick();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].args.join(" "), /GitHub\.cli/);
  assert.doesNotMatch(f.calls[1].args.join(" "), /OpenAI\.Codex/);
  f.state.installed.add("gh"); f.complete(1); await tick();
  assert.equal(f.setup.jobList().gh.state, "done");
  assert.equal(f.finished.filter((event) => event.tool === "codex").length, 1);
});

test("setup: winget 준비를 단독 취소하면 늦은 종료가 상태를 덮어쓰지 않는다", async (t) => {
  const f = installer(t);
  f.setup.install("winget");
  assert.throws(() => f.setup.install("winget"), /이미 진행 중/);
  assert.equal(f.setup.cancel("winget"), true);
  f.complete(0); await tick();
  assert.equal(f.setup.jobList().winget.state, "canceled");
  assert.equal(f.finished.length, 1);
  assert.throws(() => f.setup.input("winget", "test"), /진행 중인 로그인/);
});

test("setup: 프로세스 실행 실패와 늦은 close는 오류를 한 번만 보고한다", async (t) => {
  const f = installer(t, { platform: "linux" });
  f.setup.install("codex");
  f.calls[0].child.emit("error", Error("spawn failed")); f.complete(0); await tick();
  assert.equal(f.setup.jobList().codex.state, "error");
  assert.equal(f.finished.length, 1);
  assert.match(f.setup.jobList().codex.log, /spawn failed/);
});

test("setup: 설치 응답이 없으면 제한 시간 뒤 작업을 끝내고 재시도할 수 있다", async (t) => {
  const f = installer(t, { platform: "linux", installTimeoutMs: 1000 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.setup.install("codex"); t.mock.timers.tick(1000); await tick();
  assert.equal(f.setup.jobList().codex.state, "error");
  assert.match(f.setup.jobList().codex.log, /수동 설치/);
  f.setup.install("codex"); f.state.installed.add("codex"); f.complete(1); await tick();
  assert.equal(f.setup.jobList().codex.state, "done");
});

test("setup: winget API는 설치와 취소만 허용하고 임의 도구는 거절한다", () => {
  const calls = [];
  const setup = { install: (tool) => calls.push(["install", tool]), cancel: (tool) => calls.push(["cancel", tool]) };
  const system = createSystemService({ setup });
  system.setupAction("winget", "install"); system.setupAction("winget", "cancel");
  assert.deepEqual(calls, [["install", "winget"], ["cancel", "winget"]]);
  assert.throws(() => system.setupAction("winget", "login"), /설치·복구와 취소만/);
  assert.throws(() => system.setupAction("winget", "input"), /설치·복구와 취소만/);
  assert.throws(() => system.setupAction("toString", "install"), /없는 설치 도구/);
});

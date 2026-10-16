import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { locateCli, locateCommand, normalizeCliPath, isCliFile, refreshPath, spawnCli, cliVersion, cliAuth, decodeConsole, missingFolder } from "../server/cli.mjs";
import { insideTaskPath } from "../server/tasks.mjs";
import { installPlan, Setup } from "../server/setup.mjs";

const windows = process.platform === "win32";
const executable = (name) => name + (windows ? ".exe" : "");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cli-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("agenthub-cli-"));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const file = (name, content = "fixture") => { const f = path.join(dir, name); fs.writeFileSync(f, content); return f; };
  return { dir, file };
}

function environment(t, values) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    refreshPath();
  });
}

function mocks(t, { registry = () => "", launch = () => {} } = {}) {
  const calls = [];
  const exec = t.mock.method(childProcess, "execFileSync", (file, args) => {
    assert.match(file, /reg\.exe$/i);
    return "    Path    REG_EXPAND_SZ    " + registry(args[1]) + "\r\n";
  });
  const spawn = t.mock.method(childProcess, "spawn", (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true;
    calls.push({ file, args, options, child });
    queueMicrotask(() => launch(child, { file, args, options }));
    return child;
  });
  syncBuiltinESMExports();
  refreshPath();
  t.after(() => { exec.mock.restore(); spawn.mock.restore(); syncBuiltinESMExports(); refreshPath(); });
  return calls;
}

function complete(child, output, code = 0, stream = "stdout") {
  child[stream].write(output);
  child.emit("close", code);
}

test("cli: 경로 따옴표와 환경 변수를 정리하고 파일만 직접 지정한다", (t) => {
  const f = fixture(t), file = f.file(executable("chosen"));
  environment(t, { AGENTHUB_TEST_CLI_DIR: f.dir });
  assert.equal(path.normalize(normalizeCliPath('  "%AGENTHUB_TEST_CLI_DIR%/' + path.basename(file) + '"  ')), file);
  assert.equal(locateCli("codex", ' "' + file + '" '), file);
  assert.equal(locateCli("codex", f.dir), null);
  assert.equal(locateCli("codex", path.join(f.dir, "missing.exe")), null);
  if (windows) assert.equal(isCliFile(f.file("chosen.ps1")), false);
});

test("cli: 따옴표로 감싼 PATH에서 CLI를 찾는다", { skip: !windows }, (t) => {
  const f = fixture(t), file = f.file(executable("agenthub-probe"));
  environment(t, { PATH: '"' + f.dir + '"' }); mocks(t);
  assert.equal(locateCommand(executable("agenthub-probe")), file);
});

test("cli: 다시 확인하면 새 레지스트리 PATH를 발견하고 자식에게 같은 PATH를 넘긴다", { skip: !windows }, async (t) => {
  const f = fixture(t), file = f.file(executable("agenthub-added-cli"));
  environment(t, { PATH: "", AGENTHUB_TEST_CLI_DIR: f.dir });
  let added = false;
  const calls = mocks(t, { registry: () => added ? '"%AGENTHUB_TEST_CLI_DIR%"' : "" });
  assert.equal(locateCommand(executable("agenthub-added-cli")), null);
  added = true;
  assert.equal(locateCommand(executable("agenthub-added-cli")), null);
  refreshPath();
  assert.equal(locateCommand(executable("agenthub-added-cli")), file);
  spawnCli(file, ["--version"], { env: { Path: "", NO_COLOR: "1" } });
  assert.ok(calls[0].options.env.PATH.split(path.delimiter).includes(f.dir));
  assert.equal(calls[0].options.env.NO_COLOR, "1");
  assert.deepEqual(Object.keys(calls[0].options.env).filter((key) => key.toLowerCase() === "path"), ["PATH"]);
});

test("cli: 자동 감지는 사용자 npm 전역 prefix도 찾는다", (t) => {
  const f = fixture(t), file = f.file(executable("agenthub-prefix-cli"));
  environment(t, { PATH: "", NPM_CONFIG_PREFIX: f.dir }); mocks(t);
  assert.equal(locateCommand(executable("agenthub-prefix-cli")), file);
});

test("cli: 버전 확인은 누락·디렉터리 경로와 실행 오류를 실패로 돌려주고 재시도한다", async (t) => {
  const f = fixture(t), file = f.file(executable("cli"));
  let fail = true;
  const calls = mocks(t, { launch: (child) => fail ? child.emit("error", new Error("temporarily unavailable")) : complete(child, "CLI 1.2.3\n") });
  assert.equal(await cliVersion(path.join(f.dir, "missing.exe")), null);
  assert.equal(await cliVersion(f.dir), null);
  assert.equal(await cliVersion(file), null);
  fail = false;
  assert.equal(await cliVersion(file), "CLI 1.2.3");
  assert.equal(await cliVersion(file), "CLI 1.2.3");
  assert.equal(calls.length, 2);
  assert.equal(await cliVersion(file, { fresh: true }), "CLI 1.2.3");
  assert.equal(calls.length, 3);
});

test("cli: 실패 종료의 버전 출력은 성공으로 캐시하지 않는다", async (t) => {
  const f = fixture(t), file = f.file(executable("cli"));
  let code = 1;
  const calls = mocks(t, { launch: (child) => complete(child, code ? "node is not recognized" : "CLI 2.0.0", code, "stderr") });
  assert.equal(await cliVersion(file), null);
  code = 0;
  assert.equal(await cliVersion(file), "CLI 2.0.0");
  assert.equal(calls.length, 2);
});

test("cli: 확인 프로세스가 close를 보내지 않아도 제한 시간 안에 끝나고 재시도한다", async (t) => {
  const f = fixture(t), file = f.file(executable("cli"));
  let hanging = true;
  const calls = mocks(t, { launch: (child) => { if (!hanging) complete(child, "CLI 3.0.0"); } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = cliVersion(file);
  t.mock.timers.tick(15_000);
  assert.equal(await pending, null);
  hanging = false;
  assert.equal(await cliVersion(file), "CLI 3.0.0");
  assert.equal(calls.length, 2);
});

test("cli: 인증 실패는 재시도하고 성공·미로그인·알 수 없는 출력을 구분한다", async (t) => {
  const f = fixture(t), file = f.file(executable("cli"));
  let output = "unexpected error", code = 1;
  const calls = mocks(t, { launch: (child) => complete(child, output, code, "stderr") });
  assert.equal(await cliAuth("codex", file), null);
  output = "Logged in using ChatGPT"; code = 0;
  assert.equal(await cliAuth("codex", file), true);
  output = "Not logged in"; code = 1;
  assert.equal(await cliAuth("codex", file, { fresh: true }), false);
  output = "{}"; code = 0;
  assert.equal(await cliAuth("claude", file), null);
  output = '{"loggedIn":false}'; code = 2;
  assert.equal(await cliAuth("claude", file), false);
  assert.equal(calls.length, 5);
});

test("cli: 경로 재확인은 mtime이 같은 npm shim의 버전·인증 캐시도 비운다", async (t) => {
  const f = fixture(t), file = f.file(windows ? "cli.cmd" : "cli");
  let version = "CLI 1.0.0", auth = "Logged in";
  const calls = mocks(t, { launch: (child, { args }) => complete(child, args.some((arg) => arg.includes("--version")) ? version : auth) });
  assert.equal(await cliVersion(file), "CLI 1.0.0"); assert.equal(await cliAuth("codex", file), true);
  version = "CLI 2.0.0"; auth = "Not logged in";
  refreshPath();
  assert.equal(await cliVersion(file), "CLI 2.0.0"); assert.equal(await cliAuth("codex", file), false);
  assert.equal(calls.length, 4);
});

test("setup: 외부에서 설치한 winget도 다시 확인하면 설치 방법에 반영한다", { skip: !windows }, (t) => {
  // 이 PC의 WindowsApps에 있는 실제 winget 별칭이 보이지 않게 한다.
  const f = fixture(t); environment(t, { PATH: "", LOCALAPPDATA: path.join(f.dir, "local") });
  let added = false;
  mocks(t, { registry: () => added ? f.dir : "" });
  assert.notEqual(installPlan("codex")?.how, "winget");
  const file = f.file("winget.exe"); added = true; refreshPath();
  assert.equal(installPlan("codex")?.file, file);
});

test("setup: 강제 확인은 경로와 버전·로그인 상태를 함께 갱신한다", async (t) => {
  const f = fixture(t), file = f.file(executable("cli"));
  let version = "CLI 1.0.0";
  mocks(t, { launch: (child, { args }) => complete(child, args.some((arg) => arg.includes("--version")) ? version : '{"loggedIn":true}') });
  const setup = new Setup({ cliPath: () => file, wingetPackages: async () => [] });
  assert.equal((await setup.status()).tools[0].version, "CLI 1.0.0");
  version = "CLI 2.0.0";
  const result = await setup.status({ fresh: true });
  assert.equal(result.tools[0].version, "CLI 2.0.0");
  assert.equal(result.tools[0].loggedIn, true);
});


test("cli: stderr 경고를 버전으로 표시하지 않고 stdout의 실제 버전을 고른다", async (t) => {
  const f = fixture(t), file = f.file(executable("cli"));
  mocks(t, { launch: (child) => {
    child.stderr.write("WARNING: failed to clean up stale arg0 temp dirs\n");
    complete(child, "codex-cli 0.162.1\n");
  } });
  assert.equal(await cliVersion(file), "codex-cli 0.162.1");
});

test("cli: Claude 인증 JSON은 stderr 진단 메시지와 따로 읽는다", async (t) => {
  const f = fixture(t), file = f.file(executable("cli"));
  mocks(t, { launch: (child) => {
    child.stderr.write("warning from updater\n");
    complete(child, '{"loggedIn":true}');
  } });
  assert.equal(await cliAuth("claude", file), true);
});


test("cli: 앱 실행 뒤 추가된 Node 경로로 npm 형식 cmd shim을 실제 실행한다", { skip: !windows }, async (t) => {
  const f = fixture(t), file = f.file("new-cli.cmd", '@echo off\r\nnode -e "console.log(123456)"\r\n');
  environment(t, { PATH: "" });
  const mock = t.mock.method(childProcess, "execFileSync", () => "    Path    REG_SZ    " + path.dirname(process.execPath) + "\r\n");
  syncBuiltinESMExports(); refreshPath();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); refreshPath(); });
  const result = await new Promise((resolve, reject) => {
    const child = spawnCli(file, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output: output.trim(), error }));
  });
  assert.equal(result.code, 0, result.error);
  assert.equal(result.output, "123456");
});

test("cli: Windows 기본 명령의 출력은 UTF-8이 아니면 콘솔 코드페이지로 읽는다", { skip: !windows }, () => {
  assert.equal(decodeConsole(Buffer.from("C:\\Users\\홍길동")), "C:\\Users\\홍길동");
  // 한국어 Windows의 reg·where는 cp949로 출력한다. 다른 코드페이지의 PC에서는 UTF-8 그대로다.
  const cp949 = childProcess.execFileSync("cmd.exe", ["/d", "/c", "echo 홍길동"]);
  assert.equal(decodeConsole(cp949).trim(), "홍길동");
});

test("cli: 작업 폴더가 없어서 난 ENOENT는 실행 파일이 아니라 폴더 문제로 알린다", () => {
  const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  assert.match(missingFolder(error, path.join(os.tmpdir(), "agenthub-no-such-folder-" + Date.now())), /작업 폴더가 없습니다/);
  assert.equal(missingFolder(error, os.tmpdir()), null);
  assert.equal(missingFolder(new Error("x"), "Z:\\none"), null);
});

test("tasks: 실행 중 세션 확인은 대소문자·구분자와 하위 폴더를 같은 원본 폴더로 본다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-inside-"));
  try {
    fs.mkdirSync(path.join(root, "repo", "app"), { recursive: true });
    const repo = path.join(root, "repo");
    assert.ok(insideTaskPath(path.join(repo, "app"), repo));
    assert.ok(insideTaskPath(repo.toUpperCase(), repo.replace(/\\/g, "/") + "/"));
    assert.ok(!insideTaskPath(root, repo));
    assert.ok(!insideTaskPath(path.join(root, "repo.agenthub", "task-1"), repo));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

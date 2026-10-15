import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { installedWingetPaths } from "../server/winget.mjs";

function queryFixture(t, read) {
  const calls = [];
  const mock = t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    calls.push({ file, args, options });
    queueMicrotask(() => {
      const result = read(calls.length);
      callback(result.error ?? null, result.output ?? "");
    });
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

test("winget 패키지 조회: 같은 결과는 공유하고 다시 확인하면 새 설치 경로를 읽는다", async (t) => {
  const first = "C:\\Program Files\\WindowsApps\\AppInstaller_old\\winget.exe";
  const next = "D:\\WindowsApps\\AppInstaller_new\\winget.exe";
  const calls = queryFixture(t, (count) => ({ output: JSON.stringify([count === 1 ? first : next]) }));
  const pending = installedWingetPaths({ fresh: true, platform: "win32" });
  assert.equal(installedWingetPaths({ platform: "win32" }), pending);
  assert.deepEqual(await pending, [first]);
  assert.deepEqual(await installedWingetPaths({ fresh: true, platform: "win32" }), [next]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 10_000);
  const script = Buffer.from(calls[0].args.at(-1), "base64").toString("utf16le");
  assert.match(script, /Get-AppxPackage -Name Microsoft\.DesktopAppInstaller/);
  assert.doesNotMatch(script, /-AllUsers|Add-AppxPackage|Install-Module|Repair-WinGet/);
});

test("winget 패키지 조회: 잘못된 응답과 조회 실패는 설치됨으로 판단하지 않는다", async (t) => {
  const responses = [
    { output: "not JSON" },
    { output: JSON.stringify(["winget.exe", "C:\\fake\\other.exe", 7, "C:\\valid\\winget.exe"]) },
    { error: Error("Appx access denied") },
  ];
  queryFixture(t, (count) => responses[count - 1]);
  assert.deepEqual(await installedWingetPaths({ fresh: true, platform: "win32" }), []);
  assert.deepEqual(await installedWingetPaths({ fresh: true, platform: "win32" }), ["C:\\valid\\winget.exe"]);
  assert.deepEqual(await installedWingetPaths({ fresh: true, platform: "win32" }), []);
});

test("winget 패키지 조회: Windows 이외의 환경은 PowerShell을 실행하지 않는다", async (t) => {
  const calls = queryFixture(t, () => { throw Error("Unexpected PowerShell query"); });
  assert.deepEqual(await installedWingetPaths({ fresh: true, platform: "linux" }), []);
  assert.equal(calls.length, 0);
});

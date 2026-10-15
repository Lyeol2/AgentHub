import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findWinget, wingetBootstrapPlan, WINGET_BOOTSTRAP_SCRIPT } from "../server/winget.mjs";

test("winget: 자동 준비 스크립트는 Windows PowerShell 5.1 문법으로 파싱된다", { skip: process.platform !== "win32" }, () => {
  const plan = wingetBootstrapPlan();
  const validation = `$taskTokens = $null; $taskErrors = $null; [System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${plan.args.at(-1)}')), [ref]$taskTokens, [ref]$taskErrors) | Out-Null; if ($taskErrors.Count) { $taskErrors | ForEach-Object { Write-Output $_.Message }; exit 1 }; exit 0`;
  const result = spawnSync(plan.file, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(validation, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
});

test("winget: PATH 검색에 현재 사용자 WindowsApps 실행 별칭 폴더를 보완한다", () => {
  const localAppData = "C:\\Users\\Agent Hub\\AppData\\Local";
  const expected = path.join(localAppData, "Microsoft", "WindowsApps", "winget.exe");
  const calls = [];
  const result = findWinget((name, extraDirs) => {
    calls.push({ name, extraDirs });
    return path.join(extraDirs[0], name);
  }, localAppData, "win32");
  assert.equal(result, expected);
  assert.deepEqual(calls, [{ name: "winget.exe", extraDirs: [path.dirname(expected)] }]);
});

test("winget: 사용자 폴더가 없으면 PATH만 검색하고 다른 운영체제에서는 검색하지 않는다", () => {
  const calls = [];
  const lookup = (name, extraDirs) => { calls.push({ name, extraDirs }); return null; };
  assert.equal(findWinget(lookup, "", "win32"), null);
  assert.deepEqual(calls, [{ name: "winget.exe", extraDirs: [] }]);
  assert.equal(findWinget(lookup, "ignored", "linux"), null);
  assert.equal(calls.length, 1);
});

test("winget: PATH에 의존하지 않는 Windows PowerShell에 UTF-16LE 스크립트를 비대화식으로 전달한다", () => {
  const plan = wingetBootstrapPlan("D:\\Windows");
  assert.equal(plan.how, "winget-bootstrap");
  assert.equal(plan.file, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(plan.args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.equal(Buffer.from(plan.args.at(-1), "base64").toString("utf16le"), WINGET_BOOTSTRAP_SCRIPT);
});

test("winget: 등록 복구 후 현재 사용자 범위에서 안정판을 설치하고 실제 실행을 검증한다", () => {
  const script = Buffer.from(wingetBootstrapPlan().args.at(-1), "base64").toString("utf16le");
  assert.match(script, /Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft\.DesktopAppInstaller_8wekyb3d8bbwe/);
  const registration = script.indexOf("Add-AppxPackage");
  const existingVersionCheck = script.indexOf("if (Test-AgentHubWinGet)");
  const provider = script.indexOf("Install-PackageProvider");
  const repair = script.indexOf("Repair-WinGetPackageManager");
  const finalVersionCheck = script.indexOf("if (-not (Test-AgentHubWinGet))");
  assert.ok(registration < existingVersionCheck && existingVersionCheck < provider && provider < repair && repair < finalVersionCheck);
  assert.match(script, /Install-PackageProvider[^\r\n]+-Scope CurrentUser[^\r\n]+-Force/);
  assert.match(script, /Install-Module[^\r\n]+-Repository PSGallery[^\r\n]+-Scope CurrentUser[^\r\n]+-Confirm:\$false/);
  assert.match(script, /Repair-WinGetPackageManager -Latest -ErrorAction Stop/);
  assert.match(script, /Get-Command winget\.exe -CommandType Application/);
  assert.match(script, /& \$taskWinGetPath --version/);
  assert.match(script, /\$LASTEXITCODE -eq 0/);
  assert.match(script, /exit 1/);
  assert.doesNotMatch(script, /-AllUsers|-IncludePreRelease|-Verb RunAs|Invoke-Expression|\biex\b|SetEnvironmentVariable/i);
  assert.doesNotMatch(script, /Repair-WinGetPackageManager[^\r\n]+-Force/);
});

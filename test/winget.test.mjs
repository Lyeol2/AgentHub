import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findWinget, resolveWinget, wingetBootstrapPlan, WINGET_BOOTSTRAP_SCRIPT } from "../server/winget.mjs";

// 실제 설치 명령은 모두 같은 이름의 함수로 막고, 버전 확인도 임시 cmd만 실행한다.
// -File은 긴 테스트 스크립트가 Windows 명령줄 길이 제한에 걸리지 않게 한다.
function runBootstrapFixture({ ready = false, resourceGet = false, failModule = false, registrationFails = false, packageReady = false, brokenAlias = false, queryFails = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-winget-mock-"));
  const stub = path.join(directory, "winget-stub.cmd");
  const brokenStub = path.join(directory, "winget-broken.cmd");
  const packageDirectory = path.join(directory, "Microsoft.DesktopAppInstaller_1.0.0.0_x64__8wekyb3d8bbwe");
  const packageExecutable = path.join(packageDirectory, "winget.exe");
  const script = path.join(directory, "bootstrap-mock.ps1");
  const harness = `
$script:taskMockReady = $${ready}
$script:taskMockResourceGet = $${resourceGet}
$script:taskMockFailModule = $${failModule}
$script:taskMockRegistrationFails = $${registrationFails}
$script:taskMockPackageReady = $${packageReady}
$script:taskMockBrokenAlias = $${brokenAlias}
$script:taskMockQueryFails = $${queryFails}
function Add-AppxPackage {
    [CmdletBinding()] param([switch]$RegisterByFamilyName, [string]$MainPackage)
    if (-not $RegisterByFamilyName -or $MainPackage -ne 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe') { throw 'Unexpected Appx operation' }
    [Console]::WriteLine('MOCK Add-AppxPackage')
    if ($script:taskMockRegistrationFails) { throw 'App Installer is not provisioned for this account' }
}
function Get-Command {
    [CmdletBinding()] param([string]$Name, [string]$CommandType)
    if ($Name -ne 'winget.exe' -or $CommandType -ne 'Application') { throw 'Unexpected command lookup' }
    if ($script:taskMockReady) { [pscustomobject]@{ Source = $env:TASK_WINGET_STUB } }
    elseif ($script:taskMockBrokenAlias) { [pscustomobject]@{ Source = $env:TASK_WINGET_BROKEN_STUB } }
}
function Get-AppxPackage {
    [CmdletBinding()] param([string]$Name)
    if ($Name -ne 'Microsoft.DesktopAppInstaller') { throw 'Unexpected Appx package lookup' }
    [Console]::WriteLine('MOCK Get-AppxPackage')
    if ($script:taskMockQueryFails) { throw 'Current-user Appx registration unavailable' }
    if ($script:taskMockPackageReady) {
        [pscustomobject]@{
            Name = 'Microsoft.DesktopAppInstaller'
            PackageFamilyName = 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe'
            Version = [version]'1.0.0.0'
            InstallLocation = $env:TASK_WINGET_PACKAGE
            IsFramework = $false
            IsResourcePackage = $false
        }
    }
}
function Test-Path {
    [CmdletBinding()] param([string]$LiteralPath, [string]$PathType)
    if ($PathType -ne 'Leaf') { throw 'Unexpected filesystem lookup' }
    if ($LiteralPath -like '*\\Microsoft\\WindowsApps\\winget.exe') { return $false }
    if ($LiteralPath -eq (Join-Path $env:TASK_WINGET_PACKAGE 'winget.exe')) { return [System.IO.File]::Exists($LiteralPath) }
    throw ('Unexpected filesystem lookup: ' + $LiteralPath)
}
function Get-Module {
    [CmdletBinding()] param([switch]$ListAvailable, [string]$Name)
    if (-not $ListAvailable -or $Name -ne 'Microsoft.PowerShell.PSResourceGet') { throw 'Unexpected module lookup' }
    [Console]::WriteLine('MOCK Get-Module')
    if ($script:taskMockResourceGet) { [pscustomobject]@{ Name = $Name; Version = [version]'1.1.1' } }
}
function Install-PackageProvider {
    [CmdletBinding()] param([string]$Name, [version]$MinimumVersion, [string]$Scope, [switch]$Force)
    if ($Name -ne 'NuGet' -or $MinimumVersion -lt [version]'2.8.5.201' -or $Scope -ne 'CurrentUser' -or -not $Force) { throw 'Unexpected package provider operation' }
    [Console]::WriteLine('MOCK Install-PackageProvider')
}
function Install-Module {
    [CmdletBinding(SupportsShouldProcess=$true)] param([string]$Name, [version]$MinimumVersion, [string]$Repository, [string]$Scope, [switch]$Force, [switch]$AllowClobber)
    [Console]::WriteLine('MOCK Install-Module:' + $Name)
    # Reproduce legacy PowerShellGet failing to unpack the latest WinGet module.
    if ($Name -eq 'Microsoft.WinGet.Client') { throw 'End of Central Directory record could not be found.' }
    if ($Name -ne 'Microsoft.PowerShell.PSResourceGet' -or $MinimumVersion -lt [version]'1.1.1' -or $Repository -ne 'PSGallery' -or $Scope -ne 'CurrentUser' -or -not $Force -or -not $AllowClobber) { throw 'Unexpected legacy module operation' }
    if ($script:taskMockFailModule) { throw 'PSResourceGet bootstrap download failed' }
}
function Import-Module {
    [CmdletBinding()] param([string]$Name, [version]$MinimumVersion, [switch]$Force)
    if ($Name -notin @('Microsoft.PowerShell.PSResourceGet', 'Microsoft.WinGet.Client')) { throw 'Unexpected module import' }
    if ($Name -eq 'Microsoft.PowerShell.PSResourceGet' -and $MinimumVersion -lt [version]'1.1.1') { throw 'PSResourceGet version requirement missing' }
    [Console]::WriteLine('MOCK Import-Module:' + $Name)
}
function Install-PSResource {
    [CmdletBinding(SupportsShouldProcess=$true)] param([string]$Name, [string]$Repository, [string]$Scope, [switch]$TrustRepository, [switch]$AcceptLicense, [switch]$Quiet, [switch]$Reinstall)
    if ($Name -ne 'Microsoft.WinGet.Client' -or $Repository -ne 'PSGallery' -or $Scope -ne 'CurrentUser' -or -not $TrustRepository -or -not $AcceptLicense -or -not $Quiet -or -not $Reinstall) { throw 'Unexpected resource installation' }
    [Console]::WriteLine('MOCK Install-PSResource:' + $Name)
}
function Repair-WinGetPackageManager {
    [CmdletBinding()] param([switch]$Latest)
    if (-not $Latest) { throw 'Stable WinGet repair was not requested' }
    [Console]::WriteLine('MOCK Repair-WinGetPackageManager')
    $script:taskMockReady = $true
}
`;
  try {
    fs.writeFileSync(stub, "@echo off\r\necho v1.12.0\r\nexit /b 0\r\n");
    fs.writeFileSync(brokenStub, "@echo off\r\necho winget alias is unavailable 1>&2\r\nexit /b 1\r\n");
    if (packageReady) {
      fs.mkdirSync(packageDirectory);
      // Node의 --version만 실행한다. 실제 App Installer 실행 파일이나 설치 명령을 쓰지 않는다.
      try { fs.linkSync(process.execPath, packageExecutable); }
      catch { fs.copyFileSync(process.execPath, packageExecutable); }
    }
    fs.writeFileSync(script, "\ufeff" + harness + "\n" + WINGET_BOOTSTRAP_SCRIPT);
    return spawnSync(wingetBootstrapPlan().file, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: { ...process.env, TASK_WINGET_STUB: stub, TASK_WINGET_BROKEN_STUB: brokenStub, TASK_WINGET_PACKAGE: packageDirectory, LOCALAPPDATA: directory },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function mockEvents(result) {
  return result.stdout.split(/\r?\n/).filter((line) => line.startsWith("MOCK "));
}

test("winget: 자동 준비 스크립트는 Windows PowerShell 5.1 문법으로 파싱된다", { skip: process.platform !== "win32" }, () => {
  const plan = wingetBootstrapPlan();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-winget-parse-"));
  try {
    const target = path.join(directory, "bootstrap.ps1");
    const validator = path.join(directory, "parse.ps1");
    fs.writeFileSync(target, "\ufeff" + WINGET_BOOTSTRAP_SCRIPT);
    fs.writeFileSync(validator, "\ufeffparam([string]$TargetScript)\n$taskTokens = $null; $taskErrors = $null; [System.Management.Automation.Language.Parser]::ParseFile($TargetScript, [ref]$taskTokens, [ref]$taskErrors) | Out-Null; if ($taskErrors.Count) { $taskErrors | ForEach-Object { Write-Output $_.Message }; exit 1 }; exit 0");
    const result = spawnSync(plan.file, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", validator, "-TargetScript", target], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "winget.exe");
  assert.deepEqual(calls[0].extraDirs, [path.dirname(expected), path.join(path.dirname(expected), "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe")]);
});

test("winget: 사용자 환경 변수가 없으면 홈 폴더로 보완하고 다른 운영체제에서는 검색하지 않는다", () => {
  const calls = [];
  const lookup = (name, extraDirs) => { calls.push({ name, extraDirs }); return null; };
  const previous = process.env.LOCALAPPDATA;
  try {
    delete process.env.LOCALAPPDATA;
    assert.equal(findWinget(lookup, undefined, "win32"), null);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "winget.exe");
  assert.ok(calls[0].extraDirs.includes(path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps")));
  assert.equal(findWinget(lookup, "ignored", "linux"), null);
  assert.equal(calls.length, 1);
});

test("winget 탐지: 실행 가능한 PATH·별칭을 찾으면 Appx 조회를 생략한다", async () => {
  const file = "C:\\Users\\Agent Hub\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
  const checks = [];
  let packageQueries = 0;
  const found = await resolveWinget({
    find: () => file,
    version: async (candidate, options) => { checks.push({ candidate, options }); return "v1.12.0"; },
    packagePaths: async () => { packageQueries++; return []; },
    fresh: true,
  });
  assert.deepEqual(found, { path: file, version: "v1.12.0" });
  assert.deepEqual(checks, [{ candidate: file, options: { fresh: true } }]);
  assert.equal(packageQueries, 0);
});

test("winget 탐지: 비활성 별칭은 현재 사용자 Appx의 실제 실행 파일로 보완한다", async () => {
  const file = "C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\\winget.exe";
  const queries = [];
  const checks = [];
  const found = await resolveWinget({
    find: () => null,
    packagePaths: async (options) => { queries.push(options); return [file]; },
    version: async (candidate, options) => { checks.push({ candidate, options }); return "v1.29.380"; },
    fresh: true,
  });
  assert.deepEqual(found, { path: file, version: "v1.29.380" });
  assert.deepEqual(queries, [{ fresh: true }]);
  assert.deepEqual(checks, [{ candidate: file, options: { fresh: true } }]);
});

test("winget 탐지: 별칭이 있어도 실행 실패하면 Appx 후보를 차례로 확인한다", async () => {
  const alias = "C:\\Users\\Agent Hub\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
  const candidates = ["C:\\Packages\\old\\winget.exe", "C:\\Packages\\current\\winget.exe"];
  const checks = [];
  const found = await resolveWinget({
    find: () => alias,
    packagePaths: async () => candidates,
    version: async (file, options) => { checks.push({ file, options }); return file === candidates[1] ? "v1.29.380" : null; },
  });
  assert.deepEqual(found, { path: candidates[1], version: "v1.29.380" });
  assert.deepEqual(checks, [alias, ...candidates].map((file) => ({ file, options: { fresh: false } })));
});

test("winget 탐지: 실행되는 후보가 없으면 발견된 경로와 확인 실패를 함께 반환한다", async () => {
  const primary = "C:\\Aliases\\winget.exe";
  const installed = "C:\\Packages\\winget.exe";
  const version = async () => null;
  assert.deepEqual(await resolveWinget({ find: () => primary, version, packagePaths: async () => [installed] }), { path: primary, version: null });
  assert.deepEqual(await resolveWinget({ find: () => null, version, packagePaths: async () => [installed] }), { path: installed, version: null });
  assert.deepEqual(await resolveWinget({ find: () => null, version, packagePaths: async () => [] }), { path: null, version: null });
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
  assert.match(script, /Install-Module -Name Microsoft\.PowerShell\.PSResourceGet[^\r\n]+-MinimumVersion 1\.1\.1[^\r\n]+-Repository PSGallery[^\r\n]+-Scope CurrentUser[^\r\n]+-Confirm:\$false/);
  assert.match(script, /Get-Module -ListAvailable -Name Microsoft\.PowerShell\.PSResourceGet/);
  assert.match(script, /Import-Module Microsoft\.PowerShell\.PSResourceGet -MinimumVersion 1\.1\.1 -Force/);
  assert.match(script, /Install-PSResource -Name Microsoft\.WinGet\.Client[^\r\n]+-Repository PSGallery[^\r\n]+-Scope CurrentUser[^\r\n]+-TrustRepository[^\r\n]+-AcceptLicense[^\r\n]+-Quiet[^\r\n]+-Reinstall[^\r\n]+-Confirm:\$false/);
  assert.doesNotMatch(script, /Install-Module -Name Microsoft\.WinGet\.Client|Write-Host|Set-PSRepository|Register-PSResourceRepository/);
  assert.match(script, /Repair-WinGetPackageManager -Latest -ErrorAction Stop/);
  assert.match(script, /Get-Command winget\.exe -CommandType Application/);
  assert.match(script, /Get-AppxPackage -Name Microsoft\.DesktopAppInstaller/);
  assert.match(script, /InstallLocation/);
  assert.match(script, /Get-AgentHubWinGetPackagePaths/);
  assert.match(script, /& \$taskWinGetPath --version/);
  assert.match(script, /\$LASTEXITCODE -eq 0/);
  assert.match(script, /exit 1/);
  assert.doesNotMatch(script, /-AllUsers|-IncludePreRelease|-Verb RunAs|Invoke-Expression|\biex\b|SetEnvironmentVariable/i);
  assert.doesNotMatch(script, /Repair-WinGetPackageManager[^\r\n]+-Force/);
});

test("winget 실행: 이미 실행되면 모듈 설치 없이 끝난다", { skip: process.platform !== "win32" }, () => {
  const result = runBootstrapFixture({ ready: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  assert.deepEqual(mockEvents(result), ["MOCK Add-AppxPackage"]);
  assert.match(result.stdout, /v1\.12\.0/);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /CLIXML|<Objs/);
});

test("winget 실행: 신규 계정과 구형 PowerShellGet에서도 PSResourceGet으로 설치한다", { skip: process.platform !== "win32" }, () => {
  const result = runBootstrapFixture({ registrationFails: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  assert.deepEqual(mockEvents(result), [
    "MOCK Add-AppxPackage", "MOCK Get-AppxPackage", "MOCK Get-Module", "MOCK Install-PackageProvider",
    "MOCK Install-Module:Microsoft.PowerShell.PSResourceGet",
    "MOCK Import-Module:Microsoft.PowerShell.PSResourceGet",
    "MOCK Install-PSResource:Microsoft.WinGet.Client", "MOCK Import-Module:Microsoft.WinGet.Client",
    "MOCK Repair-WinGetPackageManager",
  ]);
  assert.match(result.stdout, /App Installer registration was unavailable/);
  assert.match(result.stdout, /v1\.12\.0/);
  assert.doesNotMatch(result.stdout, /MOCK Install-Module:Microsoft\.WinGet\.Client|CLIXML|<Objs/);
  assert.equal(result.stderr, "");
});

test("winget 실행: 기존 PSResourceGet을 재사용하며 NuGet과 모듈 재설치를 생략한다", { skip: process.platform !== "win32" }, () => {
  const result = runBootstrapFixture({ resourceGet: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  assert.deepEqual(mockEvents(result), [
    "MOCK Add-AppxPackage", "MOCK Get-AppxPackage", "MOCK Get-Module", "MOCK Import-Module:Microsoft.PowerShell.PSResourceGet",
    "MOCK Install-PSResource:Microsoft.WinGet.Client", "MOCK Import-Module:Microsoft.WinGet.Client",
    "MOCK Repair-WinGetPackageManager",
  ]);
  assert.equal(result.stderr, "");
});

test("winget 실행: PSResourceGet 준비 실패는 읽을 수 있는 오류와 종료 코드 1을 남긴다", { skip: process.platform !== "win32" }, () => {
  const result = runBootstrapFixture({ failModule: true });
  assert.equal(result.status, 1, result.error?.message ?? result.stderr + result.stdout);
  assert.deepEqual(mockEvents(result), [
    "MOCK Add-AppxPackage", "MOCK Get-AppxPackage", "MOCK Get-Module", "MOCK Install-PackageProvider",
    "MOCK Install-Module:Microsoft.PowerShell.PSResourceGet",
  ]);
  assert.match(result.stdout, /WinGet preparation failed: PSResourceGet bootstrap download failed/);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /CLIXML|<Objs/);
});

test("winget 실행: 별칭이 없어도 현재 사용자 Appx 실제 파일을 찾으면 재설치하지 않는다", { skip: process.platform !== "win32" }, () => {
  const result = runBootstrapFixture({ packageReady: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  assert.deepEqual(mockEvents(result), ["MOCK Add-AppxPackage", "MOCK Get-AppxPackage"]);
  assert.ok(result.stdout.includes(process.version));
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /MOCK Install-|MOCK Repair-/);
});

test("winget 실행: 실행할 수 없는 별칭 뒤에도 Appx 실제 파일을 확인한다", { skip: process.platform !== "win32" }, () => {
  const result = runBootstrapFixture({ packageReady: true, brokenAlias: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  assert.deepEqual(mockEvents(result), ["MOCK Add-AppxPackage", "MOCK Get-AppxPackage"]);
  assert.ok(result.stdout.includes(process.version));
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /MOCK Install-|MOCK Repair-/);
});

test("winget 실행: Appx 조회 실패 시에도 공식 복구와 버전 확인을 계속한다", { skip: process.platform !== "win32" }, () => {
  const result = runBootstrapFixture({ queryFails: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  assert.deepEqual(mockEvents(result), [
    "MOCK Add-AppxPackage", "MOCK Get-AppxPackage", "MOCK Get-Module", "MOCK Install-PackageProvider",
    "MOCK Install-Module:Microsoft.PowerShell.PSResourceGet",
    "MOCK Import-Module:Microsoft.PowerShell.PSResourceGet",
    "MOCK Install-PSResource:Microsoft.WinGet.Client", "MOCK Import-Module:Microsoft.WinGet.Client",
    "MOCK Repair-WinGetPackageManager",
  ]);
  assert.match(result.stdout, /v1\.12\.0/);
  assert.equal(result.stderr, "");
});

import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { locateCommand, cliVersion } from "./cli.mjs";

const PACKAGE_FAMILY = "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe";
const powerShellFile = (systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows") => path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// 새 사용자 계정은 App Installer가 있어도 WindowsApps 실행 별칭이 PATH에 없을 수 있다.
export function findWinget(lookup = locateCommand, localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), platform = process.platform) {
  if (platform !== "win32") return null;
  const aliases = localAppData ? path.join(localAppData, "Microsoft", "WindowsApps") : null;
  return lookup("winget.exe", aliases ? [aliases, path.join(aliases, PACKAGE_FAMILY)] : []);
}

// 현재 사용자에게 등록된 패키지만 조회한다. 별칭이 꺼졌거나 없을 때도 실제 실행 파일은 쓸 수 있다.
const packagePathsFunction = String.raw`
function Get-AgentHubWinGetPackagePaths {
    try {
        $taskWinGetPackages = @(Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction Stop)
        foreach ($taskWinGetPackage in @($taskWinGetPackages | Where-Object { $_.PackageFamilyName -eq 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe' -and -not $_.IsResourcePackage -and $_.InstallLocation } | Sort-Object Version -Descending)) {
            $taskWinGetExecutable = Join-Path $taskWinGetPackage.InstallLocation 'winget.exe'
            if (Test-Path -LiteralPath $taskWinGetExecutable -PathType Leaf) { $taskWinGetExecutable }
        }
    } catch {
        # Appx 조회가 제한된 환경은 다른 경로 확인이나 등록 복구를 계속한다.
    }
}
`;

export const WINGET_PACKAGE_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
${packagePathsFunction}
$taskWinGetPackagePaths = @(Get-AgentHubWinGetPackagePaths)
[Console]::WriteLine((ConvertTo-Json -InputObject $taskWinGetPackagePaths -Compress))
`.trim();

let packageCache;
export function installedWingetPaths({ fresh = false, platform = process.platform } = {}) {
  if (platform !== "win32") return Promise.resolve([]);
  if (!fresh && packageCache && Date.now() - packageCache.at < 30_000) return packageCache.promise;
  const promise = new Promise((resolve) => {
    try {
      execFile(powerShellFile(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINGET_PACKAGE_QUERY_SCRIPT, "utf16le").toString("base64")], {
        encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 64_000,
      }, (error, stdout) => {
        if (error) return resolve([]);
        try {
          const paths = JSON.parse(stdout.trim());
          resolve(Array.isArray(paths) ? paths.filter((file) => typeof file === "string" && path.win32.isAbsolute(file) && path.win32.basename(file).toLowerCase() === "winget.exe") : []);
        } catch { resolve([]); }
      });
    } catch { resolve([]); }
  });
  packageCache = { at: Date.now(), promise };
  return promise;
}

export async function resolveWinget({ find = findWinget, version = cliVersion, packagePaths = installedWingetPaths, fresh = false } = {}) {
  const primary = find();
  const check = async (file) => {
    try { return file ? await version(file, { fresh }) : null; }
    catch { return null; }
  };
  const primaryVersion = await check(primary);
  if (primaryVersion) return { path: primary, version: primaryVersion };
  let candidates;
  try { candidates = await packagePaths({ fresh }); }
  catch { candidates = []; }
  const seen = new Set(primary ? [path.win32.normalize(primary).toLowerCase()] : []);
  for (const file of candidates) {
    const key = path.win32.normalize(file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const foundVersion = await check(file);
    if (foundVersion) return { path: file, version: foundVersion };
  }
  return { path: primary ?? candidates[0] ?? null, version: null };
}

// Microsoft가 문서화한 등록 재시도와 WinGet PowerShell 모듈의 복구 명령을 사용한다.
// 기본 PowerShellGet 1.0의 WinGet 패키지 압축 오류를 피하도록 PSResourceGet으로 설치한다.
// https://learn.microsoft.com/en-us/windows/package-manager/winget/
// https://github.com/microsoft/winget-cli/blob/master/src/PowerShell/Help/Microsoft.WinGet.Client/Repair-WinGetPackageManager.md
// https://github.com/microsoft/winget-cli/issues/6017
export const WINGET_BOOTSTRAP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskWinGetUtf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $taskWinGetUtf8
$OutputEncoding = $taskWinGetUtf8
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

${packagePathsFunction}

function Test-AgentHubWinGetPath {
    param([string]$taskWinGetPath)
    try {
        $taskWinGetVersion = @(& $taskWinGetPath --version 2>&1)
        if ($LASTEXITCODE -eq 0 -and ($taskWinGetVersion -join [Environment]::NewLine) -match '(?m)^v?\d+\.\d+') {
            [Console]::WriteLine(($taskWinGetVersion -join [Environment]::NewLine))
            return $true
        }
    } catch {
        # 실행 별칭이 아직 준비되지 않았다면 다음 경로나 설치 복구를 시도한다.
    }
    return $false
}

function Test-AgentHubWinGet {
    $taskWinGetPaths = @()
    $taskWinGetCommand = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($taskWinGetCommand) { $taskWinGetPaths += $taskWinGetCommand.Source }
    if ($env:LOCALAPPDATA) {
        $taskWinGetAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
        if (Test-Path -LiteralPath $taskWinGetAlias -PathType Leaf) { $taskWinGetPaths += $taskWinGetAlias }
    }
    foreach ($taskWinGetPath in @($taskWinGetPaths | Select-Object -Unique)) {
        if (Test-AgentHubWinGetPath $taskWinGetPath) { return $true }
    }
    foreach ($taskWinGetPath in @(Get-AgentHubWinGetPackagePaths)) {
        if (Test-AgentHubWinGetPath $taskWinGetPath) { return $true }
    }
    return $false
}

try {
    [Console]::WriteLine('Registering App Installer for the current user...')
    try {
        Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop | Out-Null
    } catch {
        [Console]::WriteLine(('App Installer registration was unavailable: ' + $_.Exception.Message))
    }
    if (Test-AgentHubWinGet) { exit 0 }

    $taskWinGetResourceModule = Get-Module -ListAvailable -Name Microsoft.PowerShell.PSResourceGet | Where-Object { $_.Version -ge [Version]'1.1.1' }
    if (-not $taskWinGetResourceModule) {
        [Console]::WriteLine('Preparing the current-user PowerShell package installer...')
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force -ErrorAction Stop | Out-Null
        Install-Module -Name Microsoft.PowerShell.PSResourceGet -MinimumVersion 1.1.1 -Repository PSGallery -Scope CurrentUser -Force -AllowClobber -Confirm:$false -ErrorAction Stop
    }
    Import-Module Microsoft.PowerShell.PSResourceGet -MinimumVersion 1.1.1 -Force -ErrorAction Stop
    [Console]::WriteLine('Installing Microsoft.WinGet.Client for the current user...')
    Install-PSResource -Name Microsoft.WinGet.Client -Repository PSGallery -Scope CurrentUser -TrustRepository -AcceptLicense -Quiet -Reinstall -Confirm:$false -ErrorAction Stop
    Import-Module Microsoft.WinGet.Client -Force -ErrorAction Stop
    [Console]::WriteLine('Preparing the latest stable WinGet release...')
    Repair-WinGetPackageManager -Latest -ErrorAction Stop | Out-Host

    if (-not (Test-AgentHubWinGet)) { throw 'WinGet was installed but winget --version could not be verified. Check the App Installer execution alias and retry.' }
    exit 0
} catch {
    [Console]::WriteLine(('WinGet preparation failed: ' + $_.Exception.Message))
    exit 1
}
`.trim();

export function wingetBootstrapPlan(systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows") {
  return {
    how: "winget-bootstrap",
    // Windows PowerShell 5.1 includes Appx cmdlets even when PowerShell is absent from PATH.
    file: powerShellFile(systemRoot),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINGET_BOOTSTRAP_SCRIPT, "utf16le").toString("base64")],
  };
}

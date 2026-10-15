import path from "node:path";
import { locateCommand } from "./cli.mjs";

// 새 사용자 계정은 App Installer가 있어도 WindowsApps 실행 별칭이 PATH에 없을 수 있다.
export function findWinget(lookup = locateCommand, localAppData = process.env.LOCALAPPDATA, platform = process.platform) {
  if (platform !== "win32") return null;
  return lookup("winget.exe", localAppData ? [path.join(localAppData, "Microsoft", "WindowsApps")] : []);
}

// Microsoft가 문서화한 등록 재시도와 WinGet PowerShell 모듈의 복구 명령을 사용한다.
// https://learn.microsoft.com/en-us/windows/package-manager/winget/
// https://github.com/microsoft/winget-cli/blob/master/src/PowerShell/Help/Microsoft.WinGet.Client/Repair-WinGetPackageManager.md
export const WINGET_BOOTSTRAP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskWinGetUtf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $taskWinGetUtf8
$OutputEncoding = $taskWinGetUtf8
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Test-AgentHubWinGet {
    $taskWinGetPaths = @()
    $taskWinGetCommand = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($taskWinGetCommand) { $taskWinGetPaths += $taskWinGetCommand.Source }
    if ($env:LOCALAPPDATA) {
        $taskWinGetAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
        if (Test-Path -LiteralPath $taskWinGetAlias -PathType Leaf) { $taskWinGetPaths += $taskWinGetAlias }
    }
    foreach ($taskWinGetPath in @($taskWinGetPaths | Select-Object -Unique)) {
        try {
            $taskWinGetVersion = @(& $taskWinGetPath --version 2>&1)
            if ($LASTEXITCODE -eq 0 -and ($taskWinGetVersion -join [Environment]::NewLine) -match '(?m)^v?\d+\.\d+') {
                Write-Host ($taskWinGetVersion -join [Environment]::NewLine)
                return $true
            }
        } catch {
            # 실행 별칭이 아직 준비되지 않았다면 다음 경로나 설치 복구를 시도한다.
        }
    }
    return $false
}

try {
    Write-Host 'Registering App Installer for the current user...'
    try {
        Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop | Out-Null
    } catch {
        Write-Host ('App Installer registration was unavailable: ' + $_.Exception.Message)
    }
    if (Test-AgentHubWinGet) { exit 0 }

    Write-Host 'Installing Microsoft.WinGet.Client for the current user...'
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force -ErrorAction Stop | Out-Null
    Install-Module -Name Microsoft.WinGet.Client -Repository PSGallery -Scope CurrentUser -Force -AllowClobber -Confirm:$false -ErrorAction Stop
    Import-Module Microsoft.WinGet.Client -Force -ErrorAction Stop
    Write-Host 'Preparing the latest stable WinGet release...'
    Repair-WinGetPackageManager -Latest -ErrorAction Stop | Out-Host

    if (-not (Test-AgentHubWinGet)) { throw 'WinGet was installed but winget --version could not be verified. Check the App Installer execution alias and retry.' }
    exit 0
} catch {
    Write-Host ('WinGet preparation failed: ' + $_.Exception.Message)
    exit 1
}
`.trim();

export function wingetBootstrapPlan(systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows") {
  return {
    how: "winget-bootstrap",
    // Windows PowerShell 5.1 includes Appx cmdlets even when PowerShell is absent from PATH.
    file: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINGET_BOOTSTRAP_SCRIPT, "utf16le").toString("base64")],
  };
}

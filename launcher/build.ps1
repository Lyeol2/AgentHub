# AgentHub.exe를 저장소 루트에 만든다. Windows에 기본으로 들어 있는 .NET Framework 4 C# 컴파일러를 쓴다.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$icon = Join-Path $PSScriptRoot "agenthub.ico"
$out = Join-Path $root "AgentHub.exe"

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "csc.exe(.NET Framework 4)를 찾을 수 없습니다." }

if (-not (Test-Path $icon)) { & (Join-Path $PSScriptRoot "make-icon.ps1") }

& $csc /nologo /target:winexe /optimize+ /codepage:65001 `
  "/out:$out" "/win32icon:$icon" "/resource:$icon,agenthub.ico" `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  (Join-Path $PSScriptRoot "AgentHub.cs")
if ($LASTEXITCODE -ne 0) { throw "빌드에 실패했습니다." }
Write-Host "빌드 완료: $out"

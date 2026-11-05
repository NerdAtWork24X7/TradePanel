# Reproducible Windows release: one-folder sidecar + NSIS installer.
#
#   powershell -ExecutionPolicy Bypass -File backend\scripts\build-windows.ps1
#   ... -SkipBackend    # reuse the already staged sidecar
#   ... -Install        # force `npm ci` for the shell and the frontend
param(
    [switch]$SkipBackend,
    [switch]$Install
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

# Remove stale staged resources (Tauri does not prune them).
if (Test-Path "src-tauri\target\release\backend") { Remove-Item -Recurse -Force "src-tauri\target\release\backend" }
if (Test-Path "src-tauri\target\release\bundle") { Remove-Item -Recurse -Force "src-tauri\target\release\bundle" }

$Sidecar = "src-tauri\backend-dist\tradepanel-backend\tradepanel-backend.exe"
if ($SkipBackend) {
    if (-not (Test-Path $Sidecar)) {
        throw "-SkipBackend given but $Sidecar is missing; run backend\scripts\build-backend.ps1."
    }
    Write-Host "Reusing staged sidecar: $Sidecar"
} else {
    & (Join-Path $PSScriptRoot "build-backend.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Sidecar build failed" }
}

if ($Install -or -not (Test-Path "frontend\node_modules")) {
    npm --prefix frontend ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci (frontend) failed" }
}
if ($Install -or -not (Test-Path "node_modules")) {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
}

npx tauri build
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

Write-Host ""
Write-Host "Artifacts:"
Get-ChildItem "src-tauri\target\release\bundle\nsis" -Filter *.exe | Format-Table Name, Length

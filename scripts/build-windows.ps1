# Reproducible Windows release: one-folder sidecar + NSIS installer.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Remove stale staged resources (Tauri does not prune them).
if (Test-Path "src-tauri\target\release\backend") { Remove-Item -Recurse -Force "src-tauri\target\release\backend" }
if (Test-Path "src-tauri\target\release\bundle") { Remove-Item -Recurse -Force "src-tauri\target\release\bundle" }

& (Join-Path $PSScriptRoot "build-backend.ps1")
npm --prefix frontend ci --no-audit --no-fund
npm ci --no-audit --no-fund
npx tauri build

Write-Host ""
Write-Host "Artifacts:"
Get-ChildItem "src-tauri\target\release\bundle\nsis" -Filter *.exe | Format-Table Name, Length

# Build the Python sidecar (one folder) and stage it as a Tauri resource.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$Venv = if ($env:TRADEPANEL_BUILD_VENV) { $env:TRADEPANEL_BUILD_VENV } else { Join-Path $Root ".venv-build" }
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Python)) {
    Write-Host "Creating build environment at $Venv"
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        uv venv --python 3.12 $Venv
        uv pip install --python $Python -r backend\requirements.txt -r backend\build\requirements-build.txt
    } else {
        python -m venv $Venv
        & (Join-Path $Venv "Scripts\pip.exe") install -r backend\requirements.txt -r backend\build\requirements-build.txt
    }
}

Write-Host "Building one-folder sidecar"
if (Test-Path "backend\build\work") { Remove-Item -Recurse -Force "backend\build\work" }
if (Test-Path "backend\build\dist") { Remove-Item -Recurse -Force "backend\build\dist" }
& $Python -m PyInstaller --noconfirm --clean --distpath backend\build\dist --workpath backend\build\work backend\build\backend.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$Source = "backend\build\dist\tradepanel-backend"
$Target = "src-tauri\backend-dist\tradepanel-backend"
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
Copy-Item -Recurse $Source $Target

Write-Host "Smoke-testing the packaged sidecar"
& (Join-Path $Target "tradepanel-backend.exe") --self-check
if ($LASTEXITCODE -ne 0) { throw "Sidecar self-check failed" }

Write-Host "Sidecar ready: $Target"

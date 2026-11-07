# Bootstrap and launch TradePanel on native Windows.
#
#   tradePanel.cmd                     # check/install prerequisites (with consent), then run
#   tradePanel.cmd -Yes                # install missing prerequisites without prompting
#   tradePanel.cmd -NoInstall          # never install; print instructions instead
#   tradePanel.cmd --rebuild-backend   # force a fresh PyInstaller sidecar first
#   tradePanel.cmd -- --no-watch       # arguments after -- go to `tauri dev`
#
# This is the Windows counterpart of the repository-root `tradePanel` script.
# The first run detects what is missing, asks for consent, and installs it with
# winget. Later runs start directly.
#
# Arguments are read from $args rather than a param block so that arbitrary
# `tauri dev` flags (which also start with "-") pass through untouched.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$Yes = $false
$NoInstall = $false
$RebuildBackend = $false
$TauriArgs = @()
foreach ($arg in $args) {
    if (-not $arg) { continue }
    switch -Regex ($arg) {
        '^(-Yes|--yes|-y)$' { $Yes = $true; continue }
        '^(-NoInstall|--no-install)$' { $NoInstall = $true; continue }
        '^(--rebuild-backend|-r)$' { $RebuildBackend = $true; continue }
        '^--$' { continue }
        default { $TauriArgs += $arg }
    }
}

function Have($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
    # rustup and the uv installer update the user PATH, but a running process
    # does not see it until it is restarted. Add the usual locations explicitly.
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.local\bin;$env:LOCALAPPDATA\Programs\uv;$env:Path"
    foreach ($dir in @(
        "$env:LOCALAPPDATA\Programs\Python\Python312",
        "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts"
    )) {
        if (Test-Path $dir) { $env:Path = "$dir;$env:Path" }
    }
}

function Node-Ok {
    if (-not (Have node)) { return $false }
    try {
        $major = [int](& node -p "process.versions.node.split('.')[0]" 2>$null)
        return ($major -ge 20)
    } catch {
        return $false
    }
}

function Python-Ok {
    if (-not (Have python)) { return $false }
    try {
        $version = (& python --version 2>&1) -join " "
        return ($version -match '3\.(1[2-9]|[2-9][0-9])')
    } catch {
        return $false
    }
}

function VsTools-Ok {
    $pf86 = ${env:ProgramFiles(x86)}
    if (-not $pf86) { return $false }
    $vswhere = Join-Path $pf86 "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $false }
    $path = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    return [bool]$path
}

function WebView2-Ok {
    $keys = @(
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    foreach ($key in $keys) {
        if (Test-Path $key) { return $true }
    }
    return $false
}

function Get-Missing {
    $missing = @()
    if (-not (Node-Ok)) {
        $missing += @{ Label = "Node.js 20+"; Id = "OpenJS.NodeJS.LTS" }
    }
    if (-not (Have cargo) -or -not (Have rustc)) {
        $missing += @{ Label = "Rust (MSVC toolchain)"; Id = "Rustlang.Rustup" }
    }
    if (-not (Python-Ok)) {
        $missing += @{ Label = "Python 3.12"; Id = "Python.Python.3.12" }
    }
    if (-not (Have uv)) {
        $missing += @{ Label = "uv"; Id = "astral-sh.uv" }
    }
    if (-not (VsTools-Ok)) {
        $missing += @{
            Label = "Visual Studio C++ Build Tools"
            Id = "Microsoft.VisualStudio.2022.BuildTools"
            Args = @("--override", "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended")
        }
    }
    if (-not (WebView2-Ok)) {
        $missing += @{ Label = "Microsoft Edge WebView2 Runtime"; Id = "Microsoft.EdgeWebView2Runtime" }
    }
    return $missing
}

function Show-VendorLinks {
    Write-Host "Vendor downloads:"
    Write-Host "  Node.js:   https://nodejs.org/en/download"
    Write-Host "  Rust:      https://rustup.rs"
    Write-Host "  Python:    https://www.python.org/downloads/windows/"
    Write-Host "  uv:        https://docs.astral.sh/uv/getting-started/installation/"
    Write-Host "  VS Build:  https://visualstudio.microsoft.com/visual-cpp-build-tools/"
}

function Show-Manual {
    Write-Host @"
Install these with winget (or from the vendor sites), then run tradePanel.cmd again:

  winget install --id OpenJS.NodeJS.LTS -e
  winget install --id Rustlang.Rustup -e
  winget install --id Python.Python.3.12 -e
  winget install --id astral-sh.uv -e
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  winget install --id Microsoft.EdgeWebView2Runtime -e
"@
}

function Install-WingetPackage($package) {
    Write-Host "Installing $($package.Label) ($($package.Id))"
    $wingetArgs = @(
        "install", "--id", $package.Id, "--exact", "--silent",
        "--accept-package-agreements", "--accept-source-agreements"
    )
    if ($package.ContainsKey("Args")) {
        $wingetArgs += $package.Args
    }
    & winget @wingetArgs
    if ($LASTEXITCODE -ne 0) {
        throw "winget failed for $($package.Id) (exit $LASTEXITCODE)"
    }
}

# ── Prerequisite detection ──────────────────────────────────────────────────
$missing = @(Get-Missing)

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "TradePanel needs a few tools before it can run on this Windows machine:"
    foreach ($package in $missing) {
        Write-Host "  - $($package.Label)"
    }
    Write-Host ""

    if ($NoInstall) {
        Write-Host "TradePanel: -NoInstall was given; nothing will be installed." -ForegroundColor Yellow
        if (Have winget) { Show-Manual } else { Show-VendorLinks }
        exit 1
    }
    if (-not (Have winget)) {
        Write-Host "TradePanel: winget (App Installer) is required to install these automatically." -ForegroundColor Yellow
        Write-Host "Install 'App Installer' from the Microsoft Store, then run tradePanel.cmd again."
        Write-Host ""
        Show-VendorLinks
        exit 1
    }
    if (-not $Yes) {
        try {
            $reply = Read-Host "Install these now? [y/N]"
        } catch {
            Write-Host "TradePanel: cannot ask for consent without a terminal. Re-run with -Yes." -ForegroundColor Yellow
            exit 1
        }
        if ($reply -notmatch '^(y|yes)$') {
            Write-Host "Aborted. Nothing was installed."
            exit 1
        }
    }

    foreach ($package in $missing) {
        Install-WingetPackage $package
    }
    Refresh-Path

    if (Have rustup) {
        & rustup default stable-msvc
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "rustup could not set the stable-msvc toolchain automatically"
        }
    }

    $remaining = @(Get-Missing)
    if ($remaining.Count -gt 0) {
        Write-Host ""
        Write-Host "TradePanel: still missing after installation:" -ForegroundColor Yellow
        foreach ($package in $remaining) {
            Write-Host "  - $($package.Label)"
        }
        Show-Manual
        exit 1
    }
}

# ── JavaScript dependencies ─────────────────────────────────────────────────
if (-not (Test-Path "frontend\node_modules")) {
    Write-Host "Installing frontend dependencies"
    npm --prefix frontend ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci (frontend) failed" }
}
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing Tauri CLI"
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
}

# ── Python sidecar ──────────────────────────────────────────────────────────
$Sidecar = "src-tauri\backend-dist\tradepanel-backend\tradepanel-backend.exe"
if ($RebuildBackend -or -not (Test-Path $Sidecar)) {
    & (Join-Path $PSScriptRoot "build-backend.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Sidecar build failed" }
}

# ── Run ─────────────────────────────────────────────────────────────────────
$tauri = @("tauri", "dev") + $TauriArgs
& npx @tauri
exit $LASTEXITCODE

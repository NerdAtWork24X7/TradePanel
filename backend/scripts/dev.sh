#!/usr/bin/env bash
# Development loop: Python sidecar + Vite + Tauri (hot reload).
#
#   backend/scripts/dev.sh                 # reuse the staged sidecar when present
#   backend/scripts/dev.sh --rebuild-backend   # force a fresh PyInstaller build
#   backend/scripts/dev.sh -- <tauri args>     # anything else is passed to `tauri dev`
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

for _d in "$HOME/.cargo/bin" "$HOME/.local/bin" "$HOME/.nvm/versions/node"/*/bin; do
  [[ -d "$_d" ]] && PATH="$_d:$PATH"
done
export PATH

# Expose the local webkit2gtk pkg-config sysroot to cargo when present.
# Locate webkit2gtk pkg-config metadata (system install or the bundled sysroot).
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  _webkit_pc="$(find /tmp /opt /usr/local -name 'webkit2gtk-4.1.pc' -print -quit 2>/dev/null || true)"
  if [[ -n "${_webkit_pc:-}" ]]; then
    export PKG_CONFIG_PATH="$(dirname "$_webkit_pc")${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  fi
  unset _webkit_pc
fi

REBUILD=0
TAURI_ARGS=()
for arg in "$@"; do
  case "$arg" in
    -r|--rebuild-backend) REBUILD=1 ;;
    *) TAURI_ARGS+=("$arg") ;;
  esac
done

IS_WINDOWS=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac

if [[ ! -d frontend/node_modules ]]; then
  echo "Installing frontend dependencies"
  npm --prefix frontend ci
fi
if [[ ! -d node_modules ]]; then
  echo "Installing Tauri CLI"
  npm ci
fi

SIDECAR="src-tauri/backend-dist/tradepanel-backend/tradepanel-backend"
[[ -f "$SIDECAR.exe" ]] && SIDECAR="$SIDECAR.exe"

if [[ $REBUILD -eq 1 || ! -f "$SIDECAR" ]]; then
  if [[ $IS_WINDOWS -eq 1 ]]; then
    echo "Sidecar missing. Build it from PowerShell first:" >&2
    echo "  powershell -ExecutionPolicy Bypass -File backend/scripts/build-backend.ps1" >&2
    exit 1
  fi
  echo "Building the Python sidecar"
  backend/scripts/build-backend.sh
fi

# bash 3.2 (macOS) errors on an empty "${arr[@]}" under `set -u`.
if [[ ${#TAURI_ARGS[@]} -gt 0 ]]; then
  exec npx tauri dev "${TAURI_ARGS[@]}"
fi
exec npx tauri dev

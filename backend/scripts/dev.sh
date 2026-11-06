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
    # The pc file lives in a sysroot whose prefix is /usr; without a sysroot
    # the linker resolves -lwebkit2gtk-4.1 against /usr/lib where only the
    # versioned .so.0 exists. Point pkg-config at the sysroot root so the
    # unversioned .so symlinks staged there are used.
    _webkit_sysroot="$(cd "$(dirname "$_webkit_pc")/../../../.." && pwd 2>/dev/null || true)"
    if [[ -n "${_webkit_sysroot:-}" && -d "${_webkit_sysroot}/usr/lib" ]]; then
      export PKG_CONFIG_SYSROOT_DIR="$_webkit_sysroot"
    fi
    unset _webkit_sysroot
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

# A staged sidecar is a compiled snapshot: reusing one built before the current
# backend sources silently runs stale Python (the workspace store schema is one
# example) while the UI hot-reloads. Treat any newer backend source as dirty.
sidecar_stale() {
  [[ -f "$SIDECAR" ]] || return 0
  local newer
  newer="$(find backend -type f \( -name '*.py' -o -name '*.spec' -o -name '*.txt' \) \
    -newer "$SIDECAR" \
    -not -path 'backend/build/work/*' -not -path 'backend/build/dist/*' \
    -print -quit 2>/dev/null || true)"
  [[ -n "$newer" ]]
}

if [[ $REBUILD -eq 1 || ! -f "$SIDECAR" ]]; then
  if [[ $IS_WINDOWS -eq 1 ]]; then
    echo "Sidecar missing. Build it from PowerShell first:" >&2
    echo "  powershell -ExecutionPolicy Bypass -File backend/scripts/build-backend.ps1" >&2
    exit 1
  fi
  echo "Building the Python sidecar"
  backend/scripts/build-backend.sh
elif [[ $IS_WINDOWS -eq 0 ]] && sidecar_stale; then
  echo "Backend sources are newer than the staged sidecar — rebuilding it"
  backend/scripts/build-backend.sh
fi

# Reclaim a stale dev server left behind by a previous run. A previous
# `tauri dev` (or its Vite child) that did not shut down cleanly keeps
# port 5173 bound, which makes the next `beforeDevCommand` fail with
# "Port 5173 is already in use". Only processes that belong to this
# checkout are touched.
reclaim_stale_dev() {
  local port=5173
  local pids="" pid cwd cmd

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "${port}/tcp" 2>/dev/null | tr -s ' ' '\n' || true)"
  fi

  for pid in $pids; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    if [[ -n "$cwd" && "$cwd" == "$ROOT/frontend" ]]; then
      kill "$pid" 2>/dev/null || true
    elif [[ "$cmd" == *"$ROOT"* && "$cmd" == *vite* ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  # Previous tauri dev instances for this checkout (and their Vite children).
  if command -v pgrep >/dev/null 2>&1; then
    for pid in $(pgrep -f "tauri dev" 2>/dev/null || true); do
      [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
      cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
      case "$cmd" in
        *"$ROOT"*) kill "$pid" 2>/dev/null || true ;;
      esac
    done
  fi

  # Wait for the port to be released.
  local i
  for ((i = 0; i < 25; i++)); do
    if command -v lsof >/dev/null 2>&1; then
      lsof -ti "tcp:${port}" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    else
      return 0
    fi
    sleep 0.2
  done
}
reclaim_stale_dev

# bash 3.2 (macOS) errors on an empty "${arr[@]}" under `set -u`.
if [[ ${#TAURI_ARGS[@]} -gt 0 ]]; then
  exec npx tauri dev "${TAURI_ARGS[@]}"
fi
exec npx tauri dev

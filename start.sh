#!/usr/bin/env bash
#
# TradePanel launcher — one command from any checkout.
#
# Installs the JS dependencies, builds the Python sidecar when it is missing or
# out of date, then runs `tauri dev` (Vite + Rust shell with hot reload).
# Safe to call from any working directory.
#
#   ./start.sh                     # launch
#   ./start.sh --rebuild-backend   # force a fresh PyInstaller sidecar
#   ./start.sh -- <tauri args>     # forwarded to `tauri dev`
#
# Release builds: ./build.sh (see docs/BUILD.md).

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$ROOT"

# Desktop launchers (and some minimal shells) start with a PATH that omits the
# user toolchains. Pull in the common locations so node/npm/cargo resolve.
for _d in "$HOME/.cargo/bin" "$HOME/.local/bin" "$HOME/.nvm/versions/node"/*/bin; do
  [[ -d "$_d" ]] && PATH="$_d:$PATH"
done
export PATH

# When there is no controlling terminal (e.g. launched from a .desktop file),
# keep a log so failures are diagnosable instead of vanishing silently.
if [[ ! -t 1 ]]; then
  _log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/trade-panel"
  if mkdir -p "$_log_dir" 2>/dev/null; then
    exec >>"$_log_dir/launcher.log" 2>&1
    printf -- '--- %s starting TradePanel from %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$ROOT"
  fi
fi

# Tauri's Linux webview (webkit2gtk) needs pkg-config metadata. On minimal
# checkouts the dev headers are provided by a local sysroot instead of the
# system package manager; expose it to cargo/pkg-config when present.
# Locate webkit2gtk pkg-config metadata (system install or the bundled sysroot).
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  _webkit_pc="$(find /tmp /opt /usr/local -name 'webkit2gtk-4.1.pc' -print -quit 2>/dev/null || true)"
  if [[ -n "${_webkit_pc:-}" ]]; then
    export PKG_CONFIG_PATH="$(dirname "$_webkit_pc")${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  fi
  unset _webkit_pc
fi

for tool in node npm; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing $tool — install Node 20+ first (docs/BUILD.md)." >&2
    exit 1
  }
done
command -v cargo >/dev/null 2>&1 || {
  echo "Missing cargo — install the Rust toolchain first (docs/BUILD.md)." >&2
  exit 1
}

exec "$ROOT/scripts/dev.sh" "$@"

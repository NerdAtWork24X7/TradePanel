#!/usr/bin/env bash
#
# Reproducible TradePanel release build for the current platform.
#
#   ./build.sh                  # release bundles (AppImage+deb / dmg / NSIS)
#   ./build.sh --debug          # debug bundle, no optimisations
#   ./build.sh --bundles=deb    # override the Tauri bundle targets
#   ./build.sh --skip-backend   # reuse the already staged Python sidecar
#   ./build.sh --skip-ai-runtime  # reuse the already staged Node + Pi runtime
#   ./build.sh --install        # force `npm ci` for the shell and the frontend
#
# Bundling targets come from src-tauri/tauri.<platform>.conf.json unless
# --bundles is given. Windows (Git Bash/MSYS) hands off to
# backend/scripts/build-windows.ps1, which owns the native toolchain.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$ROOT"

# Expose the local webkit2gtk pkg-config sysroot to cargo when present.
# Locate webkit2gtk pkg-config metadata (system install or the bundled sysroot).
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  _webkit_pc="$(find /tmp /opt /usr/local -name 'webkit2gtk-4.1.pc' -print -quit 2>/dev/null || true)"
  if [[ -n "${_webkit_pc:-}" ]]; then
    export PKG_CONFIG_PATH="$(dirname "$_webkit_pc")${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  fi
  unset _webkit_pc
fi

usage() {
  sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

MODE="release"
BUNDLES=""
SKIP_BACKEND=0
SKIP_AI_RUNTIME=0
FORCE_INSTALL=0
PASSTHRU=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) MODE="debug" ;;
    --bundles) BUNDLES="${2:-}"; [[ -n "$BUNDLES" ]] || { echo "--bundles needs a value" >&2; exit 2; }; shift ;;
    --bundles=*) BUNDLES="${1#*=}" ;;
    --skip-backend) SKIP_BACKEND=1 ;;
    --skip-ai-runtime) SKIP_AI_RUNTIME=1 ;;
    --install) FORCE_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHRU+=("$1") ;;
  esac
  shift
done

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "Windows detected — delegating to backend/scripts/build-windows.ps1"
    exec powershell -NoProfile -ExecutionPolicy Bypass -File "$ROOT/backend/scripts/build-windows.ps1"
    ;;
esac

# ── Toolchain checks ────────────────────────────────────────────────────────
for tool in node npm npx; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing $tool — install Node 20+ first (docs/BUILD.md)." >&2; exit 1; }
done
command -v cargo >/dev/null 2>&1 || { echo "Missing cargo — install the Rust toolchain first (docs/BUILD.md)." >&2; exit 1; }

# ── JavaScript dependencies ─────────────────────────────────────────────────
if [[ $FORCE_INSTALL -eq 1 || ! -d frontend/node_modules ]]; then
  echo "Installing frontend dependencies"
  npm --prefix frontend ci --no-audit --no-fund
fi
if [[ $FORCE_INSTALL -eq 1 || ! -d node_modules ]]; then
  echo "Installing Tauri CLI"
  npm ci --no-audit --no-fund
fi

# ── Python sidecar ──────────────────────────────────────────────────────────
SIDECAR="src-tauri/backend-dist/tradepanel-backend/tradepanel-backend"
if [[ $SKIP_BACKEND -eq 1 ]]; then
  [[ -f "$SIDECAR" ]] || { echo "--skip-backend given but $SIDECAR is missing; run backend/scripts/build-backend.sh." >&2; exit 1; }
  echo "Reusing staged sidecar: $SIDECAR"
else
  backend/scripts/build-backend.sh
fi

# ── Bundled AI runtime ──────────────────────────────────────────────────────
if [[ $SKIP_AI_RUNTIME -eq 1 ]]; then
  [[ -f "src-tauri/ai-runtime/$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/manifest.json" ]] \
    || echo "Warning: --skip-ai-runtime given but no staged runtime was found" >&2
else
  node backend/scripts/build-ai-runtime.mjs --target "$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
fi

# Tauri overlays resources instead of pruning them: stale sidecar files (e.g. a
# removed TBB backend) would otherwise survive into the bundle. The loose
# `tradepanel-backend` file is the pre-resource-mapping layout; it is unused but
# would otherwise sit in the build tree forever.
rm -rf "src-tauri/target/$MODE/backend"
rm -rf "src-tauri/target/$MODE/tradepanel-backend"
rm -rf "src-tauri/target/$MODE/bundle"
rm -rf "src-tauri/target/$MODE/ai-runtime"

# ── Build ───────────────────────────────────────────────────────────────────
ARGS=(build)
[[ "$MODE" == "debug" ]] && ARGS+=(--debug)
[[ -n "$BUNDLES" ]] && ARGS+=(--bundles "$BUNDLES")
[[ ${#PASSTHRU[@]} -gt 0 ]] && ARGS+=("${PASSTHRU[@]}")

echo "Running: npx tauri ${ARGS[*]}"
npx tauri "${ARGS[@]}"

echo
echo "Artifacts:"
BUNDLE_DIR="src-tauri/target/$MODE/bundle"
FOUND=0
if [[ -d "$BUNDLE_DIR" ]]; then
  while IFS= read -r -d '' artifact; do
    ls -lh "$artifact"
    FOUND=1
  done < <(find "$BUNDLE_DIR" -maxdepth 2 -type f \
    \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name '*.dmg' -o -name '*.exe' -o -name '*.msi' \) -print0)
fi
if [[ $FOUND -eq 0 ]]; then
  echo "  (no bundles produced — binary: src-tauri/target/$MODE/tradepanel)"
fi

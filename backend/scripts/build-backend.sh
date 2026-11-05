#!/usr/bin/env bash
# Build the Python sidecar (one folder) and stage it as a Tauri resource.
# Usage: backend/scripts/build-backend.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BUILD_VENV="${TRADEPANEL_BUILD_VENV:-$ROOT/.venv-build}"
if [[ ! -x "$BUILD_VENV/bin/python" ]]; then
  echo "Creating build environment at $BUILD_VENV"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$BUILD_VENV"
    uv pip install --python "$BUILD_VENV/bin/python" -r backend/requirements.txt -r backend/build/requirements-build.txt
  else
    python3 -m venv "$BUILD_VENV"
    "$BUILD_VENV/bin/pip" install -r backend/requirements.txt -r backend/build/requirements-build.txt
  fi
fi

echo "Building one-folder sidecar"
rm -rf backend/build/work backend/build/dist
"$BUILD_VENV/bin/python" -m PyInstaller \
  --noconfirm --clean \
  --distpath backend/build/dist \
  --workpath backend/build/work \
  backend/build/backend.spec

SRC="backend/build/dist/tradepanel-backend"
DEST="src-tauri/backend-dist/tradepanel-backend"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$SRC" "$DEST"
chmod +x "$DEST/tradepanel-backend"

echo "Smoke-testing the packaged sidecar"
"$DEST/tradepanel-backend" --self-check

echo "Sidecar ready: $DEST"

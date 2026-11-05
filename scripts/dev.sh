#!/usr/bin/env bash
# Development loop: Python sidecar + Vite + Tauri (hot reload).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -d frontend/node_modules ]]; then
  echo "Installing frontend dependencies"
  npm --prefix frontend ci
fi
if [[ ! -d node_modules ]]; then
  echo "Installing Tauri CLI"
  npm ci
fi
if [[ ! -x src-tauri/backend-dist/tradepanel-backend/tradepanel-backend ]]; then
  echo "Building the Python sidecar"
  scripts/build-backend.sh
fi

exec npx tauri dev "$@"

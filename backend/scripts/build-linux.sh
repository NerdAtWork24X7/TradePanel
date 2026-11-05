#!/usr/bin/env bash
# Linux release: one-folder sidecar + AppImage + .deb.
# Thin wrapper over ./build.sh — bundle targets come from
# src-tauri/tauri.linux.conf.json (appimage, deb).
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." >/dev/null 2>&1 && pwd)"
exec "$ROOT/build.sh" "$@"

#!/usr/bin/env bash
# Reproducible Linux release: one-folder sidecar + AppImage + .deb.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Stale resources are not removed by Tauri; keep staging deterministic.
rm -rf src-tauri/target/release/backend src-tauri/target/release/bundle

scripts/build-backend.sh
npm --prefix frontend ci --no-audit --no-fund
npm ci --no-audit --no-fund
npx tauri build --bundles appimage,deb

echo
echo "Artifacts:"
ls -lh src-tauri/target/release/bundle/appimage/*.AppImage \
       src-tauri/target/release/bundle/deb/*.deb

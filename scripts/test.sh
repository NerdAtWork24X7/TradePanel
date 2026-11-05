#!/usr/bin/env bash
# Full local regression suite (no live trading, no network orders).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== Python backend + IPC tests =="
"${TRADEPANEL_PYTHON:-.venv/bin/python}" -m unittest discover -s tests -p 'test_*.py'

echo "== Chart synchronisation tests =="
node --test tests/chart_sync.test.mjs

echo "== Workspace bridge adapter tests =="
node --test frontend/tests/tauri_bridge.test.mjs

echo "== Frontend typecheck + production build =="
npm --prefix frontend run typecheck
npm --prefix frontend run build

echo "== Rust unit tests =="
(cd src-tauri && cargo test)

echo "All checks passed."

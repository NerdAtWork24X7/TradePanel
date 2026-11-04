#!/usr/bin/env bash
#
# Trade Panel launcher.
#
# Runs the app from this checkout using the project virtualenv when present,
# falling back to `uv run` or the system python3. Safe to call from any CWD
# (including a .desktop launcher).

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$ROOT_DIR"

# Launched from a desktop icon there is no terminal; keep a log instead.
if [[ ! -t 1 ]]; then
    LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/trade-panel"
    if mkdir -p "$LOG_DIR" 2>/dev/null; then
        exec >>"$LOG_DIR/launcher.log" 2>&1
        printf -- '--- %s starting Trade Panel from %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$ROOT_DIR"
    fi
fi

# Prefer the locked project environment.
if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
    exec "$ROOT_DIR/.venv/bin/python" "$ROOT_DIR/main.py" "$@"
fi

if command -v uv >/dev/null 2>&1; then
    exec uv run python "$ROOT_DIR/main.py" "$@"
fi

if command -v python3 >/dev/null 2>&1; then
    exec python3 "$ROOT_DIR/main.py" "$@"
fi

printf 'Trade Panel: no Python interpreter found.\n' >&2
printf 'Install uv or create .venv in %s, then retry.\n' "$ROOT_DIR" >&2
exit 1

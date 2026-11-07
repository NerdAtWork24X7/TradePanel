#!/usr/bin/env bash
#
# Install a desktop launcher (application-menu entry + desktop icon) for
# Trade Panel. Re-run this after moving the checkout to refresh the paths.
#
# Run ./tradePanel once from a terminal first: the desktop entry has no
# terminal, so the first-run prerequisite consent prompt cannot be shown there.

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
APP_ID="trade-panel"
APP_NAME="Trade Panel"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/256x256/apps"

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [[ -z "$DESKTOP_DIR" || "$DESKTOP_DIR" == "$HOME" ]]; then
    DESKTOP_DIR="$HOME/Desktop"
fi

mkdir -p "$APPS_DIR" "$ICON_DIR"
install -m 644 "$ROOT_DIR/logo.png" "$ICON_DIR/$APP_ID.png"

LAUNCHER="$APPS_DIR/$APP_ID.desktop"
cat > "$LAUNCHER" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME
GenericName=Crypto Trading Panel
Comment=Hyperliquid and Binance trading panel with TradingView-style charts
Exec=$ROOT_DIR/tradePanel
Path=$ROOT_DIR
Icon=$APP_ID
Terminal=false
Categories=Finance;Office;
Keywords=crypto;trading;hyperliquid;binance;chart;
StartupNotify=true
EOF
chmod 755 "$LAUNCHER"

# Place a clickable icon on the desktop as well.
if [[ -d "$DESKTOP_DIR" ]]; then
    install -m 755 "$LAUNCHER" "$DESKTOP_DIR/$APP_ID.desktop"
    # GNOME/Nautilus requires the trusted flag to launch from the desktop.
    gio set "$DESKTOP_DIR/$APP_ID.desktop" metadata::trusted true 2>/dev/null || true
fi

command -v desktop-file-validate >/dev/null 2>&1 && \
    desktop-file-validate "$LAUNCHER" || true
command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
    gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true

printf 'Installed %s\n' "$APP_NAME"
printf '  launcher: %s\n' "$LAUNCHER"
if [[ -d "$DESKTOP_DIR" ]]; then
    printf '  desktop:  %s\n' "$DESKTOP_DIR/$APP_ID.desktop"
fi

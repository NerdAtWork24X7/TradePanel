#!/usr/bin/env bash
#
# Build the Linux release bundles (.deb + .AppImage) and collect them in ./release.
#
#   ./release.sh                  # optimised build, artifacts copied to ./release
#   ./release.sh --debug          # debug build (artifacts in ./release as well)
#   ./release.sh --clean          # wipe ./release before copying
#   ./release.sh --skip-backend   # reuse the already staged Python sidecar
#   ./release.sh --skip-ai-runtime  # reuse the already staged Node + Pi runtime
#   ./release.sh --install        # force `npm ci` for the shell and the frontend
#   ./release.sh -- --verbose     # extra args are forwarded to `tauri build`
#
# Everything else is delegated to ./build.sh, which owns the toolchain checks,
# sidecar/runtime staging and the actual `tauri build` invocation.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$ROOT"

RELEASE_DIR="$ROOT/release"

usage() {
  sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

MODE="release"
CLEAN=0
FORWARD=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) MODE="debug"; FORWARD+=("$1") ;;
    --clean) CLEAN=1 ;;
    --bundles|--bundles=*)
      echo "--bundles is fixed to 'appimage,deb' by this script; use ./build.sh for other targets." >&2
      exit 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) FORWARD+=("$1") ;;
  esac
  shift
done

if [[ $CLEAN -eq 1 ]]; then
  rm -rf "$RELEASE_DIR"
fi
mkdir -p "$RELEASE_DIR"

echo "Building AppImage + deb (mode: $MODE)"
"$ROOT/build.sh" --bundles=appimage,deb "${FORWARD[@]}"

BUNDLE_DIR="$ROOT/src-tauri/target/$MODE/bundle"

shopt -s nullglob
ARTIFACTS=(
  "$BUNDLE_DIR"/appimage/*.AppImage
  "$BUNDLE_DIR"/deb/*.deb
)
shopt -u nullglob

if [[ ${#ARTIFACTS[@]} -eq 0 ]]; then
  echo "No AppImage or deb bundles found under $BUNDLE_DIR" >&2
  exit 1
fi

echo
echo "Copying bundles to $RELEASE_DIR"
for artifact in "${ARTIFACTS[@]}"; do
  cp -f -- "$artifact" "$RELEASE_DIR/"
done

echo
echo "Release artifacts:"
ls -lh "$RELEASE_DIR"

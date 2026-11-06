#!/usr/bin/env bash
# Make pkg-config find the WebKitGTK 4.1 build metadata Tauri needs.
#
# The supported setup is to install the distro -dev packages (see
# docs/BUILD.md). When they are absent, this helper falls back to a local
# pkg-config sysroot that advertises the already-installed runtime libraries.
# The *-sys crates ship pre-generated bindings, so only the .pc metadata and
# unversioned .so symlinks are required; headers are not.
#
# The sysroot lives under ${XDG_DATA_HOME:-~/.local/share}/tradepanel so it
# survives reboots. (An older revision searched /tmp, which is wiped on
# restart; that is why the build started failing after a reboot.) Override the
# location with TRADEPANEL_WEBKIT_SYSROOT.
#
# Usage (from a bash script):
#   source "$ROOT/backend/scripts/webkit-env.sh"
#   tradepanel_webkit_env

_tradepanel_webkit_pc_dir() {
  printf '%s/lib/pkgconfig' "$1"
}

# Print the upstream version of an installed package, e.g.
# "2.52.6-0ubuntu0.24.04.1" -> "2.52.6".
_tradepanel_webkit_version() {
  local pkg="$1" fallback="$2" ver=""
  if command -v dpkg-query >/dev/null 2>&1; then
    ver="$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)"
    ver="${ver#*:}"          # strip epoch
    ver="${ver%%-*}"         # strip Debian revision
  fi
  printf '%s' "${ver:-$fallback}"
}

# Locate an installed runtime library by soname.
_tradepanel_webkit_lib() {
  local soname="$1" path=""
  if command -v ldconfig >/dev/null 2>&1; then
    path="$(ldconfig -p 2>/dev/null | awk -v s="$soname" '$1 == s { print $NF; exit }')"
  fi
  if [[ -z "$path" ]]; then
    path="$(find /usr/lib /lib -name "$soname" -print -quit 2>/dev/null || true)"
  fi
  printf '%s' "$path"
}

# Create a minimal sysroot at $1 for the runtime libraries installed on the
# host. Fails if any of the three libraries is missing.
_tradepanel_webkit_generate_sysroot() {
  local sysroot="$1"
  local libdir="$sysroot/lib"
  local pcdir
  pcdir="$(_tradepanel_webkit_pc_dir "$sysroot")"

  local webkit jsc soup
  webkit="$(_tradepanel_webkit_lib libwebkit2gtk-4.1.so.0)"
  jsc="$(_tradepanel_webkit_lib libjavascriptcoregtk-4.1.so.0)"
  soup="$(_tradepanel_webkit_lib libsoup-3.0.so.0)"

  if [[ -z "$webkit" || -z "$jsc" || -z "$soup" ]]; then
    cat >&2 <<'EOF'
TradePanel: WebKitGTK 4.1 development files are missing and no runtime
libraries were found to build a fallback sysroot.

Install the distro packages (recommended):

  sudo apt update
  sudo apt install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
      libsoup-3.0-dev

See docs/BUILD.md for other distributions.
EOF
    return 1
  fi

  mkdir -p "$libdir" "$pcdir"

  # Unversioned names are what `-lfoo` resolves against; the runtime packages
  # only ship the versioned .so.0.
  ln -sfn "$webkit" "$libdir/libwebkit2gtk-4.1.so"
  ln -sfn "$jsc"    "$libdir/libjavascriptcoregtk-4.1.so"
  ln -sfn "$soup"   "$libdir/libsoup-3.0.so"

  local wv jv sv
  wv="$(_tradepanel_webkit_version libwebkit2gtk-4.1-0 2.40.0)"
  jv="$(_tradepanel_webkit_version libjavascriptcoregtk-4.1-0 2.40.0)"
  sv="$(_tradepanel_webkit_version libsoup-3.0-0 3.4.0)"

  cat >"$pcdir/webkit2gtk-4.1.pc" <<EOF
prefix=/usr
libdir=$libdir
includedir=\${prefix}/include

Name: WebKitGTK
Description: Web content engine for GTK (runtime fallback metadata)
Version: $wv
Libs: -L\${libdir} -lwebkit2gtk-4.1
Cflags:
EOF

  cat >"$pcdir/javascriptcoregtk-4.1.pc" <<EOF
prefix=/usr
libdir=$libdir
includedir=\${prefix}/include

Name: JavaScriptCoreGTK
Description: JavaScript engine for GTK (runtime fallback metadata)
Version: $jv
Libs: -L\${libdir} -ljavascriptcoregtk-4.1
Cflags:
EOF

  cat >"$pcdir/libsoup-3.0.pc" <<EOF
prefix=/usr
libdir=$libdir
includedir=\${prefix}/include

Name: libsoup
Description: HTTP library for GLib (runtime fallback metadata)
Version: $sv
Libs: -L\${libdir} -lsoup-3.0
Cflags:
EOF

  return 0
}

# Export PKG_CONFIG_PATH (and a sysroot if one was found) so cargo can build.
tradepanel_webkit_env() {
  # Windows/macOS builds do not use WebKitGTK, and a host without pkg-config
  # will fail later with a clearer cargo error.
  if ! command -v pkg-config >/dev/null 2>&1; then
    return 0
  fi

  if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    return 0
  fi

  local sysroot="${TRADEPANEL_WEBKIT_SYSROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tradepanel/webkit-sysroot}"

  # Reuse an existing fallback sysroot. Also accept one staged in the old
  # /tmp /opt /usr/local locations so an in-progress session keeps working.
  if [[ ! -f "$(_tradepanel_webkit_pc_dir "$sysroot")/webkit2gtk-4.1.pc" ]]; then
    local legacy
    legacy="$(find /tmp /opt /usr/local -name 'webkit2gtk-4.1.pc' -print -quit 2>/dev/null || true)"
    if [[ -n "$legacy" ]]; then
      sysroot="$(cd "$(dirname "$legacy")/../../../.." && pwd)"
      export PKG_CONFIG_PATH="$(dirname "$legacy")${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
      # That layout uses prefix=/usr, so the linker needs the sysroot root.
      if [[ -d "$sysroot/usr/lib" ]]; then
        export PKG_CONFIG_SYSROOT_DIR="$sysroot"
      fi
      return 0
    fi
    _tradepanel_webkit_generate_sysroot "$sysroot" || return 1
  fi

  export PKG_CONFIG_PATH="$(_tradepanel_webkit_pc_dir "$sysroot")${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

  if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    echo "TradePanel: failed to configure WebKitGTK pkg-config metadata." >&2
    return 1
  fi
  return 0
}

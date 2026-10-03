#!/usr/bin/env bash
# Check build prerequisites and list anything missing, with the MacPorts fix.
# Exit status is non-zero if a required tool is missing.
set -u

ZIG="${ZIG:-zig-0.16}"
OBSIDIAN_APP="${OBSIDIAN_APP:-/Applications/Obsidian.app}"
missing=0

ok()   { printf '  ok       %-14s %s\n' "$1" "$2"; }
warn() { printf '  warn     %-14s %s\n' "$1" "$2"; }
miss() { printf '  MISSING  %-14s %s\n' "$1" "$2"; missing=$((missing + 1)); }

need() { # need <name> <command> <fix>
  if command -v "$2" >/dev/null 2>&1; then ok "$1" "$(command -v "$2")"; else miss "$1" "$3"; fi
}

echo "Prerequisites:"
if [ "$(uname -sm)" = "Darwin arm64" ]; then ok platform "macOS $(sw_vers -productVersion), arm64"
else miss platform "Apple Silicon macOS is required (found $(uname -sm))"; fi

need node  node  "sudo port install nodejs22 npm10"
need npm   npm   "sudo port install nodejs22 npm10"
need python3 python3 "sudo port install python314   (node-gyp needs Python 3)"
need rsync rsync "sudo port install rsync"

if command -v "$ZIG" >/dev/null 2>&1; then
  v="$("$ZIG" version 2>/dev/null)"
  case "$v" in
    0.16.*|0.17.*|0.1[89].*) ok zig "$ZIG $v" ;;
    *) miss zig "$ZIG reports $v; Ghostty needs Zig >= 0.16.0   (sudo port install zig-0.16)" ;;
  esac
else
  miss zig "sudo port install zig-0.16   (or set ZIG=/path/to/zig)"
fi

if xcode-select -p >/dev/null 2>&1 && command -v clang++ >/dev/null 2>&1; then
  ok xcode-clt "$(xcode-select -p)"
else
  miss xcode-clt "xcode-select --install"
fi

if [ -d "$OBSIDIAN_APP" ]; then
  ev="$(plutil -extract CFBundleVersion raw "$OBSIDIAN_APP/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist" 2>/dev/null || true)"
  if [ -n "$ev" ]; then ok obsidian "Electron $ev (native addons are built for this)"
  else miss obsidian "cannot read Electron version; set ELECTRON_VERSION=x.y.z"; fi
else
  miss obsidian "$OBSIDIAN_APP not found; install Obsidian or set OBSIDIAN_APP"
fi

if [ -n "${PLUGIN_DIR:-}" ]; then
  parent="$(dirname "$PLUGIN_DIR")"
  if [ -d "$parent" ]; then ok plugin-dir "$PLUGIN_DIR"
  else warn plugin-dir "$parent does not exist yet (it will be created by make install)"; fi
fi

for v in ${VAULTS:-}; do
  if [ -d "$v" ]; then ok vault "$v"; else warn vault "$v not found (make setup-vaults will skip it)"; fi
done

echo
if [ "$missing" -gt 0 ]; then
  echo "$missing required prerequisite(s) missing."
  exit 1
fi
echo "All required prerequisites present."

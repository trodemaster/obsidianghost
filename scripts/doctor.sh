#!/usr/bin/env bash
# Check prerequisites for building and installing the plugin, and list anything
# missing with the MacPorts fix. Exit status is non-zero if a required tool is missing.
#
# Nothing is compiled: libghostty-vt is the official WebAssembly release and
# node-pty ships an N-API prebuild, so the toolchain is Node and a few basics.
set -u

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
else miss platform "Apple Silicon macOS is required to run the plugin (found $(uname -sm))"; fi

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge 20 ]; then ok node "$(command -v node) ($(node --version))"
  else miss node "Node $(node --version) is too old; need 20+   (sudo port install nodejs22 npm10)"; fi
else
  miss node "sudo port install nodejs22 npm10"
fi
need npm   npm   "sudo port install nodejs22 npm10"
need curl  curl  "sudo port install curl"
need rsync rsync "sudo port install rsync"

if command -v gh >/dev/null 2>&1; then ok gh "$(command -v gh) (make install-release)"
else warn gh "only needed for make install-release   (sudo port install gh)"; fi

if [ -d "$OBSIDIAN_APP" ]; then ok obsidian "$OBSIDIAN_APP"
else miss obsidian "$OBSIDIAN_APP not found; install Obsidian or set OBSIDIAN_APP"; fi

if [ -n "${PLUGIN_DIR:-}" ]; then
  parent="$(dirname "$PLUGIN_DIR")"
  if [ -d "$parent" ]; then ok plugin-dir "$PLUGIN_DIR"
  else warn plugin-dir "$parent does not exist yet (it will be created by make install)"; fi
else
  miss plugin-dir "no vault found and PLUGIN_DIR unset; open a vault in Obsidian once, or set PLUGIN_DIR=<vault>/.obsidian/plugins/obsidian-claude-ghostty"
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

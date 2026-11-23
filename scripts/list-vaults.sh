#!/usr/bin/env bash
# Print the path of every vault Obsidian knows about, one per line, sorted by path.
# Reads Obsidian's own registry; prints nothing if it is missing or Node is absent.
# The Makefile uses this for the default VAULTS, and the dev scripts for the default
# vault name (OBSIDIAN_VAULT overrides it).
set -u
cfg="${OBSIDIAN_CONFIG:-$HOME/Library/Application Support/obsidian/obsidian.json}"
[ -f "$cfg" ] && command -v node >/dev/null 2>&1 || exit 0
node -e '
  const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).vaults || {};
  const fs = require("fs");
  Object.values(v).map((x) => x.path).filter((p) => p && fs.existsSync(p)).sort().forEach((p) => console.log(p));
' "$cfg" 2>/dev/null || true

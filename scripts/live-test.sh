#!/usr/bin/env bash
# Rebuild the plugin, hot-reload it into the already-running Obsidian app,
# open a fresh terminal session, and run a JS probe against it via
# `obsidian-cli eval` (talks to Obsidian over ~/.obsidian-cli.sock — no
# window focus or screen coordinates involved).
#
# Usage: scripts/live-test.sh <test-script.js> [vault]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OBSIDIAN_CLI=/Applications/Obsidian.app/Contents/MacOS/obsidian-cli
PLUGIN_ID=obsidian-claude-ghostty

TEST_SCRIPT="${1:-}"
VAULT="${2:-daneel}"

if [ -z "$TEST_SCRIPT" ]; then
  echo "usage: $0 <test-script.js> [vault]" >&2
  exit 1
fi
TEST_SCRIPT="$(cd "$(dirname "$TEST_SCRIPT")" && pwd)/$(basename "$TEST_SCRIPT")"

cd "$REPO_ROOT"
make reinstall

"$OBSIDIAN_CLI" plugin:reload id="$PLUGIN_ID" vault="$VAULT" >/dev/null
"$OBSIDIAN_CLI" command id="$PLUGIN_ID:new-terminal" vault="$VAULT" >/dev/null

"$OBSIDIAN_CLI" eval \
  code="eval(require('fs').readFileSync('$TEST_SCRIPT','utf8'))" \
  vault="$VAULT" format=json

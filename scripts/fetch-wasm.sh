#!/usr/bin/env bash
# Download the pinned libghostty-vt WebAssembly module into native/ and verify
# its SHA-256 against native/libghostty-vt.env. A verified copy is left alone.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../native/libghostty-vt.env
. "$root/native/libghostty-vt.env"
out="$root/native/ghostty-vt.wasm"

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

if [ -f "$out" ] && [ "$(sha256 "$out")" = "$VT_WASM_SHA256" ]; then
  echo "libghostty-vt $VT_VERSION wasm already present and verified"
  exit 0
fi

tmp="$(mktemp "${TMPDIR:-/tmp}/ghostty-vt.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
echo "Downloading $VT_WASM_URL"
curl -fsSL --retry 3 -o "$tmp" "$VT_WASM_URL"
actual="$(sha256 "$tmp")"
if [ "$actual" != "$VT_WASM_SHA256" ]; then
  echo "SHA-256 mismatch for libghostty-vt $VT_VERSION wasm" >&2
  echo "  expected $VT_WASM_SHA256" >&2
  echo "  actual   $actual" >&2
  exit 1
fi
mv "$tmp" "$out"
trap - EXIT
echo "libghostty-vt $VT_VERSION wasm verified ($actual)"

#!/usr/bin/env bash
# Assemble the installable plugin payload in dist/<plugin-id>/ and, with --zip,
# a release archive dist/<plugin-id>-<version>.zip. Expects main.js and
# native/ghostty-vt.wasm to be built already (make package does both).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
id="$(node -p 'require("./manifest.json").id')"
version="$(node -p 'require("./manifest.json").version')"
pkg_version="$(node -p 'require("./package.json").version')"
if [ "$version" != "$pkg_version" ]; then
  echo "manifest.json version $version does not match package.json $pkg_version" >&2
  exit 1
fi

for f in main.js manifest.json styles.css native/ghostty-vt.wasm \
         node_modules/node-pty/package.json node_modules/node-pty/prebuilds/darwin-arm64/pty.node; do
  [ -f "$f" ] || { echo "missing $f (run make package)" >&2; exit 1; }
done

out="dist/$id"
rm -rf "$out"
mkdir -p "$out/node_modules/node-pty/prebuilds"
cp main.js manifest.json styles.css LICENSE THIRD_PARTY_NOTICES.md "$out/"
cp native/ghostty-vt.wasm "$out/ghostty-vt.wasm"

# node-pty at runtime needs only its JS, its manifest and the N-API prebuild
# (ABI-stable across Electron versions). npm leaves spawn-helper without the
# execute bit, which makes every spawn fail with posix_spawnp.
pty=node_modules/node-pty
cp "$pty/package.json" "$pty/LICENSE" "$out/$pty/"
cp -R "$pty/lib" "$out/$pty/lib"
cp -R "$pty/prebuilds/darwin-arm64" "$out/$pty/prebuilds/darwin-arm64"
chmod 755 "$out/$pty/prebuilds/darwin-arm64/spawn-helper"
find "$out/$pty/lib" \( -name '*.map' -o -name '*.test.js' \) -delete

echo "packaged $id $version in $out"

if [ "${1:-}" = "--zip" ]; then
  zip="dist/$id-$version.zip"
  rm -f "$zip"
  (cd dist && zip -qr -X "$id-$version.zip" "$id")
  echo "wrote $zip"
fi

import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const zigDir = join(root, "native", "ghostty_vt", "zig");
const prefix = join(root, "native", "ghostty_vt", "zig-out");
const ghosttySrc = join(zigDir, "ghostty_src");

if (!existsSync(ghosttySrc)) {
  throw new Error(
    "ghostty sources not found. Expected symlink at native/ghostty_vt/zig/ghostty_src."
  );
}

function findZig() {
  if (process.env.ZIG) {
    return process.env.ZIG;
  }

  const pinnedZig = join(root, "vendor", "zig", "0.15.2", "zig");
  if (existsSync(pinnedZig)) {
    return pinnedZig;
  }

  throw new Error(
    `Pinned Zig 0.15.2 not found at ${pinnedZig}.\n` +
    "Run: make native  (auto-downloads zig-aarch64-macos-0.15.2)"
  );
}

// Zig 0.15 doesn't recognise the macOS 26 SDK name returned by xcrun.
// Inject a shim xcrun that redirects --show-sdk-path to MacOSX15.4.sdk.
function makeXcrunShim() {
  if (process.env.PATH?.includes("MacOSX15.4")) return process.env.PATH ?? "";
  const shimDir = mkdtempSync(join(tmpdir(), "zig-xcrun-"));
  const shimPath = join(shimDir, "xcrun");
  writeFileSync(
    shimPath,
    `#!/bin/bash
if [[ "$*" == *"--show-sdk-path"* ]]; then
  echo /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
  exit 0
fi
exec /usr/bin/xcrun "$@"
`
  );
  chmodSync(shimPath, 0o755);
  return `${shimDir}:${process.env.PATH ?? ""}`;
}

const zig = findZig();
const result = spawnSync(
  zig,
  ["build", "-Doptimize=ReleaseFast", "--prefix", prefix],
  {
    cwd: zigDir,
    stdio: "inherit",
    env: { ...process.env, PATH: makeXcrunShim() },
  }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

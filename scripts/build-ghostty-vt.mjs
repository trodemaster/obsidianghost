import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, writeFileSync, chmodSync, readdirSync, unlinkSync, rmdirSync } from "fs";
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

// Zig 0.15 cannot link against the newer macOS SDK stubs.
let shimDir;
function makeXcrunShim() {
  if (process.platform !== "darwin") return process.env.PATH ?? "";
  const sdk = process.env.MACOS_SDK_PATH || [
    join(root, "vendor", "sdk", "MacOSX15.4.sdk"),
    "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk",
  ].find((path) => existsSync(join(path, "usr", "lib", "libSystem.tbd")));
  if (!sdk || !existsSync(join(sdk, "usr", "lib", "libSystem.tbd"))) {
    throw new Error("Zig 0.15 requires a compatible SDK. Install MacOSX15.4.sdk in vendor/sdk/ or set MACOS_SDK_PATH.");
  }
  shimDir = mkdtempSync(join(tmpdir(), "zig-xcrun-"));
  const shimPath = join(shimDir, "xcrun");
  writeFileSync(
    shimPath,
    `#!/bin/bash
if [[ "$*" == *"--show-sdk-path"* ]]; then
  printf '%s\\n' ${JSON.stringify(sdk)}
  exit 0
fi
exec /usr/bin/xcrun "$@"
`
  );
  chmodSync(shimPath, 0o755);
  return `${shimDir}:${process.env.PATH ?? ""}`;
}

const zig = findZig();
function repackArchive() {
  if (process.platform !== "darwin") return;
  const dir = mkdtempSync(join(tmpdir(), "ghostty-archive-"));
  const archive = join(prefix, "lib", "libghostty_vt.a");
  try {
    const extract = spawnSync("/usr/bin/ar", ["-x", archive], { cwd: dir, stdio: "inherit" });
    if (extract.status !== 0) throw new Error("Could not extract Zig archive");
    const objects = readdirSync(dir).filter((name) => name.endsWith(".o")).map((name) => join(dir, name));
    if (!objects.length) throw new Error("Zig archive contained no objects");
    objects.forEach((path) => chmodSync(path, 0o644));
    const pack = spawnSync("/usr/bin/libtool", ["-static", "-o", archive, ...objects], { stdio: "inherit" });
    if (pack.status !== 0) throw new Error("Could not align Zig archive for the Apple linker");
  } finally {
    readdirSync(dir).forEach((name) => unlinkSync(join(dir, name)));
    rmdirSync(dir);
  }
}

try {
  const result = spawnSync(
  zig,
  ["build", "-Doptimize=ReleaseFast",
    ...(process.platform === "darwin" ? [`-Dtarget=${process.arch === "arm64" ? "aarch64" : "x86_64"}-macos.11.0`] : []),
    "--prefix", prefix],
  {
    cwd: zigDir,
    stdio: "inherit",
    env: { ...process.env, PATH: makeXcrunShim(), ZIG_GLOBAL_CACHE_DIR: join(root, ".zig-cache") },
  }
);

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0) repackArchive();
} finally {
  if (shimDir) {
    unlinkSync(join(shimDir, "xcrun"));
    rmdirSync(shimDir);
  }
}

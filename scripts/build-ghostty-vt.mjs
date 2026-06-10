import { spawnSync } from "child_process";
import { existsSync } from "fs";
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
  // Explicit override via env var
  if (process.env.ZIG) {
    return process.env.ZIG;
  }

  // Prefer pinned Zig 0.15.2 (compatible with uucode 0.2.0 and Ghostty v1.3.1)
  const pinnedZig = join(root, "vendor", "zig", "0.15.2", "zig");
  if (existsSync(pinnedZig)) {
    return pinnedZig;
  }

  throw new Error(
    `Pinned Zig 0.15.2 not found at ${pinnedZig}.\n` +
    "Run: cd vendor/zig/0.15.2 && curl -L https://ziglang.org/download/0.15.2/zig-x86_64-macos-0.15.2.tar.xz | tar xJ --strip-components=1"
  );
}

const zig = findZig();
const result = spawnSync(
  zig,
  ["build", "-Doptimize=ReleaseFast", "--prefix", prefix],
  { cwd: zigDir, stdio: "inherit" }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

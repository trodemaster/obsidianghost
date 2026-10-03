# Review request: is this build toolchain out of date?

Written 2026-10-03 from the personal machine. The reviewer is the work machine,
where this plugin is already built and running. **Please answer in the
"Responses" section at the bottom of this file**, commit, and push.

## Why

Merging `feat/terminal-images-rendering` into `main` and trying to install the
plugin on the personal machine turned up signs that the pinned toolchain is
stale. Please compare against what actually works on the work machine and say
what we should change.

## Personal machine state (the one failing)

| Item | Value |
|---|---|
| macOS | 27.0.1 (Darwin 27.0.0), Apple Silicon |
| SDKs in `/Library/Developer/CommandLineTools/SDKs/` | `MacOSX26.5.sdk`, `MacOSX27.0.sdk` only (no 15.x) |
| Obsidian's bundled Electron (`CFBundleVersion`) | 43.3.0 |
| Electron target in `package.json` | **39.8.3 on `main`**; a local, uncommitted edit changes it to 43.3.0 |
| Zig | pinned 0.15.2 (downloaded into `vendor/zig/0.15.2/`) |
| Ghostty sources | vendored in `vendor/ghostty/src` (Makefile/HANDOFF say v1.3.1) |
| Node/npm | not installed yet (MacPorts only, no Homebrew) |

## What was observed

1. `scripts/build-ghostty-vt.mjs` only accepts `MacOSX15.4.sdk` (from
   `vendor/sdk/`, `MACOS_SDK_PATH`, or the CLT SDK dir) and shims `xcrun` to
   return it.
2. Running the same `zig build -Doptimize=ReleaseFast -Dtarget=aarch64-macos.11.0`
   with the shim pointed at `MacOSX26.5.sdk`, and again at `MacOSX27.0.sdk`,
   fails at link time with many errors such as `undefined symbol: _malloc_size`,
   `_sigaction`, `_waitpid`, `_sysctlbyname`, `_posix_memalign`. These come from
   Zig's own build runner (`build_zcu.o`), so Zig 0.15.2 cannot resolve libSystem
   from the newer `.tbd` files.
3. `HANDOFF.md` says Obsidian's Electron is 43, but `package.json` still builds
   `ghostty_vt.node` and `pty.node` for Electron 39.8.3. The addon is N-API
   (ABI-stable), but `node-pty` is not, so its Electron target matters.
4. The `main` README, Makefile and HANDOFF.md predate the work-machine
   changes (the `claude --continue` auto-launch became a "Startup command"
   setting, and the plugin was renamed "Agent Ghostty Terminal").

## Questions for the work machine

Please fill in each answer.

1. What are the exact versions in use: macOS, Obsidian, Obsidian's Electron
   (`Electron Framework.framework` Info.plist `CFBundleVersion`), Node, Zig?
2. Which SDK does the Zig build actually use there? Is `MacOSX15.4.sdk` present
   (where, and how was it obtained)? Or does the build work against the current
   SDK?
3. Does the Electron target in `package.json` (39.8.3) match what you build with?
   Does `node-pty` built for that target load in the running Obsidian? If you
   built for a different Electron version, which one?
4. Is Zig 0.15.2 still the right pin? Does Ghostty v1.3.1 still build only on
   0.15.x? Is there a newer Ghostty or Zig combination that works?
5. Is the vendored `vendor/ghostty` the same revision you build from?
6. Do the Makefile targets (`make install`, `make native`, `make pty`) work
   unmodified on a fresh clone there? What did you have to change?
7. Anything else out of date in this repo (README install steps, Makefile,
   build script, pinned versions)?

## Responses

_(work machine: write here)_

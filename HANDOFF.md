# Handoff — obsidianghost

As of 2026-10-03.

## Repository

- Remote: `origin` → https://github.com/trodemaster/obsidianghost.git, the pushable remote from the personal machine.
- Personal repo: work happens on branches and merges to `main` through a PR only when finished.
- Branch `modernize` carries the toolchain modernization described below.

## Toolchain (MacPorts only)

```bash
sudo port install zig-0.16 nodejs22 npm10 python314
make doctor      # lists anything missing
make install     # build everything and sync to the central plugin dir
make setup-vaults
```

- **Zig**: MacPorts `zig-0.16` (0.16.0). No download and no custom SDK. The old workaround (Zig 0.15.2 + `MacOSX15.4.sdk` + `xcrun` shim + archive repack) is gone: 0.15.2 could not link against the macOS 26/27 SDKs, and 0.16 does.
- **Ghostty**: `vendor/ghostty` is a snapshot of upstream `main`, pinned in `vendor/ghostty/UPSTREAM`, not the v1.3.1 release. `main` requires Zig ≥ 0.16.0, and v1.3.1 is the last release on 0.15.2. `vendor/uucode` is pinned to the commit Ghostty `main` uses.
- **Electron**: read from the installed Obsidian at build time. Both native addons are N-API, so they are ABI-stable across Electron majors; still smoke-test after an Obsidian update.
- **npm**: if `npm install` fails with "cache folder contains root-owned files", run `sudo chown -R 501:20 ~/.npm`. A `sudo port install` can leave root-owned files there. Setting `npm_config_cache` to a repo-local directory also works.

## Install layout

Central install: `~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`. Each vault symlinks to it (`make setup-vaults`). That directory is tracked in machine-cfg, so commit and push it from the terminal after `make install`.

## Behavior summary

[README.md](README.md) has the user-facing features and settings. Implementation notes:

- **Startup**: **Start directory** and **Startup command** are settings. Blank command = plain Bash at the vault root. There is no built-in agent command. Right-click the ghost ribbon icon, or use **+**, for "New shell (no Agent)". The plugin ID stays `obsidian-claude-ghostty`.
- **Links**: Cmd/Ctrl+click opens OSC 8 links (`vt.hyperlinkAt`) and plain-text URLs (regex over row text). The modifier is required on the click itself.
- **Selection and input**: mouse drag selects cells and copies through Electron's `clipboard`. Dropped files insert shell-quoted paths via `webUtils.getPathForFile`. Shift+Enter sends ESC+CR. The shell is identified as Ghostty (`TERM_PROGRAM=ghostty`, pty name `xterm-ghostty`).
- **Titles**: the tab label and header follow the agent's OSC 0/2 title. Both need undocumented Obsidian API (`leaf.updateHeader()`, `view.titleEl`), reached through casts.
- **Rendering**: native physical cells with wide characters and whole graphemes. Real regular/bold/italic faces load separately, and metrics come from font tables rounded to device pixels. Block elements and box lines are drawn procedurally. DEC mode 2027 is negotiated, not forced. The native shim answers color, cursor, status and mode queries. Old addons are rejected with an actionable message, and a new `.node` needs an Obsidian restart because Node can keep the previous addon cached.
- **Images**: the native build has Kitty graphics disabled (`oniguruma=false`) and its handler drops APC actions. `kitty-graphics.ts` decodes direct-PNG / Unicode-virtual-placement commands alongside VT parsing, and the canvas paints them from the viewport's placeholder cells. See the README for limits.
- **Font standard**: `SauceCodePro Nerd Font Mono` at size 18 gives 22 × 45 physical-pixel cells at DPR 2 in both Ghostty and the plugin. Use a real family name in the Ghostty config, not a font filename.

## Live testing

`scripts/live-test.sh <probe.js> [vault]` rebuilds, hot-reloads the plugin through `obsidian-cli`, opens a shell-only terminal, and evals a probe from `scripts/tests/`. `npm run test:images` and `npm run test:rendering` run isolated probes; set `GHOSTTY_METRICS_FILE` to compare against a real Ghostty measurement (see the README). Reloading the plugin ends embedded terminal sessions.

## Known issues and next steps

- Two terminals in the same vault, each running `claude --continue`, race over the same session file and render blank. Use "New shell (no Agent)" for the second tab.
- Scroll uses a full repaint instead of shifting canvas pixels.
- Add font-family and font-size settings so the Ghostty config doesn't need editing.
- Right-click "Open agent here" in the file tree.
- Consider replacing `native/ghostty_vt/zig/lib.zig` with upstream's libghostty-vt C API.
- Keep `vendor/ghostty` current: re-vendor from upstream, update `UPSTREAM`, rebuild, and run the probes.
- Verify the modernized build in the running Obsidian: restart it, enable the plugin, and run `npm run test:rendering` and `npm run test:images`.

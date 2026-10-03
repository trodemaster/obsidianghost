# obsidianghost

Obsidian plugin that embeds an agent terminal (Claude Code, Copilot CLI, or any shell command) using libghostty-vt (native N-API) + node-pty, with a Canvas renderer, inline Kitty images, and vault-aware OSC 8 hyperlink handling.

- [README.md](README.md): install, settings, and user-facing features
- [IMPLEMENTATION.md](IMPLEMENTATION.md): architecture, native layer, design notes, and findings/backlog

This file holds the working state: conventions, toolchain, behavior notes, testing, and next steps. Keep it current. There is no separate handoff document.

## Conventions

- Personal repo: work on a branch and open a PR to `main` only when the work is done. The pushable remote is `origin` (https://github.com/trodemaster/obsidianghost.git).
- **Package management**: this machine uses MacPorts only. Use the `/macports` skill for installing or managing packages (Node.js, etc.); do not suggest or use Homebrew.
- Run `git`/`gh` from inside the repo directory (direnv loads credentials from the shell's cwd).
- Target this machine's OS and architecture (macOS 27, Apple Silicon). The work machine is nearly identical.

## Toolchain

```bash
sudo port install zig-0.16 nodejs22 npm10 python314
make doctor      # lists anything missing
make install     # build everything and sync to the central plugin dir
make setup-vaults
```

- **Zig**: MacPorts `zig-0.16` (0.16.0). No download and no custom SDK. The old workaround (Zig 0.15.2 + `MacOSX15.4.sdk` + `xcrun` shim + archive repack) is gone: 0.15.2 could not link against the macOS 26/27 SDKs, and 0.16 does.
- **Ghostty**: `vendor/ghostty` is a snapshot of upstream `main`, pinned in `vendor/ghostty/UPSTREAM`, trimmed to the files the build reads. The latest release (v1.3.1) is the last on Zig 0.15.2; `main` requires Zig ≥ 0.16.0. `vendor/uucode` is pinned to the commit Ghostty `main` uses.
- **Electron**: read from the installed Obsidian at build time (`ELECTRON_VERSION` overrides it). Both native addons are N-API, so they are ABI-stable across Electron majors; still smoke-test after an Obsidian update.
- **npm**: a `sudo npm` or `sudo port install` can leave root-owned files in `~/.npm`. If `npm install` complains about this, run `sudo chown -R 501:20 ~/.npm`, or set `npm_config_cache` to a repo-local directory.
- Make targets: `make help` lists them. `make reinstall` is the fast JS loop. `make install` also rebuilds the native addons.

## Install layout

Central install: `~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`. Each vault symlinks to it (`make setup-vaults`). That directory is tracked in machine-cfg, so commit and push it from the terminal after `make install`.

## Behavior notes

- **Startup**: **Start directory**, **Shell**, and **Startup command** are settings. Blank Shell resolves to `/opt/local/bin/bash` (MacPorts bash 5) if present, else `/bin/bash`. Blank command = plain shell at the vault root; there is no built-in agent command (set `claude --continue` for Claude Code). Right-click the ghost ribbon icon, or use **+**, for "New shell (no Agent)". The plugin ID stays `obsidian-claude-ghostty`.
- **Links**: Cmd/Ctrl+click opens OSC 8 links (`vt.hyperlinkAt`) and plain-text URLs (regex over row text). The modifier is required on the click itself.
- **Selection and input**: mouse drag selects cells and copies through Electron's `clipboard`. Dropped files insert shell-quoted paths via `webUtils.getPathForFile`. Shift+Enter sends ESC+CR. The shell is identified as Ghostty (`TERM_PROGRAM=ghostty`, pty name `xterm-ghostty`).
- **Titles**: the tab label and header follow the agent's OSC 0/2 title. Both need undocumented Obsidian API (`leaf.updateHeader()`, `view.titleEl`), reached through casts.
- **Rendering**: native physical cells with wide characters and whole graphemes. Real regular/bold/italic faces load separately, and metrics come from font tables rounded to device pixels. Block elements and box lines are drawn procedurally. DEC mode 2027 is negotiated, not forced. The native shim answers color, cursor, status and mode queries. Old addons are rejected with an actionable message, and a new `.node` needs an Obsidian restart because Node can keep the previous addon cached.
- **Images**: the native build has Kitty graphics disabled (`oniguruma=false`) and its handler drops APC actions. `kitty-graphics.ts` decodes direct-PNG / Unicode-virtual-placement commands alongside VT parsing, and the canvas paints them from the viewport's placeholder cells. Cursor-positioned placements are not supported (see IMPLEMENTATION.md).
- **Font standard**: `SauceCodePro Nerd Font Mono` at size 18 gives 22 × 45 physical-pixel cells at DPR 2 in both Ghostty and the plugin. Use a real family name in the Ghostty config, not a font filename.

## Testing

Enable Obsidian's CLI first (Settings → General → Advanced → Command line interface). It talks over a unix socket, so from a sandboxed Claude session these commands need the sandbox disabled.

- `npm run test:images -- <vault>` and `npm run test:rendering -- <vault>` run isolated probes against a running Obsidian without reloading existing tabs. Set `GHOSTTY_METRICS_FILE` to compare against a real Ghostty measurement (see the README).
- `scripts/live-test.sh <probe.js> [vault]` rebuilds, hot-reloads the plugin, opens a shell-only terminal, and evals a probe from `scripts/tests/`. Reloading the plugin ends embedded terminal sessions.

Status on 2026-10-03 (modernized build, `orac` vault, macOS 27.0.1, Obsidian Electron 43.3.0):

- `test:images`: pass, 19 of 19.
- `test:rendering`: 30 of 32. `realFontFaces` fails because this machine has only the Regular face of SauceCode Pro Nerd Font Mono installed, and `~/.config/ghostty/config` names the font by filename. `fontBasedBoxStroke` also fails and was not investigated; it may share that cause. The probe reported DPR 1, so cell metrics don't match the 22 × 45 reference.
- The terminal tab starts `/opt/local/bin/bash` (verified from the process tree).

## Known issues and next steps

- Merge the `modernize` branch through a PR once the font setup is fixed and `test:rendering` is re-run. Also try a real Claude Code session in the terminal.
- Install the bold, italic and bold-italic faces and switch the Ghostty config to the family name, then re-run `test:rendering`. If `fontBasedBoxStroke` still fails, treat it as a regression.
- Cursor-positioned Kitty placement (`a=T`, what `timg -pk` emits) is the next image feature (see IMPLEMENTATION.md).
- Two terminals in the same vault, each running `claude --continue`, race over the same session file and render blank. Use "New shell (no Agent)" for the second tab.
- Scroll uses a full repaint instead of shifting canvas pixels.
- Add font-family and font-size settings so the Ghostty config doesn't need editing.
- Right-click "Open agent here" in the file tree.
- Consider replacing `native/ghostty_vt/zig/lib.zig` with upstream's libghostty-vt C API.
- Keep `vendor/ghostty` current: re-vendor from upstream, update `UPSTREAM`, rebuild, and run the probes.

# obsidianghost — Design and Architecture

## Goal

A sidebar terminal for agent CLIs (Claude Code, Copilot CLI, or any shell command) embedded in Obsidian. It renders with libghostty-vt (native N-API) and node-pty, so sessions keep full fidelity: 24-bit color, styles, scrollback, Kitty inline images, and clickable OSC 8 / plain-text links that open vault files.

Inspired by [derek-larson14/obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar), replacing its xterm.js + Python PTY bridge. The terminal-engine approach follows [ComputelessComputer/obsidian-ghostty](https://github.com/ComputelessComputer/obsidian-ghostty).

## Tech stack

| Component | Tool |
|---|---|
| Terminal engine | libghostty-vt, from vendored Ghostty sources (`vendor/ghostty`, pinned in `vendor/ghostty/UPSTREAM`) |
| Native build | Zig 0.16 (MacPorts `zig-0.16`) → `libghostty_vt.a`, linked by node-gyp into `ghostty_vt.node` |
| N-API wrapper | C++ with node-addon-api (`native/ghostty_vt.cc`) |
| PTY | node-pty (N-API), rebuilt for the installed Obsidian's Electron |
| Plugin | TypeScript bundled by esbuild into `main.js` |
| Platform | macOS on Apple Silicon only (`isDesktopOnly: true`) |

The Electron version is read from the installed Obsidian at build time (`ELECTRON_VERSION`), not hard-coded.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                Obsidian (Electron)               │
│  GhosttyTerminalView (ItemView, TypeScript)      │
│   ├─ Canvas renderer  (main.ts, font-metrics.ts) │
│   ├─ Kitty image layer (kitty-graphics.ts)       │
│   ├─ Link hit-testing → open in vault            │
│   ├─ ghostty_vt.node (N-API) → libghostty_vt.a   │
│   └─ node-pty → shell → agent command            │
└──────────────────────────────────────────────────┘
```

## Native layer

- `native/ghostty_vt/zig/lib.zig` is our wrapper around Ghostty's terminal library. It exports a small C ABI (see `native/ghostty_vt/include/ghostty_vt.h`): terminal lifecycle, `feed`, `resize`, scrollback control, cursor, per-row text/cell/style-run dumps, dirty-row and scroll-delta tracking, hyperlink lookup, default colors, and queued terminal replies.
- `native/ghostty_vt/zig/build.zig` builds only the terminal library: it generates the Unicode tables with uucode, wires `terminal_options`, and emits a static archive for macOS 11+.
- `vendor/ghostty/src` and `vendor/uucode` are source snapshots. Re-vendor by copying from upstream and updating the `UPSTREAM` file in each directory. Building needs Zig ≥ the `minimum_zig_version` in Ghostty's `build.zig.zon` (0.16.0 at the pinned commit).
- Upstream now ships libghostty-vt as a first-class C library (`vendor/ghostty/src/lib_vt.zig`, `terminal/c/`). Replacing `lib.zig` with it is a possible future simplification.

## Theme and fonts

Colors and font come from `~/.config/ghostty/config`: `theme`, `palette = N=#RRGGBB`, `font-family`, and `font-size`. The theme file is read from the Ghostty app bundle, and the palette is applied to the VT through OSC 4 at session start. Foreground and background fall back to Obsidian's CSS. The Nocturnal Winter Obsidian theme lives in machine-cfg and is linked by `make setup-themes`.

## Build flow

```bash
make doctor             # check prerequisites
make install            # full build + sync to the central plugin dir
make setup-vaults       # symlink the plugin into each vault
make reinstall          # fast loop: JS only
make reinstall-runtime  # JS + native addon + node-pty
```

## Distribution

Native `.node` files cannot ship through the community store's `main.js`-only constraint, so this is a local developer install. A possible future path is a runtime download of a per-Electron-ABI build from GitHub Releases.

## Findings and backlog

### Kitty graphics: timg and cursor-positioned placement (2026-10-03)

Question: can `timg` render an image through the Kitty protocol inside a Claude session in the plugin?

Findings (measured from a Claude session in the `orac` vault with `timg 1.6.3`):

- `timg -pk` emits `ESC[?25l ESC_Ga=T,i=<random>,q=2,f=100,m=1;<base64 PNG>…`: direct PNG (`f=100`, default `t=d`), chunked (`m=1`), transmit-and-display at the cursor (`a=T`), responses suppressed (`q=2`). It uses no `U=1` and no Unicode placeholder characters. `--compress` did not change the prefix.
- The plugin only handles direct PNG with Unicode virtual placements (`U=1`), the form Copilot CLI uses. It does not paint `a=T` placements positioned at the cursor, so timg output would not render even if it reached the terminal.
- A Claude session cannot deliver it anyway. The Bash tool's subprocess has no controlling terminal (`tty` reports "not a tty", opening `/dev/tty` fails with "Device not configured"), and stdout is captured and returned to the model, so the escape bytes never reach the pty. `timg` also needs `-g<cols>x<rows>` when it has no tty. Claude Code's `!` shell escape captures output as well. This blocker is outside the plugin.

Decision: do not pursue now. Merge the modernization first, then treat timg as a follow-up.

Backlog options:

1. **Cursor-positioned placement**, so `timg -pk` works in a plain shell tab ("New shell (no Agent)"). The PNG and chunk decoding in `kitty-graphics.ts` already exists. New work: honor `a=T` / `a=p`, anchor the image to the cursor cell, size it from pixel dimensions or `c=` / `r=`, move the cursor past it, and keep it attached to scrollback. A different route is to rewrite the sequence to `U=1` plus placeholder cells.
2. **Side channel for Claude sessions.** Something a tool call can invoke (a small command writing to a file or socket the plugin watches) that makes the plugin draw an image in the pane. This is a larger design decision.

Suggested order: option 1, then decide on option 2.

# obsidianghost — Design and Architecture

## Goal

A sidebar terminal for agent CLIs (Claude Code, Copilot CLI, or any shell command) embedded in Obsidian. It renders with libghostty-vt (the official WebAssembly build of Ghostty's terminal engine) and node-pty, so sessions keep full fidelity: 24-bit color, styles, scrollback, Kitty inline images, and clickable OSC 8 / plain-text links that open vault files.

Inspired by [derek-larson14/obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar), replacing its xterm.js + Python PTY bridge. The terminal-engine approach follows [ComputelessComputer/obsidian-ghostty](https://github.com/ComputelessComputer/obsidian-ghostty).

## Tech stack

| Component | Tool |
|---|---|
| Terminal engine | libghostty-vt 1.0.1, the official `ghostty-vt.wasm` release (stable C ABI), pinned in `native/libghostty-vt.env` |
| Engine adapter | TypeScript over the wasm exports (`native/ghostty-wasm.ts`) |
| PTY | node-pty 1.1.0, using its shipped N-API prebuild (`prebuilds/darwin-arm64`) |
| Plugin | TypeScript bundled by esbuild into `main.js` |
| Platform | macOS on Apple Silicon only (`isDesktopOnly: true`) |

There is no native compile step. The wasm module is independent of Electron and of the OS, and the node-pty prebuild is N-API, so it is ABI-stable across Electron versions.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                Obsidian (Electron)               │
│  GhosttyTerminalView (ItemView, TypeScript)      │
│   ├─ Canvas renderer  (main.ts, font-metrics.ts) │
│   ├─ Kitty image layer (kitty-graphics.ts)       │
│   ├─ Link hit-testing → open in vault            │
│   ├─ native/ghostty-wasm.ts → ghostty-vt.wasm    │
│   └─ node-pty → shell → agent command            │
└──────────────────────────────────────────────────┘
```

## Engine adapter

`native/ghostty.ts` defines the `GhosttyTerminal` interface the view uses (feed, resize, scroll, per-row cells and style runs, dirty rows, scroll delta, cursor, hyperlinks, colors, palette, replies) and the async loader. `native/ghostty-wasm.ts` implements it on the libghostty-vt C API:

- **Loading.** `WebAssembly.instantiate` (async; Chromium refuses synchronous compilation of large modules on the main thread). Each terminal view gets its own instance, so closing a view frees its memory.
- **ABI.** wasm32: pointers and `size_t` are 4 bytes, unions containing `uint64_t` are 8-byte aligned, and structs passed by value travel as pointers (`GhosttyPoint`, `GhosttyTerminalScrollViewport`). A fixed scratch block holds out-parameters, and opaque handles are read back from its slot with `ghostty_wasm_take_opaque`.
- **Callbacks.** C function pointers are indices into the exported `__indirect_function_table`. `wasmCallable` builds a one-function wasm module that imports the JS callback and re-exports it as a wasm function, which the table accepts. The write-pty callback queues replies per terminal (routed by the userdata id); `takeResponses()` drains them, and the view writes them to the pty.
- **Rendering reads.** `ghostty_render_state_update`, then the row iterator; only rows the library marks dirty (or all rows on a full redraw) are copied out, one string per physical cell plus resolved style runs, and cached until the next write. Wide-character tails are `""`; bold brightens palette colors 0–7, as Ghostty does by default. The adapter clears the library's dirty flags after copying and reports the rows through `takeDirtyViewportRows()`.
- **Colors.** The theme foreground/background are set as the terminal defaults and the Ghostty palette as the default palette (`GHOSTTY_TERMINAL_OPT_COLOR_PALETTE`), so OSC 10/11/4 queries report them and OSC 104 restores them.
- **Grapheme clustering.** DEC mode 2027 is set as a default mode (`GHOSTTY_TERMINAL_OPT_MODE_DEFAULT`), as Ghostty does with its default `grapheme-width-method = unicode`. Before 0.9.0 it was off unless the program enabled it, which split ZWJ emoji, flags and skin-tone modifiers in Claude Code.
- **Kitty graphics.** The library's own Kitty support is switched off (image storage limit 0) because `kitty-graphics.ts` already parses the same APC stream and sends the replies. Moving images into the library is a backlog item below.
- **Performance** (Node, M-series): a full 200×50 frame read is about 1.7 ms; parsing 20,000 lines of output about 4 ms.

`scripts/test-vt.mjs` (`make test`) checks the adapter in plain Node: query replies, mode 2027, cursor reports, style runs, palette and bold colors, hyperlinks, dirty tracking, scrollback, wide characters and Kitty placeholders.

## Theme and fonts

Colors and font come from `~/.config/ghostty/config`: `theme`, `palette = N=#RRGGBB`, `font-family`, and `font-size`. The theme file is read from the Ghostty app bundle. Foreground and background fall back to Obsidian's CSS. An Obsidian theme can be linked into the vaults with `make setup-themes`.

## Build flow

```bash
make doctor             # check prerequisites (Node, npm, curl, rsync)
make install            # npm ci, fetch wasm, bundle, package, sync to the central plugin dir
make setup-vaults       # symlink the plugin into each vault
make reinstall          # fast loop: main.js only
make release-zip        # check + test + verify, then the release archive
```

`scripts/package.sh` assembles `dist/obsidian-claude-ghostty/`: `main.js`, `manifest.json`, `styles.css`, `ghostty-vt.wasm`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and node-pty's `package.json`, `LICENSE`, `lib/` and darwin-arm64 prebuild (about 1.5 MB in all). It sets the execute bit on `spawn-helper`, which npm drops. `scripts/verify-payload.mjs` checks the result.

## Distribution

Releases are GitHub release zips built by `.github/workflows/ci.yml` on the self-hosted macOS runners. `make install-release TAG=…` installs one. The community store and BRAT only copy `main.js`, `manifest.json` and `styles.css`, so they cannot carry node-pty; the wasm could be inlined into `main.js` if that ever matters, but node-pty would still need its own file.

## Findings and backlog

### Kitty graphics: timg and cursor-positioned placement (2026-10-03)

Question: can `timg` render an image through the Kitty protocol inside a Claude session in the plugin?

Findings (measured from a Claude session in a vault with `timg 1.6.3`):

- `timg -pk` emits `ESC[?25l ESC_Ga=T,i=<random>,q=2,f=100,m=1;<base64 PNG>…`: direct PNG (`f=100`, default `t=d`), chunked (`m=1`), transmit-and-display at the cursor (`a=T`), responses suppressed (`q=2`). It uses no `U=1` and no Unicode placeholder characters. `--compress` did not change the prefix.
- The plugin only handles direct PNG with Unicode virtual placements (`U=1`), the form Copilot CLI uses. It does not paint `a=T` placements positioned at the cursor, so timg output would not render even if it reached the terminal.
- A Claude session cannot deliver it anyway. The Bash tool's subprocess has no controlling terminal (`tty` reports "not a tty", opening `/dev/tty` fails with "Device not configured"), and stdout is captured and returned to the model, so the escape bytes never reach the pty. `timg` also needs `-g<cols>x<rows>` when it has no tty. Claude Code's `!` shell escape captures output as well. This blocker is outside the plugin.

Decision: do not pursue now. Merge the modernization first, then treat timg as a follow-up.

Backlog options (libghostty-vt 1.0 now provides Kitty graphics with placements, `ghostty_kitty_graphics_*`, which would cover option 1 natively once a synchronous PNG decoder is supplied through `ghostty_sys_set`):

1. **Cursor-positioned placement**, so `timg -pk` works in a plain shell tab ("New shell (no Agent)"). The PNG and chunk decoding in `kitty-graphics.ts` already exists. New work: honor `a=T` / `a=p`, anchor the image to the cursor cell, size it from pixel dimensions or `c=` / `r=`, move the cursor past it, and keep it attached to scrollback. A different route is to rewrite the sequence to `U=1` plus placeholder cells.
2. **Side channel for Claude sessions.** Something a tool call can invoke (a small command writing to a file or socket the plugin watches) that makes the plugin draw an image in the pane. This is a larger design decision.

Suggested order: option 1, then decide on option 2.

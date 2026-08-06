# Handoff - obsidianghost

As of 2026-08-05.

## Repository State

- Canonical repo: https://github.com/blake_adobe/obsidianghost (not accessible from this machine — blake_adobe is a GitHub Enterprise account)
- PR remote: https://github.com/trodemaster/obsidianghost (pushable from this machine; use for occasional upstream PRs)
- Local remotes: `trodemaster` (push/pull), `blake_adobe` (reference only)
- Branch: `main`, tracking `trodemaster/main`
- Last commit: `063525f0 Canvas renderer with Ghostty font, theme palette, and multi-tab support`
- Working tree: clean as of this commit — text-selection + clipboard implementation (see below) is committed and manually verified in a live Obsidian session (daneel vault). Builds clean (`npm run build`); synced to the machine-cfg plugin dir via `make reinstall`. `npx tsc --noEmit` reports a pre-existing, unrelated error (`document.fonts.add` — stale `lib.dom.d.ts` typing, present on `main` before this session too); esbuild bundling is unaffected.

## Plugin Install Architecture

The plugin is installed once to a central directory and each vault symlinks into it:

- **Central install**: `~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`
- **orac vault**: `~/orac/.obsidian/plugins/obsidian-claude-ghostty` → central dir ✅
- **daneel vault**: `~/daneel/.obsidian/plugins/obsidian-claude-ghostty` → central dir ✅

To add a new vault: `make setup-vaults` (idempotent) or manually symlink.

## Generated Artifacts (not committed)

- `main.js`
- `native/ghostty_vt.node`
- `build/`
- `node_modules/`
- `.zig-cache/`, `.zig-shim/`
- `native/ghostty_vt/zig-out/`
- `vendor/zig/*/zig`
- `.env`, `.env.*`, `.envrc`

## What Works Now

- Plugin loads in Obsidian.
- PTY-backed Ghostty terminal view renders live shell/Claude terminal content via Canvas 2D renderer.
- Rendering pipeline:
  - `takeDirtyViewportRows(rows)` — only repaint changed rows
  - `dumpViewportRow(row)` — row text
  - `dumpViewportRowStyleRuns(row)` — per-row style runs (fg/bg/flags)
  - `cursorPosition()` — cursor overlay
  - `takeViewportScrollDelta()` — scroll tracking
- N-API exposes: `dumpViewportRow`, `dumpViewportRowStyleRuns`, `takeDirtyViewportRows`, `takeViewportScrollDelta`, `hyperlinkAt`, `setDefaultColors`
- Bold text correctly maps to bright palette entries (Zig fix in `lib.zig`).
- Terminal foreground and background read from Ghostty theme (`foreground`/`background` keys); fall back to Obsidian CSS background.
- ANSI palette (colors 0–15) read from `~/.config/ghostty/config`: `theme = <name>` loads theme file from Ghostty app bundle; `palette = N=#RRGGBB` entries override per-index. Applied via OSC 4 sequences at session start so the VT palette matches real Ghostty.
- Characters are rendered cell-by-cell at `col * charWidth` (no Canvas advance-width drift).
- OSC 8 links: hover shows pointer + tooltip; click opens vault files or external URLs.
- Font loads from `~/.config/ghostty/config` (`font-family` + `font-size`). PostScript name resolved to file path by filesystem search; loaded via FontFace with base64 data URI. Internal CSS name `GhosttyTerminalFont` assigned to avoid system name resolution. Currently: `SauceCodeProNerdFontMono-Regular` at 18px.
- Row height from `fontBoundingBoxAscent + fontBoundingBoxDescent` (font's native line box, no extra leading).
- Ribbon icon (ghost) in left sidebar toggles the terminal.
- Tab title and view header driven by `getDisplayText()` which tracks `sessionTitle`. Starts as "Claude"; updates live from OSC 0/2 window title sequences.
- Cmd+J closes the terminal leaf while it's focused (`handleKeyDown`); a "Toggle terminal" command is also registered (bindable to any hotkey via Obsidian's own hotkey settings). The `IMPLEMENTATION.md` work-item list still lists "Cmd+J toggle" as outstanding — that's stale, this already works.
- **Text selection + clipboard (verified live in daneel vault)**: mouse-drag selects a cell range (`selectionAnchor`/`selectionFocus`), painted as a translucent overlay (`drawSelection()`) tinted from Ghostty's `selection-background` theme key (falls back to theme fg @ 35% alpha if absent). Auto-copies to the system clipboard on mouseup after a real drag (via Electron's `clipboard` module, not the web Clipboard API — avoids permission-prompt issues). Cmd+C re-copies the current selection. A plain click (no drag) is left alone so link-opening still works; `didDragSelect` suppresses the link-click handler only when a real drag just happened. Confirmed via `screenshot-window` + manual drag: highlight renders correctly across wrapped lines, and the pasted clipboard content matched the selection exactly (trimmed per-line, multi-line joined).

## Latest Visual State

As of 2026-06-12: rendering is functionally complete. Font, colors, density, and palette all match real Ghostty. Claude Code sessions render correctly with vivid Nocturnal Winter palette, proper Nerd Font glyphs, bold/italic, OSC 8 hyperlinks, and table box-drawing characters.

## Known Remaining Issues

- Wide glyph / emoji cell alignment: `rowTextToCells()` uses `Array.from` (codepoint-split, not grapheme-cluster aware). Wide chars need 2-cell treatment.
- Scroll delta pixel-shift optimization: current code forces full repaint on scroll instead of shifting canvas pixels.
- Claude Code UX not yet implemented: right-click "Open Claude here", plugin settings panel, `claude --continue` on vault open.
- Debug `console.log` statements in `ensureFontLoaded()` and `getCharSize()` should be removed once stable.
 **Clickable links**: OSC 8 hyperlinks already open on click, but plain URLs printed in terminal output (not wrapped in OSC 8 sequences) are not detected or clickable. Need regex-based URL detection over viewport rows, hover underline, and click-to-open — same as OSC 8 path.
- **Drag and drop — file paths**: Add `dragover`/`drop` listeners on `screenEl`; on file drop, resolve `event.dataTransfer.files[0].path` to a POSIX path string and write it to the PTY (same as typing the path). Multiple files should be space-separated with shell-quoting for paths that contain spaces.
- **Drag and drop — images**: Same path-insertion behavior as other files. Image files dropped onto the terminal should have their POSIX path written to the PTY so Claude Code picks them up as image context (Claude reads image paths from the prompt). No inline rendering needed.

## Build And Install

Fast JS/CSS loop (no native rebuild):

```bash
make reinstall
```

Full local install, including native addon and node-pty rebuilds:

```bash
make install
```

Native-only rebuild (Zig + node-gyp; auto-downloads Zig 0.15.2 if missing):

```bash
make native
make pty
```

Set up vault symlinks (idempotent):

```bash
make setup-vaults
```

Useful checks:

```bash
make check
npx tsc --noEmit
```

Notes:

- `make native` downloads Zig 0.15.2 (aarch64-macos) into `vendor/zig/0.15.2/` automatically if not present.
- `make native` injects a `.zig-shim/xcrun` wrapper so Zig 0.15's SDK probe gets `MacOSX15.4.sdk` instead of the macOS 26.5 SDK name it doesn't recognize.
- `npm run build:native:electron` also works (same xcrun shim injected via `scripts/build-ghostty-vt.mjs`).
- After copying a new `.node` file into Obsidian, restart Obsidian or disable/enable the plugin so Electron unloads the old native module.
- To reload only JS/CSS without restarting Obsidian: open the command palette (`Cmd+P`) and run **"Reload app without saving"**.

## Recommended Next Steps

1. **Verify build on macOS 26 / aarch64** — run `make native` on a clean tree to confirm the Zig auto-download and xcrun shim work end-to-end.
2. **Verify and fix character density** — measure `charWidth` and `charHeight` from Canvas against what Ghostty computes via CoreText for `SauceCodePro Nerd Font Mono` at 18pt.
3. **Wide glyph support** — `rowTextToCells()` needs grapheme-cluster awareness.
4. **Remove debug logging** — `console.log` in `ensureFontLoaded()` and `getCharSize()`.
5. **Plugin settings panel** — let user override font-family and font-size without editing the Ghostty config.
6. **Claude Code UX** — right-click "Open Claude here" in the file tree, `claude --continue` on vault open. (Cmd+J toggle already exists — see "What Works Now".)
7. **Clickable plain-text URLs** and **drag-and-drop file/image paths** — see "Known Remaining Issues".
8. **Fix stale `document.fonts.add` typing error** — `npx tsc --noEmit` reports `Property 'add' does not exist on type 'FontFaceSet'` at `ensureFontLoaded()`; pre-existing (confirmed present on `main` before this session), doesn't block `esbuild`, but worth tracking down (likely a `lib`/`@types` mismatch in `tsconfig.json`).

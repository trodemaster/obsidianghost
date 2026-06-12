# Handoff - obsidianghost

As of 2026-06-12.

## Repository State

- Repo: https://github.com/blake_adobe/obsidianghost
- Branch: `main`, tracking `origin/main`
- Last committed and pushed baseline: `24ea28d4 Snapshot current plugin state`
- Current work is intentionally uncommitted. Do not assume `main` on GitHub has the renderer work yet.
- Default local vault: `/Users/blake/Developer/orac`
- Local plugin id: `obsidian-claude-ghostty`
- Local plugin install path: `/Users/blake/Developer/orac/.obsidian/plugins/obsidian-claude-ghostty`

Current uncommitted source changes:

- `main.ts` — Canvas renderer, dirty-row redraws, theme colors, cursor overlay, OSC 8 hover/click handling, Ghostty-font loading.
- `native/ghostty.ts` — TypeScript surface for `dumpViewportRow`.
- `native/ghostty_vt.cc` — N-API method for `dumpViewportRow`.
- `native/ghostty_vt/zig/lib.zig` — fixed row dump range; bold→bright palette fix.
- `styles.css` — Canvas terminal screen styles and link tooltip styles.
- `tsconfig.json` — adds Node types.
- `README.md` — Makefile development loop.
- `Makefile` — local build/install shortcuts.
- `IMPLEMENTATION.md`, `AGENTS.md`, `CLAUDE.md`, and this file — resume documentation.

Generated artifacts are ignored and should not be committed:

- `main.js`
- `native/ghostty_vt.node`
- `build/`
- `node_modules/`
- Zig caches and outputs
- `vendor/zig/*/zig`
- `.env`, `.env.*`, `.envrc`

## What Works Now

- Plugin loads in Obsidian.
- PTY-backed Ghostty terminal view renders live shell/Claude terminal content.
- Old `<pre>` viewport dump replaced by Canvas 2D renderer.
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
- Tab title and view header driven by `getDisplayText()` which tracks `sessionTitle`. Starts as "Claude"; updates live from OSC 0/2 window title sequences (Starship sets this on directory change; Claude Code sets it during sessions).

## Latest Visual State

As of 2026-06-12: rendering is functionally complete. Font, colors, density, and palette all match real Ghostty. Claude Code sessions render correctly with vivid Nocturnal Winter palette, proper Nerd Font glyphs, bold/italic, OSC 8 hyperlinks, and table box-drawing characters.

## Known Remaining Issues

- Wide glyph / emoji cell alignment: `rowTextToCells()` uses `Array.from` (codepoint-split, not grapheme-cluster aware). Wide chars need 2-cell treatment.
- Scroll delta pixel-shift optimization: current code forces full repaint on scroll instead of shifting canvas pixels.
- Claude Code UX not yet implemented: right-click "Open Claude here", plugin settings panel, `claude --continue` on vault open.
- Debug `console.log` statements in `ensureFontLoaded()` and `getCharSize()` should be removed once stable.

## Build And Install

Fast JS/CSS loop (no native rebuild):

```bash
make reinstall
```

Full local install, including native addon and node-pty rebuilds:

```bash
make install
```

Useful checks:

```bash
make check
npx tsc --noEmit
npm run build
npm run build:native:electron
npm run build:pty:electron
```

Notes:

- Native builds use the pinned Zig binary at `vendor/zig/0.15.2/zig`.
- After copying a new `.node` file into Obsidian, restart Obsidian or disable/enable the plugin so Electron unloads the old native module.
- To reload only JS/CSS without restarting Obsidian: open the command palette (`Cmd+P`) and run **"Reload app without saving"**.

## Recommended Next Steps

1. **Verify and fix character density** — measure `charWidth` and `charHeight` from Canvas against what Ghostty computes via CoreText for `SauceCodePro Nerd Font Mono` at 18pt. Key question: does Canvas `fontBoundingBoxAscent + fontBoundingBoxDescent` equal Ghostty's row pitch for this font, or is there a small systematic offset?
2. **Wide glyph support** — `rowTextToCells()` needs grapheme-cluster awareness for emoji, Nerd Font icons (which are often single-width despite appearing wider), and combining marks.
3. **Plugin settings panel** — let user override font-family and font-size without editing the Ghostty config directly.
4. **Claude Code UX** — Cmd+J toggle, right-click "Open Claude here", `claude --continue` on vault open.
5. **Commit** — once density is acceptable, commit all source and markdown changes (not build artifacts).

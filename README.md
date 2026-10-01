# obsidianghost

Obsidian plugin that embeds a Claude Code terminal using libghostty-vt (native N-API) + node-pty, with a Canvas renderer and vault-aware OSC 8 hyperlink handling.

## Inline Images

Copilot CLI images render through Kitty graphics **direct PNG transmission and Unicode
virtual placements** (`f=100`, `U=1`). Chunked transfers, image/placement deletion,
placement resizing, and viewport redraws are supported. Placeholder diacritics stay
attached to their terminal cells instead of appearing as missing-font glyphs.

The image cache is limited to 64 MiB of decoded pixels per terminal. Unsupported
formats/actions and invalid images are logged and receive protocol errors when replies
are enabled. Raw RGB/RGBA, compressed transfers, file/shared-memory transmission,
non-default placement IDs, traditional cursor-positioned Kitty placements, Sixel,
and iTerm2 images are not supported.

## Project Docs

- [IMPLEMENTATION.md](IMPLEMENTATION.md) — full development spec and work items
- [HANDOFF.md](HANDOFF.md) — current status, build/install notes, and next steps

## Text Rendering

The renderer uses native physical cells, including wide-character continuation cells
and complete graphemes, for text, image placement, selection, and link hit testing.
Applications can negotiate grapheme clustering through DEC mode 2027; it is not
enabled globally. Shells receive `COLORTERM=truecolor`, and native color/cursor queries
are answered so applications can choose their correct theme and backgrounds.

Installed TTF/OTF fonts resolve by family metadata or legacy filename stem. Regular,
bold, italic, and bold-italic faces are loaded separately; unavailable faces produce
warnings and use browser fallback/synthesis. Cell pitch and baseline use font-table
metrics rounded to physical pixels, with Canvas metrics as an explicit fallback.
Backgrounds are painted before text, and common light/heavy box lines are drawn on
the device-pixel grid. Canvas and native Ghostty rasterization are not bit-identical.

Unicode block elements (`U+2580–U+259F`) are also drawn procedurally. Shade
characters `░▒▓` use Ghostty's uniform 64/128/192-of-255 coverage instead of the
font's dot pattern; full, fractional, and quadrant blocks fill device-aligned cells.
This makes CLI progress bars continuous while preserving their colors and faint style.

Use a real family name in Ghostty, for example
`font-family = SauceCodePro Nerd Font Mono`, not its font filename. At font size 18
and DPR 2, this family measures **22 × 45 physical pixels per cell** in both renderers.

## Fresh Clone Setup

```bash
make install
```

Downloads Zig 0.15.2 (aarch64), builds `ghostty_vt.node` and `pty.node` for Electron 39, and syncs everything to the central plugin dir (`~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`).

Zig 0.15 requires a compatible macOS SDK. On newer macOS releases, place
`MacOSX15.4.sdk` in `vendor/sdk/` (ignored by Git), or set `MACOS_SDK_PATH` to a
compatible SDK. The build script owns the temporary SDK shim, repacks the static
archive for Apple's linker, and targets macOS 11 rather than the build host's OS.

Set up vault symlinks (idempotent):

```bash
make setup-vaults
```

## Development Loop

```bash
make reinstall          # rebuild JS and sync — use this on every TypeScript change
make reinstall-runtime  # rebuild JS + sync current native binaries
make native             # rebuild ghostty_vt.node (Zig source changed)
make pty                # rebuild pty.node (node-pty source/Electron bump)
make check              # type-check + bundle
npm run test:images     # isolated image probe in running Obsidian; does not reload agents
npm run test:rendering  # isolated native-cell, font, color, and pixel probe
npm run dev             # esbuild watch mode
```

After syncing JS, reload in Obsidian via `Cmd+P` → "Reload app without saving".  
This text-rendering upgrade requires rebuilding and syncing the native addon:
`make native && make reinstall-runtime`. Restart Obsidian after a native upgrade;
plugin reload alone can retain Node's old addon cache. An outdated addon is reported
explicitly. Reloads/restarts terminate embedded terminal sessions.

For a measured Ghostty comparison, run the same fixture in Ghostty:
`node scripts/rendering-fixture.cjs --measure /tmp/ghostty-cells.json` (press `q`
to close), then run
`GHOSTTY_METRICS_FILE=/tmp/ghostty-cells.json npm run test:rendering`.

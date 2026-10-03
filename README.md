# obsidianghost

Obsidian plugin that embeds an agent terminal (Claude Code, Copilot CLI, or any shell command) using libghostty-vt (native N-API) + node-pty, with a Canvas renderer, inline Kitty images, and vault-aware OSC 8 hyperlink handling.

The plugin ID stays `obsidian-claude-ghostty` so saved layouts, enabled-plugin entries, and hotkeys keep working; the display name is **Agent Ghostty Terminal**.

## Requirements

- macOS on Apple Silicon (the Zig download and native build target `aarch64-macos`)
- Obsidian 1.12.0 or newer (desktop only; the native addon targets Electron 39)
- Node.js and npm
- Xcode Command Line Tools
- Zig 0.15.2 — downloaded automatically into `vendor/zig/0.15.2/` by `make`
- A compatible macOS SDK. Zig 0.15 cannot link against newer SDK stubs, so on recent macOS releases put `MacOSX15.4.sdk` in `vendor/sdk/` (ignored by Git) or set `MACOS_SDK_PATH`. `/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk` is also found automatically.

Ghostty sources are vendored under `vendor/ghostty`, so no submodule step is needed.

## Install

```bash
git clone https://github.com/trodemaster/obsidianghost.git
cd obsidianghost
make install
make setup-vaults
```

- `make install` runs `npm install`, bundles the plugin, builds `ghostty_vt.node` and `pty.node` for Electron 39, and syncs `manifest.json`, `styles.css`, `main.js`, and the native payload into the central plugin directory, `~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`. Override it with `make install PLUGIN_DIR=/path`.
- `make setup-vaults` symlinks that directory into `<vault>/.obsidian/plugins/obsidian-claude-ghostty` for each vault listed in `VAULTS` at the top of the `Makefile` (default `~/orac` and `~/daneel`). It is idempotent and skips missing vaults. Edit `VAULTS` for your own vaults, or symlink manually.
- Optionally run `make setup-themes` to link the Nocturnal Winter theme, then select it once in **Settings → Appearance**.

Then in Obsidian: **Settings → Community plugins**, turn off Restricted mode if needed, and enable **Agent Ghostty Terminal**. Click the ghost icon in the left ribbon to open a terminal. Cmd+J closes it while focused, and **Toggle terminal** is available as a command you can bind to any hotkey.

### Updating

```bash
git pull
make reinstall                      # TypeScript/CSS changes only
make reinstall-runtime              # also re-sync the native addon and node-pty
make native pty reinstall-runtime   # Zig, node-pty, or Electron changes
```

After syncing JS, reload with `Cmd+P` → "Reload app without saving". After syncing a new `.node` file, restart Obsidian: a plugin reload alone can keep Node's old addon cache, and an outdated addon is reported explicitly. Reloads and restarts end embedded terminal sessions.

### Troubleshooting

- **`Zig 0.15 requires a compatible SDK`**: install `MacOSX15.4.sdk` into `vendor/sdk/` or export `MACOS_SDK_PATH`.
- **Plugin missing in Obsidian**: confirm the vault symlink exists, then restart Obsidian.
- **Native module load or version errors**: run `make native pty reinstall-runtime` and restart Obsidian.
- **Zig 0.16 build failures**: Ghostty v1.3.1 needs Zig 0.15.2. Use the pinned toolchain from `make`.

## Settings

In **Settings → Community plugins → Agent Ghostty Terminal**:

- **Start directory**: blank opens terminals at the vault root. Accepts an absolute path, a `~`-prefixed path, or a vault-relative path.
- **Startup command**: an optional shell command or script, run once in each new or restored terminal in the start directory. Blank starts only the shell; there is no built-in agent command. For Claude Code, set it to `claude --continue`.

Terminals start Bash on macOS/Linux. Right-click the ghost ribbon icon or the terminal's **+** button and choose **New shell (no Agent)** to bypass the startup command. Settings changes affect subsequent terminals, not running sessions. Installations shared between vaults via symlinks also share their settings.

> Earlier versions auto-launched `claude --continue`. That is now an explicit startup command setting, so existing installs need to set it once.

## Features

- Canvas renderer on native physical cells, with wide characters and full graphemes handled for text, images, selection, and link hit testing
- Ghostty config integration: font family and size, theme colors, and the ANSI palette are read from `~/.config/ghostty/config`
- Cmd/Ctrl+click opens OSC 8 hyperlinks and plain-text URLs
- Mouse text selection with automatic clipboard copy
- Drag and drop files or images onto the terminal to insert their shell-quoted paths
- Shift+Enter inserts a newline in Claude Code chat; the terminal identifies itself as Ghostty (`xterm-ghostty`)
- Tab and header titles follow the agent's session title

### Inline Images

Images render through Kitty graphics **direct PNG transmission and Unicode virtual placements** (`f=100`, `U=1`). Chunked transfers, image/placement deletion, placement resizing, and viewport redraws are supported. Placeholder diacritics stay attached to their terminal cells instead of appearing as missing-font glyphs.

The image cache is limited to 64 MiB of decoded pixels per terminal. Unsupported formats/actions and invalid images are logged and receive protocol errors when replies are enabled. Raw RGB/RGBA, compressed transfers, file/shared-memory transmission, non-default placement IDs, traditional cursor-positioned Kitty placements, Sixel, and iTerm2 images are not supported.

### Text Rendering

Applications can negotiate grapheme clustering through DEC mode 2027; it is not enabled globally. Shells receive `COLORTERM=truecolor`, and native color/cursor queries are answered so applications can choose their correct theme and backgrounds.

Installed TTF/OTF fonts resolve by family metadata or legacy filename stem. Regular, bold, italic, and bold-italic faces load separately; unavailable faces produce warnings and use browser fallback/synthesis. Cell pitch and baseline use font-table metrics rounded to physical pixels, with Canvas metrics as an explicit fallback. Backgrounds are painted before text, and common light/heavy box lines are drawn on the device-pixel grid. Canvas and native Ghostty rasterization are not bit-identical.

Unicode block elements (`U+2580–U+259F`) are drawn procedurally. Shade characters `░▒▓` use Ghostty's uniform 64/128/192-of-255 coverage instead of the font's dot pattern, and full, fractional, and quadrant blocks fill device-aligned cells, so CLI progress bars are continuous.

Use a real family name in Ghostty, for example `font-family = SauceCodePro Nerd Font Mono`, not a font filename. At font size 18 and DPR 2 this family measures **22 × 45 physical pixels per cell** in both renderers.

## Development

```bash
make reinstall          # rebuild JS and sync — use on every TypeScript change
make reinstall-runtime  # rebuild JS + sync current native binaries
make native             # rebuild ghostty_vt.node (Zig source changed)
make pty                # rebuild pty.node (node-pty source/Electron bump)
make check              # type-check + bundle
npm run test:images     # isolated image probe in running Obsidian; does not reload agents
npm run test:rendering  # isolated native-cell, font, color, and pixel probe
npm run dev             # esbuild watch mode
```

For a measured Ghostty comparison, run the same fixture in Ghostty:
`node scripts/rendering-fixture.cjs --measure /tmp/ghostty-cells.json` (press `q` to close), then run
`GHOSTTY_METRICS_FILE=/tmp/ghostty-cells.json npm run test:rendering`.

## Project Docs

- [IMPLEMENTATION.md](IMPLEMENTATION.md) — full development spec and work items
- [HANDOFF.md](HANDOFF.md) — current status, build/install notes, and next steps

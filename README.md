# obsidianghost

Obsidian plugin that embeds an agent terminal (Claude Code, Copilot CLI, or any shell command) using libghostty-vt (native N-API) + node-pty, with a Canvas renderer, inline Kitty images, and vault-aware OSC 8 hyperlink handling.

The plugin ID stays `obsidian-claude-ghostty` so saved layouts, enabled-plugin entries, and hotkeys keep working; the display name is **Agent Ghostty Terminal**.

## Requirements

macOS on Apple Silicon with Obsidian 1.12.0 or newer (desktop only). Install the toolchain with MacPorts:

```bash
sudo port install zig-0.16 nodejs22 npm10 python314
xcode-select --install     # if the Xcode Command Line Tools are missing
```

- Zig 0.16 builds libghostty-vt from the vendored Ghostty sources (`vendor/ghostty`, no submodule step). It links against the stock macOS SDK, so no extra SDK is needed.
- Node.js, npm and Python 3 are used by esbuild and node-gyp.
- The native addons are built for the Electron version of the **installed Obsidian**, which the Makefile reads automatically (override with `ELECTRON_VERSION=x.y.z`).

`make doctor` checks all of this and lists anything that is missing; the build targets run it first.

## Install

```bash
git clone https://github.com/trodemaster/obsidianghost.git
cd obsidianghost
make doctor
make install
make setup-vaults
```

- `make install` runs `npm install`, builds `ghostty_vt.node` and `pty.node` for Obsidian's Electron, bundles the plugin, and syncs `manifest.json`, `styles.css`, `main.js`, and the native payload into the central plugin directory, `~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`. Override it with `make install PLUGIN_DIR=/path`.
- `make setup-vaults` symlinks that directory into `<vault>/.obsidian/plugins/obsidian-claude-ghostty` for each vault in `VAULTS` (default `~/orac` and `~/daneel`; override with `make setup-vaults VAULTS="..."`). It is idempotent and skips missing vaults.
- Optionally run `make setup-themes` to link the Nocturnal Winter theme, then select it once in **Settings → Appearance**.

Then in Obsidian: **Settings → Community plugins**, turn off Restricted mode if needed, and enable **Agent Ghostty Terminal**. Click the ghost icon in the left ribbon to open a terminal. Cmd+J closes it while focused, and **Toggle terminal** is available as a command you can bind to any hotkey.

### Updating

```bash
git pull
make reinstall           # TypeScript/CSS changes only
make install             # Zig, node-pty, vendored Ghostty, or Obsidian/Electron changes
```

After syncing JS, reload with `Cmd+P` → "Reload app without saving". After syncing a new `.node` file, restart Obsidian: a plugin reload alone can keep Node's old addon cache, and an outdated addon is reported explicitly. Reloads and restarts end embedded terminal sessions.

### Troubleshooting

- **`make doctor` reports MISSING**: run the `port install` command it prints.
- **`npm install` says the cache has root-owned files**: `sudo chown -R 501:20 ~/.npm`.
- **Plugin missing in Obsidian**: confirm the vault symlink exists, then restart Obsidian.
- **Native module load or version errors**: run `make install` and restart Obsidian.

## Settings

In **Settings → Community plugins → Agent Ghostty Terminal**:

- **Start directory**: blank opens terminals at the vault root. Accepts an absolute path, a `~`-prefixed path, or a vault-relative path.
- **Shell**: path to the shell to start. Blank auto-detects MacPorts bash (`/opt/local/bin/bash`) when installed, otherwise `/bin/bash` (macOS's bash 3.2).
- **Startup command**: an optional shell command or script, run once in each new or restored terminal in the start directory. Blank starts only the shell; there is no built-in agent command. For Claude Code, set it to `claude --continue`.

Terminals start the configured shell. Right-click the ghost ribbon icon or the terminal's **+** button and choose **New shell (no Agent)** to bypass the startup command. Settings changes affect subsequent terminals, not running sessions. Installations shared between vaults via symlinks also share their settings.

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

The image cache is limited to 64 MiB of decoded pixels per terminal. Unsupported formats/actions and invalid images are logged and receive protocol errors when replies are enabled. Raw RGB/RGBA, compressed transfers, file/shared-memory transmission, non-default placement IDs, traditional cursor-positioned Kitty placements (what `timg -pk` emits), Sixel, and iTerm2 images are not supported. Output captured by an agent's tool call, such as a Claude Code Bash tool, never reaches the terminal, so images must be printed by a program running directly in the shell.

### Text Rendering

Applications can negotiate grapheme clustering through DEC mode 2027; it is not enabled globally. Shells receive `COLORTERM=truecolor`, and native color/cursor queries are answered so applications can choose their correct theme and backgrounds.

Installed TTF/OTF fonts resolve by family metadata or legacy filename stem. Regular, bold, italic, and bold-italic faces load separately; unavailable faces produce warnings and use browser fallback/synthesis. Cell pitch and baseline use font-table metrics rounded to physical pixels, with Canvas metrics as an explicit fallback. Backgrounds are painted before text, and common light/heavy box lines are drawn on the device-pixel grid. Canvas and native Ghostty rasterization are not bit-identical.

Unicode block elements (`U+2580–U+259F`) are drawn procedurally. Shade characters `░▒▓` use Ghostty's uniform 64/128/192-of-255 coverage instead of the font's dot pattern, and full, fractional, and quadrant blocks fill device-aligned cells, so CLI progress bars are continuous.

Use a real family name in Ghostty, for example `font-family = SauceCodePro Nerd Font Mono`, not a font filename. At font size 18 and DPR 2 this family measures **22 × 45 physical pixels per cell** in both renderers.

## Development

```bash
make doctor             # check prerequisites
make reinstall          # rebuild JS and sync — use on every TypeScript change
make reinstall-runtime  # rebuild JS + sync current native binaries
make native             # rebuild ghostty_vt.node (Zig source changed)
make pty                # rebuild pty.node (node-pty source/Electron bump)
make check              # type-check + bundle
npm run test:images -- <vault>     # isolated image probe in running Obsidian; does not reload agents
npm run test:rendering -- <vault>  # isolated native-cell, font, color, and pixel probe
npm run dev             # esbuild watch mode
```

The probes talk to a running Obsidian through its CLI: enable **Settings → General → Advanced → Command line interface** first, and open an Agent terminal in the target vault.

For a measured Ghostty comparison, run the same fixture in Ghostty:
`node scripts/rendering-fixture.cjs --measure /tmp/ghostty-cells.json` (press `q` to close), then run
`GHOSTTY_METRICS_FILE=/tmp/ghostty-cells.json npm run test:rendering`.

## Project Docs

- [CLAUDE.md](CLAUDE.md) — conventions, toolchain, testing status, and next steps
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — architecture, native layer, and design findings

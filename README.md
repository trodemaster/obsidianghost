# obsidianghost

Obsidian plugin that embeds an agent terminal (Claude Code, Copilot CLI, or any shell command) using libghostty-vt 1.0 (official WebAssembly build) + node-pty, with a Canvas renderer, inline Kitty images, and vault-aware OSC 8 hyperlink handling.

The plugin ID stays `obsidian-claude-ghostty` so saved layouts, enabled-plugin entries, and hotkeys keep working; the display name is **Agent Ghostty Terminal**.

## Requirements

macOS on Apple Silicon with Obsidian 1.12.0 or newer (desktop only). The only toolchain is Node, from MacPorts:

```bash
sudo port install nodejs22 npm10
```

Nothing is compiled:

- **libghostty-vt** is the official [libghostty-vt 1.0](https://lib.ghostty.org/vt/) WebAssembly release. `make wasm` downloads the version pinned in `native/libghostty-vt.env` and checks its SHA-256.
- **node-pty** uses its shipped N-API prebuild, which works with any Electron version, so Obsidian updates need no rebuild.

`make doctor` lists anything that is missing; `make install` runs it first.

## Install

```bash
git clone https://github.com/trodemaster/obsidianghost.git
cd obsidianghost
make doctor
make install
make setup-vaults
```

- `make install` installs npm dependencies, fetches `ghostty-vt.wasm`, bundles `main.js`, assembles the payload in `dist/obsidian-claude-ghostty/`, and syncs it into the central plugin directory, `~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`. Override it with `make install PLUGIN_DIR=/path`. The sync never touches `data.json`, so settings survive.
- Without a checkout's build, `make install-release TAG=v0.9.0` installs a published GitHub release zip instead (needs `gh` signed in to an account that can read the repo).
- `make setup-vaults` symlinks that directory into `<vault>/.obsidian/plugins/obsidian-claude-ghostty` for each vault in `VAULTS` (default `~/orac` and `~/daneel`; override with `make setup-vaults VAULTS="..."`). It is idempotent and skips missing vaults.
- Optionally run `make setup-themes` to link the Nocturnal Winter theme, then select it once in **Settings → Appearance**.

Then in Obsidian: **Settings → Community plugins**, turn off Restricted mode if needed, and enable **Agent Ghostty Terminal**. Click the ghost icon in the left ribbon to open a terminal. Cmd+J closes it while focused, and **Toggle terminal** is available as a command you can bind to any hotkey.

### Updating

```bash
git pull
make reinstall           # TypeScript/CSS changes only
make install             # dependency, libghostty-vt, or packaging changes
```

Then reload with `Cmd+P` → "Reload app without saving". The engine is WebAssembly, so a reload picks up a new version too; only a node-pty change needs a full restart. Reloads and restarts end embedded terminal sessions.

Upgrading from 0.1.x: `make install` removes the old `native/ghostty_vt.node` from the plugin directory. Restart Obsidian once afterwards so it drops the old addon.

### Troubleshooting

- **`make doctor` reports MISSING**: run the `port install` command it prints.
- **npm cache permission errors**: the Makefile uses a repo-local npm cache (`.cache/npm`) and doesn't touch `~/.npm`. If you run `npm` by hand, set `npm_config_cache` the same way.
- **Plugin missing in Obsidian**: confirm the vault symlink exists, then restart Obsidian.
- **"libghostty-vt not found"** in the terminal pane: `ghostty-vt.wasm` is missing from the plugin directory. Run `make install`.
- **`posix_spawnp failed`**: node-pty's `spawn-helper` lost its execute bit. `make install` sets it; for a hand-copied install run `chmod 755 node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` in the plugin directory.

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

Grapheme clustering (DEC mode 2027) is on by default, as in Ghostty, so emoji sequences such as 👩‍💻, 🇺🇸 and 👍🏽 take one wide cell; programs can still turn it off. Shells receive `COLORTERM=truecolor`, and libghostty-vt answers color, cursor, mode and device-attribute queries so applications can choose their correct theme and backgrounds. The caret follows the program's cursor visibility (DECTCEM), as in Ghostty.

Installed TTF/OTF fonts resolve by family metadata or legacy filename stem. Regular, bold, italic, and bold-italic faces load separately; unavailable faces produce warnings and use browser fallback/synthesis. Cell pitch and baseline use font-table metrics rounded to physical pixels, with Canvas metrics as an explicit fallback. Backgrounds are painted before text, and common light/heavy box lines are drawn on the device-pixel grid. Canvas and native Ghostty rasterization are not bit-identical.

Unicode block elements (`U+2580–U+259F`) are drawn procedurally. Shade characters `░▒▓` use Ghostty's uniform 64/128/192-of-255 coverage instead of the font's dot pattern, and full, fractional, and quadrant blocks fill device-aligned cells, so CLI progress bars are continuous.

Use a real family name in Ghostty, for example `font-family = SauceCodePro Nerd Font Mono`, not a font filename. At font size 18 and DPR 2 this family measures **22 × 45 physical pixels per cell** in both renderers.

## Development

```bash
make doctor             # check prerequisites
make reinstall          # rebuild JS and sync — use on every TypeScript change
make check              # type-check + bundle
make test               # headless libghostty-vt adapter tests (plain Node, no Obsidian)
make verify             # package, then check the payload (wasm tests, node-pty spawn)
make release-zip        # check + test + verify, then dist/obsidian-claude-ghostty-<version>.zip
npm run test:images -- <vault>     # isolated image probe in running Obsidian; does not reload agents
npm run test:rendering -- <vault>  # isolated native-cell, font, color, and pixel probe
npm run dev             # esbuild watch mode
```

The probes talk to a running Obsidian through its CLI: enable **Settings → General → Advanced → Command line interface** first, and open an Agent terminal in the target vault.

For a measured Ghostty comparison, run the same fixture in Ghostty:
`node scripts/rendering-fixture.cjs --measure /tmp/ghostty-cells.json` (press `q` to close), then run
`GHOSTTY_METRICS_FILE=/tmp/ghostty-cells.json npm run test:rendering`.

### Releases

Versions follow semver; 0.x releases are betas. To release, bump `version` in `manifest.json` and `package.json`, add a `versions.json` entry and a `CHANGELOG.md` section, merge to `main`, then push a tag `v<version>`. The CI workflow (`.github/workflows/ci.yml`) runs on the self-hosted macOS runners: it tests every push and pull request, and for a tag it builds the zip and publishes a GitHub release (0.x is marked pre-release).

To update libghostty-vt, change the three values in `native/libghostty-vt.env` (the hash comes from the release's `SHA256SUMS`), run `make test`, and update `THIRD_PARTY_NOTICES.md` if the release's `deps/libghostty-vt-third-party.json` changed.

## Project Docs

- [CLAUDE.md](CLAUDE.md) — conventions, toolchain, testing status, and next steps
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — architecture, engine adapter, and design findings
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — bundled third-party licenses

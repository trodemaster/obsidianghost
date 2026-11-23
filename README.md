# obsidianghost

An Obsidian plugin that puts a real terminal in a sidebar tab, built to run an agent CLI (Claude Code, Copilot CLI, or any shell command) next to your notes. It uses Ghostty's terminal engine, [libghostty-vt](https://lib.ghostty.org/vt/), and draws with a canvas tuned to match Ghostty's look.

Display name **Agent Ghostty Terminal**, plugin ID `obsidian-claude-ghostty`. Desktop only: macOS on Apple Silicon, Obsidian 1.12.0 or newer.

## Install

Having an agent do it? Point it at [INSTALL.md](INSTALL.md), a step-by-step install and upgrade guide written for agents (Claude Code, Codex, Copilot CLI): it checks the machine, verifies the release download, keeps your settings, and asks before enabling the plugin or restarting Obsidian.

### From a release

Each [GitHub release](https://github.com/trodemaster/obsidianghost/releases) has a zip, `obsidian-claude-ghostty-<version>.zip`, holding a ready-to-use plugin folder. Unzip it into `<vault>/.obsidian/plugins/` so you get `<vault>/.obsidian/plugins/obsidian-claude-ghostty/`. Unzip it rather than copying files one by one: `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` must stay executable.

From a checkout, `make install-release TAG=v0.9.0` does the same into the central plugin directory described below. It needs `gh` signed in to an account that can read the repo.

### From source

Node is the only toolchain; nothing is compiled.

```bash
sudo port install nodejs22 npm10
git clone https://github.com/trodemaster/obsidianghost.git
cd obsidianghost
make doctor          # lists anything missing
make install         # build and sync into the central plugin directory
make setup-vaults    # symlink the plugin into each vault
```

- `make install` installs the npm dependencies, downloads `ghostty-vt.wasm` (the version and SHA-256 pinned in `native/libghostty-vt.env`), bundles `main.js`, and syncs the result into the plugin folder. By default that is `<vault>/.obsidian/plugins/obsidian-claude-ghostty` in the first vault Obsidian knows (`scripts/list-vaults.sh` lists them, sorted by path). `make help` prints the folder it will use.
- `make setup-vaults` links that folder into every other vault Obsidian knows, so they all share one copy and one set of settings. It skips vaults that already have the plugin.
- Override the defaults on the command line, or export them in a local `.envrc` (gitignored; direnv loads it): `VAULTS` (space-separated vault paths), `PLUGIN_DIR` (where the one real copy lives, e.g. a folder outside any vault), `THEME_DIR`.
- `make setup-themes` optionally links the theme folder in `THEME_DIR` into each vault; select it once in **Settings → Appearance**.

### Enable

In **Settings → Community plugins**, turn off Restricted mode if needed and enable **Agent Ghostty Terminal**. Click the ghost icon in the left ribbon to open a terminal.

### Update

```bash
git pull
make install          # or: make reinstall, when only TypeScript/CSS changed
```

Then quit Obsidian (`Cmd+Q`) and open it again. Updates never touch `data.json`, so settings are kept. Restarting ends the terminal sessions that were running.

### Troubleshooting

- **The plugin isn't listed**: check the vault's `.obsidian/plugins/obsidian-claude-ghostty` link or folder, then restart Obsidian.
- **"libghostty-vt not found"** in the terminal tab: `ghostty-vt.wasm` is missing from the plugin folder. Run `make install`, or unzip the release again.
- **`posix_spawnp failed`**: `spawn-helper` lost its execute bit. Run `chmod 755 node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` in the plugin folder.
- **npm permission errors**: the Makefile keeps npm's cache in the repo (`.cache/npm`) and never touches `~/.npm`; set `npm_config_cache` the same way when running npm by hand.

## Settings

**Settings → Community plugins → Agent Ghostty Terminal**:

| Setting | What it does | Blank means |
|---|---|---|
| **Start directory** | Working directory for new terminals: an absolute path, a `~` path, or a path relative to the vault root. | The vault root |
| **Shell** | The shell to start, as an absolute or `~` path. | MacPorts bash (`/opt/local/bin/bash`) if installed, else `/bin/bash` |
| **Font size** | Terminal font size in pixels, 6–72. Applies to open terminals immediately. | `font-size` from the Ghostty config |
| **Agent start command** | Typed into each new or restored terminal after the shell starts, for example `claude --continue` or a wrapper script. | A plain shell; there is no built-in agent |

- **Font size** and **Agent start command** are stored per computer, by host name (the setting shows which computer you are on). A `data.json` copied or synced between machines still starts the right agent, at the right size, on each.
- Start directory, shell and agent command apply to terminals opened afterwards, not to running ones.
- Vaults that share one plugin folder through symlinks share its settings.
- Settings are saved in the plugin folder's `data.json`.

Font family, colors and palette are not plugin settings: they come from Ghostty's config (see below).

## Using it

- **Open**: click the ghost ribbon icon, or run **Toggle terminal** / **New terminal** from the command palette (both can have hotkeys).
- **Shell without the agent**: right-click the ghost icon or a terminal's **+** button and choose **New shell (no Agent)**.
- **Close**: `Cmd+J` while the terminal has focus, or close the tab. Exiting the shell also closes the tab.
- **Links**: `Cmd`+click opens OSC 8 hyperlinks and plain URLs; links to notes open in the vault.
- **Selection**: drag to select; it is copied to the clipboard. `Cmd+C` also copies the selection.
- **Files**: drop files or images on the terminal to insert their shell-quoted paths.
- **Keys**: `Shift+Enter` inserts a newline in Claude Code. `Cmd+A`/`Cmd+E`/`Cmd+K`/`Cmd+U`/`Cmd+L`/`Cmd+Backspace` and `Option+←/→/Backspace` map to the usual shell line-editing keys. `PageUp`/`PageDown` scroll by a page, `Shift+↑/↓` by a line, `Shift+Home`/`Shift+End` to the top or bottom.
- **Titles**: the tab title follows the title the agent sets.

## How it works

```
Obsidian (Electron renderer)
 └─ Terminal view (main.ts)
     ├─ node-pty ─────────── shell → agent command
     ├─ libghostty-vt.wasm ─ parses output, keeps screen + scrollback, answers queries
     ├─ canvas renderer ──── draws cells from the engine's render state
     └─ kitty-graphics.ts ── inline images
```

**Terminal engine.** Program output goes into [libghostty-vt](https://lib.ghostty.org/vt/) 1.0, Ghostty's own terminal emulator, compiled to WebAssembly and loaded from `ghostty-vt.wasm` in the plugin folder. It handles escape sequences, the screen and scrollback, styles, hyperlinks and wide characters, and it answers programs' queries (colors, cursor position, modes, device attributes). `native/ghostty-wasm.ts` drives it through its stable C API. One engine instance runs per terminal tab.

**Shell.** [node-pty](https://github.com/microsoft/node-pty) starts the shell in a pseudo-terminal, using its prebuilt macOS binary (N-API, so Obsidian updates need no rebuild). The shell sees `TERM=xterm-ghostty`, `TERM_PROGRAM=ghostty` and `COLORTERM=truecolor`, so tools such as Claude Code treat it as Ghostty. After the shell starts, the plugin types this computer's agent start command, unless the tab is a "New shell (no Agent)".

**Rendering.** After output arrives, the plugin reads the rows the engine marks as changed and draws them on a canvas, one physical cell at a time, with whole graphemes and double-width characters. Cell size and baseline come from the font's own tables, rounded to device pixels, so cells match Ghostty: SauceCodePro Nerd Font Mono at 18 px is 22 × 45 device pixels at Retina scale in both. Regular, bold, italic and bold-italic faces load separately. Box-drawing lines and block elements (`▀▄█░▒▓`, progress-bar eighths) are drawn as shapes rather than glyphs, so bars and borders join seamlessly.

**Behaving like Ghostty.**
- Grapheme clustering (DEC mode 2027) is on, as in Ghostty, so 👩‍💻, 🇺🇸 and 👍🏽 each take one wide cell.
- The caret follows the program's cursor visibility; Claude Code hides it and draws its own.
- Bold text brightens the eight basic colors.

**Ghostty config.** `~/.config/ghostty/config` supplies `font-family` (and `font-family-bold`/`-italic`/`-bold-italic`), `font-size`, `theme`, `palette = N=#RRGGBB`, the foreground/background and the selection color; themes are read from the Ghostty app bundle. Use a font family name, not a file name. The palette becomes the terminal's default palette, so programs that reset colors return to it. The config is read when the plugin loads; restart Obsidian after changing it.

**Images.** Kitty graphics with direct PNG data and Unicode placeholders (`f=100`, `U=1`, the form Copilot CLI uses) are shown inline, including chunked transfers, deletion and resizing, with up to 64 MiB of decoded images per terminal. Not supported: raw RGB/RGBA, compressed or file transfers, images placed at the cursor (what `timg -pk` sends), Sixel and iTerm2 images. Output captured by an agent's tool call (such as Claude Code's Bash tool) never reaches the terminal, so images only appear for programs printing directly to the shell.

## More

- [INSTALL.md](INSTALL.md): install, upgrade and uninstall steps for agents
- [CHANGELOG.md](CHANGELOG.md): release notes
- [IMPLEMENTATION.md](IMPLEMENTATION.md): architecture and design notes
- [CLAUDE.md](CLAUDE.md): development, testing, releases and to-dos
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): bundled third-party licenses

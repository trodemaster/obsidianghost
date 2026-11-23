# obsidianghost

Obsidian plugin that embeds an agent terminal (Claude Code, Copilot CLI, or any shell command) using libghostty-vt 1.0 (official WebAssembly build) + node-pty, with a Canvas renderer, inline Kitty images, and vault-aware OSC 8 hyperlink handling.

- [README.md](README.md): install, settings, usage, and how the plugin works (user-facing; development, testing and release details live here instead)
- [IMPLEMENTATION.md](IMPLEMENTATION.md): architecture, engine adapter, design notes, and findings/backlog
- [INSTALL.md](INSTALL.md): agent-run install/upgrade/uninstall guide, with skill frontmatter (`install-obsidianghost`). Steps 3–4 were run verbatim on 2026-11-21 (fresh install and upgrade into a scratch folder, `verify-payload` pass) and steps 7 and 9 read-only in a live vault. Keep it in step with the payload layout, `native/libghostty-vt.env` and the settings API (`setAgentCommand`, `setFontSize`, `getNativeState`).
- [CHANGELOG.md](CHANGELOG.md): release notes (the release workflow publishes the matching section)

This file holds the working state: conventions, toolchain, behavior notes, testing, and next steps. Keep it current. There is no separate handoff document.

## Conventions

- Personal repo: work on a branch and open a PR to `main` only when the work is done. The pushable remote is `origin` (https://github.com/trodemaster/obsidianghost.git).
- **Package management**: this machine uses MacPorts only. Use the `/macports` skill for installing or managing packages (Node.js, etc.); do not suggest or use Homebrew.
- Run `git`/`gh` from inside the repo directory (direnv loads credentials from the shell's cwd).
- Target macOS on Apple Silicon.
- Personal setup (which vaults, where the plugin lives, CI runners) stays out of the repo: it is set through a local, gitignored `.envrc` (`VAULTS`, `PLUGIN_DIR`, `THEME_DIR`, `OBSIDIAN_VAULT`) and the `OBSIDIANGHOST_RUNS_ON` repository variable.

## Toolchain

```bash
sudo port install nodejs22 npm10
make doctor      # lists anything missing
make install     # npm ci, fetch wasm, bundle, package, sync to the plugin dir
make setup-vaults
```

- **libghostty-vt**: the official 1.0.1 WebAssembly release, pinned (version, URL, SHA-256) in `native/libghostty-vt.env`. `make wasm` downloads and verifies it into `native/ghostty-vt.wasm` (gitignored). No Zig, no vendored Ghostty, no C/C++ build. Building it from source would need Zig 0.17 (MacPorts `zig-0.17`), but nothing here does.
- **node-pty**: pinned to 1.1.0 and used through its shipped N-API prebuild; `npm ci --ignore-scripts` skips its node-gyp install script. npm drops the execute bit on `spawn-helper`; `scripts/package.sh` restores it (without it every spawn fails with `posix_spawnp failed`).
- **npm**: MacPorts installs and `sudo npm` leave `~/.npm` root-owned. Never chown it. The Makefile points npm at a repo-local cache (`.cache/npm`).
- **Versions**: semver, 0.x are betas. To release: bump `manifest.json` and `package.json`, add the `versions.json` entry and the `CHANGELOG.md` section, merge to `main`, push tag `v<version>` (if the repository variable `OBSIDIANGHOST_RUNS_ON` points at self-hosted runners, have one online first). `manifest.json`, `package.json`, `versions.json` and `CHANGELOG.md` move together; `scripts/package.sh` refuses mismatched versions and the release job refuses a tag that differs from `manifest.json`.
- Make targets: `make help` lists them. `make reinstall` is the fast JS loop; `make test` and `make verify` run without Obsidian.

## CI and releases

`.github/workflows/ci.yml` runs `make check`, `make test`, `make verify` on every push and PR, and for a `v*` tag `make release-zip` plus `scripts/publish-release.sh` (REST API through curl, 0.x marked pre-release; `DRAFT=true` makes a draft for testing, no tag created). Jobs run on GitHub-hosted `macos-latest` unless the repository variable `OBSIDIANGHOST_RUNS_ON` holds a JSON `runs-on` value (for example `["self-hosted","macOS_27"]`). Pull requests always use the hosted runner, so fork code never reaches a self-hosted machine; if self-hosted runners are used, also set Settings → Actions → "Require approval for all outside collaborators". The Node setup is the composite action `.github/actions/toolchain` (setup-node on hosted runners, MacPorts on self-hosted ones).

## Install layout

`make install` syncs to `PLUGIN_DIR` (default `<first vault>/.obsidian/plugins/obsidian-claude-ghostty`, see `make help`); `make setup-vaults` links it into the other vaults. The payload is about 1.5 MB (no node-pty sources or build output); `make install` removes the old pre-0.9 `native/` directory there. `make install-release TAG=…` installs a release zip instead of a local build. The plugin's settings file, `data.json`, stays unique to each host: if the plugin folder is under version control, ignore it and never commit it.

## Behavior notes

- **Startup**: **Start directory**, **Shell**, and **Agent start command** are settings. The agent command is stored per computer in `data.json` (`agentCommands`, keyed by the short lowercase host name). `data.json` stays local to each host; the host keys only make a copied or synced file safe. A pre-0.9 `startupCommand` migrates to the first computer that loads it. Blank Shell resolves to `/opt/local/bin/bash` (MacPorts bash 5) if present, else `/bin/bash`. Blank agent command = plain shell at the vault root; there is no built-in agent command (set `claude --continue` for Claude Code). Right-click the ghost ribbon icon, or use **+**, for "New shell (no Agent)". The plugin ID stays `obsidian-claude-ghostty`.
- **Links**: Cmd/Ctrl+click opens OSC 8 links (`vt.hyperlinkAt`) and plain-text URLs (regex over row text). The modifier is required on the click itself.
- **Selection and input**: mouse drag selects cells and copies through Electron's `clipboard`. Dropped files insert shell-quoted paths via `webUtils.getPathForFile`. Shift+Enter sends ESC+CR. The shell is identified as Ghostty (`TERM_PROGRAM=ghostty`, pty name `xterm-ghostty`).
- **Titles**: the tab label and header follow the agent's OSC 0/2 title. Both need undocumented Obsidian API (`leaf.updateHeader()`, `view.titleEl`), reached through casts.
- **Rendering**: native physical cells with wide characters and whole graphemes. Real regular/bold/italic faces load separately, and metrics come from font tables rounded to device pixels. Block elements and box lines are drawn procedurally. Grapheme clustering (DEC mode 2027) is on by default and survives RIS, matching Ghostty's `grapheme-width-method = unicode`; Claude Code never sends `2027h` but sizes emoji sequences as Ghostty does, so with it off 👩‍💻/🇺🇸/👍🏽 split and lose parts. libghostty-vt answers color, cursor, status, mode and device-attribute queries through its write-pty callback (`takeResponses()`). The caret follows DECTCEM, so programs that hide the cursor (Claude Code draws its own) show no caret, as in Ghostty. After installing a build, quit and restart Obsidian (`Cmd+Q`): reloads have caused problems before, and restarting is the user's call because it ends embedded sessions.
- **Images**: the library's Kitty graphics are switched off at runtime (image storage limit 0), so it neither stores images nor replies. `kitty-graphics.ts` decodes direct-PNG / Unicode-virtual-placement commands alongside VT parsing, and the canvas paints them from the viewport's placeholder cells. Cursor-positioned placements are not supported (see IMPLEMENTATION.md).
- **Font size**: per computer (`fontSizes` in `data.json`, same host key as the agent command); blank falls back to the Ghostty config's `font-size`. `plugin.ghosttyFont` is the parsed config, `plugin.terminalFont` the same with this computer's size; `setFontSize` re-lays out open views (`refreshFont`). Family still comes only from the Ghostty config. Probe: `scripts/tests/font-size.js`.
- **Font standard**: `SauceCodePro Nerd Font Mono` at size 18 gives 22 × 45 physical-pixel cells at DPR 2 in both Ghostty and the plugin. Use a real family name in the Ghostty config, not a font filename.

## Testing

- `make test` (`npm run test:vt`): headless adapter checks in plain Node against `native/ghostty-vt.wasm`. `make verify` also packages and checks the payload, including a node-pty spawn (that spawn needs the Claude sandbox disabled; it blocks pty creation).
- Enable Obsidian's CLI for the live probes (Settings → General → Advanced → Command line interface). It talks over a unix socket, so from a sandboxed Claude session these commands need the sandbox disabled.
- `npm run test:images -- <vault>` and `npm run test:rendering -- <vault>` run isolated probes against a running Obsidian without reloading existing tabs. To compare against real Ghostty, run the fixture there first: `node scripts/rendering-fixture.cjs --measure /tmp/ghostty-cells.json` (press `q` to close), then `GHOSTTY_METRICS_FILE=/tmp/ghostty-cells.json npm run test:rendering -- <vault>`.
- `scripts/obsidian-ui.sh` (repo skill `obsidian-ui`): drives the real app through AppleScript/System Events — opens a throwaway shell-only tab, types real keystrokes into it (refusing if anything else has focus), pastes Unicode, captures the bytes sent to the pty, reads the screen and screenshots the window. Sandbox off; needs Accessibility and Screen Recording.
- `scripts/live-test.sh <probe.js> [vault]` rebuilds, hot-reloads the plugin, opens a shell-only terminal, and evals a probe from `scripts/tests/`. Reloading the plugin ends embedded terminal sessions.

Status on 2026-11-21 (branch `libghostty-1.0`, v0.9.0, libghostty-vt 1.0.1 wasm, macOS 27.2):

- `make test`: pass, 27 of 27. `make verify`: pass (payload complete, packaged wasm passes, packaged node-pty spawns a 91×27 pty).
- `make check`: tsc and esbuild clean.
- Live in Obsidian (after `make install` and an Obsidian restart): the plugin reports `Loaded libghostty-vt 1.0.1 (wasm)`; `test:rendering` pass, 31 of 31; `test:images` pass, 19 of 19.
- Claude Code session checked by eye (screenshots): tables, code, CJK, box drawing and the status line render correctly. That check found the grapheme bug (👩‍💻/🇺🇸/👍🏽 split), now fixed and confirmed in a live vault after a restart with `scripts/obsidian-ui.sh`.
- Settings probes (run directly with `obsidian-cli vault=<vault> eval`, no reload): `startup-command.js` pass, 15 of 15; `font-size.js` pass, 7 of 7. Neither writes `data.json`.
- `osc8-links`, `plain-url-links`, `shift-enter`, `session-title`, `drag-drop`: pass. Every live probe now opens its own shell-only tab and closes it, so none can write into a terminal running an agent; run them directly (`obsidian-cli vault=<vault> eval code="eval(require('fs').readFileSync('<abs path>','utf8'))"`) after a restart. `live-test.sh` reloads the plugin, so avoid it.

## Known issues and next steps

- 0.9.0 is released (2026-11-21, pre-release). Before 1.0: real use on a second machine (`make install-release TAG=v0.9.0`, own `data.json`), and any fixes that turns up.
- Fonts: chezmoi installs the four SauceCodePro Nerd Font Mono faces (dotfiles `run_onchange_darwin.sh.tmpl`) and sets `font-family = SauceCodePro Nerd Font Mono`.
- Kitty graphics through libghostty-vt (`ghostty_kitty_graphics_*`, render-state placement iterator) would bring cursor-positioned placements (`a=T`, what `timg -pk` emits) and let `kitty-graphics.ts` go. It needs a synchronous PNG decoder installed with `ghostty_sys_set` (see IMPLEMENTATION.md).
- Selection and key encoding could move to the library too (`ghostty_selection_gesture_*`, `ghostty_key_encoder_*`).
- Two terminals in the same vault, each running `claude --continue`, race over the same session file and render blank. Use "New shell (no Agent)" for the second tab.
- Scroll uses a full repaint instead of shifting canvas pixels.
- Add a font-family setting (size is done) so the Ghostty config doesn't need editing.
- Right-click "Open agent here" in the file tree.
- Keep libghostty-vt current: bump `native/libghostty-vt.env`, run `make test` and the probes, and refresh `THIRD_PARTY_NOTICES.md` if upstream's linked dependencies changed.

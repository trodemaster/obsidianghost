# obsidianghost

Obsidian plugin that embeds an agent terminal (Claude Code, Copilot CLI, or any shell command) using libghostty-vt 1.0 (official WebAssembly build) + node-pty, with a Canvas renderer, inline Kitty images, and vault-aware OSC 8 hyperlink handling.

- [README.md](README.md): install, settings, and user-facing features
- [IMPLEMENTATION.md](IMPLEMENTATION.md): architecture, engine adapter, design notes, and findings/backlog
- [CHANGELOG.md](CHANGELOG.md): release notes (the release workflow publishes the matching section)

This file holds the working state: conventions, toolchain, behavior notes, testing, and next steps. Keep it current. There is no separate handoff document.

## Conventions

- Personal repo: work on a branch and open a PR to `main` only when the work is done. The pushable remote is `origin` (https://github.com/trodemaster/obsidianghost.git).
- **Package management**: this machine uses MacPorts only. Use the `/macports` skill for installing or managing packages (Node.js, etc.); do not suggest or use Homebrew.
- Run `git`/`gh` from inside the repo directory (direnv loads credentials from the shell's cwd).
- Target this machine's OS and architecture (macOS 27, Apple Silicon). The work machine is nearly identical.

## Toolchain

```bash
sudo port install nodejs22 npm10
make doctor      # lists anything missing
make install     # npm ci, fetch wasm, bundle, package, sync to the central plugin dir
make setup-vaults
```

- **libghostty-vt**: the official 1.0.1 WebAssembly release, pinned (version, URL, SHA-256) in `native/libghostty-vt.env`. `make wasm` downloads and verifies it into `native/ghostty-vt.wasm` (gitignored). No Zig, no vendored Ghostty, no C/C++ build. Building it from source would need Zig 0.17 (MacPorts `zig-0.17`), but nothing here does.
- **node-pty**: pinned to 1.1.0 and used through its shipped N-API prebuild; `npm ci --ignore-scripts` skips its node-gyp install script. npm drops the execute bit on `spawn-helper`; `scripts/package.sh` restores it (without it every spawn fails with `posix_spawnp failed`).
- **npm**: MacPorts installs and `sudo npm` leave `~/.npm` root-owned. Never chown it. The Makefile points npm at a repo-local cache (`.cache/npm`).
- **Versions**: semver, 0.x are betas. `manifest.json`, `package.json`, `versions.json` and `CHANGELOG.md` move together; `scripts/package.sh` refuses mismatched versions and the release job refuses a tag that differs from `manifest.json`.
- Make targets: `make help` lists them. `make reinstall` is the fast JS loop; `make test` and `make verify` run without Obsidian.

## CI and releases

`.github/workflows/ci.yml` runs on the self-hosted macOS runners (label from the `OBSIDIANGHOST_RUNNER` repository variable, default `macOS_27`): `make check`, `make test`, `make verify` on every push and PR, and for a `v*` tag `make release-zip` plus `gh release create` (0.x marked pre-release). GitHub registers self-hosted runners per repository for personal accounts, and ghrunnerd registers its runners to blakeports, so this repo uses an on-demand runner: `scripts/ci-runner.sh up` starts the `macos-27` Lima VM on far-star if needed (via `ghrunnerd vm-start`) and runs a second, separate agent in it (`~/actions-runner-obsidianghost`, copied from the VM's `/opt/actions-runner`), registered as `macOS_27-obsidianghost` with the `macOS_27` label; `--once` makes it ephemeral (one job). `scripts/ci-runner.sh down` deregisters it and powers the VM off only if `up` powered it on and the blakeports `macOS_27` runner is idle. `status` shows all three. Queued jobs wait (up to a day) until the runner is up. Sandbox off; `ghrunnerd exec` takes its flags before the VM id. First green run: PR #2, `test` in 55 s.

## Install layout

Central install: `~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`. Each vault symlinks to it (`make setup-vaults`). That directory is tracked in machine-cfg, so commit and push it from the terminal after `make install`. Since 0.9.0 the payload is about 1.5 MB (no node-pty sources or build output); `make install` removes the old `native/` directory there, so commit that deletion too. `make install-release TAG=…` installs a release zip instead of a local build (for example on the work machine, whose machine-cfg has a different upstream).

## Behavior notes

- **Startup**: **Start directory**, **Shell**, and **Agent start command** are settings. The agent command is stored per computer in `data.json` (`agentCommands`, keyed by the short lowercase host name), because the plugin folder and its `data.json` can be shared between machines through machine-cfg; a pre-0.9 `startupCommand` migrates to the first computer that loads it. Blank Shell resolves to `/opt/local/bin/bash` (MacPorts bash 5) if present, else `/bin/bash`. Blank agent command = plain shell at the vault root; there is no built-in agent command (set `claude --continue` for Claude Code). Right-click the ghost ribbon icon, or use **+**, for "New shell (no Agent)". The plugin ID stays `obsidian-claude-ghostty`.
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
- `npm run test:images -- <vault>` and `npm run test:rendering -- <vault>` run isolated probes against a running Obsidian without reloading existing tabs. Set `GHOSTTY_METRICS_FILE` to compare against a real Ghostty measurement (see the README).
- `scripts/obsidian-ui.sh` (repo skill `obsidian-ui`): drives the real app through AppleScript/System Events — opens a throwaway shell-only tab, types real keystrokes into it (refusing if anything else has focus), pastes Unicode, captures the bytes sent to the pty, reads the screen and screenshots the window. Sandbox off; needs Accessibility and Screen Recording.
- `scripts/live-test.sh <probe.js> [vault]` rebuilds, hot-reloads the plugin, opens a shell-only terminal, and evals a probe from `scripts/tests/`. Reloading the plugin ends embedded terminal sessions.

Status on 2026-11-21 (branch `libghostty-1.0`, v0.9.0, libghostty-vt 1.0.1 wasm, macOS 27.2):

- `make test`: pass, 27 of 27. `make verify`: pass (payload complete, packaged wasm passes, packaged node-pty spawns a 91×27 pty).
- `make check`: tsc and esbuild clean.
- Live in Obsidian (`orac`, after `make install` and an Obsidian restart): the plugin reports `Loaded libghostty-vt 1.0.1 (wasm)`; `test:rendering` pass, 31 of 31; `test:images` pass, 19 of 19.
- Claude Code session checked by eye (screenshots): tables, code, CJK, box drawing and the status line render correctly. That check found the grapheme bug (👩‍💻/🇺🇸/👍🏽 split), now fixed and confirmed in `orac` after a restart with `scripts/obsidian-ui.sh`.
- Settings probes in `orac` (run directly with `obsidian-cli vault=orac eval`, no reload): `startup-command.js` pass, 15 of 15 (its `daneel` check skips where that wrapper is absent); `font-size.js` pass, 7 of 7. Neither writes `data.json`.
- `osc8-links`, `plain-url-links`, `shift-enter`, `session-title`, `drag-drop`: pass in `orac`. Every live probe now opens its own shell-only tab and closes it, so none can write into a terminal running an agent; run them directly (`obsidian-cli vault=<vault> eval code="eval(require('fs').readFileSync('<abs path>','utf8'))"`) after a restart. `live-test.sh` reloads the plugin, so avoid it.

## Known issues and next steps

- Open the PR for `libghostty-1.0`.
- Register a self-hosted runner to this repo (ghrunnerd) so CI can run; then tag `v0.9.0` after merging.
- Fonts: chezmoi installs the four SauceCodePro Nerd Font Mono faces (dotfiles `run_onchange_darwin.sh.tmpl`) and sets `font-family = SauceCodePro Nerd Font Mono`.
- Kitty graphics through libghostty-vt (`ghostty_kitty_graphics_*`, render-state placement iterator) would bring cursor-positioned placements (`a=T`, what `timg -pk` emits) and let `kitty-graphics.ts` go. It needs a synchronous PNG decoder installed with `ghostty_sys_set` (see IMPLEMENTATION.md).
- Selection and key encoding could move to the library too (`ghostty_selection_gesture_*`, `ghostty_key_encoder_*`).
- Two terminals in the same vault, each running `claude --continue`, race over the same session file and render blank. Use "New shell (no Agent)" for the second tab.
- Scroll uses a full repaint instead of shifting canvas pixels.
- Add a font-family setting (size is done) so the Ghostty config doesn't need editing.
- Right-click "Open agent here" in the file tree.
- Keep libghostty-vt current: bump `native/libghostty-vt.env`, run `make test` and the probes, and refresh `THIRD_PARTY_NOTICES.md` if upstream's linked dependencies changed.

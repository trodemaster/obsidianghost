# Handoff - obsidianghost

As of 2026-08-06.

## Repository State

- Canonical repo: https://github.com/blake_adobe/obsidianghost (not accessible from this machine — blake_adobe is a GitHub Enterprise account)
- PR remote: https://github.com/trodemaster/obsidianghost (pushable from this machine; use for occasional upstream PRs)
- Local remotes: only `origin`, pointing to `https://github.com/trodemaster/obsidianghost.git` (the `trodemaster`/`blake_adobe` remote *names* mentioned above don't actually exist as separate git remotes on this machine — `git push origin main` is what works)
- Branch: `main`, tracking `origin/main`
- Working tree: clean as of this commit. Builds clean (`npm run build`); synced to the machine-cfg plugin dir via `make reinstall`. `npx tsc --noEmit` reports a pre-existing, unrelated error (`document.fonts.add` — stale `lib.dom.d.ts` typing, predates this session); esbuild bundling is unaffected.

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
- **Clickable links, Cmd/Ctrl+click (verified live in daneel vault)**: matches real Ghostty/iTerm2's convention — links only light up (underline + pointer cursor + tooltip) while Cmd (or Ctrl) is held, so a bare click stays free for normal terminal interaction (text selection, cursor positioning). Covers both OSC 8 hyperlinks (`findOsc8LinkAt`, via `vt.hyperlinkAt`) and plain-text URLs Claude Code (or any CLI) prints as bare text (`findPlainUrlLinkAt`, regex-based over `dumpViewportRow` output, trims trailing sentence punctuation/unmatched closing brackets). `handleScreenClick` requires the modifier on the click event itself, not just a stale hover, to avoid opening a link the modifier was released on. A `window`-level keydown/keyup listener (`handleLinkModifierChange`) re-evaluates hover immediately on Cmd/Ctrl press or release even without mouse movement, matching real terminal feel. **Note**: this changed existing OSC 8 behavior — links previously opened on a bare click; they now require the modifier too, for consistency with the new plain-URL links.
- Font loads from `~/.config/ghostty/config` (`font-family` + `font-size`). PostScript name resolved to file path by filesystem search; loaded via FontFace with base64 data URI. Internal CSS name `GhosttyTerminalFont` assigned to avoid system name resolution. Currently: `SauceCodeProNerdFontMono-Regular` at 18px.
- Row height from `fontBoundingBoxAscent + fontBoundingBoxDescent` (font's native line box, no extra leading).
- Ribbon icon (ghost) in left sidebar toggles the terminal.
- **Tab title and view header both uplevel Claude Code's own session descriptor (verified live in daneel vault)**: both are driven by `getDisplayText()`, which returns `sessionTitle` — starts as `"Claude"`, updated live by `parseOscTitleFromStream()`/`setSessionTitle()` from OSC 0/2 terminal-title sequences (Claude Code sets these to its auto-generated or `/rename`d session topic — the exact same text it shows in its own status line, prefixed there with 🏷️ instead of the spinner/sparkle it uses for the terminal title). **Neither DOM target syncs with `getDisplayText()` automatically** — this shipped broken (JS-side `sessionTitle` updated correctly, but the visible tab and header both stayed frozen on "Claude") and needed two separate explicit fixes, since they're two different pieces of undocumented API surface (present at runtime on Obsidian 1.13.4, not in `obsidian.d.ts`, so both are accessed through a cast): `(this.leaf as unknown as {updateHeader?: () => void}).updateHeader?.()` refreshes the tab strip label; `(this as unknown as {titleEl?: HTMLElement}).titleEl?.setText(...)` refreshes the header bar above the terminal content (that one is framework-set only once, at initial view creation, never again). Confirmed via `scripts/tests/session-title.js` + screenshot: after driving a real `claude --continue` session, both the tab (`leaf.tabHeaderInnerTitleEl`) and header (`view.titleEl`) show the live session topic (e.g. "✳ Clean bash history and improve ignor…"), not the "Claude" default.
- Cmd+J closes the terminal leaf while it's focused (`handleKeyDown`); a "Toggle terminal" command is also registered (bindable to any hotkey via Obsidian's own hotkey settings). The `IMPLEMENTATION.md` work-item list still lists "Cmd+J toggle" as outstanding — that's stale, this already works.
- **Text selection + clipboard (verified live in daneel vault)**: mouse-drag selects a cell range (`selectionAnchor`/`selectionFocus`), painted as a translucent overlay (`drawSelection()`) tinted from Ghostty's `selection-background` theme key (falls back to theme fg @ 35% alpha if absent). Auto-copies to the system clipboard on mouseup after a real drag (via Electron's `clipboard` module, not the web Clipboard API — avoids permission-prompt issues). Cmd+C re-copies the current selection. A plain click (no drag) is left alone so link-opening still works; `didDragSelect` suppresses the link-click handler only when a real drag just happened. Confirmed via `screenshot-window` + manual drag: highlight renders correctly across wrapped lines, and the pasted clipboard content matched the selection exactly (trimmed per-line, multi-line joined).
- **Shift+Enter inserts a newline instead of submitting (verified live)**: `handleKeyDown` now sends `\x1b\r` (ESC+CR) for Shift+Enter instead of bare `\r` — the same convention real Ghostty/iTerm2/Kitty/WezTerm ship as a default keybinding, which Node's own `readline` keypress parser decodes as `meta+return` (an ESC prefix always means "meta" to it, regardless of the actual key). Claude Code's CLI already treats `meta+return` as "insert newline" — no terminal-specific config or native protocol (Kitty keyboard protocol / CSI u) needed, since our plugin owns the keydown→byte path directly rather than going through a real terminal's own keybinding layer. Also identifies the spawned shell as real Ghostty: `env.TERM_PROGRAM="ghostty"`, `env.TERM_PROGRAM_VERSION="1.3.1"`, and pty `name: "xterm-ghostty"` (node-pty derives `env.TERM` from `name`, clobbering any `env.TERM` set directly — see the comment at the `spawnPty` call in `main.ts`). The `xterm-ghostty` terminfo entry is already installed system-wide by the Ghostty app, so ncurses-based programs (vim, tmux, etc.) resolve it fine. Confirmed by launching the real `claude` CLI inside the pty and driving it via `scripts/live-test.sh scripts/tests/shift-enter.js` (see "Live Testing Loop" below) — pressing Shift+Enter left `line one` / `line two` as two lines in the same unsent input box.
- **Drag and drop, files and images (verified live in daneel vault)**: dropping one or more files onto the terminal (`handleDragOver`/`handleDrop` on `screenEl`) resolves each to its POSIX path via Electron's `webUtils.getPathForFile` (the modern replacement for the deprecated `File.path`; this Obsidian's Electron 43 has it), shell-single-quotes each path (escaping embedded `'` as `'\''`), and writes them space-joined to the pty — inserted as text, not submitted, same as paste. No inline image rendering: Claude Code reads image paths straight out of the prompt text, so writing the path is all that's needed. A `.is-drag-over` CSS class gives a subtle accent-color inset border while dragging over the terminal. `require("electron")` is wrapped in try/catch — same reason as the clipboard `require` in `copyToClipboard` above: esbuild only leaves an unresolvable `require()` in the bundle as-is (deferred to runtime) when it's inside a try/catch; otherwise it's a bundle-time error, since `"electron"` isn't in `esbuild.config.cjs`'s `external` list.
- **Auto-launch `claude --continue`, configurable start directory, shell-only escape hatch, auto-close on exit (verified live in daneel vault)**: every new terminal spawns the shell and immediately writes `claude --continue\r` to it (falls back to a fresh session gracefully if there's no prior Claude Code history for that directory — no need to detect that ourselves). `cwd` comes from `GhosttyPlugin.getStartDirectory()` — a new per-vault `startDirectory` setting (empty = vault root; supports absolute, `~`-prefixed, or vault-relative paths), editable via a new `GhosttySettingTab` (`PluginSettingTab`). Right-clicking the ghost ribbon icon, or the in-view "+" ("New terminal") button, opens a `Menu` with "New Claude session" / "New shell (no Claude)" — the latter sets a one-shot `pendingShellOnly` flag on the plugin, consumed by `GhosttyTerminalView.startSession()` via `consumeShellOnlyFlag()` (always `false` for leaves Obsidian restores from a saved layout, so restored terminals default to continuing). `IPty.onExit` closes the tab (`this.leaf.detach()`) on a *natural* shell exit (exit Claude, then exit the shell — Claude runs as a foreground command inside the shell, not replacing it, so both steps are needed); a `intentionallyKilled` flag set right before `stopSession()`'s own `pty.kill()` distinguishes that from a natural exit, so closing the tab yourself doesn't trigger a redundant second detach. **Known sharp edge, not yet mitigated**: opening two terminals in the same vault both auto-continuing collides — both `claude --continue` processes contend over the same session file and the terminals render blank. Discovered via the live-test harness itself doing exactly this by accident (see `scripts/live-test.sh`'s history). No fix implemented yet; workaround is the "New shell (no Claude)" option for a second tab, or running `claude` manually without `--continue` there.

## Latest Visual State

As of 2026-06-12: rendering is functionally complete. Font, colors, density, and palette all match real Ghostty. Claude Code sessions render correctly with vivid Nocturnal Winter palette, proper Nerd Font glyphs, bold/italic, OSC 8 hyperlinks, and table box-drawing characters.

## Known Remaining Issues

- Wide glyph / emoji cell alignment: `rowTextToCells()` uses `Array.from` (codepoint-split, not grapheme-cluster aware). Wide chars need 2-cell treatment.
- Scroll delta pixel-shift optimization: current code forces full repaint on scroll instead of shifting canvas pixels.
- Claude Code UX not yet implemented: right-click "Open Claude here" in the file tree.
- Multiple terminals in the same vault both auto-continuing race over the same Claude Code session file (see "What Works Now" — auto-launch note). No fix implemented; low urgency since "New shell (no Claude)" is available as a workaround for a second tab.
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

## Live Testing Loop

For changes that need to be verified against a *running* Obsidian instance (keyboard/mouse handling, PTY env, terminal rendering) without any screen automation or manual clicking: `obsidian-cli` (ships with Obsidian, talks over `~/.obsidian-cli.sock`) can hot-reload the plugin and `eval` arbitrary JS directly in the app's renderer context — including reaching into a live `GhosttyTerminalView` instance (`view.pty`, `view.inputEl`, `view.vt`), monkey-patching `pty.write` to capture bytes, and dispatching real `KeyboardEvent`s through the actual `handleKeyDown` path. No AppleScript, no `cliclick`, no screen coordinates.

```bash
scripts/live-test.sh scripts/tests/shift-enter.js [vault]   # default vault: daneel
```

`scripts/live-test.sh` runs `make reinstall`, `obsidian-cli plugin:reload`, opens a fresh **shell-only** terminal tab (bypasses the default `claude --continue` auto-launch — a second auto-continuing terminal in the same vault collides with whatever the test script itself launches, see the auto-launch note above), then `eval`s the given JS file and prints its returned value as JSON. Test scripts under `scripts/tests/`:

- `shift-enter.js` — regression probe for the Shift+Enter/TERM_PROGRAM fix above: checks the env vars a spawned shell sees, and the literal bytes written to the pty for Shift+Enter vs. plain Enter.
- `plain-url-links.js` — regression probe for the clickable-plain-URL fix above: prints a URL with trailing punctuation via `printf`, checks `findLinkAt` trims it correctly, and drives real `mousemove`/`click` `MouseEvent`s through `screenEl` (with/without `metaKey`) to confirm hover only engages and `window.open` only fires when the modifier is held.
- `osc8-links.js` — same shape, for OSC 8 hyperlinks. Builds the OSC 8 escape sequence via `printf`'s own `\033` octal-escape parsing (interpreted when the command *runs*, i.e. after Enter) rather than embedding raw ESC bytes in the typed command line — the shell's line editor (zsh's ZLE) treats a literal ESC byte in *typed input* as a meta-key prefix and eats it, silently corrupting the command before it ever executes. (This gotcha only affects test-authoring, not the app itself — the app never types raw escape bytes into the shell.)

- `drag-drop.js` — regression probe for drag-and-drop file/image path insertion: monkey-patches `require("electron").webUtils.getPathForFile` (Node's require cache means this affects the same singleton `handleDrop()` calls into) so synthetic `File`/`DataTransfer`/`DragEvent` objects — which have no real OS-drag path association — can still exercise the real shell-quoting and multi-file-join logic, then checks `.is-drag-over` toggles correctly across `dragover`/`dragleave`/`drop`.
- `claude-continue.js` — regression probe for auto-launch/start-directory/shell-only/auto-close above: opens a default terminal and checks the dump for either the fresh version banner or resumed-session UI chrome (a `--continue` resume won't show the banner — it jumps straight into prior transcript), opens a shell-only terminal and checks no Claude UI appears, temporarily overrides `settings.startDirectory` and checks `pwd` reflects it (restores the original value afterward), and drives the exit-Claude-then-exit-shell sequence to confirm the tab auto-closes. Needed generous wait times (~1.2–1.5s) around the Claude exit sequence — a resumed session with a lot of scrollback takes longer to unwind than a fresh one.

- `session-title.js` — regression probe for the tab/header title-sync fix above: opens a default terminal, checks the rendered `leaf.tabHeaderInnerTitleEl.textContent` and `view.titleEl.textContent` (not just the JS-side `getDisplayText()`, since that's exactly what silently worked while the DOM didn't) both update away from the "Claude" default and match `getDisplayText()` once Claude Code sets a session title.

All six print `pass: true`/`false` as a top-level field for quick scanning.

For end-to-end confidence beyond the byte-level probe, the fix was also verified by having a test script `pty.write("claude\r")`, wait for boot, type text, dispatch a synthetic Shift+Enter, type more text, then `view.vt.dumpViewportRow(n)` across the viewport to confirm the real `claude` CLI's input box showed both lines unsent (rather than submitting on the first). Not committed as a script (slow — needs network/auth, live LLM calls) — see this session's history to recreate if the byte-level probe ever needs re-corroborating against a real `claude` session.

## Recommended Next Steps

1. **Verify build on macOS 26 / aarch64** — run `make native` on a clean tree to confirm the Zig auto-download and xcrun shim work end-to-end.
2. **Verify and fix character density** — measure `charWidth` and `charHeight` from Canvas against what Ghostty computes via CoreText for `SauceCodePro Nerd Font Mono` at 18pt.
3. **Wide glyph support** — `rowTextToCells()` needs grapheme-cluster awareness.
4. **Remove debug logging** — `console.log` in `ensureFontLoaded()` and `getCharSize()`.
5. **Extend the plugin settings panel** — currently just `startDirectory` (see "What Works Now"); add font-family/font-size overrides so users don't have to edit the Ghostty config directly.
6. **Right-click "Open Claude here"** in the file tree. (Cmd+J toggle and `claude --continue` auto-launch already exist — see "What Works Now".)
7. **Fix the multi-terminal `--continue` race** — see "Known Remaining Issues".
8. **Fix stale `document.fonts.add` typing error** — `npx tsc --noEmit` reports `Property 'add' does not exist on type 'FontFaceSet'` at `ensureFontLoaded()`; pre-existing (confirmed present on `main` before this session), doesn't block `esbuild`, but worth tracking down (likely a `lib`/`@types` mismatch in `tsconfig.json`).

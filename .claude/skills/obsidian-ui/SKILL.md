---
name: obsidian-ui
description: Drive the real Obsidian app for obsidianghost test automation — open a throwaway shell-only terminal tab in a vault, send real keystrokes and pastes to it through AppleScript/System Events, read its screen back, capture the bytes sent to the pty, and screenshot the window. Use when testing the plugin end to end in Obsidian (keyboard input, Shift+Enter, dead keys, paste, rendering of real output), when checking a change by eye, or when asked to "type into", "drive", "automate" or "screenshot" the Obsidian terminal.
---

# Driving Obsidian for plugin tests

`scripts/obsidian-ui.sh` combines three channels:

| Channel | Used for |
|---|---|
| `obsidian-cli eval` (unix socket) | opening/closing the test tab, focus, reading the screen, pty byte capture, plugin state |
| AppleScript → System Events | raising the vault's window and sending **real** key events (the browser's whole keydown/IME path) |
| `wincap` (screenshot-window skill) | PNG of the vault's window |

Obsidian has no AppleScript dictionary (`tell application "Obsidian"` only supports activate/quit); everything UI goes through System Events (`process "Obsidian"`, windows titled `<tab> - <vault> - Obsidian <version>`).

The headless and eval-only tests (`make test`, `npm run test:rendering -- <vault>`, `scripts/live-test.sh`) remain the first line. Use this skill for what they cannot reach: real OS key events, focus, paste, and how it looks.

## Prerequisites

- Run every command with the Claude sandbox **disabled**: the CLI socket, System Events (Apple Events) and wincap's ScreenCaptureKit are all blocked inside it.
- Obsidian running with the vault open, the plugin loaded (`make install`), and Settings → General → Advanced → Command line interface enabled.
- Accessibility permission for the app hosting Claude (for System Events keystrokes) and Screen Recording for wincap.
- Keystrokes go to the frontmost app, so the script raises Obsidian and briefly takes focus. Tell the user before a long run.

## Commands

The vault defaults to `orac`; prefix `OBSIDIAN_VAULT=daneel` for another one.

```bash
S=scripts/obsidian-ui.sh
$S info                      # plugin version, engine, terminals (which is the test tab)
$S open                      # new shell-only tab ("New shell (no Agent)"), focused; prints leaf id
$S type 'echo hello'         # real keystrokes, printable ASCII only
$S key return                # also: shift+return ctrl+c ctrl+u cmd+k up down esc tab opt+e ...
$S wait '^hello$' 5          # poll the screen for an extended regex
$S screen                    # visible rows as text
$S paste 'echo 👩‍💻 日本語'     # any Unicode via Cmd+V (clipboard text restored afterwards)
$S capture start; $S key shift+return; $S capture stop    # => "\u001b\r"
$S shot "$TMPDIR/after.png"  # screenshot; then Read the PNG
$S close                     # always close the test tab when done
```

`capture` wraps the view's `pty.write`, so it shows exactly what the plugin sent for a key, independent of what the shell does with it.

## Safety rules

- **Only the test tab receives input.** `open` records its leaf id in the vault window (`globalThis.__ghosttyUiTestLeaf`). Before each `type`, `paste` or `key`, the script refocuses that tab and refuses to send anything unless the vault's window is frontmost, the test tab is the active leaf, and DOM focus is inside it. Never bypass this to type into another terminal: the user's tabs run live agent sessions (for example the `obsidian-session` Claude).
- Do not reload the plugin or the app (`plugin:reload`, `app:reload`, quitting Obsidian) without the user's go-ahead. It ends every embedded terminal session, including the user's. `info` shows what is running.
- `paste` replaces the clipboard for about 0.3 s and restores only its **text**; an image on the clipboard is lost. Prefer `type` and dead keys when the clipboard may matter.
- Close the test tab at the end, even after a failure.

## Gotchas found while building this

- `obsidian-cli` honors `vault=` only **before** the command (`obsidian-cli vault=orac eval code=…`). After it, the option is silently ignored and the focused vault is used.
- System Events `keystroke` cannot type characters outside the keyboard layout: `é` arrives as `a`. That is why `type` rejects non-ASCII. Real users type `é` as a dead key, which tests the IME/composition path: `$S key opt+e e` sends `é`.
- `kind` is a reserved word in AppleScript (`set kind to …` fails with -10006); pass data into AppleScript through `on run argv` (`osascript - args… <<'APPLESCRIPT'`), never by splicing strings into source.
- The window title follows the active tab (`✳ obsidian-session - orac - Obsidian 1.15.1`); match on ` - <vault> - Obsidian`.
- A just-opened tab needs its pty and engine before input; `open` waits for both (up to 5 s).

## Example: check a keyboard fix end to end

```bash
S=scripts/obsidian-ui.sh
make reinstall            # then ask the user to reload the plugin, or do it once they agree
$S open
$S capture start; $S key shift+return; $S capture stop     # expect "\u001b\r"
$S key ctrl+u
$S paste 'echo 👩‍💻 🇺🇸 👍🏽 日本語 café'; $S key return
$S wait '^👩‍💻 🇺🇸 👍🏽 日本語 café' 5
$S shot "$TMPDIR/check.png"   # Read it: each emoji should be one glyph
$S close
```

`screen` returns text, so it proves the characters arrived but not how cells were laid out or drawn: a grapheme split across cells still joins back into the same string. Judge layout from the screenshot, or from `view.vt.dumpViewportRowCells(row)` through `obsidian-cli eval`. Replies to queries (DSR, DECRQM, OSC 10/11) go back to the shell as input rather than onto the screen, so check those in `make test`, not here.

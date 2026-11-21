#!/usr/bin/env bash
# Drive the real Obsidian UI for plugin test automation: raise a vault's window,
# open a dedicated shell-only test terminal, send real keystrokes to it through
# System Events, read its screen back through obsidian-cli, and screenshot it.
#
# Every keystroke goes only to the test terminal this script opened (tracked by
# leaf id inside that vault's window); typing refuses to run if anything else has
# focus, so it never types into a terminal running a real agent session.
#
# Needs, outside the Claude sandbox: Obsidian's CLI enabled (unix socket),
# Accessibility for the calling app (System Events keystrokes), and Screen
# Recording for wincap (screenshots).
#
# Usage: scripts/obsidian-ui.sh <command> [args]   (see `help`)
set -euo pipefail

CLI=${OBSIDIAN_CLI:-/Applications/Obsidian.app/Contents/MacOS/obsidian-cli}
WINCAP=${WINCAP:-$HOME/.claude/skills/screenshot-window/bin/wincap}
PLUGIN_ID=obsidian-claude-ghostty
VIEW_TYPE=ghostty-terminal-view
VAULT=${OBSIDIAN_VAULT:-orac}

die() { echo "obsidian-ui: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/obsidian-ui.sh <command> [args]       (vault: $OBSIDIAN_VAULT, default orac)

  windows                 List Obsidian windows (title, frontmost)
  raise                   Bring the vault's window to the front
  open                    Open a shell-only test terminal tab and focus it; prints its leaf id
  focus                   Focus the test terminal and raise its window
  type TEXT               Type ASCII TEXT into the test terminal as real keystrokes
  paste TEXT              Paste TEXT (any Unicode) with Cmd+V; the clipboard's text is restored after
  key SPEC...             Press keys, e.g. return  shift+return  ctrl+c  cmd+k  up  esc  tab  opt+e
  screen                  Print the test terminal's visible rows (trailing blank rows dropped)
  wait REGEX [SECONDS]    Wait until the screen matches the extended regex (default 10 s)
  capture start|stop      Record the bytes the view writes to the pty; stop prints them as JSON
  info                    Plugin version, engine, and every terminal (pid, title, test or not)
  shot [OUT.png]          Screenshot the vault's window; prints the PNG path
  close                   Close the test terminal

Prefix with OBSIDIAN_VAULT=daneel to target another vault.
EOF
}

# Run JS in the vault's window; prints the value. vault= must come before the
# command, otherwise obsidian-cli silently uses the focused vault.
cli_eval() {
  local out last
  out=$("$CLI" "vault=$VAULT" eval "code=$1" 2>&1) || true
  last=$(printf '%s\n' "$out" | tail -n 1)
  case "$last" in
    "=> "*) printf '%s\n' "${last#=> }" ;;
    *) die "obsidian-cli eval failed: $out" ;;
  esac
}

# JS prelude: the test leaf, or an error string the caller turns into a failure.
JS_LEAF="const id = globalThis.__ghosttyUiTestLeaf;
  const leaf = id && app.workspace.getLeafById(id);
  if (!leaf || leaf.view?.getViewType?.() !== '$VIEW_TYPE') return 'ERR no test terminal; run: scripts/obsidian-ui.sh open';
  const view = leaf.view;"

check() { # check <value>: fail on an ERR result, else print it
  case "$1" in ERR\ *) die "${1#ERR }" ;; *) printf '%s\n' "$1" ;; esac
}

osa() { osascript - "$@"; }

raise_window() {
  osa "$VAULT" <<'APPLESCRIPT'
on run argv
  set needle to " - " & (item 1 of argv) & " - Obsidian"
  tell application "System Events"
    if not (exists process "Obsidian") then error "Obsidian is not running" number 1
    tell process "Obsidian"
      set frontmost to true
      repeat with w in windows
        if name of w contains needle then
          perform action "AXRaise" of w
          delay 0.2
          return name of w
        end if
      end repeat
    end tell
  end tell
  error "no Obsidian window for vault " & (item 1 of argv) number 1
end run
APPLESCRIPT
}

front_window() {
  osa <<'APPLESCRIPT'
tell application "System Events"
  set p to process "Obsidian"
  if not (frontmost of p) then return ""
  return name of window 1 of p
end tell
APPLESCRIPT
}

focus_test() {
  check "$(cli_eval "(async () => { $JS_LEAF
    app.workspace.setActiveLeaf(leaf, { focus: true });
    view.focusInput();
    await new Promise((r) => setTimeout(r, 100));
    return id; })()")" >/dev/null
  raise_window >/dev/null
}

# Refuse to type unless the vault's window is frontmost and the test terminal
# owns keyboard focus inside it.
guard() {
  local front
  front=$(front_window)
  [[ "$front" == *" - $VAULT - Obsidian"* ]] || die "the $VAULT window is not frontmost (front: '${front:-another app}')"
  check "$(cli_eval "(() => { $JS_LEAF
    if (app.workspace.activeLeaf !== leaf) return 'ERR test terminal is not the active leaf';
    if (!document.hasFocus()) return 'ERR the $VAULT window does not have focus';
    if (!view.containerEl.contains(document.activeElement)) return 'ERR focus is not in the test terminal';
    return 'ok'; })()")" >/dev/null
}

paste_text() {
  osa "$1" <<'APPLESCRIPT'
on run argv
  set saved to missing value
  try
    set saved to the clipboard as text
  end try
  set the clipboard to (item 1 of argv)
  tell application "System Events" to keystroke "v" using {command down}
  delay 0.3
  if saved is not missing value then set the clipboard to saved
end run
APPLESCRIPT
}

send_keys() { # send_keys text <string> | send_keys key <spec>
  osa "$@" <<'APPLESCRIPT'
on run argv
  set sendKind to item 1 of argv
  set payload to item 2 of argv
  tell application "System Events"
    if sendKind is "text" then
      keystroke payload
      return
    end if
    set AppleScript's text item delimiters to "+"
    set parts to text items of payload
    set AppleScript's text item delimiters to ""
    set mods to {}
    repeat with i from 1 to (count parts) - 1
      set m to item i of parts
      if m is "shift" then
        set end of mods to shift down
      else if m is "ctrl" or m is "control" then
        set end of mods to control down
      else if m is "alt" or m is "opt" or m is "option" then
        set end of mods to option down
      else if m is "cmd" or m is "command" then
        set end of mods to command down
      else
        error "unknown modifier: " & m number 1
      end if
    end repeat
    set k to last item of parts
    set codes to {{"return", 36}, {"enter", 76}, {"tab", 48}, {"space", 49}, {"backspace", 51}, ¬
      {"delete", 117}, {"esc", 53}, {"escape", 53}, {"left", 123}, {"right", 124}, ¬
      {"down", 125}, {"up", 126}, {"home", 115}, {"end", 119}, {"pageup", 116}, {"pagedown", 121}}
    repeat with c in codes
      if (item 1 of c) is k then
        key code (item 2 of c) using mods
        return
      end if
    end repeat
    if (count k) is not 1 then error "unknown key: " & k number 1
    keystroke k using mods
  end tell
end run
APPLESCRIPT
}

screen_rows() {
  local json
  json=$(check "$(cli_eval "(() => { $JS_LEAF
    const rows = [];
    for (let r = 0; r < view.viewportSize.rows; r++) rows.push(view.vt.dumpViewportRow(r));
    while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
    return JSON.stringify(rows); })()")")
  node -e 'for (const r of JSON.parse(process.argv[1])) console.log(r)' "$json"
}

cmd=${1:-help}
[ $# -gt 0 ] && shift

case "$cmd" in
  windows)
    osa <<'APPLESCRIPT'
tell application "System Events" to tell process "Obsidian"
  set out to ""
  repeat with w in windows
    set out to out & name of w & linefeed
  end repeat
  return out & "frontmost: " & (frontmost as text)
end tell
APPLESCRIPT
    ;;
  raise)
    raise_window
    ;;
  open)
    id=$(check "$(cli_eval "(async () => {
      const plugin = app.plugins.getPlugin('$PLUGIN_ID');
      if (!plugin) return 'ERR plugin $PLUGIN_ID is not loaded in $VAULT';
      const before = new Set(app.workspace.getLeavesOfType('$VIEW_TYPE'));
      await plugin.openNewTerminal(undefined, { shellOnly: true });
      const leaf = app.workspace.getLeavesOfType('$VIEW_TYPE').find((l) => !before.has(l));
      if (!leaf) return 'ERR no new terminal leaf appeared';
      for (let i = 0; i < 50 && !(leaf.view.pty && leaf.view.vt); i++) await new Promise((r) => setTimeout(r, 100));
      if (!leaf.view.pty) return 'ERR terminal opened but its shell did not start';
      globalThis.__ghosttyUiTestLeaf = leaf.id;
      return leaf.id; })()")")
    focus_test
    echo "$id"
    ;;
  focus)
    focus_test
    ;;
  type)
    [ $# -ge 1 ] || die "usage: type TEXT"
    # System Events keystroke maps characters outside the keyboard layout to wrong
    # keys (é arrives as "a"); use paste, or dead keys (key opt+e e) for real input.
    LC_ALL=C grep -q '[^ -~]' <<<"$*" && die "type takes printable ASCII only; use paste for other text"
    focus_test; guard
    send_keys text "$*"
    ;;
  paste)
    [ $# -ge 1 ] || die "usage: paste TEXT"
    focus_test; guard
    paste_text "$*"
    ;;
  key)
    [ $# -ge 1 ] || die "usage: key SPEC..."
    focus_test; guard
    for spec in "$@"; do send_keys key "$spec"; sleep 0.05; done
    ;;
  screen)
    screen_rows
    ;;
  wait)
    [ $# -ge 1 ] || die "usage: wait REGEX [SECONDS]"
    deadline=$((SECONDS + ${2:-10}))
    while :; do
      if screen_rows | grep -Eq -- "$1"; then exit 0; fi
      [ $SECONDS -lt $deadline ] || { screen_rows >&2; die "timed out waiting for /$1/"; }
      sleep 0.3
    done
    ;;
  capture)
    case "${1:-}" in
      start)
        check "$(cli_eval "(() => { $JS_LEAF
          if (!view.__uiWrite) {
            view.__uiWrite = view.pty.write.bind(view.pty);
            view.pty.write = (d) => { view.__uiCapture.push(String(d)); return view.__uiWrite(d); };
          }
          view.__uiCapture = [];
          return 'capturing'; })()")"
        ;;
      stop)
        check "$(cli_eval "(() => { $JS_LEAF
          const data = (view.__uiCapture || []).join('');
          if (view.__uiWrite) { view.pty.write = view.__uiWrite; delete view.__uiWrite; }
          delete view.__uiCapture;
          return JSON.stringify(data); })()")"
        ;;
      *) die "usage: capture start|stop" ;;
    esac
    ;;
  info)
    cli_eval "(() => {
      const p = app.plugins.getPlugin('$PLUGIN_ID');
      const test = globalThis.__ghosttyUiTestLeaf;
      return JSON.stringify({
        vault: app.vault.getName(), plugin: p?.manifest.version ?? null, engine: p?.nativeState?.message ?? null,
        terminals: app.workspace.getLeavesOfType('$VIEW_TYPE').map((l) => ({
          id: l.id, title: l.view.getDisplayText?.(), pid: l.view.pty?.pid ?? null,
          test: l.id === test, active: app.workspace.activeLeaf === l })),
      }); })()"
    ;;
  shot)
    out=${1:-${TMPDIR:-/tmp}/obsidian-$VAULT-$(date +%Y%m%d-%H%M%S).png}
    raise_window >/dev/null
    result=$("$WINCAP" capture --app Obsidian --title " - $VAULT - Obsidian" --out "$out")
    node -e 'const r = JSON.parse(process.argv[1]); if (r.error) { console.error(JSON.stringify(r)); process.exit(1); } console.log(r.path)' "$result"
    ;;
  close)
    check "$(cli_eval "(() => { $JS_LEAF
      leaf.detach(); delete globalThis.__ghosttyUiTestLeaf; return 'closed'; })()")"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2; exit 2
    ;;
esac

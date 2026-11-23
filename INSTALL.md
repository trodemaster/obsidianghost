---
name: install-obsidianghost
description: Install or upgrade the obsidianghost Obsidian plugin (Agent Ghostty Terminal, id obsidian-claude-ghostty) on a Mac from a GitHub release — check prerequisites, download and verify the release zip, place it in the plugin folder without touching settings, link it into vaults, enable it, set this computer's agent command and font size, and verify it loads. Use when asked to install, set up, update, upgrade, reinstall or uninstall obsidianghost / Agent Ghostty Terminal on macOS.
---

# Install or upgrade obsidianghost on a Mac

Instructions for an agent. Follow the steps in order and run the commands yourself; stop and ask where a step says so. Section [Upgrade](#upgrade) covers a machine that already has the plugin.

The plugin ships as a release zip (`obsidian-claude-ghostty-<version>.zip`) containing one folder, `obsidian-claude-ghostty/`, ready to use: `main.js`, `manifest.json`, `styles.css`, `ghostty-vt.wasm` (the terminal engine), node-pty's macOS binary under `node_modules/`, and license files. Nothing is compiled, and no Node or npm is needed.

## Ground rules

- **macOS on Apple Silicon only** (`uname -sm` = `Darwin arm64`), Obsidian 1.12.0 or newer. Stop on anything else.
- **Packages come from MacPorts** (`sudo port install …`). Never use or suggest Homebrew.
- **Never touch `data.json`** in the plugin folder: it holds this computer's settings. Never commit it to git.
- **Ask before** turning off Obsidian's Restricted mode, enabling the plugin, and quitting or restarting Obsidian (a restart ends every terminal session running in it, including agent sessions). Do not reload the plugin or the app instead of restarting; a full quit and reopen is the supported way to load a new build.
- **Agent sandboxes**: the Obsidian CLI talks over a unix socket and node-pty needs a real pty, so in a sandboxed agent (Claude Code) run the CLI and verification commands with the sandbox disabled.
- The repository is `trodemaster/obsidianghost`. If it is private, `gh` must be signed in to an account that can read it (`gh auth status`).

## 1. Check the machine

```bash
uname -sm                                                   # must be: Darwin arm64
sw_vers -productVersion
/Applications/Obsidian.app/Contents/MacOS/obsidian-cli version 2>/dev/null \
  || defaults read /Applications/Obsidian.app/Contents/Info.plist CFBundleShortVersionString
command -v gh unzip shasum rsync
gh auth status
```

- Obsidian missing or older than 1.12.0: ask the user to install or update it (obsidian.md), then continue.
- `gh` missing: `sudo port install gh`, then `gh auth login` (interactive: ask the user to run it, e.g. `! gh auth login` in Claude Code).
- `rsync` and `shasum` ship with macOS; `unzip` too.

List the vaults Obsidian knows, and **ask the user which vaults should get the plugin**:

```bash
plutil -extract vaults json -o - "$HOME/Library/Application Support/obsidian/obsidian.json" \
  | python3 -c 'import json,sys; [print(v["path"]) for v in json.load(sys.stdin).values()]' 2>/dev/null \
  || grep -o '"path":"[^"]*"' "$HOME/Library/Application Support/obsidian/obsidian.json"
```

## 2. Choose the plugin folder

The plugin lives in one folder; each vault either contains it or links to it. If the user keeps their plugins in a central folder outside the vaults, use that as `PLUGIN_DIR` and link every vault to it (step 5).

- Install into the first chosen vault,
  `PLUGIN_DIR=<vault>/.obsidian/plugins/obsidian-claude-ghostty`, and link any other chosen vaults to it (step 5). Vaults sharing one folder share settings; if the user wants separate settings per vault, repeat steps 4–5 with a separate `PLUGIN_DIR` per vault instead.

If `<vault>/.obsidian/plugins/obsidian-claude-ghostty` already exists, this is an upgrade: see [Upgrade](#upgrade) and keep using that folder (follow the symlink with `readlink` if it is one).

## 3. Download and verify the release

```bash
REPO=trodemaster/obsidianghost
TAG=$(gh release list --repo "$REPO" --limit 1 --json tagName --jq '.[0].tagName')   # newest, pre-releases included
WORK=$(mktemp -d "${TMPDIR:-/tmp}/obsidianghost.XXXXXX")
gh release download "$TAG" --repo "$REPO" --pattern 'obsidian-claude-ghostty-*.zip' --dir "$WORK"
ZIP=$(printf '%s\n' "$WORK"/obsidian-claude-ghostty-*.zip | head -n 1)   # a glob, not ls: ls is often aliased

# The zip's SHA-256 must match the digest GitHub recorded for the asset.
want=$(gh release view "$TAG" --repo "$REPO" --json assets \
  --jq '.assets[] | select(.name | startswith("obsidian-claude-ghostty-")) | .digest' | sed 's/^sha256://')
have=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
[ "$want" = "$have" ] && echo "zip verified" || echo "CHECKSUM MISMATCH: stop"

unzip -q "$ZIP" -d "$WORK"
PAYLOAD="$WORK/obsidian-claude-ghostty"

# The engine must match the hash pinned in the tagged source.
pinned=$(gh api "repos/$REPO/contents/native/libghostty-vt.env?ref=$TAG" \
  -H 'Accept: application/vnd.github.raw' | sed -n 's/^VT_WASM_SHA256=//p')
[ "$(shasum -a 256 "$PAYLOAD/ghostty-vt.wasm" | cut -d' ' -f1)" = "$pinned" ] \
  && echo "engine verified" || echo "ENGINE MISMATCH: stop"
grep '"version"' "$PAYLOAD/manifest.json"
```

Stop on any mismatch. Install a specific version by setting `TAG=v0.9.0` instead of looking up the newest. Tell the user that 0.x releases are betas.

## 4. Put the files in place

The same commands install and upgrade. They never touch `data.json`, and they replace `node_modules/node-pty` wholesale so no stale files remain.

```bash
PLUGIN_DIR=...   # from step 2
mkdir -p "$PLUGIN_DIR"
rsync -a --exclude data.json --exclude node_modules "$PAYLOAD/" "$PLUGIN_DIR/"
mkdir -p "$PLUGIN_DIR/node_modules"
rsync -a --delete "$PAYLOAD/node_modules/node-pty" "$PLUGIN_DIR/node_modules/"
chmod 755 "$PLUGIN_DIR/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
rm -rf "$PLUGIN_DIR/native"                       # leftover of 0.1.x builds
xattr -dr com.apple.quarantine "$PLUGIN_DIR" 2>/dev/null || true
ls "$PLUGIN_DIR"
```

Expected: `LICENSE  THIRD_PARTY_NOTICES.md  ghostty-vt.wasm  main.js  manifest.json  node_modules  styles.css` (plus `data.json` if the plugin was configured before).

## 5. Link the vaults

For each chosen vault whose plugin folder is not `PLUGIN_DIR` itself:

```bash
VAULT=...        # vault path
target="$VAULT/.obsidian/plugins/obsidian-claude-ghostty"
mkdir -p "$VAULT/.obsidian/plugins"
if [ -L "$target" ]; then echo "already linked -> $(readlink "$target")"
elif [ -e "$target" ]; then echo "a real folder is already there: ask the user before replacing it"
else ln -s "$PLUGIN_DIR" "$target" && echo "linked $target"; fi
```

## 6. Enable the plugin

**Ask the user first**: enabling means turning off Restricted mode (if it is on), which lets this vault run community plugins.

- **By hand** (always works): Obsidian → **Settings → Community plugins** → turn off Restricted mode → enable **Agent Ghostty Terminal**.
- **With the Obsidian CLI** (needs **Settings → General → Advanced → Command line interface** turned on, and Obsidian running with the vault open). Pass `vault=` **before** the command; after it, the CLI silently uses whichever vault has focus.

  ```bash
  CLI=/Applications/Obsidian.app/Contents/MacOS/obsidian-cli
  NAME=$(basename "$VAULT")      # the vault's name
  "$CLI" vault="$NAME" eval code="(async () => {
    await app.plugins.setEnable(true);
    await app.plugins.loadManifests();
    if (!app.plugins.plugins['obsidian-claude-ghostty']) await app.plugins.enablePluginAndSave('obsidian-claude-ghostty');
    return app.plugins.getPlugin('obsidian-claude-ghostty')?.manifest.version ?? 'not loaded';
  })()"
  ```

## 7. Restart Obsidian

Ask the user to quit Obsidian completely (`Cmd+Q`) and open it again, or to let you do it. Check first whether terminals are running; quitting ends them:

```bash
"$CLI" vault="$NAME" eval code="app.workspace.getLeavesOfType('ghostty-terminal-view').map(l => l.view.getDisplayText()).join(', ') || 'no terminals'"
```

Repeat for each open vault; tell the user which terminals would close.

With the user's go-ahead: `osascript -e 'tell application "Obsidian" to quit'`, wait until `pgrep -x Obsidian` finds nothing, then `open -a Obsidian`.

## 8. Settings for this computer

Ask the user what the terminal should start (for example `claude --continue`, `copilot`, or a wrapper script; blank = a plain shell) and whether they want a font size other than Ghostty's `font-size`. Both are stored per computer.

- **By hand**: **Settings → Community plugins → Agent Ghostty Terminal**: Start directory, Shell, Font size, Agent start command.
- **With the CLI**: put the command in as a JSON string literal (escape `\` and `"`):

  ```bash
  "$CLI" vault="$NAME" eval code="(async () => {
    const p = app.plugins.getPlugin('obsidian-claude-ghostty');
    await p.setAgentCommand(\"claude --continue\");   // the user's command
    // await p.setFontSize(16);                       // optional; null = Ghostty's size
    return JSON.stringify({ agent: p.agentCommand(), fontSize: p.terminalFont.size });
  })()"
  ```

Font family and colors come from `~/.config/ghostty/config` (`font-family`, `theme`, `palette`); the plugin works without that file, using a monospace fallback and Obsidian's colors.

## 9. Verify

```bash
"$CLI" vault="$NAME" eval code="(async () => {
  const p = app.plugins.getPlugin('obsidian-claude-ghostty');
  if (!p) return 'plugin not loaded';
  const s = await p.getNativeState(true);
  return JSON.stringify({ version: p.manifest.version, engine: s.message, agent: p.agentCommand(), fontSize: p.terminalFont.size });
})()"
```

Expected: the release's version and `engine: "Loaded libghostty-vt <x.y.z> (wasm)"`. Then ask the user to click the ghost icon in the left ribbon: a terminal opens at the vault root (or the start directory) and runs the agent command. Without the CLI, that click is the whole check.

Clean up: `rm -rf "$WORK"`.

## Upgrade

1. Find what is installed and what is available:
   ```bash
   grep '"version"' "$PLUGIN_DIR/manifest.json"
   gh release list --repo trodemaster/obsidianghost --limit 5
   ```
   If the installed version is current, stop and say so.
2. Read the release notes between the two versions (`gh release view <tag> --repo trodemaster/obsidianghost`) and tell the user what changes, especially anything under **Changed** or **Removed**.
3. Run steps 3 and 4 with the plugin's existing folder as `PLUGIN_DIR` (for a symlinked vault: `PLUGIN_DIR=$(readlink <vault>/.obsidian/plugins/obsidian-claude-ghostty)`). Settings in `data.json` are kept.
4. Restart Obsidian (step 7, with the user's go-ahead), then verify (step 9).

**From 0.1.x** (before 0.9.0, which replaced the native engine with WebAssembly):
- Step 4 removes the old `native/ghostty_vt.node` and the old node-pty build; a full restart is required so Obsidian drops the old native module.
- 0.1.x had a single **Startup command** for all computers. 0.9.0 turns it into this computer's **Agent start command** the first time it loads; check it in step 8 and set it on each other computer.
- Nothing has to be rebuilt after Obsidian updates any more.

**From a source checkout instead of a release** (developers): `git pull && make install` in the repo, then restart Obsidian. `make install-release TAG=<tag>` installs a release into the central folder from a checkout.

## Uninstall

Ask first. Disable the plugin in **Settings → Community plugins**, quit Obsidian, then remove each vault's `.obsidian/plugins/obsidian-claude-ghostty` (a symlink or folder) and, if nothing links to it any more, the central folder. Removing the folder also removes its `data.json` settings.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Plugin not listed in Community plugins | The vault's `.obsidian/plugins/obsidian-claude-ghostty` link or folder is missing or broken (`ls -la`); fix it and restart Obsidian. |
| "libghostty-vt not found" in the terminal tab | `ghostty-vt.wasm` is missing from `PLUGIN_DIR`: redo step 4. |
| `posix_spawnp failed` | `chmod 755 "$PLUGIN_DIR/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"` |
| "Failed to load node-pty" | `node_modules/node-pty` is incomplete: redo step 4. If macOS blocked the binary, run the `xattr` line from step 4. |
| CLI commands hit the wrong vault | Put `vault=<name>` before the command (`obsidian-cli vault=<vault> eval …`). |
| CLI says it cannot connect | Turn on **Settings → General → Advanced → Command line interface**; in a sandboxed agent, run it with the sandbox disabled. |
| Old version still running after the files changed | Obsidian was reloaded, not restarted: quit with `Cmd+Q` and reopen. |
| Emoji or box characters look wrong | Set a real font family in `~/.config/ghostty/config` (for example `font-family = SauceCodePro Nerd Font Mono`), then restart Obsidian. |

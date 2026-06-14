# obsidianghost

Obsidian plugin that embeds a Claude Code terminal using libghostty-vt (native N-API) + node-pty, with a Canvas renderer and vault-aware OSC 8 hyperlink handling.

## Project Docs

- [IMPLEMENTATION.md](IMPLEMENTATION.md) — full development spec and work items
- [HANDOFF.md](HANDOFF.md) — current status, build/install notes, and next steps

## Fresh Clone Setup

```bash
make install
```

Downloads Zig 0.15.2 (aarch64), builds `ghostty_vt.node` and `pty.node` for Electron 39, and syncs everything to the central plugin dir (`~/Developer/machine-cfg/obsisian/plugins/obsidian-claude-ghostty/`).

Set up vault symlinks (idempotent):

```bash
make setup-vaults
```

## Development Loop

```bash
make reinstall          # rebuild JS and sync — use this on every TypeScript change
make reinstall-runtime  # rebuild JS + sync current native binaries
make native             # rebuild ghostty_vt.node (Zig source changed)
make pty                # rebuild pty.node (node-pty source/Electron bump)
make check              # type-check + bundle
npm run dev             # esbuild watch mode
```

After syncing JS, reload in Obsidian via `Cmd+P` → "Reload app without saving".  
After syncing a new `.node` file, disable/enable the plugin or restart Obsidian.

# obsidianghost

Obsidian plugin that embeds a Ghostty-backed terminal.

## Project Docs

- [IMPLEMENTATION.md](IMPLEMENTATION.md) - full development spec and work items.
- [HANDOFF.md](HANDOFF.md) - current status, known rendering issues, build/install notes, and resume steps.

## Development

The fast development loop is:

```bash
make reinstall
```

That rebuilds `main.js` and syncs only `manifest.json`, `styles.css`, and
`main.js` into the local vault plugin directory. It intentionally skips native
rebuilds.

Use the fuller targets when the runtime pieces change:

```bash
make reinstall-runtime   # sync current native addon and node-pty too
make install             # rebuild native addon + node-pty, then sync everything
make check               # type-check and bundle
```

The default vault is `/Users/blake/Developer/orac`. Override it when needed:

```bash
make reinstall VAULT=/path/to/vault
```

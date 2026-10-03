# Plan: Cmd/Ctrl+click on bare file-path references to open them in Obsidian

Status: **research complete, not yet implemented.** Written without touching the running
plugin (no build, no `make reinstall`, no `plugin:reload`) per explicit instruction, since
the plugin was in active use during this research session.

## Problem

When Claude Code edits, reads, or references a file, it prints the path in its own output
— e.g. `pmm_ci_terraform_current_state.md` or `project/issue.md` — visually distinguished
from surrounding prose (a different foreground color). These aren't currently clickable in
the terminal. Goal: Cmd/Ctrl+click one of these tokens and have Obsidian open that file in
the editor, the same way Cmd/Ctrl+click already works for URLs and OSC 8 hyperlinks.

## Key research finding: these are NOT OSC 8 hyperlinks

Confirmed live, read-only, against the user's actual running session (no plugin reload —
just querying the already-loaded `GhosttyTerminal` instance's existing VT buffer via
`vt.hyperlinkAt()`):

```
token: "pmm_ci_terraform_current_state.md"  →  hyperlinkAt: null
token: "CI.md"                              →  hyperlinkAt: null
token: "uci_secret_sharing_challenge_2026h2.md" → hyperlinkAt: null
```

So `findOsc8LinkAt()` (`main.ts:1085`) will never match these — Claude Code's own terminal
renderer applies plain ANSI SGR color styling to path-like tokens in prose, not a real
OSC 8 `\x1b]8;;URI\x1b\\...` wrapper. Confirmed via `dumpViewportRowStyleRuns()`: the path
token rendered at fg `0xB1B9F9` (light lavender-blue) vs. `0xE6E5E5` for surrounding prose
text, both with `flags: 0` (no bold/underline/italic) — a pure color distinction, most
likely Claude's markdown-renderer code-span/path styling, not a clickable-link primitive.

This also means: static analysis of the `claude` binary's bundled hyperlink-related strings
(`supportsHyperlinks`, a `Yg(text, href, {supportsHyperlinks})` OSC-8-wrapping helper used
for *markdown links* in prose, and ripgrep's own bundled `--hyperlink` flag for its Grep
tool) turned up real OSC 8 machinery elsewhere in the binary, but not for these
tool-output file-path mentions specifically — consistent with the live `hyperlinkAt: null`
result above. **Don't go looking for an OSC-8-based shortcut here; there isn't one.**

## The good news: nearly everything downstream already exists

This plugin already has a full "resolve a bare/relative path against the vault and open it
in the editor" pipeline, built for OSC 8 vault-file links and exercised today. Look at
`openHyperlink()` (`main.ts:1428`):

```ts
private async openHyperlink(uri: string): Promise<void> {
  const trimmed = uri.trim();
  if (!trimmed) return;
  if (/^https?:\/\//i.test(trimmed)) {
    window.open(trimmed, "_blank");
    return;
  }
  const target = this.resolveVaultTarget(trimmed);   // <-- this already handles bare paths
  ...
  const leaf = this.app.workspace.getLeaf("tab");
  await leaf.openFile(file, { active: true, eState: ... });
  ...
}
```

`resolveVaultTarget()` (`main.ts:1462`) → `uriToPathLike()` (`main.ts:1486`) already:
- Passes through any string with no URI scheme prefix unchanged (a bare path like
  `project/issue.md` has no `scheme:` prefix, so it's returned as-is).
- Handles `file://` URIs too, decoding the pathname.
- Rejects other schemes (`mailto:`, etc.) by returning `null`.

`extractPathLocation()` (`main.ts:1502`) already strips a trailing `:line` or `:line:col`
suffix (e.g. `file.py:42:7`) for jump-to-line support.

`getVaultPathCandidates()` (`main.ts:1520`) already tries, in order: the path as-is
(vault-root-relative), and — if that doesn't resolve — relative to the *currently active
file's directory* (`this.app.workspace.getActiveFile()`). Absolute paths inside the vault's
filesystem base path get converted to vault-relative first.

**Conclusion: `openHyperlink()`'s vault-resolution logic needs zero changes** — a bare
relative path found in terminal output and handed to it already resolves correctly, with
optional line/column positioning. It *does* need one small change to *where* it opens the
result — see "Pane targeting" below, discovered from a real UX complaint hitting the exact
same underlying API this function already uses. The main missing piece is still
*detecting* that a given hovered cell is sitting on top of one of these path-like tokens in
plain text — the existing three-tier hover chain (`main.ts:1081`) just needs a fourth tier:

```ts
private findLinkAt(col: number, row: number): HoveredLink | null {
  return (
    this.findOsc8LinkAt(col, row) ??
    this.findPlainUrlLinkAt(col, row) ??
    this.findVaultPathLinkAt(col, row)          // <-- new
  );
}
```

## New work: `findVaultPathLinkAt()`

Model directly on the existing `findPlainUrlLinkAt()` (`main.ts:1108`), which already
establishes the pattern: regex-scan the row's plain text (via the same
`rowTextToCells(vt.dumpViewportRow(row - 1), cols).join("")` used everywhere else), find
the match spanning the hovered column, return a `HoveredLink`.

**One meaningful difference from the URL matcher: existence-check before highlighting.**
Any `https://...`-looking string is presumed clickable — there's nothing to validate. A
bare path is different: plenty of dotted tokens in prose *aren't* file references (version
numbers, decimal values, code identifiers). To avoid lighting up things that aren't really
files, `findVaultPathLinkAt()` should call the *already-synchronous* `resolveVaultTarget()`
(no `await` anywhere in that call chain today — confirmed by re-reading it) on each regex
candidate and only return a `HoveredLink` if it actually resolves to a real `TFile`. This
turns the highlight into "real, clickable path" by construction, at basically zero added
runtime cost (`app.vault.getAbstractFileByPath()` is an in-memory index lookup, not disk
I/O — safe to call on every hover recompute, no caching needed).

### Regex design

Something in this shape — permissive enough to catch `project/issue.md`,
`pmm_ci_terraform_current_state.md`, `src/main.ts`, optionally with a trailing
`:line[:col]`:

```ts
const VAULT_PATH_REGEX = /\b[\w.\-][\w.\-/]*\.(md|ts|tsx|js|jsx|json|py|go|rs|rb|sh|yaml|yml|toml|txt|css|html)(?::\d+(?::\d+)?)?\b/gi;
```

The extension allowlist keeps false-positive surface area small (a plain word followed by
a stray period won't match). It can grow over time — it's a precision knob, not a
correctness requirement, since the existence check is what actually gates clickability.

### Function sketch

```ts
private findVaultPathLinkAt(col: number, row: number): HoveredLink | null {
  if (!this.vt) return null;
  const { cols } = this.viewportSize;
  const rowText = this.rowTextToCells(this.vt.dumpViewportRow(row - 1), cols).join("");

  VAULT_PATH_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VAULT_PATH_REGEX.exec(rowText))) {
    const startIdx = match.index;
    const endIdx = startIdx + match[0].length;
    if (col - 1 < startIdx || col - 1 >= endIdx) continue;
    if (!this.resolveVaultTarget(match[0])) continue; // not a real file — skip, don't highlight
    return { uri: match[0], row, startCol: startIdx + 1, endCol: endIdx + 1 };
  }
  return null;
}
```

No changes needed to `handleMouseMove`, `handleLinkModifierChange`, `handleScreenClick`,
`drawHoveredLink`, or the link tooltip — all of that is already generic over any
`HoveredLink`, regardless of which tier produced it.

## Pane targeting: don't open the note next to the terminal

Real-world evidence this matters: asking Claude Code (running *inside* our terminal) to
"open secrets management in obsidian" — via `obsidian-cli open`, a separate tool, not this
plugin — landed the new note tab in the terminal's own split, because Obsidian's default
"new tab" behavior joins whichever pane was *most recently active*, and that was the
terminal (the user had just been typing into it). The user wanted it in the main editor
area instead, dragging it there manually as a workaround.

`openHyperlink()` (`main.ts:1449`, inside the function reviewed above) has the *identical*
exposure, using the exact same default-joins-active-pane Obsidian primitive:

```ts
const leaf = this.app.workspace.getLeaf("tab");   // joins whatever's currently active
```

If a user Cmd/Ctrl-clicks a file-path link while the terminal has input focus (the normal
case — you're reading Claude's output, which is why you're hovering a link over it), the
opened note would land right back in the terminal's split. Same bug, different trigger.

**Fix**: before calling `getLeaf("tab")`, prefer joining an *existing markdown-note leaf's*
tab group instead of whatever's merely "active" — same pattern `openNewTerminal()`
(`main.ts`, `GhosttyPlugin`) already uses in reverse (it anchors new terminal tabs to an
*existing terminal leaf* specifically, not just "the active leaf", for the same reason).

```ts
const workspace = this.app.workspace;
const anchor = workspace.getLeavesOfType("markdown").at(-1);
if (anchor) {
  workspace.setActiveLeaf(anchor, { focus: false });
}
const leaf = workspace.getLeaf("tab");
```

Falls back to today's behavior (join whatever's active) only if there's no existing note
leaf anywhere — nothing better to target in that edge case. Verified API exists via
`obsidian.d.ts`: `Workspace.getLeavesOfType(viewType: string): WorkspaceLeaf[]` and
`Workspace.setActiveLeaf(leaf, options)` (both already used elsewhere in this file).
`Workspace.getMostRecentLeaf(root?: WorkspaceParent)` was also considered — it takes a root
to scope the search, which looked promising for "the main editor area only" — but the
terminal's own split lives inside `workspace.rootSplit` too (it's created via
`getLeaf("split", "horizontal")` off the main area, not a sidebar), so scoping by root
wouldn't actually exclude it. Targeting by view type (`"markdown"`) is the more direct fix.

**Separately, not in this plugin's scope**: `obsidian-cli`'s own `open` command doesn't
document a pane-targeting flag (`--help` shows only a bare `newtab`), unlike its
`daily`/`daily:append` commands which document `paneType=tab|split|window`. Worth trying
`paneType=split` against `open` speculatively (it may share undocumented plumbing), or
raising it as a gap with whoever maintains that tool — but that's a separate CLI, not code
in this repo.

## Known limitations / non-goals for v1

- **Paths containing spaces** (e.g. `Unified CI.md`, seen live in this research) won't
  match `\S`-based tokenization. Could special-case by also trying to extend the match
  across a small number of embedded spaces and re-checking existence, but that's real
  complexity for a rare case — defer unless it turns out to matter in practice.
- **Files that don't exist yet** (Claude proposing a new filename) are intentionally *not*
  clickable — there's nothing to open. This is a feature of the existence-check design,
  not a bug to fix.
- **Color-based detection was considered and rejected for v1.** Cross-referencing the
  `0xB1B9F9`-ish highlight color via `dumpViewportRowStyleRuns()` was tempting (it's
  literally the signal a human eye uses), but it's fragile across themes/Claude Code
  versions, and the existing `findPlainUrlLinkAt()` doesn't use style data either — staying
  consistent with that precedent (pure text regex + validation) is simpler and more robust.
  Revisit only if the plain regex approach produces too many false negatives in practice.

## Testing plan (for whenever it's safe to reload the plugin)

Same pattern as the existing `scripts/tests/plain-url-links.js` / `osc8-links.js`: write a
`scripts/tests/vault-path-links.js` that
1. `printf`s a line containing the relative path of a real file already in the vault
   (e.g. `HANDOFF.md`) into the terminal, since that guarantees `resolveVaultTarget()`
   succeeds.
2. Dispatches a real `mousemove` + `click` `MouseEvent` on `screenEl` with/without
   `metaKey`, same harness pattern as the other two link tests.
3. Confirms `window.open`/`leaf.openFile` isn't called without the modifier, and that
   `app.workspace.getActiveFile()?.path` matches the target file after a Cmd-click.
4. Also test the negative case: a made-up path that doesn't exist should produce
   `hoveredLink: null` even with the modifier held (no highlight, since it's not a real
   file) — this is the behavior the existence check exists for.
5. Pane-targeting regression: with a terminal leaf active/focused and at least one other
   markdown leaf already open elsewhere, Cmd-click a valid path link and confirm the
   opened note's leaf is *not* in the same tab group (`leaf.parent`) as the terminal's.

**Do not run this via `scripts/live-test.sh` (which does `make reinstall` +
`plugin:reload`, swapping the live plugin instance) while the user is actively relying on
the running terminal.** Run it in a session where that disruption is acceptable.

## Files to touch when implementing

- `main.ts`: add `VAULT_PATH_REGEX` constant (near `PLAIN_URL_REGEX`, `main.ts:56`), add
  `findVaultPathLinkAt()` (near `findPlainUrlLinkAt()`, `main.ts:1108`), extend
  `findLinkAt()` (`main.ts:1081`) to add the third tier, and fix the pane-targeting in
  `openHyperlink()` (`main.ts:1449`) per the "Pane targeting" section above — this last
  part isn't specific to vault-path links, it'll also improve existing OSC 8 vault-file
  link behavior, so it's worth doing regardless of ship order.
- `scripts/tests/vault-path-links.js` (new): live regression test, per above.
- `HANDOFF.md`: add to "What Works Now" once verified live, following the existing
  writeup style for the other two link tiers.

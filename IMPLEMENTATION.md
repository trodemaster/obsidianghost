# Obsidian Plugin for libghostty — Development Spec

## Links

- [ghostty-org/ghostty](https://github.com/ghostty-org/ghostty) — Ghostty terminal emulator source
- [Build a plugin – Obsidian Docs](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin) — official plugin dev guide
- [awesome-libghostty](https://github.com/Uzaaft/awesome-libghostty) — curated index of libghostty projects (501 stars)
- [ghostling](https://github.com/ghostty-org/ghostling) — official reference terminal emulator built on libghostty-vt
- [Libghostty Is Coming – Mitchell Hashimoto](https://mitchellh.com/writing/libghostty-is-coming) — architectural vision and roadmap
- [ComputelessComputer/obsidian-ghostty](https://github.com/ComputelessComputer/obsidian-ghostty) — reference implementation (community-listed, early scaffold)
- [obsidianmd/obsidian-releases PR #10046](https://github.com/obsidianmd/obsidian-releases/pull/10046) — community plugin registry merge
- [derek-larson14/obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar) — direct inspiration: what we're building a better version of

## Goal

Build a better **obsidian-claude-sidebar** — a sidebar terminal for Claude Code embedded in Obsidian — replacing its xterm.js + Python PTY bridge with libghostty-vt (native N-API) + node-pty. The result should render Claude Code sessions with full richness: 24-bit color, bold/italic, scrollback, and clickable OSC 8 hyperlinks for file paths that open directly in the Obsidian vault.

### What obsidian-claude-sidebar does (the baseline)

- Embeds a full PTY terminal (xterm.js) in Obsidian's sidebar
- Spawns Claude Code (or other CLIs) via a Python PTY bridge (`terminal_pty.py`)
- Supports multiple tabs, right-click context menu to open Claude in a folder/file path
- Base64-embeds Python scripts inside `main.js` and writes them to disk at runtime

### Its limitations (what we're fixing)

| Limitation | Our fix |
|---|---|
| Requires Python 3 installed | node-pty — no Python dependency |
| xterm.js renders ANSI but doesn't understand it | libghostty-vt parses VT correctly, exposes typed cell data |
| No clickable file paths | OSC 8 hyperlink hit-testing → open in Obsidian vault |
| Claude output is raw terminal, no Obsidian integration | Vault-aware link handler; paths open as Obsidian notes |
| Session lost on Obsidian restart | PTY session persistence via `claude --continue` |
| Stale Python process management | node-pty handles process lifecycle cleanly |

---

## Prior Art

| | ComputelessComputer | obsidian-claude-sidebar | lavs9 |
|---|---|---|---|
| Terminal engine | libghostty-vt (N-API) | xterm.js | libghostty-vt (WASM) |
| PTY | node-pty (native) | Python bridge | Python bridge |
| Renderer | plain text dump (incomplete) | xterm.js (full) | WASM + Python |
| Clickable links | No | No | No |
| Claude Code focus | No | Yes | No |
| Community listed | Yes | Yes | No |
| Electron target | 37.6.0 (stale) | unknown | N/A |

We are combining ComputelessComputer's terminal engine with obsidian-claude-sidebar's Claude Code UX focus, and adding the renderer and link handling that neither has.

---

## Tech Stack

| Component | Tool | Notes |
|---|---|---|
| Package manager | **npm** | Standard; reference repo uses bun but npm works fine |
| Native lib build | **Zig** (latest stable) | Builds libghostty-vt static lib |
| libghostty | **latest Ghostty release** | Vendored or via MacPorts port |
| N-API addon | **node-gyp** + node-addon-api | C++ wrapper over libghostty-vt C API |
| Electron target | **39.x** (Obsidian 1.11) | Reference repo hardcoded 37.6.0 — must update |
| PTY | **node-pty** | Rebuilt against Electron 39 headers; replaces Python bridge |
| Bundler | **esbuild** | Bundles TS → main.js |
| Language | **TypeScript** | Plugin + renderer |
| Obsidian API | **latest** (1.11) | Reference repo pinned to 1.5.7 — must update |
| Platform | **macOS only** | `isDesktopOnly: true`; libghostty-vt macOS/Linux, node-pty no Windows PTY |

### MacPorts Dependencies

Only one MacPorts dependency: **`zig`** — already available at 0.16.0.

```
sudo port install zig
```

libghostty-vt is built from vendored Ghostty source as part of `npm run build:native` — no system-wide install needed. The static `libghostty_vt.a` is linked directly into `ghostty_vt.node` and never installed separately.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│               Obsidian (Electron 39)             │
│  ┌────────────────────────────────────────────┐  │
│  │           ClaudeTerminalView               │  │
│  │            (ItemView, TypeScript)          │  │
│  │                                            │  │
│  │  ┌─────────────┐   ┌────────────────────┐  │  │
│  │  │   Canvas    │   │  Hyperlink         │  │  │
│  │  │   Renderer  │   │  Hit-tester        │  │  │
│  │  │   (TS)      │   │  → open in vault   │  │  │
│  │  └──────┬──────┘   └────────┬───────────┘  │  │
│  │         │                   │              │  │
│  │  ┌──────▼───────────────────▼───────────┐  │  │
│  │  │       ghostty_vt.node (N-API)        │  │  │
│  │  │       C++ wrapper → libghostty_vt.a  │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │  node-pty → claude / shell PTY       │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## libghostty-vt API Surface

### C API (`ghostty_vt.h`)

```c
// Terminal lifecycle
ghostty_vt_terminal_t ghostty_vt_terminal_new(uint16_t cols, uint16_t rows);
void                  ghostty_vt_terminal_free(terminal);
void                  ghostty_vt_terminal_set_default_colors(terminal, fg_r,g,b, bg_r,g,b);

// Input
int  ghostty_vt_terminal_feed(terminal, bytes, len);
int  ghostty_vt_terminal_resize(terminal, cols, rows);

// Scrollback
int  ghostty_vt_terminal_scroll_viewport(terminal, delta_lines);
int  ghostty_vt_terminal_scroll_viewport_top(terminal);
int  ghostty_vt_terminal_scroll_viewport_bottom(terminal);

// Cursor
bool ghostty_vt_terminal_cursor_position(terminal, col_out, row_out);

// Plain text — used in reference impl, discards all style data
ghostty_vt_bytes_t ghostty_vt_terminal_dump_viewport(terminal);
ghostty_vt_bytes_t ghostty_vt_terminal_dump_viewport_row(terminal, row);

// ── Rich data — not yet exposed in reference N-API addon ────────────────────

// Per-cell styles: packed CellStyle[cols] — 8 bytes per cell
ghostty_vt_bytes_t ghostty_vt_terminal_dump_viewport_row_cell_styles(terminal, row);

// Style runs (efficient): packed StyleRun[] — adjacent same-style cells collapsed
ghostty_vt_bytes_t ghostty_vt_terminal_dump_viewport_row_style_runs(terminal, row);

// Dirty rows: u16[] of row indices changed since last call
ghostty_vt_bytes_t ghostty_vt_terminal_take_dirty_viewport_rows(terminal, rows);

// Scroll delta since last call
int32_t ghostty_vt_terminal_take_viewport_scroll_delta(terminal);

// OSC 8 hyperlink URI at cell — null if none (Claude Code uses this for file paths)
ghostty_vt_bytes_t ghostty_vt_terminal_hyperlink_at(terminal, col, row);
```

### Data structures

```c
struct CellStyle {           // 8 bytes, one per cell column
  uint8_t fg_r, fg_g, fg_b; // foreground RGB, resolved from 256-color palette
  uint8_t bg_r, bg_g, bg_b; // background RGB, resolved
  uint8_t flags;             // 0x01 inverse  0x02 bold    0x04 italic
                             // 0x08 underline 0x10 faint  0x20 invisible
                             // 0x40 strikethrough
  uint8_t reserved;
};

struct StyleRun {            // 12 bytes, variable count per row
  uint16_t start_col;        // inclusive
  uint16_t end_col;          // exclusive
  uint8_t  fg_r, fg_g, fg_b;
  uint8_t  bg_r, bg_g, bg_b;
  uint8_t  flags;            // same bitset
  uint8_t  reserved;
};
```

---

## Work Items

### 1. MacPorts ✅

- [x] `sudo port install zig` — 0.16.0 already available, no custom port needed
- [x] No MacPorts port for libghostty — built from vendored source at `npm run build:native`
- **Note:** Zig 0.16.0 (MacPorts) does NOT build Ghostty v1.3.1 — `std.Io` / `std.posix` breaking changes. Pinned to **Zig 0.15.2** (latest in the 0.15.x line) at `vendor/zig/0.15.2/`. Ghostty's 0.16 migration is in-progress for v1.4.0 (issue #12228). Upgrade path: re-vendor Ghostty v1.4.0 + bump `minimum_zig_version` to 0.16.

### 2. Fork and Update Reference Repo ✅

- [x] Copied (not forked) ComputelessComputer/obsidian-ghostty
- [x] Update vendored Ghostty from `v1.2.3` → `v1.3.1`
- [x] Pinned Zig 0.15.2 (see note in §1); `build.zig.zon` sets `minimum_zig_version = "0.15.2"`
- [x] Update Electron target: `37.6.0` → `39.8.3` in all build scripts
- [x] Rebuilt node-pty against Electron 39.8.3 / ABI 140
- [x] Updated `obsidian` devDep to 1.12.x types
- [x] Removed `bootstrap-zig.mjs`; `build-ghostty-vt.mjs` resolves pinned `vendor/zig/0.15.2/zig`
- [x] `libghostty_vt.a` (4.3 MB) + `ghostty_vt.node` (988 KB) build clean
- [x] Plugin installed and live in `/Users/blake/Developer/orac/.obsidian/plugins/obsidian-claude-ghostty/`
- [x] Gate passed: live shell renders in vault, viewport dump confirms prompt

### 3. Expand N-API Addon (`ghostty_vt.cc`) ✅

- [x] `dumpViewportRowStyleRuns(row: number): Buffer` — 12 bytes/StyleRun
- [x] `takeDirtyViewportRows(totalRows: number): Buffer` — 2 bytes/row (u16 LE indices)
- [x] `takeViewportScrollDelta(): number`
- [x] `hyperlinkAt(col: number, row: number): string | null`
- [x] `setDefaultColors(fg: number, bg: number): void` — 0xRRGGBB args, unpacked in C++
- [x] `ghostty.ts` updated: new method types + `StyleRun` type + `parseStyleRuns()` + `parseDirtyRows()` helpers
- [x] Gate passed: all 5 methods verified live in Obsidian eval (`styleRunsByteLen=12`, `dirtyRowsByteLen=4`, etc.)

### 4. Canvas Renderer

Replace `<pre>` + `dumpViewport()` plain text with a Canvas 2D renderer:

- [ ] Measure monospace char dimensions once on init; remeasure on resize
- [ ] Each frame: call `takeDirtyViewportRows()` → only repaint changed rows
- [ ] Per dirty row: fetch text (`dumpViewportRow`) + style runs (`dumpViewportRowStyleRuns`)
- [ ] Zip text characters with style runs → `fillText` per run with `fillRect` background
- [ ] Apply flags: bold → `font-weight: bold`, italic → `font-style: italic`, underline/strikethrough → `strokeLine`
- [ ] Handle scroll delta via `takeViewportScrollDelta()` → shift canvas without full repaint
- [ ] Cursor: overlay block cursor at `cursorPosition()` coords

### 5. Hyperlink Hit-Testing (the Claude Code integration piece)

- [ ] `mousemove`: convert pixel (x,y) → (col, row); call `hyperlinkAt()` → show pointer + underline
- [ ] `click`: resolve URI type:
  - `file:///path/to/file` or bare path → `app.vault.getAbstractFileByPath()` → open as Obsidian note or reveal in file explorer
  - `https://` / `http://` → `window.open()` in default browser
  - Relative paths (e.g. `src/foo.ts:42`) → resolve against vault root or active file
- [ ] Show URI in a tooltip or status bar on hover

### 6. Claude Code UX (from obsidian-claude-sidebar)

- [ ] Default launch command: `claude` (configurable in plugin settings)
- [ ] Right-click file/folder in Obsidian file tree → "Open Claude here" → spawn terminal with `cwd` set to that path
- [ ] Cmd+J (or configurable) to toggle terminal panel
- [ ] On vault open: optionally auto-launch Claude with `claude --continue` to resume last session
- [ ] Plugin settings: shell command, default cwd, font size, color theme defaults

### 7. Theme Integration

- [ ] Read Obsidian CSS variables `--text-normal`, `--background-primary` for default fg/bg
- [ ] Pass to `ghostty_vt_terminal_set_default_colors()` on init
- [ ] Observe theme changes → re-pass colors + trigger full repaint

### 8. Distribution

Native `.node` files can't ship via the community store's `main.js`-only constraint.

- **Phase 1 (dev/personal):** build locally via `npm run build:native:electron`. MacPorts port handles libghostty-vt. Document as developer install.
- **Phase 2 (community store):** evaluate runtime-download model — per-ABI ZIP from GitHub Releases (O-Terminal pattern). Requires maintaining builds for each Electron ABI as Obsidian updates.

---

## Build Flow (target state)

```bash
# Prerequisites (once)
sudo port install zig             # Zig 0.16.0 — compiler for libghostty_vt.a

# Project setup (once)
npm install
npm run build:native:electron     # zig build → libghostty_vt.a → node-gyp → ghostty_vt.node
npm run build:pty:electron        # rebuild node-pty against Electron 39 headers

# Development
npm run dev                       # watch + rebuild main.js on change

# Production
npm run build
```

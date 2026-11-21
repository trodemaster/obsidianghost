# Changelog

All notable changes to this plugin. Versions follow [Semantic Versioning](https://semver.org/);
0.x releases are betas, and 1.0 will mark the first stable release.

## [0.9.0] - 2026-11-21

First beta on libghostty-vt 1.0, the first release of Ghostty's terminal engine
with a stable C ABI.

### Changed

- The terminal engine is now the official libghostty-vt 1.0.1 WebAssembly build
  (`ghostty-vt.wasm`), downloaded from release.files.ghostty.org and checked
  against a pinned SHA-256. It replaces the custom Zig wrapper, the C++ N-API
  addon and the vendored Ghostty `main` snapshot.
- Building needs only Node and npm. Zig, Python, node-gyp and the Xcode
  command line tools are no longer required, and nothing is rebuilt when
  Obsidian updates its Electron version.
- node-pty uses its shipped N-API prebuild, and the installed copy shrinks from
  about 63 MB to about 400 KB.
- Query replies (colors, cursor and status reports, DEC modes, device
  attributes) come from libghostty-vt itself. The Ghostty theme palette is set as
  the terminal's default palette, so OSC 104 resets to it.
- The caret follows the cursor visibility the program sets (DECTCEM), as in
  Ghostty.
- Grapheme clustering (DEC mode 2027) is on by default, as in Ghostty. Emoji
  sequences such as 👩‍💻, 🇺🇸 and 👍🏽 now take one wide cell in Claude Code instead
  of splitting and losing parts.

### Added

- **Font size** setting, per computer, applied to open terminals immediately.
  Blank keeps using `font-size` from the Ghostty config.
- **Agent start command** setting, stored per computer (by host name), so one
  plugin folder shared between machines can start a different agent or wrapper
  on each. It replaces **Startup command**; an existing value becomes this
  computer's command.
- `make test`: headless adapter tests that run in plain Node.
- `make verify`, `make release-zip` and `make install-release TAG=…`, plus a CI
  workflow for the self-hosted macOS runners that publishes tagged releases.
- `THIRD_PARTY_NOTICES.md`, covering libghostty-vt, the libraries compiled into
  it, and node-pty.

### Removed

- `make native` and `make pty`, `binding.gyp`, `native/ghostty_vt/`, `vendor/`.

## [0.1.0] - 2026-10-03

Modernized build on Ghostty `main` with Zig 0.16 (see git history).

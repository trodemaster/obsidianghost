SHELL := /bin/bash

# ── plugin identity ───────────────────────────────────────────────────────────
PLUGIN_ID  := obsidian-claude-ghostty
PLUGIN_DIR := $(HOME)/Developer/machine-cfg/obsisian/plugins/$(PLUGIN_ID)

THEME_NAME := Nocturnal Winter
THEME_DIR  := $(HOME)/Developer/machine-cfg/obsisian/themes/$(THEME_NAME)

# Obsidian vaults that get symlinks into the central plugin and theme dirs
VAULTS := $(HOME)/orac $(HOME)/daneel

# ── Zig 0.15.2 ───────────────────────────────────────────────────────────────
# Zig 0.16 breaks Ghostty v1.3.1 (uucode std.Io API change). Pinned at 0.15.2.
ZIG           := $(CURDIR)/vendor/zig/0.15.2/zig
ZIG_CACHE_DIR := $(CURDIR)/.zig-cache
ZIG_SHIM_DIR  := $(CURDIR)/.zig-shim
# Shim prepended to PATH so Zig's xcrun --show-sdk-path probe gets MacOSX15.4
# instead of macOS 26 SDK name which Zig 0.15 doesn't recognise.
ZIG_BUILD_ENV := PATH=$(ZIG_SHIM_DIR):$$PATH ZIG_GLOBAL_CACHE_DIR=$(ZIG_CACHE_DIR)

RSYNC        := rsync -a
RSYNC_DELETE := rsync -a --delete

# Stamp guards npm install so it only runs once (until node_modules is wiped).
# --ignore-scripts skips node-pty's postinstall node-gyp (wrong runtime target).
# Native addons are built explicitly via `make native` and `make pty`.
STAMP := node_modules/.install-stamp

.DEFAULT_GOAL := help

.PHONY: help print-vars deps check build native pty install reinstall \
        reinstall-runtime sync-plugin sync-native sync-node-pty \
        setup-vaults setup-themes clean dev ensure-plugin-dir

help:
	@printf '%s\n' \
		'Targets:' \
		'  make install            Fresh-clone setup: npm install + native + pty + sync all' \
		'  make reinstall          Fast loop: build JS and sync manifest/styles/main.js' \
		'  make reinstall-runtime  Sync JS plus current native addon and node-pty payload' \
		'  make setup-vaults       Create plugin symlinks in orac and daneel vaults' \
		'  make setup-themes       Create Nocturnal Winter theme symlinks in orac and daneel vaults' \
		'  make check              Type-check and build the plugin bundle' \
		'  make native             Rebuild libghostty-vt + ghostty_vt.node for Obsidian Electron' \
		'  make pty                Rebuild node-pty for Obsidian Electron' \
		'  make dev                Run esbuild in watch mode' \
		'' \
		'Variables:' \
		'  PLUGIN_DIR=/path        Default: $(PLUGIN_DIR)'

print-vars:
	@printf 'PLUGIN_ID=%s\nPLUGIN_DIR=%s\nVAULTS=%s\nZIG=%s\n' \
		"$(PLUGIN_ID)" "$(PLUGIN_DIR)" "$(VAULTS)" "$(ZIG)"

$(STAMP):
	npm install --ignore-scripts
	touch $@

deps: $(STAMP)

check:
	npx tsc --noEmit
	npm run build

build:
	npm run build

# ── Zig toolchain ─────────────────────────────────────────────────────────────

$(ZIG):
	mkdir -p $(dir $@)
	curl -L https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz \
	  | tar xJ --strip-components=1 -C $(dir $@)

# Fake xcrun that returns MacOSX15.4 SDK path for Zig 0.15 on macOS 26.
$(ZIG_SHIM_DIR)/xcrun: Makefile
	mkdir -p $(ZIG_SHIM_DIR)
	printf '#!/bin/bash\nif [[ "$$*" == *"--show-sdk-path"* ]]; then\n  echo /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk\n  exit 0\nfi\nexec /usr/bin/xcrun "$$@"\n' > $@
	chmod +x $@

# ── native addon ──────────────────────────────────────────────────────────────

native: $(STAMP) $(ZIG) $(ZIG_SHIM_DIR)/xcrun
	cd native/ghostty_vt/zig && \
	  $(ZIG_BUILD_ENV) $(ZIG) build -Doptimize=ReleaseFast --prefix ../zig-out
	rm -rf /tmp/zig-extract && mkdir /tmp/zig-extract
	(cd /tmp/zig-extract && ar -x $(CURDIR)/native/ghostty_vt/zig-out/lib/libghostty_vt.a)
	chmod 644 /tmp/zig-extract/*.o
	ar -rcs $(CURDIR)/native/ghostty_vt/zig-out/lib/libghostty_vt.a /tmp/zig-extract/*.o
	./node_modules/.bin/node-gyp rebuild \
	  --runtime=electron --target=39.8.3 --dist-url=https://electronjs.org/headers
	cp build/Release/ghostty_vt.node native/ghostty_vt.node

# ── node-pty ─────────────────────────────────────────────────────────────────

pty: $(STAMP)
	npm_config_devdir=/tmp/node-gyp npm run build:pty:electron

# ── install ──────────────────────────────────────────────────────────────────

install: $(STAMP) build native pty sync-plugin sync-native sync-node-pty

reinstall: build sync-plugin

reinstall-runtime: build sync-plugin sync-native sync-node-pty

sync-plugin: ensure-plugin-dir
	$(RSYNC) manifest.json styles.css main.js "$(PLUGIN_DIR)/"

sync-native: ensure-plugin-dir
	$(RSYNC) native/ghostty_vt.node "$(PLUGIN_DIR)/native/"

sync-node-pty: ensure-plugin-dir
	$(RSYNC_DELETE) node_modules/node-pty "$(PLUGIN_DIR)/node_modules/"

ensure-plugin-dir:
	install -d "$(PLUGIN_DIR)" "$(PLUGIN_DIR)/native" "$(PLUGIN_DIR)/node_modules"

# ── vault symlinks ────────────────────────────────────────────────────────────

setup-vaults:
	@for v in $(VAULTS); do \
	  target=$$v/.obsidian/plugins/$(PLUGIN_ID); \
	  if [ -L "$$target" ]; then \
	    printf 'skip  %s (symlink exists)\n' "$$target"; \
	  elif [ -e "$$target" ]; then \
	    printf 'WARN  %s exists but is not a symlink — skipping\n' "$$target"; \
	  else \
	    ln -s "$(PLUGIN_DIR)" "$$target" && printf 'link  %s\n' "$$target"; \
	  fi; \
	done

setup-themes:
	@for v in $(VAULTS); do \
	  target="$$v/.obsidian/themes/$(THEME_NAME)"; \
	  if [ -L "$$target" ]; then \
	    printf 'skip  %s (symlink exists)\n' "$$target"; \
	  elif [ -e "$$target" ]; then \
	    printf 'WARN  %s exists but is not a symlink — skipping\n' "$$target"; \
	  else \
	    mkdir -p "$$v/.obsidian/themes" && \
	    ln -s "$(THEME_DIR)" "$$target" && printf 'link  %s\n' "$$target"; \
	  fi; \
	done

# ── housekeeping ─────────────────────────────────────────────────────────────

dev:
	npm run dev

clean:
	npm run clean:native
	rm -rf $(ZIG_CACHE_DIR) $(ZIG_SHIM_DIR) /tmp/zig-extract

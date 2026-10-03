SHELL := /bin/bash

# ── configuration (override on the command line, e.g. make install PLUGIN_DIR=...) ──
PLUGIN_ID  := obsidian-claude-ghostty
PLUGIN_DIR ?= $(HOME)/Developer/machine-cfg/obsisian/plugins/$(PLUGIN_ID)

THEME_NAME := Nocturnal Winter
THEME_DIR  ?= $(HOME)/Developer/machine-cfg/obsisian/themes/$(THEME_NAME)

# Obsidian vaults that get symlinks into the central plugin and theme dirs
VAULTS ?= $(HOME)/orac $(HOME)/daneel

# Toolchain (MacPorts: zig-0.16, nodejs22, npm10, python314)
ZIG ?= zig-0.16
OBSIDIAN_APP ?= /Applications/Obsidian.app

# Native addons are built for the Electron that the installed Obsidian ships.
ELECTRON_VERSION ?= $(shell plutil -extract CFBundleVersion raw \
  "$(OBSIDIAN_APP)/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist" 2>/dev/null)

NODE_GYP = npx node-gyp rebuild --runtime=electron --target=$(ELECTRON_VERSION) \
  --arch=arm64 --dist-url=https://electronjs.org/headers --devdir=$(CURDIR)/.cache/node-gyp

# Keep npm's cache in the repo: ~/.npm is root-owned on MacPorts machines (sudo npm / port).
export npm_config_cache := $(CURDIR)/.cache/npm

# npm install --ignore-scripts skips node-pty's own node-gyp run (wrong runtime);
# `make pty` rebuilds it for Electron.
STAMP := node_modules/.install-stamp

.DEFAULT_GOAL := help
.PHONY: help doctor deps check build native pty install reinstall reinstall-runtime \
        sync-js sync-runtime setup-vaults setup-themes dev clean

help:
	@printf '%s\n' \
		'Targets:' \
		'  make doctor             Check prerequisites and list anything missing' \
		'  make install            Full build (JS + native + pty) and sync to the plugin dir' \
		'  make reinstall          Fast loop: rebuild JS and sync manifest/styles/main.js' \
		'  make reinstall-runtime  Rebuild JS and also sync native addon + node-pty' \
		'  make native             Rebuild libghostty-vt + ghostty_vt.node (Zig 0.16)' \
		'  make pty                Rebuild node-pty for the installed Obsidian Electron' \
		'  make check              Type-check and bundle' \
		'  make dev                esbuild watch mode' \
		'  make setup-vaults       Symlink the plugin into each vault' \
		'  make setup-themes       Symlink the Nocturnal Winter theme into each vault' \
		'  make clean              Remove build output and caches' \
		'' \
		'Variables: PLUGIN_DIR, VAULTS, ZIG, ELECTRON_VERSION, OBSIDIAN_APP' \
		'  PLUGIN_DIR=$(PLUGIN_DIR)' \
		'  ELECTRON_VERSION=$(ELECTRON_VERSION)'

doctor:
	@ZIG="$(ZIG)" OBSIDIAN_APP="$(OBSIDIAN_APP)" PLUGIN_DIR="$(PLUGIN_DIR)" VAULTS="$(VAULTS)" scripts/doctor.sh

$(STAMP): package.json package-lock.json
	npm install --ignore-scripts
	touch $@

deps: doctor $(STAMP)

build: $(STAMP)
	npm run build

check: build
	npx tsc --noEmit

native: deps
	cd native/ghostty_vt/zig && ZIG_GLOBAL_CACHE_DIR=$(CURDIR)/.cache/zig \
	  $(ZIG) build -Doptimize=ReleaseFast -Dtarget=aarch64-macos.11.0 --prefix ../zig-out
	$(NODE_GYP)
	cp build/Release/ghostty_vt.node native/ghostty_vt.node

pty: deps
	MACOSX_DEPLOYMENT_TARGET=11.0 $(NODE_GYP) --directory node_modules/node-pty

install: native pty build sync-js sync-runtime

reinstall: build sync-js

reinstall-runtime: build sync-js sync-runtime

sync-js:
	install -d "$(PLUGIN_DIR)"
	rsync -a manifest.json styles.css main.js "$(PLUGIN_DIR)/"

sync-runtime:
	install -d "$(PLUGIN_DIR)/native" "$(PLUGIN_DIR)/node_modules"
	rsync -a native/ghostty_vt.node "$(PLUGIN_DIR)/native/"
	rsync -a --delete node_modules/node-pty "$(PLUGIN_DIR)/node_modules/"

# link <source> <dest-subdir> over every vault; idempotent, never overwrites real dirs
define link_into_vaults
	@for v in $(VAULTS); do \
	  if [ ! -d "$$v" ]; then printf 'WARN  vault not found: %s — skipping\n' "$$v"; continue; fi; \
	  target="$$v/.obsidian/$(2)"; \
	  if [ -L "$$target" ]; then printf 'skip  %s (symlink exists)\n' "$$target"; \
	  elif [ -e "$$target" ]; then printf 'WARN  %s exists but is not a symlink — skipping\n' "$$target"; \
	  else mkdir -p "$$(dirname "$$target")" && ln -s "$(1)" "$$target" && printf 'link  %s\n' "$$target"; fi; \
	done
endef

setup-vaults:
	$(call link_into_vaults,$(PLUGIN_DIR),plugins/$(PLUGIN_ID))

# After linking, select the theme once in Settings → Appearance.
setup-themes:
	$(call link_into_vaults,$(THEME_DIR),themes/$(THEME_NAME))

dev: $(STAMP)
	npm run dev

clean:
	rm -rf build native/ghostty_vt.node native/ghostty_vt/zig-out native/ghostty_vt/zig/.zig-cache \
	  .cache/zig .zig-cache main.js

SHELL := /bin/bash

# ── configuration (override on the command line, or export in a local .envrc) ──
PLUGIN_ID  := obsidian-claude-ghostty

# Vaults that get the plugin: every vault Obsidian knows about (scripts/list-vaults.sh).
# Space-separated paths, so paths containing spaces are not supported here.
ifndef VAULTS
VAULTS := $(shell scripts/list-vaults.sh | tr '\n' ' ')
endif

# The one real copy of the plugin. Default: inside the first vault; the others get a
# symlink to it (make setup-vaults) and share its settings. Point PLUGIN_DIR somewhere
# else to keep the plugin outside any vault.
ifndef PLUGIN_DIR
PLUGIN_DIR := $(if $(firstword $(VAULTS)),$(firstword $(VAULTS))/.obsidian/plugins/$(PLUGIN_ID))
endif

# Optional: a theme folder to link into each vault's .obsidian/themes (make setup-themes).
THEME_DIR ?=

# Release tag for install-release (default: the version in manifest.json)
VERSION := $(shell node -p 'require("./manifest.json").version' 2>/dev/null)
TAG ?= v$(VERSION)

# libghostty-vt pin: VT_VERSION, VT_WASM_URL, VT_WASM_SHA256
include native/libghostty-vt.env

# Keep npm's cache in the repo: ~/.npm is root-owned on MacPorts machines (sudo npm / port).
export npm_config_cache := $(CURDIR)/.cache/npm

# --ignore-scripts: node-pty's install script would try a node-gyp build; the
# shipped N-API prebuild is all the plugin needs.
STAMP := node_modules/.install-stamp
PAYLOAD := dist/$(PLUGIN_ID)

.DEFAULT_GOAL := help
.PHONY: help doctor deps wasm build check test package verify release-zip install reinstall \
        install-release sync setup-vaults setup-themes dev clean

help:
	@printf '%s\n' \
		'Targets:' \
		'  make doctor             Check prerequisites and list anything missing' \
		'  make install            Build everything and sync it to the plugin dir' \
		'  make reinstall          Fast loop: rebuild main.js and sync it' \
		'  make install-release    Install a GitHub release zip (TAG=$(TAG))' \
		'  make wasm               Download and verify libghostty-vt $(VT_VERSION) (wasm)' \
		'  make check              Type-check and bundle' \
		'  make test               Headless libghostty-vt adapter tests (no Obsidian needed)' \
		'  make package            Assemble the plugin payload in $(PAYLOAD)/' \
		'  make verify             package + check the payload (wasm tests, node-pty spawn)' \
		'  make release-zip        package + dist/$(PLUGIN_ID)-$(VERSION).zip' \
		'  make dev                esbuild watch mode' \
		'  make setup-vaults       Symlink the plugin into each vault' \
		'  make setup-themes       Symlink THEME_DIR into each vault as a theme' \
		'  make clean              Remove build output and caches' \
		'' \
		'Variables (export them in .envrc to keep them): PLUGIN_DIR, VAULTS, THEME_DIR, TAG' \
		'  PLUGIN_DIR=$(PLUGIN_DIR)' \
		'  VAULTS=$(VAULTS)'

doctor:
	@PLUGIN_DIR="$(PLUGIN_DIR)" VAULTS="$(VAULTS)" scripts/doctor.sh

$(STAMP): package.json package-lock.json
	npm ci --ignore-scripts --no-audit --no-fund
	touch $@

deps: $(STAMP)

wasm:
	scripts/fetch-wasm.sh

build: deps
	npm run build

check: build
	npx tsc --noEmit

test: deps wasm
	npm run test:vt

package: build wasm
	scripts/package.sh

verify: package
	node scripts/verify-payload.mjs $(PAYLOAD)

release-zip: check test verify
	scripts/package.sh --zip

# Fail early, with a hint, when no vault was found and PLUGIN_DIR is unset.
define need_plugin_dir
	@test -n "$(PLUGIN_DIR)" || { echo "No PLUGIN_DIR: Obsidian knows no vaults here. Set PLUGIN_DIR=<vault>/.obsidian/plugins/$(PLUGIN_ID)" >&2; exit 1; }
endef

install: doctor package sync

reinstall: build
	$(need_plugin_dir)
	install -d "$(PLUGIN_DIR)"
	rsync -a main.js manifest.json styles.css "$(PLUGIN_DIR)/"

# Sync the payload without touching data.json (the plugin's saved settings).
sync:
	$(need_plugin_dir)
	install -d "$(PLUGIN_DIR)"
	rsync -a --exclude node_modules "$(PAYLOAD)/" "$(PLUGIN_DIR)/"
	install -d "$(PLUGIN_DIR)/node_modules"
	rsync -a --delete "$(PAYLOAD)/node_modules/node-pty" "$(PLUGIN_DIR)/node_modules/"
	@# Pre-0.9 installs carried the N-API addon in native/.
	rm -rf "$(PLUGIN_DIR)/native"
	@echo "Synced to $(PLUGIN_DIR). Quit and restart Obsidian (Cmd+Q) to pick it up."

install-release:
	rm -rf .cache/release && install -d .cache/release
	gh release download "$(TAG)" --pattern '$(PLUGIN_ID)-*.zip' --dir .cache/release
	cd .cache/release && unzip -q $(PLUGIN_ID)-*.zip
	$(MAKE) sync PAYLOAD=.cache/release/$(PLUGIN_ID)

# link <source> <dest-subdir> over every vault; idempotent, never overwrites real dirs
define link_into_vaults
	@for v in $(VAULTS); do \
	  if [ ! -d "$$v" ]; then printf 'WARN  vault not found: %s — skipping\n' "$$v"; continue; fi; \
	  target="$$v/.obsidian/$(2)"; \
	  if [ -e "$$target" ] && [ "$$target" -ef "$(1)" ]; then printf 'skip  %s (the plugin itself)\n' "$$target"; \
	  elif [ -L "$$target" ]; then printf 'skip  %s (symlink exists)\n' "$$target"; \
	  elif [ -e "$$target" ]; then printf 'WARN  %s exists but is not a symlink — skipping\n' "$$target"; \
	  else mkdir -p "$$(dirname "$$target")" && ln -s "$(1)" "$$target" && printf 'link  %s\n' "$$target"; fi; \
	done
endef

setup-vaults:
	$(need_plugin_dir)
	$(call link_into_vaults,$(PLUGIN_DIR),plugins/$(PLUGIN_ID))

# After linking, select the theme once in Settings → Appearance.
setup-themes:
	@test -d "$(THEME_DIR)" || { echo "Set THEME_DIR to a theme folder (one holding manifest.json and theme.css)." >&2; exit 1; }
	$(call link_into_vaults,$(THEME_DIR),themes/$(notdir $(THEME_DIR)))

dev: deps
	npm run dev

clean:
	rm -rf dist main.js native/ghostty-vt.wasm .cache/release

SHELL := /bin/bash

VAULT ?= /Users/blake/Developer/orac
PLUGIN_ID ?= obsidian-claude-ghostty
PLUGIN_DIR ?= $(VAULT)/.obsidian/plugins/$(PLUGIN_ID)
RSYNC ?= rsync -a
RSYNC_DELETE ?= rsync -a --delete

.DEFAULT_GOAL := help

.PHONY: help print-vars deps check build native pty install reinstall reinstall-runtime sync-plugin sync-native sync-node-pty clean dev ensure-vault ensure-plugin-dir

help:
	@printf '%s\n' \
		'Targets:' \
		'  make reinstall          Fast loop: build JS and sync manifest/styles/main.js' \
		'  make reinstall-runtime  Sync JS plus current native addon and node-pty payload' \
		'  make install            Full local install: build JS, rebuild native addon/node-pty, sync all' \
		'  make check              Type-check and build the plugin bundle' \
		'  make native             Rebuild libghostty-vt + ghostty_vt.node for Obsidian Electron' \
		'  make pty                Rebuild node-pty for Obsidian Electron' \
		'  make dev                Run esbuild in watch mode' \
		'' \
		'Variables:' \
		'  VAULT=/path/to/vault    Default: $(VAULT)' \
		'  PLUGIN_DIR=/path        Default: $(PLUGIN_DIR)'

print-vars:
	@printf 'VAULT=%s\nPLUGIN_ID=%s\nPLUGIN_DIR=%s\n' "$(VAULT)" "$(PLUGIN_ID)" "$(PLUGIN_DIR)"

deps:
	npm install

check:
	npx tsc --noEmit
	npm run build

build:
	npm run build

native:
	npm run build:native:electron

pty:
	npm run build:pty:electron

install:
	$(MAKE) build
	$(MAKE) native
	$(MAKE) pty
	$(MAKE) sync-plugin
	$(MAKE) sync-native
	$(MAKE) sync-node-pty

reinstall:
	$(MAKE) build
	$(MAKE) sync-plugin

reinstall-runtime:
	$(MAKE) build
	$(MAKE) sync-plugin
	$(MAKE) sync-native
	$(MAKE) sync-node-pty

sync-plugin: ensure-plugin-dir
	$(RSYNC) manifest.json styles.css main.js "$(PLUGIN_DIR)/"

sync-native: ensure-plugin-dir
	$(RSYNC) native/ghostty_vt.node "$(PLUGIN_DIR)/native/"

sync-node-pty: ensure-plugin-dir
	$(RSYNC_DELETE) node_modules/node-pty "$(PLUGIN_DIR)/node_modules/"

ensure-plugin-dir: ensure-vault
	install -d "$(PLUGIN_DIR)" "$(PLUGIN_DIR)/native" "$(PLUGIN_DIR)/node_modules"

ensure-vault:
	@test -d "$(VAULT)/.obsidian" || { printf 'Vault not found at %s\nSet VAULT=/path/to/vault and try again.\n' "$(VAULT)"; exit 1; }

dev:
	npm run dev

clean:
	npm run clean:native

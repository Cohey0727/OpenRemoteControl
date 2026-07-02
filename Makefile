# open-rc — developer Makefile
#
# Thin convenience layer over the npm scripts in package.json. Run
# `make help` for the list.
#
# The Makefile mirrors the CLI: `serve`/`hub` (spawn-free relays),
# `attach-orc` (spawns a fresh `claude`), and `attach-tmux` (mirrors a
# `claude` you already started in tmux). There is no `make client`, no
# `make spawn`. The server itself never spawns anything.

SHELL := /bin/sh
.SHELLFLAGS := -eu -c

ROOT_DIR := $(shell pwd)
BIN      := $(ROOT_DIR)/src/cli.ts
UI_DIR   := $(ROOT_DIR)/ui

# Where `make setup` installs the `attach-orc` / `open-rc` launchers.
# Override with `make setup BIN_DIR=/usr/local/bin` if you prefer a dir
# already on your PATH.
BIN_DIR ?= $(HOME)/.local/bin

# Legacy shell-init file (superseded by the PATH launchers); teardown
# still removes it so upgraders aren't left with a stale source line.
SHELL_INIT_DIR  ?= $(HOME)/.config/open-rc
SHELL_INIT_FILE := $(SHELL_INIT_DIR)/shell.sh

HOST     ?= 127.0.0.1
PORT     ?= 7322

# ANSI colors for the setup banner. The raw ESC byte is captured at parse
# time so it survives being handed to printf as data. Amber is the brand
# accent (your control points); cyan is structure; dim is everything the
# machine just did on your behalf.
ESC   := $(shell printf '\033')
AMBER := $(ESC)[38;5;208m
CYAN  := $(ESC)[36m
DIM   := $(ESC)[90m
BOLD  := $(ESC)[1m
OFF   := $(ESC)[0m

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help message
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install deps (bun install)
	bun install
	@echo "Done. Run \`make serve\` (or \`bun run serve\`) to launch open-rc."

.PHONY: setup
setup: ## Register the open-rc launcher on PATH
	@# Install the launcher on PATH. It's a thin wrapper around the
	@# current source, so `git pull` updates behavior with no rebuild.
	@mkdir -p $(BIN_DIR)
	@printf '%s\n' '#!/bin/sh' 'exec bun run $(ROOT_DIR)/src/cli.ts "$$@"' > $(BIN_DIR)/open-rc
	@chmod +x $(BIN_DIR)/open-rc
	@# Upgraders: drop the removed attach-orc launcher, its slash-command
	@# symlink, and the superseded shell-init file if an older setup left them.
	@rm -f $(BIN_DIR)/attach-orc
	@rm -f $(HOME)/.claude/commands/attach-orc.md
	@rm -f $(SHELL_INIT_FILE)
	@printf '%s\n' \
	  '' \
	  '  $(AMBER)$(BOLD)██████  ██████  ██████$(OFF)' \
	  '  $(AMBER)$(BOLD)██  ██  ██  ██  ██    $(OFF)' \
	  '  $(AMBER)$(BOLD)██  ██  █████   ██    $(OFF)' \
	  '  $(AMBER)$(BOLD)██  ██  ██ ██   ██    $(OFF)' \
	  '  $(AMBER)$(BOLD)██████  ██  ██  ██████$(OFF)' \
	  '  $(DIM)o p e n · r e m o t e · c o n t r o l$(OFF)' \
	  '' \
	  '   $(DIM)┌─────────┐         ┌─────────┐         ┌─────────┐$(OFF)' \
	  '   $(DIM)│ browser │$(CYAN)◀──ws───▶$(DIM)│ $(AMBER)open·rc$(DIM) │$(CYAN)◀─agent─▶$(DIM)│  bridge │$(OFF)' \
	  '   $(DIM)└─────────┘         └─────────┘         └─────────┘$(OFF)' \
	  '      $(DIM)phone / laptop        the relay        you own this$(OFF)' \
	  '' \
	  ' $(AMBER)◉$(OFF) $(DIM)on PATH$(OFF)   $(BIN_DIR)/open-rc' \
	  '' \
	  ' $(BOLD)the server spawns nothing$(OFF) $(DIM)— you bring your own bridge to /agent$(OFF)' \
	  '   $(CYAN)open-rc serve$(OFF)   $(DIM)the relay + SPA$(OFF)' \
	  '   $(CYAN)open-rc tui$(OFF)     $(DIM)a terminal window onto a relayed session$(OFF)' \
	  ''
	@case ":$$PATH:" in \
	  *":$(BIN_DIR):"*) ;; \
	  *) printf '%s\n' \
	       ' $(AMBER)!$(OFF) $(BIN_DIR) $(DIM)is not on your PATH — add it, then restart your shell / Claude Code:$(OFF)' \
	       '     $(CYAN)export PATH="$(BIN_DIR):$$PATH"$(OFF)  $(DIM)» ~/.zshrc or ~/.bashrc$(OFF)' \
	       '' ;; \
	esac

.PHONY: teardown
teardown: ## Remove the PATH launcher (and any stale attach-orc leftovers)
	@rm -f $(BIN_DIR)/open-rc
	@rm -f $(BIN_DIR)/attach-orc
	@rm -f $(HOME)/.claude/commands/attach-orc.md
	@rm -f $(SHELL_INIT_FILE)
	@echo "Removed: $(BIN_DIR)/open-rc (and stale attach-orc launcher/command if present)"
	@echo "Note: any 'export PATH=$(BIN_DIR):...' or 'source $(SHELL_INIT_FILE)' lines"
	@echo "      you added to ~/.zshrc / ~/.bashrc were NOT removed — clean those up by hand."

.PHONY: uninstall
uninstall: ## No-op (kept for symmetry with install)

# ---------------------------------------------------------------------------
# Run / interact
# ---------------------------------------------------------------------------

.PHONY: serve
serve: ## Start the local WebSocket relay + SPA
	bun run $(BIN) serve --host $(HOST) --port $(PORT)

.PHONY: hub
hub: ## Start the public hub relay (Phase 4)
	bun run $(BIN) hub --host $(HOST) --port 7443

.PHONY: tui
tui: ## Terminal window onto a relayed session (spawn-free /ws client)
	bun run $(BIN) tui --server ws://$(HOST):$(PORT)/ws

.PHONY: dev
dev: ## Start the server in --watch mode (auto-restart on file change)
	bun run --watch $(BIN) serve --host $(HOST) --port $(PORT)

# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------

.PHONY: test
test: ## Run the test suite
	bun test

.PHONY: test-coverage
test-coverage: ## Run the test suite with coverage
	bun run test:coverage

.PHONY: typecheck
typecheck: ## Run TypeScript with --noEmit
	bun run typecheck

.PHONY: lint
lint: ## Run biome on the repo
	bun run lint

.PHONY: fmt
fmt: ## Auto-format the source with biome
	bun run fmt

.PHONY: verify
verify: typecheck test ## Typecheck + test (the CI gate)

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

.PHONY: build
build: ## (Distribution) Cross-compile a single-binary executable for the current host
	@echo "Note: build is for DISTRIBUTION only. To run the server, use 'make serve'."
	bun run build

.PHONY: build-all
build-all: ## (Distribution) Cross-compile single-binary executables for all 5 targets
	@echo "Note: build-all is for DISTRIBUTION only. To run the server, use 'make serve'."
	bun run build --all

.PHONY: build-icons
build-icons: ## Rasterise ui/icon.svg into the PWA manifest + iOS home-screen PNGs
	@echo "Regenerating PWA icon PNGs from ui/icon.svg…"
	bun run build-icons

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf dist
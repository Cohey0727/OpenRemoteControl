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
setup: ## Register attach-orc/open-rc on PATH + symlink the /attach-orc command
	@test -f commands/attach-orc.md || (echo "commands/attach-orc.md missing"; exit 1)
	@# 1) Symlink the slash command. Its body is the generic `attach-orc
	@#    $$ARGUMENTS`, so the file is machine-independent — a symlink is
	@#    safe and `git pull` propagates edits with no reinstall.
	@mkdir -p $(HOME)/.claude/commands
	@rm -f $(HOME)/.claude/commands/attach-orc.md
	@ln -s $(ROOT_DIR)/commands/attach-orc.md $(HOME)/.claude/commands/attach-orc.md
	@# 2) Install the launchers on PATH. Each is a thin wrapper around the
	@#    current source, so `git pull` updates behavior with no rebuild.
	@#    exec preserves cwd, so claude spawns in whatever dir you call it from.
	@mkdir -p $(BIN_DIR)
	@printf '%s\n' '#!/bin/sh' 'exec bun run $(ROOT_DIR)/src/cli.ts attach-orc "$$@"' > $(BIN_DIR)/attach-orc
	@printf '%s\n' '#!/bin/sh' 'exec bun run $(ROOT_DIR)/src/cli.ts "$$@"' > $(BIN_DIR)/open-rc
	@chmod +x $(BIN_DIR)/attach-orc $(BIN_DIR)/open-rc
	@# Drop the superseded shell-init file if an older setup left one.
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
	  '   $(DIM)│ browser │$(CYAN)◀──ws───▶$(DIM)│ $(AMBER)open·rc$(DIM) │$(CYAN)◀─agent─▶$(DIM)│ claude  │$(OFF)' \
	  '   $(DIM)└─────────┘         └─────────┘         └─────────┘$(OFF)' \
	  '      $(DIM)phone / laptop        the relay         your claude$(OFF)' \
	  '' \
	  ' $(AMBER)◉$(OFF) $(DIM)command$(OFF)   $(HOME)/.claude/commands/attach-orc.md $(DIM)» symlink$(OFF)' \
	  ' $(AMBER)◉$(OFF) $(DIM)on PATH$(OFF)   $(BIN_DIR)/{attach-orc, open-rc}' \
	  '' \
	  ' $(BOLD)launch from any project$(OFF) $(DIM)— it drives THAT project'"'"'s claude$(OFF)' \
	  '   $(CYAN)/attach-orc$(OFF)   $(DIM)in Claude Code · works in any repo$(OFF)' \
	  '   $(CYAN)attach-orc$(OFF)    $(DIM)in any terminal$(OFF)' \
	  ''
	@case ":$$PATH:" in \
	  *":$(BIN_DIR):"*) ;; \
	  *) printf '%s\n' \
	       ' $(AMBER)!$(OFF) $(BIN_DIR) $(DIM)is not on your PATH — add it, then restart your shell / Claude Code:$(OFF)' \
	       '     $(CYAN)export PATH="$(BIN_DIR):$$PATH"$(OFF)  $(DIM)» ~/.zshrc or ~/.bashrc$(OFF)' \
	       '' ;; \
	esac

.PHONY: teardown
teardown: ## Remove the /attach-orc command symlink + the PATH launchers
	@rm -f $(HOME)/.claude/commands/attach-orc.md
	@rm -f $(BIN_DIR)/attach-orc $(BIN_DIR)/open-rc
	@rm -f $(SHELL_INIT_FILE)
	@echo "Removed: $(HOME)/.claude/commands/attach-orc.md"
	@echo "Removed: $(BIN_DIR)/attach-orc, $(BIN_DIR)/open-rc"
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

.PHONY: attach-orc
attach-orc: ## Attach a local claude subprocess to the running serve (Phase 7.5)
	@echo "Note: 'attach-orc' is a CLI bridge — it spawns 'claude' locally and"
	@echo "forwards its stream-json stdio to ws://$(HOST):$(PORT)/agent."
	@echo "The 'serve' process itself does NOT spawn anything."
	bun run $(BIN) attach-orc --server ws://$(HOST):$(PORT)/agent

.PHONY: attach-tmux
attach-tmux: ## Mirror an existing tmux claude into the running serve (TARGET=<pane>)
	@echo "Note: 'attach-tmux' mirrors a claude you already started in tmux."
	@echo "It spawns 'tmux' (never 'claude') and never kills the pane."
	@echo "Pass TARGET=<pane> or omit to auto-detect the sole claude pane."
	bun run $(BIN) attach-tmux --server ws://$(HOST):$(PORT)/agent $(if $(TARGET),--target $(TARGET),)

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
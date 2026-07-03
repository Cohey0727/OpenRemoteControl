# open-rc — developer Makefile
#
# Thin convenience layer over the npm scripts in package.json. Run
# `make help` for the list.
#
# The Makefile mirrors the CLI: `serve`, `hub`, `tui`, `attach-orc`,
# and `hook` — relays, WebSocket clients, and the transcript bridge.
# The user runs `claude` themselves; nothing here launches a process.

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
# Banner pieces (shared by setup / serve / dev)
# ---------------------------------------------------------------------------

.PHONY: logo
logo:
	@printf '%s\n' \
	  '' \
	  '  $(AMBER)$(BOLD)██████  ██████  ██████$(OFF)' \
	  '  $(AMBER)$(BOLD)██  ██  ██  ██  ██    $(OFF)' \
	  '  $(AMBER)$(BOLD)██  ██  █████   ██    $(OFF)' \
	  '  $(AMBER)$(BOLD)██  ██  ██ ██   ██    $(OFF)' \
	  '  $(AMBER)$(BOLD)██████  ██  ██  ██████$(OFF)' \
	  '  $(DIM)o p e n · r e m o t e · c o n t r o l$(OFF)' \
	  ''

.PHONY: relay-diagram
relay-diagram:
	@printf '%s\n' \
	  '   $(DIM)┌─────────┐         ┌─────────┐         ┌─────────┐$(OFF)' \
	  '   $(DIM)│ browser │$(CYAN)◀──ws───▶$(DIM)│ $(AMBER)open·rc$(DIM) │$(CYAN)◀─agent─▶$(DIM)│  bridge │$(OFF)' \
	  '   $(DIM)└─────────┘         └─────────┘         └─────────┘$(OFF)' \
	  '      $(DIM)phone / laptop        the relay        you own this$(OFF)' \
	  ''

# URL list intentionally absent: the server itself prints the ◉ URL
# block on boot (also when launched without make), so the banner
# would duplicate it.
.PHONY: serve-hints
serve-hints:
	@printf '%s\n' \
	  ' $(BOLD)share the session you are already in$(OFF)' \
	  '   $(CYAN)/attach-orc$(OFF)     $(DIM)inside claude — THIS session appears in the sidebar$(OFF)' \
	  '   $(CYAN)open-rc tui$(OFF)     $(DIM)a terminal window onto the same session$(OFF)' \
	  '' \
	  ' $(DIM)ctrl-c stops the relay$(OFF)' \
	  ''

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install deps (bun install)
	bun install
	@echo "Done. Run \`make serve\` (or \`bun run serve\`) to launch open-rc."

.PHONY: setup
setup: logo relay-diagram ## Register the open-rc launcher, Claude Code hooks, and /attach-orc command (asks for your relay URL)
	@# Install the launcher on PATH. It's a thin wrapper around the
	@# current source, so `git pull` updates behavior with no rebuild.
	@#
	@# The relay URL is ASKED on the CLI (interactive runs): answer with
	@# your relay (e.g. https://orc.example.com) and the launcher bakes
	@# it in as the ORC_BASE_URL default (`:=` — a value already in the
	@# environment still wins), so `open-rc tui`, `/attach-orc`, and the
	@# hooks all target it with zero shell configuration. Empty answer =
	@# local default (ws://127.0.0.1:7322). Non-interactive runs skip
	@# the question; `make setup ORC_BASE_URL=…` answers it up front.
	@# Re-run setup any time to change or clear the default.
	@mkdir -p $(BIN_DIR)
	@URL='$(ORC_BASE_URL)'; \
	if [ -z "$$URL" ] && [ -t 0 ]; then \
	  printf ' %s\n' '$(BOLD)relay URL$(OFF) $(DIM)— where should this machine attach sessions?$(OFF)'; \
	  printf ' %s ' '$(DIM)(e.g. https://orc.example.com — empty = local 127.0.0.1:7322)$(OFF)$(AMBER)›$(OFF)'; \
	  read -r URL || URL=''; \
	fi; \
	if [ -n "$$URL" ]; then \
	  printf '%s\n' '#!/bin/sh' \
	    ': "$${ORC_BASE_URL:='"$$URL"'}"' \
	    'export ORC_BASE_URL' \
	    'exec bun run $(ROOT_DIR)/src/cli.ts "$$@"' > $(BIN_DIR)/open-rc; \
	  printf ' %s\n' '$(AMBER)◉$(OFF) $(DIM)relay$(OFF)     $(CYAN)'"$$URL"'$(OFF) $(DIM)(launcher default — env still wins)$(OFF)'; \
	else \
	  printf '%s\n' '#!/bin/sh' 'exec bun run $(ROOT_DIR)/src/cli.ts "$$@"' > $(BIN_DIR)/open-rc; \
	fi
	@chmod +x $(BIN_DIR)/open-rc
	@# Upgraders: drop the long-gone standalone attach-orc launcher and
	@# the superseded shell-init file if an older setup left them.
	@rm -f $(BIN_DIR)/attach-orc
	@rm -f $(SHELL_INIT_FILE)
	@# Claude Code integration: Stop/UserPromptSubmit/SessionEnd hooks in
	@# ~/.claude/settings.json + the /attach-orc slash command symlink.
	@bun run $(ROOT_DIR)/scripts/install-hooks.ts --bin $(BIN_DIR)/open-rc
	@printf '%s\n' \
	  ' $(AMBER)◉$(OFF) $(DIM)on PATH$(OFF)   $(BIN_DIR)/open-rc' \
	  ' $(AMBER)◉$(OFF) $(DIM)hooks$(OFF)     ~/.claude/settings.json $(DIM)(Stop / UserPromptSubmit / SessionEnd)$(OFF)' \
	  ' $(AMBER)◉$(OFF) $(DIM)command$(OFF)   ~/.claude/commands/attach-orc.md'
	@printf '%s\n' \
	  '' \
	  ' $(BOLD)share the session you are already in$(OFF)' \
	  '   $(CYAN)open-rc serve$(OFF)      $(DIM)the relay + SPA$(OFF)' \
	  '   $(CYAN)/attach-orc$(OFF)        $(DIM)inside claude — mirror THIS session to the browser$(OFF)' \
	  '   $(CYAN)open-rc tui$(OFF)        $(DIM)a terminal window onto a relayed session$(OFF)' \
	  ''
	@case ":$$PATH:" in \
	  *":$(BIN_DIR):"*) ;; \
	  *) printf '%s\n' \
	       ' $(AMBER)!$(OFF) $(BIN_DIR) $(DIM)is not on your PATH — add it, then restart your shell / Claude Code:$(OFF)' \
	       '     $(CYAN)export PATH="$(BIN_DIR):$$PATH"$(OFF)  $(DIM)» ~/.zshrc or ~/.bashrc$(OFF)' \
	       '' ;; \
	esac

.PHONY: teardown
teardown: ## Remove the launcher, Claude Code hooks, and /attach-orc command
	@bun run $(ROOT_DIR)/scripts/install-hooks.ts --remove || true
	@rm -f $(BIN_DIR)/open-rc
	@rm -f $(BIN_DIR)/attach-orc
	@rm -f $(HOME)/.claude/commands/attach-orc.md
	@rm -f $(SHELL_INIT_FILE)
	@echo "Removed: $(BIN_DIR)/open-rc, Claude Code hooks, and /attach-orc command"
	@echo "Note: any 'export PATH=$(BIN_DIR):...' or 'source $(SHELL_INIT_FILE)' lines"
	@echo "      you added to ~/.zshrc / ~/.bashrc were NOT removed — clean those up by hand."

.PHONY: uninstall
uninstall: ## No-op (kept for symmetry with install)

# ---------------------------------------------------------------------------
# Run / interact
# ---------------------------------------------------------------------------

.PHONY: serve
serve: logo relay-diagram serve-hints ## Start the local WebSocket relay + SPA
	@bun run $(BIN) serve --host $(HOST) --port $(PORT)

.PHONY: hub
hub: ## Start the public hub relay (Phase 4)
	bun run $(BIN) hub --host $(HOST) --port 7443

.PHONY: tui
tui: ## Terminal window onto a relayed session (pure /ws client)
	bun run $(BIN) tui --server ws://$(HOST):$(PORT)/ws

.PHONY: dev
dev: logo relay-diagram serve-hints ## Start the server in --watch mode (auto-restart on file change)
	@printf '%s\n' ' $(AMBER)⟳$(OFF) $(DIM)watch mode — the relay restarts on every file change$(OFF)' ''
	@bun run --watch $(BIN) serve --host $(HOST) --port $(PORT)

# ---------------------------------------------------------------------------
# Docker (all-in-one image: serve by default, hub/tui via args)
# ---------------------------------------------------------------------------

.PHONY: docker-build
docker-build: ## Build the all-in-one Docker image (open-rc:latest)
	docker build -t open-rc .

.PHONY: docker-serve
docker-serve: logo relay-diagram serve-hints ## Run the relay in Docker (loopback :7322, data volume)
	docker compose up -d --build
	@printf '%s\n' '' ' $(AMBER)◉$(OFF) $(DIM)container$(OFF)  open-rc $(DIM)(docker compose)$(OFF) — $(CYAN)make docker-logs$(OFF) / $(CYAN)make docker-stop$(OFF)' ''

.PHONY: docker-logs
docker-logs: ## Tail the Docker relay's logs
	docker compose logs -f

.PHONY: docker-stop
docker-stop: ## Stop and remove the Docker relay (data volume survives)
	docker compose down

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
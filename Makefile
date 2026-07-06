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

# Where setup/teardown write the Claude Code integration. Overriding
# these (together with BIN_DIR) sandboxes a test run completely —
# without them a `make setup BIN_DIR=/tmp/x` would still rewrite the
# REAL ~/.claude hooks to a throwaway path.
CLAUDE_SETTINGS     ?= $(HOME)/.claude/settings.json
CLAUDE_COMMANDS_DIR ?= $(HOME)/.claude/commands
# User-scope MCP config — where setup registers the `orc` channel
# server entry (research-preview Channels sharing, `orc channel`).
CLAUDE_JSON         ?= $(HOME)/.claude.json

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
	  '   $(CYAN)/orc$(OFF)     $(DIM)inside claude — THIS session appears in the sidebar$(OFF)' \
	  '   $(CYAN)orc tui$(OFF)         $(DIM)a terminal window onto the same session$(OFF)' \
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
setup: logo relay-diagram ## Register the open-rc launcher, Claude Code hooks, and /orc command (asks for your relay URL)
	@# Install the launcher on PATH. It's a thin wrapper around the
	@# current source, so `git pull` updates behavior with no rebuild.
	@#
	@# The relay URL is ASKED on the CLI (interactive runs): answer with
	@# your relay (e.g. https://orc.example.com) and the launcher bakes
	@# it in as the ORC_BASE_URL default (`:=` — a value already in the
	@# environment still wins), so `open-rc tui`, `/orc`, and the
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
	AUTH='$(ORC_AUTH)'; \
	{ printf '%s\n' '#!/bin/sh'; \
	  [ -n "$$URL" ] && printf '%s\n' ': "$${ORC_BASE_URL:='"$$URL"'}"' 'export ORC_BASE_URL'; \
	  [ -n "$$AUTH" ] && printf '%s\n' ': "$${ORC_AUTH:='"$$AUTH"'}"' 'export ORC_AUTH'; \
	  printf '%s\n' 'exec bun run $(ROOT_DIR)/src/cli.ts "$$@"'; \
	} > $(BIN_DIR)/orc; \
	[ -n "$$URL" ] && printf ' %s\n' '$(AMBER)◉$(OFF) $(DIM)relay$(OFF)     $(CYAN)'"$$URL"'$(OFF) $(DIM)(launcher default — env still wins)$(OFF)'; \
	[ -n "$$AUTH" ] && printf ' %s\n' '$(AMBER)◉$(OFF) $(DIM)auth$(OFF)      $(DIM)ORC_AUTH baked into the launcher$(OFF)'; \
	true
	@chmod +x $(BIN_DIR)/orc
	@# Clean break (2026-07-03): the launcher is `orc` now. Drop the old
	@# `open-rc` / `attach-orc` launchers and the superseded shell-init
	@# file so the command exists under one name only.
	@rm -f $(BIN_DIR)/open-rc
	@rm -f $(BIN_DIR)/attach-orc
	@rm -f $(SHELL_INIT_FILE)
	@# Claude Code integration: Stop/UserPromptSubmit/SessionEnd hooks in
	@# ~/.claude/settings.json + the /orc slash command symlink.
	@bun run $(ROOT_DIR)/scripts/install-hooks.ts --bin $(BIN_DIR)/orc \
	  --settings $(CLAUDE_SETTINGS) --commands-dir $(CLAUDE_COMMANDS_DIR)
	@# Channels sharing (research preview): register `orc channel` as a
	@# user-scope MCP server so `claude
	@# --dangerously-load-development-channels server:orc` can spawn it.
	@bun run $(ROOT_DIR)/scripts/install-channel.ts --bin $(BIN_DIR)/orc \
	  --claude-json $(CLAUDE_JSON) || true
	@printf '%s\n' \
	  ' $(AMBER)◉$(OFF) $(DIM)on PATH$(OFF)   $(BIN_DIR)/orc' \
	  ' $(AMBER)◉$(OFF) $(DIM)hooks$(OFF)     ~/.claude/settings.json $(DIM)(Stop / UserPromptSubmit / Notification / SessionEnd)$(OFF)' \
	  ' $(AMBER)◉$(OFF) $(DIM)command$(OFF)   ~/.claude/commands/orc.md' \
	  ' $(AMBER)◉$(OFF) $(DIM)channel$(OFF)   ~/.claude.json $(DIM)(mcpServers.orc — research-preview Channels sharing)$(OFF)'
	@printf '%s\n' \
	  '' \
	  ' $(BOLD)share the session you are already in$(OFF)' \
	  '   $(CYAN)orc serve$(OFF)      $(DIM)the relay + SPA$(OFF)' \
	  '   $(CYAN)/orc$(OFF)           $(DIM)inside claude — mirror THIS session to the browser$(OFF)' \
	  '   $(CYAN)orc tui$(OFF)        $(DIM)a terminal window onto a relayed session$(OFF)' \
	  '' \
	  ' $(BOLD)or share with instant delivery (Channels research preview)$(OFF)' \
	  '   $(CYAN)claude --dangerously-load-development-channels server:orc$(OFF)' \
	  '   $(DIM)start the session like this — browser messages then land instantly,$(OFF)' \
	  '   $(DIM)even while it is idle, and permission prompts relay to the browser$(OFF)' \
	  ''
	@case ":$$PATH:" in \
	  *":$(BIN_DIR):"*) ;; \
	  *) printf '%s\n' \
	       ' $(AMBER)!$(OFF) $(BIN_DIR) $(DIM)is not on your PATH — add it, then restart your shell / Claude Code:$(OFF)' \
	       '     $(CYAN)export PATH="$(BIN_DIR):$$PATH"$(OFF)  $(DIM)» ~/.zshrc or ~/.bashrc$(OFF)' \
	       '' ;; \
	esac

.PHONY: teardown
teardown: ## Remove the launcher, Claude Code hooks, /orc command, and channel entry
	@bun run $(ROOT_DIR)/scripts/install-hooks.ts --remove \
	  --settings $(CLAUDE_SETTINGS) --commands-dir $(CLAUDE_COMMANDS_DIR) || true
	@bun run $(ROOT_DIR)/scripts/install-channel.ts --remove \
	  --claude-json $(CLAUDE_JSON) || true
	@rm -f $(BIN_DIR)/orc
	@rm -f $(BIN_DIR)/orc
	@rm -f $(BIN_DIR)/open-rc
	@rm -f $(BIN_DIR)/attach-orc
	@rm -f $(HOME)/.claude/commands/orc.md
	@rm -f $(HOME)/.claude/commands/attach-orc.md
	@rm -f $(SHELL_INIT_FILE)
	@echo "Removed: $(BIN_DIR)/orc, Claude Code hooks, and /orc command"
	@echo "Note: any 'export PATH=$(BIN_DIR):...' or 'source $(SHELL_INIT_FILE)' lines"
	@echo "      you added to ~/.zshrc / ~/.bashrc were NOT removed — clean those up by hand."

.PHONY: uninstall
uninstall: ## No-op (kept for symmetry with install)

# ---------------------------------------------------------------------------
# Run / interact
# ---------------------------------------------------------------------------

.PHONY: ui-build
ui-build: ## Build the React SPA (Vite) into ui/dist
	@bun run build:ui

.PHONY: serve
serve: logo relay-diagram serve-hints ui-build ## Build the SPA, then start the relay + SPA
	@bun run $(BIN) serve --host $(HOST) --port $(PORT)

.PHONY: hub
hub: ## Start the public hub relay (Phase 4)
	bun run $(BIN) hub --host $(HOST) --port 7443

.PHONY: tui
tui: ## Terminal window onto a relayed session (pure /ws client)
	bun run $(BIN) tui --server ws://$(HOST):$(PORT)/ws

.PHONY: dev
dev: logo relay-diagram serve-hints ui-build ## Relay in --watch mode serving a built SPA (for UI HMR run `bun run dev` + `bun run dev:relay`)
	@printf '%s\n' \
	  ' $(AMBER)⟳$(OFF) $(DIM)watch mode — the relay restarts on every source change$(OFF)' \
	  ' $(DIM)for live SPA HMR: run $(CYAN)bun run dev$(OFF)$(DIM) (Vite :5173, proxies /ws) alongside $(CYAN)bun run dev:relay$(OFF)' ''
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
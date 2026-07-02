# open-rc — Roadmap

> **Last revised:** 2026-07-01 — Phase 7 (no-spawn pivot) complete.
> All seven phases done. The server is a pure WebSocket relay: no
> spawn, no process table, no take-over. The CLI exposes exactly
> `serve` and `hub`.

---

## 0. Phasing principle

Each phase ends with something a real person can use. We don't ship
a phase until its deliverable runs end-to-end and the user can
demonstrate the value described in that phase's "Definition of done."

The approach is fixed: `open-rc serve` is a pure WebSocket relay.
It does not spawn `claude`. It does not manage `claude`. The user
runs `claude` themselves and brings their own bridge. See
[`architecture.md`](./architecture.md) and [`survey.md`](./survey.md).

---

## Phase 1 — Local serve MVP — ✓ DONE

**Goal.** A local relay the user runs directly via Bun, opens
`http://127.0.0.1:<port>` in a browser, and sees a working UI.

> **Build is optional.** Phase 1 launches the server directly from
> the TypeScript source (`bun run src/cli.ts serve …`). The single-
> binary build (`bun run build`) is a distribution convenience for
> users who don't have Bun installed — it is not required to run
> the server.

**Scope.**

- `open-rc serve` (default command).
- Binds `127.0.0.1:7322` (configurable via `--port`).
- Bun.serve hosting the SPA + WebSocket on `/ws` (browsers) and
  `/agent` (user-owned bridges).
- SPA = vanilla TypeScript with a small signal implementation,
  served via `Bun.Transpiler` for `.ts` files (no UI build step).
  The one render dep (`marked`) is vendored locally; no CDN.

**Definition of done — ✓ met.**

- `bun run src/cli.ts serve --port 7322` boots in <500 ms.
- User opens `http://127.0.0.1:7322`, sees the SPA.
- The server does not spawn anything. `pgrep -f open-rc` returns
  exactly one pid; `pgrep -f claude` returns zero results from the
  server's process tree.

---

## Phase 2 — Permission model (server-side plumbing) — ✓ DONE

**Goal.** The server knows how to route `permission_request` and
`permission_response` frames between clients and browsers. Whether
the user's `claude` actually emits permission pauses is up to the
user's bridge and their `claude` configuration.

**Scope.**

- `permission_request` / `permission_response` wired through `/ws`.
- UI: centered modal with tool name, arguments, Allow/Deny buttons.
- Optional audit log of every permission decision (server-side).

**Definition of done — ✓ met.**

- Server correctly routes `permission_request` from a client to
  every attached browser, and routes the browser's response back to
  the client.

---

## Phase 3 — UI polish — ✓ DONE

**Goal.** The UI is actually pleasant to use.

**Scope.**

- Markdown rendering for assistant text (sanitized before it touches
  the DOM — no raw-HTML/script injection from model output).
- Monospace code blocks (no syntax-highlighter dependency — the
  vendored bundle stays lean; markdown is the only render dep).
- Tool call cards (collapsed by default, expandable to show input +
  output).
- Thinking blocks (collapsed by default; opt-in show).
- Cost + duration metrics on `done` events.
- Cancel button that sends a generic interrupt frame to the bridge
  (the bridge decides what to do with it — open-rc has no opinion).
- Mobile-responsive layout (single-column under 768 px).

**Definition of done — ✓ met.**

- Mobile browser (Safari iOS, Chrome Android) usable in portrait.

---

## Phase 4 — Hub mode — ✓ DONE

**Goal.** A self-hostable public deployment that many `open-rc serve`
instances dial into, and many browser/mobile clients attach to.

**Scope.**

- `open-rc hub` command: same binary, different mode.
- WSS listener (TLS via `bun:tls`).
- bun:sqlite schema for registered devices, sessions, audit log.
- Ed25519 device enrollment: first run, generate keypair, print
  enrollment URL; user opens URL in browser, confirms pairing,
  device is registered.
- Optional Tailscale or Cloudflare Tunnel integration docs.

**Definition of done — ✓ met.**

- Two `open-rc serve` instances on different machines dial into one
  `open-rc hub`.
- User logs into hub from a phone browser.
- Phone sees both machines' client list.
- User sends a prompt from phone → reaches the right machine → reply
  streams back.

---

## Phase 5 — Web Push — ✓ DONE

**Goal.** Phone-first experience.

**Scope.**

- Browser push via VAPID (Web Push API). iOS supports Web Push on
  home-screen-installed PWAs starting Safari 16.4 (the install side
  of that requirement ships in [Phase 8.1](#phase-81--pwa-install--offline-app-shell-cache----done)).
- Notification grouping per session.
- Quick-action shortcuts (cancel, view last message).
- Re-engagement: opening the app mid-turn resumes streaming.

**Definition of done — ✓ met.**

- Phone notification arrives within 5 s of `done` event when no UI
  is attached. Tapping the notification opens the session at the new
  turn.

---

## Phase 6 — Hardening — ✓ DONE

**Goal.** Production-deployable.

**Scope.**

- Test suite: unit (bun test) on protocol parser + translator;
  integration on server routing with a mock bridge and on the
  `attach-orc` CLI round-trip. (End-to-end Playwright coverage is
  deferred — none ships yet; layout is verified manually via a
  headless browser during development.)
- Coverage ≥80%.
- CI: GitHub Actions matrix (macOS, Linux; Bun 1.x).
- Release: cross-compile Bun binaries for `darwin-arm64`,
  `darwin-x64`, `linux-x64`, `linux-arm64`.
- Changelog, SECURITY.md, README Quick Start works in <5 minutes.

**Definition of done — ✓ met.**

- All CI green. Tagged releases on GitHub.

---

## Phase 7 — No-spawn pivot — ✓ DONE

**Goal.** `open-rc serve` is a pure WebSocket relay. It does not
spawn anything. It does not manage anything. The user runs `claude`
themselves and brings their own bridge.

This is a **cleanup phase**, not a feature phase. The hard work
(subprocess management, persistence, take-over logic) is being
*removed* from open-rc and pushed back to the user, where it
belongs.

**Scope.**

- **Remove `open-rc attach` from the CLI.** Delete `src/attach.ts`
  if present, remove from `src/cli.ts` dispatch, remove from
  `package.json` `bin` aliases (none should exist).
- **Remove `src/session/subprocess.ts`.** This was the
  `Bun.spawn`-wrapping class. Delete it.
- **Remove `src/session/manager.ts`.** This was the session
  lifecycle owner that wrapped the subprocess. Delete it. The
  server has no session lifecycle; clients manage their own
  `claude`.
- **Remove `src/session/persistence.ts` from the server.** The
  server does not persist anything. Delete the file (or move it
  out of `src/server/` if a future phase resurrects a bridge we
  ship; for v0.x it is gone).
- **Update `src/ws.ts`.** Remove the `create_session` /
  `remove_session` / `list_sessions` server-side handlers and the
  corresponding `WsClientMessage` variants. The browser cannot
  create or remove clients.
- **Update `src/serve.ts`.** Remove the boot-time auto-spawn path
  and the `sessions.json` rehydration path. The server has no boot
  spawn and no on-start work.
- **Update `src/cli.ts`.** Remove the `attach` command branch
  (including the historical `attach-orc` alias). The CLI surface
  shrinks to exactly `serve` and `hub`.
- **Update `package.json`.** Remove the `dev` script's `--cwd` flag
  pass-through (it implied a default cwd for a spawned subprocess).
  `start` becomes `bun run src/cli.ts serve --port 7322`.
- **Update `Makefile`.** Remove any `make attach` or
  `make client` target. The Makefile should expose only
  `make start` (= serve) and the usual dev/test targets.
- **Update `ui/app.ts`.** Remove the `+ New session` button and
  the `× Remove` button from the sidebar. The sidebar shows what
  bridges are currently connected; clicking a row attaches the
  chat pane to that bridge's stream. There is no
  create / remove affordance.
- **Update `tests/`.**
  - Delete `tests/session-manager.test.ts` (no manager).
  - Delete `tests/multi-session.test.ts` (no server-owned
    sessions).
  - Delete `tests/attach-cli.test.ts` (no attach CLI).
  - Delete `tests/takeover.test.ts` (no takeover; banned).
  - Delete `tests/external-sessions.test.ts` (no external sessions
    endpoint; banned).
  - Delete `tests/history.test.ts` (no history feature).
  - Rewrite `tests/serve.integration.test.ts` to use a mock
    bridge (not a spawned subprocess). The mock bridge opens a
    WebSocket and sends canned frames; the test asserts the server
    routes them to attached browsers.
  - Update `tests/claim-endpoint.test.ts` (or delete it) to assert
    there is no `/api/external-sessions` endpoint.
- **Static checks.**
  - `grep -rn "Bun.spawn" src/serve.ts src/cli.ts src/ws.ts` returns
    zero matches.
  - `grep -rn "ps" src/serve.ts src/cli.ts src/ws.ts` returns only
    matches in unrelated identifiers (e.g., a string literal that
    happens to contain "ps"). Walk the matches and confirm none of
    them invoke `ps`, `lsof`, or `child_process`.
  - `grep -rn "spawn" src/` returns zero matches except inside
    `node_modules` or comments referencing the historical
    constraint.
  - `grep -rn "subprocess" src/` returns zero matches except in
    comments referencing the historical constraint.
- **Documentation.** Already complete in this phase — `CLAUDE.md`,
  `README.md`, `docs/architecture.md`, `docs/roadmap.md` (this
  file), `docs/tech-stack.md`, `docs/survey.md`, `SECURITY.md` all
  reflect the no-spawn model with no contradictions and no
  lingering spawn references.

**Out of scope (this phase).**

- Shipping a bridge. Permanently banned — bridges are the user's
  responsibility.
- Process discovery. Permanently banned — the server has no
  process table to discover from.
- Browser-side session creation. Permanently banned.
- Re-attaching to an in-flight subprocess across restarts. The
  user's bridge can implement this if it wants; open-rc doesn't
  care.

**Definition of done.**

- `open-rc serve` runs without spawning anything. `pgrep -f claude`
  shows zero results immediately after `serve` boots.
- `grep -rn "Bun.spawn" src/serve.ts src/cli.ts src/ws.ts` returns
  zero matches.
- `grep -rn "spawn" src/` returns zero matches except in
  comments that explicitly note the historical constraint.
- The CLI surface is exactly `serve` and `hub`. `open-rc attach`
  and `open-rc attach-orc` are unknown commands. *(Superseded by
  Phase 7.5 — see above.)*
- The UI has no "+ New session" button and no "× Remove" button.
  The sidebar is passive.
- Tests pass with ≥80% coverage on the server. `make verify` is
  green.
- README Quick Start works in <5 minutes: install Bun, run
  `bun run start`, open the URL, see a working UI. (The user
  brings their own `claude` and bridge; that part is documented but
  not part of the Quick Start.)
- `git grep -nE "spawn|subprocess|attach-orc" docs/ CLAUDE.md
  README.md SECURITY.md` returns zero matches except in sections
  that explicitly forbid the term.

---

## Phase 7.5 — `open-rc attach-orc` CLI (third command) — ✓ DONE

**Goal.** Give the user a one-liner to drive a CLI-launched `claude`
session from the browser without writing a bridge by hand. The
command is named `attach-orc` (`orc` = "open remote control").

Phase 7 deleted the historical `open-rc attach` to enforce the
"server never spawns" rule. This phase re-adds an attach entry
point as a **CLI** command — `attach-orc` — a separate process the
user runs in their terminal — so the server remains spawn-free
while the user gets an obvious attach path.

- `src/cli/attach-orc.ts` — parses flags, spawns
  `claude --print --input-format stream-json --output-format
  stream-json --verbose`, bridges its stdio ↔ `/agent` WS. (Switched
  from `--bare` on 2026-07-02: bare-mode auth is strictly
  `ANTHROPIC_API_KEY`, which broke OAuth-login machines.)
- Fail-fast: if the FIRST registration doesn't complete within 10 s
  (serve down, bad URL, clientId collision), exit(1) with the reason —
  the `/attach-orc` slash command reads an early exit as "serve isn't
  running". After a successful registration, reconnects retry forever.
  `ORC_REGISTER_TIMEOUT_MS` overrides the deadline (tests only).
- Streaming: `--include-partial-messages` is part of the spawn args;
  `stream_event` text deltas are relayed as `text_delta` frames so the
  browser renders replies as they generate (with a typing indicator
  before the first token). Deltas are never recorded to history — the
  final `text` frame supersedes them. The server stamps `done` frames
  with `ts` (epoch ms) so turn dividers carry a wall-clock timestamp
  that survives replay.
- `src/cli.ts` — third dispatch branch (`serve`, `hub`,
  `attach-orc`).
- The server's process tree still contains only `serve` (verified
  via `lsof` / `ps`); `claude` is a child of `attach-orc`, never of
  `serve`.
- CLI flags: `--server`, `--label`, `--cwd`, `--client-id`. No
  `--model` / `--claude` knobs — it bridges the `claude` session
  itself. `ORC_BASE_URL` derives the `/agent` URL for a remote serve
  (VPN / ECS); `ORC_CLAUDE_BIN` is a test-only binary override.
- Stream-json → BridgeFrame mapping: `assistant` (text/thinking/
  tool_use) → `text`/`thinking`/`tool_use`; `user` (tool_result) →
  `tool_result`; `permission_request` → `permission_request`;
  `result` → `done`.
- Reconnect with 1-3 s backoff on WS drop. SIGINT/SIGTERM forward
  SIGTERM to `claude`.
- `tests/attach-orc-cli.test.ts` — full round-trip test through a
  mock `claude` binary.

### Phase 7.6 — `/attach-orc` slash command — ✓ DONE

**Goal.** Let the user launch the bridge from inside Claude Code
itself, instead of opening a separate terminal to run the CLI.

- `commands/attach-orc.md` — repo-tracked slash command definition.
  Body tells Claude to run `bun run src/cli.ts attach-orc $ARGUMENTS`
  via the Bash tool. The slash command introduces **no new spawn**
  — it delegates verbatim to the existing Phase 7.5 CLI. The
  server's no-spawn property is unaffected.
- `make setup` — symlinks `commands/attach-orc.md` →
  `~/.claude/commands/attach-orc.md` so `/attach-orc` is available
  in Claude Code globally. `make teardown` removes the symlink.
- README Quick Start updated to document `make setup` first, then
  `/attach-orc` from inside Claude Code (recommended) or
  `bun run src/cli.ts attach-orc` directly (headless fallback).
- `CLAUDE.md` got a new "slash command is a thin front-end" rule.

Reaffirmed constraints:

- `make setup` writes only to `~/.claude/commands/`. It does not
  edit any project file or run a server.
- The slash command's body forwards `$ARGUMENTS` to the CLI; no
  pre-processing, no side effects beyond what the CLI already does.
- Removing the slash command (via `make teardown` or by deleting
  `commands/attach-orc.md`) does not affect the CLI or the server.

### Phase 7.7 — Shared session (`open-rc tui`) — ✓ DONE

**Goal.** One session, driven from BOTH the browser and a terminal.
The realization: a `claude` process has one stdin/stdout, so live
bidirectional sharing requires a single owner and many thin clients —
not two `claude`s. (True live-mirroring of a *native* `claude` TUI is
the private RemoteControl feature open-rc avoids; out of scope.)

- `src/cli/tui.ts` — `open-rc tui`, a terminal front-end that is a
  plain `/ws` client (the same protocol the browser SPA speaks). It
  attaches to a clientId, renders the stream, reads stdin → `send`,
  and handles permissions (`/allow` / `/deny`). It spawns nothing.
- The single `claude` is owned by `attach-orc`; the browser and any
  `tui` windows all attach to the same clientId on `serve`. A prompt
  from any client and the bridge's stream fan out to all → one shared
  conversation.
- Server: on `send`, the relay now broadcasts a `user` frame to every
  attached client (not just the sender), so all views render the same
  prompt from one source of truth. The SPA dropped its optimistic
  local append and renders the echo instead.
- `tests/shared-session.test.ts` — two `/ws` clients attached to one
  bridge both receive the `user` echo and the fanned-out reply.

Reaffirmed constraints:

- `serve`/`hub` stay spawn-free; `tui` is a spawn-free `/ws` client;
  `attach-orc` remains the only `Bun.spawn`.
- The shared session lives entirely in the `attach-orc`-owned
  `claude`. (This phase originally also banned PTY/TTY hijack and
  native-TUI mirroring; that ban was **lifted 2026-07-02** — client-
  side PTY bridging to an existing `claude` is now permitted, so a
  session started in a terminal can be mirrored into the browser.
  `serve` still stays a pure relay that touches no terminal.)

### Phase 7.8 — Session URLs + history-on-attach — ✓ DONE

**Goal.** Address two gaps: a session wasn't addressable (the URL was
always `/`), and attaching showed a blank pane until the next frame.

- **Path routing.** The browser reflects the active session in the URL
  path — `/sessions/<clientId>` via `history.pushState` — with
  `popstate` handling and boot-from-path, so a reload or shared link
  deep-links back. `serve` gained an SPA fallback for `/sessions/*`;
  SPA assets moved to root-absolute paths (`/app.ts`, `/vendor/…`) so
  they resolve under a session subpath.
- **History-on-attach.** `serve` keeps a bounded in-memory buffer
  (`BridgeConn.history`, cap `MAX_HISTORY`) of each connected client's
  relayed conversation frames + echoed `user` prompts (not the
  transient `permission_request`) and replays it to any browser/`tui`
  that attaches. The SPA clears its local transcript on (re)attach so
  the replay repopulates without duplicates. Ephemeral: dropped on
  bridge disconnect, never written to disk — this is the live stream
  the server already relays, NOT the old external-JSONL replay and NOT
  disk persistence.
- `tests/shared-session.test.ts` also exercises the replay path.

Reaffirmed constraints:

- No DISK persistence, no `sessions.json`, no reading `claude`'s
  transcripts. The buffer is in-memory and bounded.
- History is only for a *currently-connected* client; disconnected
  clients keep nothing.

---

## Phase 8 — Quality of life (post-pivot)

**Goal.** Make the post-pivot experience nicer than the pre-pivot
one was.

### Phase 8.1 — PWA install + offline app-shell cache — ✓ DONE

**Scope.**

- Web App Manifest (`/manifest.webmanifest`) with name, short_name,
  start_url, scope, `display: standalone`, theme_color, background
  color, 192 / 512 / maskable-512 / 180×180 icon set, and a `Sessions`
  shortcut.
- App-shell service worker: NetworkFirst for same-origin GETs, with a
  precache fallback so the SPA loads even when the relay is down. The
  `/ws` WebSocket is obviously live-only — offline = shell renders,
  the composer is disabled.
- iOS Safari integration: `apple-mobile-web-app-capable`, status-bar
  style, apple-touch-icon. The SPA surfaces a one-time hint pointing
  at the share-sheet install flow (iOS fires no `beforeinstallprompt`).
- Chrome / Edge / Firefox: custom "Install" button in the sidebar
  header (captured `beforeinstallprompt`), an update prompt on
  `controllerchange` so a new SW actually ships.
- Static-asset serve: `src/serve.ts` accepts `.webmanifest` and sets
  `application/manifest+json` + `cache-control: no-cache` so a manifest
  edit ships without clearing storage.

**Definition of done — ✓ met.**

- Lighthouse PWA installability audit passes; iOS home-screen install
  works end-to-end; the shell loads after `Network → Offline` reload;
  Web Push remains functional (the SW's push handler is preserved).

### Phase 8.2 — Streaming, loading state, turn timestamps — ✓ DONE

**Scope.**

- `attach-orc` passes `--include-partial-messages`; its translator maps
  `stream_event` text deltas to a new `text_delta` frame.
- Server relays `text_delta` live but never records it to history (the
  final `text` frame carries the whole reply).
- SPA renders the streaming partial in a live region with a caret, and
  a typing indicator while busy with nothing streamed yet.
- Server stamps `done` frames with `ts` (epoch ms) so turn dividers
  show a wall-clock time that survives history replay; `tui` shows it too.
- IME guard on the composer (`isComposing` / keyCode 229) so a
  conversion-commit Enter doesn't send.

### Phase 8.3 — `attach-tmux`: mirror an existing terminal `claude` — ✓ DONE

**Goal.** Drive the interactive `claude` the user already started in a
terminal (not a fresh headless one) from the browser, with its live TUI
mirrored. Enabled by lifting the PTY/TTY-hijack ban (client-side only).

**Scope.**

- `src/cli/attach-tmux.ts` — new client-side command. Registers on
  `/agent` like `attach-orc`, but instead of spawning `claude`: polls
  `tmux capture-pane -p -t <target>` on an interval and relays the
  screen as a `screen` frame on change; delivers browser `prompt`
  frames with `tmux send-keys -l -- <text>` + `Enter`. Auto-detects the
  sole claude pane when `--target` is omitted. Fails fast on first
  register (like `attach-orc`). **Never** kills or signals the pane.
- `screen` frame added to the protocol (`BridgeFrame` /
  `RelayedMessage` / `ServerBrowserMessage`). Relayed live; NOT flipped
  to busy (a redraw isn't a turn) and NOT pushed into the history ring
  — instead the server keeps `BridgeConn.latestScreen` (one string) and
  replays it on attach so a late joiner sees a static pane too.
- SPA: a `screen` renders the client as a monospace terminal mirror
  (`<pre class="term-mirror">`, horizontal scroll for wide panes)
  instead of the conversation cards.
- `serve` stays a pure relay: all tmux interaction is in the
  client-side `attach-tmux` process. `ORC_TMUX_BIN` overrides tmux for
  tests.

**Definition of done — ✓ met.**

- Verified end-to-end against a real `claude` in tmux: the browser
  shows the live TUI (`capture-pane`), and a browser prompt reaches the
  real session (`send-keys`) with the reply appearing in both the
  terminal and the browser mirror. `tests/attach-tmux-cli.test.ts`
  covers flag parsing, screen normalization, and the round-trip through
  a mock tmux.

Candidate items (prioritized at the start of the phase):

- **Inline label editing.** The bridge registers a label; the
  browser can rename it (the server propagates). Persistence is
  the bridge's problem; the server just keeps the live label.
- **Sidebar search / filter.** When you have 10 bridges connected
  across a few hosts, a small filter input in the sidebar is nice.
- **Sidebar sort.** By lastActivity (default), by status, by cwd.
- **Sidebar grouping by host.** Either the bridge sends `host` on
  register (extending the protocol — non-breaking), or the server
  tags the client with the source IP. Decide based on what hub
  mode needs.
- **History nudge.** When you re-attach to a client after a pause,
  a small "X new messages" pill at the top of the chat pane lets
  you scroll down at once.
- **Reference bridges.** Ship a `examples/` directory with two or
  three tiny reference bridges (Bun script that pipes stdin,
  `websocat` wrapper, tmux capture-pane). Not part of the CLI;
  documented but optional.

---

## Things we explicitly will not do

These would each be their own multi-month project. They are noted
here so future contributors don't accidentally scope-creep into them.

- **Reimplementing the Claude Code agent loop.** The user runs the
  CLI.
- **Reimplementing the Anthropic Messages API.**
- **A full claude.ai clone.** Minimal chat UI is the goal.
- **A hosted SaaS.** Anyone self-hosts.
- **Mobile apps in the App Store.** PWA or Tauri, not native.
- **Provider adapters.** The CLI handles provider differences via
  `ANTHROPIC_BASE_URL`; we don't replicate that logic.
- **Anthropic OAuth / Trusted Device issuer.** Out of scope by
  design.
- **Process discovery of external `claude` instances.** Banned by
  design.
- **Server-side spawn.** Banned by design.
- **A client tool that wraps `claude`.** Banned by design. The
  user builds their own bridge.
- **Browser-side session creation.** Banned by design. The browser
  shows what bridges are currently connected; it cannot spawn one.

---

## Risks & mitigations

| Risk | Phase | Mitigation |
| ---- | ----- | ---------- |
| stream-json schema changes between CLI releases | 1, 2 | Pin a known-good CLI version in docs; reference implementation in `src/session/stream-json.ts` updated when the schema breaks. The server is byte-pass-through and doesn't care. |
| Subprocess hangs (e.g., API timeout) | n/a | The server has no subprocesses. The user's `claude` may hang; that's the user's problem. Documented. |
| Bun 1.x API churn | 1 | Pin minimum Bun version; document it. |
| 3P provider (Deepseek/GLM/MiniMax) doesn't support tool use | n/a | The CLI surfaces errors via stream-json. The user's bridge forwards them. We don't replicate provider logic. |
| Multiple bridges on the same cwd race for the same sessionId | 7 | Not the server's problem — the server is byte-pass-through. The user's bridges sort it out. |
| Server restart loses the in-memory client map | 7 | Clients reconnect on a short backoff and re-register; the server reconstructs the map. No state to lose. |
| Hostile local user spoofs a client id on `/ws` | 7 | Local-only mode binds 127.0.0.1. Hub mode requires device enrollment before `/ws` is reachable. Document the threat in SECURITY.md. |
| Two servers on the same port | 7 | Documented. `--port` is single-instance; pick a different port. |
| Server accidentally re-introduces spawn | 7+ | CI check: `grep -rn "Bun.spawn" src/serve.ts src/cli.ts src/ws.ts` must return zero. Block the PR if it doesn't. |
| "Just add a bridge command, it's small" temptation | 8+ | Don't. Bridges grow. The CLI surface area stays at `serve` + `hub` forever. |
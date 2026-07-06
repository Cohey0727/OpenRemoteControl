# Open Remote Control — Roadmap

> **Last revised:** 2026-07-06. The server is a pure WebSocket relay:
> it runs no processes, walks no process table, takes over nothing.
> The CLI exposes `serve`, `hub`, `tui`, `attach-orc`, `channel`, and
> `hook` — none launch a process (`channel` is itself spawned by
> claude's own MCP machinery, never by open-rc).

> **⚠ 2026-07-02 — process-launching helpers removed.** The phases
> below that shipped CLI commands which started processes — **Phase
> 7.5 `attach-orc`** (launched `claude`), **Phase 7.6 `/orc`**
> (its slash command), and **Phase 8.3 `attach-tmux`** (drove `tmux`
> to mirror a pane) — were **removed** at the user's direction:
> starting processes is out of scope. The entries are kept below as a
> record of what was built and why, not as current features. (Phase
> 8.2's streaming/`text_delta`/timestamp work and the `tui`
> shared-session work survive.)
>
> **Phase 8.4 (same day) reintroduced the `attach-orc` NAME with the
> opposite mechanics**: it shares the ALREADY-RUNNING session it is
> invoked from, by tailing the session's own transcript and delivering
> browser prompts through Claude Code hooks — zero spawning. See
> Phase 8.4 below; it is the current, shipped design.

---

## 0. Phasing principle

Each phase ends with something a real person can use. We don't ship
a phase until its deliverable runs end-to-end and the user can
demonstrate the value described in that phase's "Definition of done."

The approach is fixed: `orc serve` is a pure WebSocket relay.
It does not start or manage `claude`. The user runs `claude`
themselves and brings their own bridge. See
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

- `orc serve` (default command).
- Binds `127.0.0.1:7322` (configurable via `--port`).
- Bun.serve hosting the SPA + WebSocket on `/ws` (browsers) and
  `/agent` (user-owned bridges).
- SPA = vanilla TypeScript with a small signal implementation,
  served via `Bun.Transpiler` for `.ts` files (no UI build step).
  The one render dep (`marked`) is vendored locally; no CDN.

**Definition of done — ✓ met.**

- `bun run src/cli.ts serve --port 7322` boots in <500 ms.
- User opens `http://127.0.0.1:7322`, sees the SPA.
- The server starts no processes. `pgrep -f open-rc` returns
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

**Goal.** A self-hostable public deployment that many `orc serve`
instances dial into, and many browser/mobile clients attach to.

**Scope.**

- `orc hub` command: same binary, different mode.
- WSS listener (TLS via `bun:tls`).
- bun:sqlite schema for registered devices, sessions, audit log.
- Ed25519 device enrollment: first run, generate keypair, print
  enrollment URL; user opens URL in browser, confirms pairing,
  device is registered.
- Optional Tailscale or Cloudflare Tunnel integration docs.

**Definition of done — ✓ met.**

- Two `orc serve` instances on different machines dial into one
  `orc hub`.
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

## Phase 7 — Pure-relay pivot — ✓ DONE

**Goal.** `orc serve` is a pure WebSocket relay. It starts and
manages nothing. The user runs `claude` themselves and brings their
own bridge.

This is a **cleanup phase**, not a feature phase. The hard work
(subprocess management, persistence, take-over logic) is being
*removed* from open-rc and pushed back to the user, where it
belongs.

**Scope.**

- **Remove `orc attach` from the CLI.** Delete `src/attach.ts`
  if present, remove from `src/cli.ts` dispatch, remove from
  `package.json` `bin` aliases (none should exist).
- **Remove `src/session/subprocess.ts`.** This was the class that
  launched the `claude` subprocess. Delete it.
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
- **Update `src/serve.ts`.** Remove the boot-time auto-launch path
  and the `sessions.json` rehydration path. The server does no
  on-start work.
- **Update `src/cli.ts`.** Remove the `attach` command branch
  (including the historical `attach-orc` alias). The CLI surface
  shrinks to exactly `serve` and `hub`.
- **Update `package.json`.** Remove the `dev` script's `--cwd` flag
  pass-through (it implied a default cwd for a launched subprocess).
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
    bridge (not a launched subprocess). The mock bridge opens a
    WebSocket and sends canned frames; the test asserts the server
    routes them to attached browsers.
  - Update `tests/claim-endpoint.test.ts` (or delete it) to assert
    there is no `/api/external-sessions` endpoint.
- **Static checks.**
  - A static scan of `src/serve.ts`, `src/cli.ts`, and `src/ws.ts`
    for process-launch calls returns zero matches.
  - `grep -rn "ps" src/serve.ts src/cli.ts src/ws.ts` returns only
    matches in unrelated identifiers (e.g., a string literal that
    happens to contain "ps"). Walk the matches and confirm none of
    them invoke `ps`, `lsof`, or `child_process`.
  - A scan of `src/` for process-launch calls returns zero matches
    except inside `node_modules` or comments referencing the
    historical constraint.
  - `grep -rn "subprocess" src/` returns zero matches except in
    comments referencing the historical constraint.
- **Documentation.** Already complete in this phase — `CLAUDE.md`,
  `README.md`, `docs/architecture.md`, `docs/roadmap.md` (this
  file), `docs/tech-stack.md`, `docs/survey.md`, `SECURITY.md` all
  reflect the pure-relay model with no contradictions and no
  lingering process-launch references.

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

- `orc serve` starts no processes. `pgrep -f claude`
  shows zero results immediately after `serve` boots.
- A static scan of `src/serve.ts`, `src/cli.ts`, and `src/ws.ts`
  finds no process-launch calls.
- A scan of `src/` for process-launch calls returns zero matches
  except in comments that explicitly note the historical constraint.
- The CLI surface is exactly `serve` and `hub`. `orc attach`
  and `orc attach` are unknown commands. *(Superseded by
  Phase 7.5 — see above.)*
- The UI has no "+ New session" button and no "× Remove" button.
  The sidebar is passive.
- Tests pass with ≥80% coverage on the server. `make verify` is
  green.
- README Quick Start works in <5 minutes: install Bun, run
  `bun run start`, open the URL, see a working UI. (The user
  brings their own `claude` and bridge; that part is documented but
  not part of the Quick Start.)
- Scanning `docs/`, `CLAUDE.md`, `README.md`, and `SECURITY.md` for
  process-launch terms, `subprocess`, or `attach-orc` returns zero
  matches except in sections that explicitly forbid the term.

---

## Phase 7.5 — `orc attach` CLI (third command) — ✓ DONE, ✗ REMOVED 2026-07-02

**Goal.** Give the user a one-liner to drive a CLI-launched `claude`
session from the browser without writing a bridge by hand. The
command is named `attach-orc` (`orc` = "open remote control").

Phase 7 deleted the historical `orc attach` to enforce the
"server never launches processes" rule. This phase re-adds an attach
entry point as a **CLI** command — `attach-orc` — a separate process
the user runs in their terminal — so the server itself launches
nothing while the user gets an obvious attach path.

- `src/cli/attach-orc.ts` — parses flags, launches
  `claude --print --input-format stream-json --output-format
  stream-json --verbose`, bridges its stdio ↔ `/agent` WS. (Switched
  from `--bare` on 2026-07-02: bare-mode auth is strictly
  `ANTHROPIC_API_KEY`, which broke OAuth-login machines.)
- Fail-fast: if the FIRST registration doesn't complete within 10 s
  (serve down, bad URL, clientId collision), exit(1) with the reason —
  the `/orc` slash command reads an early exit as "serve isn't
  running". After a successful registration, reconnects retry forever.
  `ORC_REGISTER_TIMEOUT_MS` overrides the deadline (tests only).
- Streaming: `--include-partial-messages` is part of the launch args;
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

### Phase 7.6 — `/orc` slash command — ✓ DONE, ✗ REMOVED 2026-07-02

**Goal.** Let the user launch the bridge from inside Claude Code
itself, instead of opening a separate terminal to run the CLI.

- `commands/orc.md` — repo-tracked slash command definition.
  Body tells Claude to run `bun run src/cli.ts attach-orc $ARGUMENTS`
  via the Bash tool. The slash command launches **nothing new** — it
  delegates verbatim to the existing Phase 7.5 CLI, so the server's
  pure-relay property is unaffected.
- `make setup` — symlinks `commands/orc.md` →
  `~/.claude/commands/orc.md` so `/orc` is available
  in Claude Code globally. `make teardown` removes the symlink.
- README Quick Start updated to document `make setup` first, then
  `/orc` from inside Claude Code (recommended) or
  `bun run src/cli.ts attach-orc` directly (headless fallback).
- `CLAUDE.md` got a new "slash command is a thin front-end" rule.

Reaffirmed constraints:

- `make setup` writes only to `~/.claude/commands/`. It does not
  edit any project file or run a server.
- The slash command's body forwards `$ARGUMENTS` to the CLI; no
  pre-processing, no side effects beyond what the CLI already does.
- Removing the slash command (via `make teardown` or by deleting
  `commands/orc.md`) does not affect the CLI or the server.

### Phase 7.7 — Shared session (`orc tui`) — ✓ DONE

**Goal.** One session, driven from BOTH the browser and a terminal.
The realization: a `claude` process has one stdin/stdout, so live
bidirectional sharing requires a single owner and many thin clients —
not two `claude`s. (True live-mirroring of a *native* `claude` TUI is
the private RemoteControl feature open-rc avoids; out of scope.)

- `src/cli/tui.ts` — `orc tui`, a terminal front-end that is a
  plain `/ws` client (the same protocol the browser SPA speaks). It
  attaches to a clientId, renders the stream, reads stdin → `send`,
  and handles permissions (`/allow` / `/deny`). It starts no processes.
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

- `serve`/`hub` launch nothing; `tui` is a `/ws` client that starts
  no processes; `attach-orc` remains the only place that launches a
  subprocess.
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
- Aggressive background updates (2026-07-03): the server stamps
  `/sw.js` with a `shell-rev` fingerprint of `ui/` so any shell change
  is an SW update (no manual `CACHE_VERSION` bump); the SPA runs
  `registration.update()` every 5 min + on foreground-resume + on
  `online`; the SW `skipWaiting()`s after precache; the page reloads
  on `controllerchange`, parking/restoring the composer draft via
  `sessionStorage`.

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

### Phase 8.3 — `attach-tmux`: mirror an existing terminal `claude` — ✓ DONE, ✗ REMOVED 2026-07-02

**Goal.** Drive the interactive `claude` the user already started in a
terminal (not a fresh headless one) from the browser, with its live TUI
mirrored. Enabled by lifting the PTY/TTY-hijack ban (client-side only).

**Scope.**

- `src/cli/attach-tmux.ts` — new client-side command. Registers on
  `/agent` like `attach-orc`, but instead of launching `claude`: polls
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

### Phase 8.4 — Shared session: `/orc` transcript bridge + hook delivery — ✓ DONE (2026-07-02)

**Goal (user requirement, translated from the Japanese original).**
Fully share the session between the browser and the CLI: a session
that ran `/orc` appears in the sidebar; clicking it shows the
history and lets you send messages; both the CLI and the browser can
read and send. **Not by spawning** — the session being shared is the
one the user is already sitting in.

**Mechanics (zero spawning, kept forever).**

- `orc attach` (`src/cli/attach.ts`) resolves the newest
  transcript JSONL for its cwd (`src/transcript/locate.ts` — the
  session that just ran `/orc` modified its transcript last),
  registers on `/agent` with **clientId = session id** (stable deep
  links), replays the transcript as history (translate:
  `src/transcript/translate.ts`; capped at `MAX_REPLAY_FRAMES`), then
  tails it live (`src/transcript/tail.ts`, 300 ms polling).
- Browser/tui → session: `prompt` frames are appended to
  `~/.open-rc/attach/<sessionId>/queue.ndjson`
  (`src/attach/state.ts`). The Claude Code hooks
  (`src/cli/attach-hooks.ts`, installed by `make setup` via
  `scripts/install-hooks.ts`) deliver them: **Stop** touches a marker
  (→ bridge sends `done`) and drains the queue, answering
  `{"decision":"block","reason":<messages>}` so the session responds;
  while `attached.count > 0` it lingers (default 45 s,
  `ORC_STOP_LINGER_MS`) polling for late prompts. **UserPromptSubmit**
  attaches queued prompts as `additionalContext`. **SessionEnd**
  touches the end marker; the bridge unregisters and exits.
- Protocol additions: bridge → server `user` frame (transcript-replayed
  CLI prompts; `[open-rc]`-marked injections are filtered to avoid
  double render), server → bridge `attached { count }`.
- Hooks are instant no-ops without a fresh bridge heartbeat
  (`bridge.json`, 15 s cadence / 45 s staleness), so unshared sessions
  pay nothing.

**Definition of done.** ✓ `make setup` installs launcher + hooks +
command; `/orc` in a running session → sidebar row (session id)
→ click → full history → browser send → session responds at the next
hook moment → response visible in browser, terminal, and `tui`.
Integration-tested in `tests/attach-bridge.test.ts` (in-process
serve + fixture transcript; no child processes in the test suite).

**Accepted limitation.** A browser message sent while the session is
idle past the linger window waits for the next session activity (next
CLI prompt or turn). Waking an idle interactive `claude` would require
PTY/tmux/stdin tricks — permanently banned.

### Phase 8.5 — Channels sharing: `orc channel` (Issue #11 O4) — ✓ DONE (2026-07-06)

**Goal.** Erase Phase 8.4's accepted idle blind spot for sessions the
user is willing to start with sharing in mind, using Claude Code's own
**Channels** mechanism (research preview, claude v2.1.80+) — option O4
of Issue #11, chosen precisely because claude spawns the channel
server itself, so open-rc's no-spawn rule holds (O1/O2 spawned and
were rejected).

**Mechanics (still zero spawning by open-rc).**

- `orc channel` (`src/cli/channel.ts`) is an MCP channel server
  (`src/channel/mcp.ts`, stdio) that claude spawns from the
  `mcpServers.orc` entry `make setup` registers in `~/.claude.json`
  (`scripts/install-channel.ts`, idempotent). The user enables it per
  session: `claude --dangerously-load-development-channels server:orc`.
- Browser prompts (relayed over the same `/agent` WS) are pushed into
  the session as `notifications/claude/channel` events —
  **instantly, even while the session is idle**. No hook window, no
  queue, no terminal capture; the Stop hook short-circuits on
  `channel.marker`.
- Permission relay: tool-approval dialogs mirror to the browser as
  `permission_request`; the viewer's verdict returns as a channel
  permission notification (first answer, terminal or remote, wins).
- Session→browser stays the transcript replay + tail shared with
  `orc attach`, discovered lazily (`src/channel/discover.ts`) because
  claude spawns the channel before the session writes its first line.

**Definition of done — ✓ met (verified empirically 2026-07-06, claude
v2.1.201).** (a) Prompt delivered to a fully idle session that had
never taken a turn — no blind spot; (b) permission-relay round trip —
browser approved a Bash/curl call, terminal dialog closed, tool ran;
(c) **third-party provider**: MiniMax-M3 via
`ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic` registered the
channel and answered an idle channel prompt — the core use case Remote
Control cannot serve. Go.

**Accepted risk.** Channels is a research preview: the
`--dangerously-load-development-channels` flag is required (custom
channels are not on Anthropic's allowlist), the protocol contract may
change between CLI releases, and Team/Enterprise orgs must enable
`channelsEnabled`. Channel events are dropped silently when the
channel isn't enabled — the bridge emits an `error` frame after ~20 s
of visible silence. `/orc` (Phase 8.4) stays shipped as the fallback
for sessions already running without the flag.

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
- **Server-side process launching.** Banned by design.
- **A client tool that wraps `claude` (owns its stdio / lifecycle).**
  Banned by design. `attach-orc` shares a session from the outside
  (transcript + hooks); anything that needs to own the process is a
  user-built bridge.
- **Browser-side session creation.** Banned by design. The browser
  shows what bridges are currently connected; it cannot start one.

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
| Server accidentally re-introduces process launching | 7+ | CI check: a static scan of `src/serve.ts`, `src/cli.ts`, and `src/ws.ts` for process-launch calls must return zero. Block the PR if it doesn't. |
| "Just add a bridge command, it's small" temptation | 8+ | The one sanctioned bridge is `attach-orc`, and it is structurally incapable of spawning (no child_process anywhere). Any new helper must keep that property. |
| Stop-hook linger blocks the terminal after each turn | 8.4 | Linger runs only while a viewer is attached, defaults to 45 s, is env-tunable (`ORC_STOP_LINGER_MS`), and Esc skips it. |
| Browser message to an idle session past the linger window | 8.4 | Documented, accepted: delivered at the next session activity. Never "fixed" with PTY/tmux. `orc channel` (8.5) removes the blind spot for sessions started with Channels enabled. |
| Channels protocol changes / preview flag removed | 8.5 | Research preview, documented as such. `/orc` (8.4) remains the flag-free fallback; the channel bridge is additive and can be re-pinned or dropped without touching the relay. |
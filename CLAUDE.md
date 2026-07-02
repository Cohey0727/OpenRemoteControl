# CLAUDE.md

Project memory for Claude Code (and any future Claude agents) working
on open-rc. Read this before changing anything.

---

## Project goal

**Share an ALREADY-RUNNING Claude Code session with a browser —
including a phone. The goal is to share an existing session, NOT to
spawn a new one.**

The user already has a `claude` running (in a terminal, however they
like). open-rc's job is to make *that* session visible and driveable
from a browser: the browser sees the live stream and can send prompts,
and those prompts land in the same running session. open-rc does not
start `claude`, does not own it, does not manage its lifecycle.

> **Spawning is out of scope right now.** A command that spawns
> `claude` (or spawns `tmux`/a PTY to mirror one) may be built in the
> future, but it is **not needed now and must not exist in the current
> codebase.** There is no `Bun.spawn`, no `child_process`, no `fork`,
> no `exec`, no PTY, no tmux anywhere in the project today. If you
> think you need to spawn something, stop — the answer is a
> user-provided bridge, not a spawn.

`open-rc` is a single thing: `open-rc serve`, a pure WebSocket relay.
It does not spawn `claude`. It does not manage `claude`. It does not
know `claude` is a process. The user runs `claude` themselves, and
arranges for its `stream-json` to flow over a WebSocket to `open-rc
serve`. The browser connects to `open-rc serve`, sees the connected
streams, and sends prompts back.

```
┌──────────┐  WS(/ws)  ┌────────────────┐  WS(client)  ┌────────────────────┐
│ Browser  │◀────────▶│ open-rc serve   │◀────────────▶│ user-owned bridge   │
│  SPA     │  frames  │ (pure relay)    │   frames     │ (whatever pipes     │
└──────────┘          │                 │              │  claude's stdio to  │
                      │  - clients[]    │              │  a WebSocket)       │
                      │  - routes       │              └──────────┬──────────┘
                      └────────────────┘                         │
                                                                 │ user owns this
                                                                 ▼
                                                          ┌─────────────┐
                                                          │ claude      │
                                                          │  (user's    │
                                                          │   process)  │
                                                          └─────────────┘
```

The motivation: Claude Code's native RemoteControl is locked to
claude.ai OAuth + Trusted Device enrollment, so non-Anthropic
providers (Deepseek, GLM, MiniMax, etc.) can't ride it. open-rc
rebuilds the same UX against any provider by relaying the public
`stream-json` wire format. The relay itself doesn't care what feeds it.

The user owns the bridge from `claude` to a WebSocket. `open-rc
serve` does not provide one. That is the user's responsibility —
because the moment we ship a bridge, we'd be tempted to spawn
`claude` for them, and spawning is out of scope.

---

## Required features (must ship)

- **Sidebar of currently-connected clients.** 300 px sidebar on the
  left, always visible on desktop, slides in/out on mobile. Each row
  = one currently-open WebSocket to `open-rc serve` from a user's
  bridge. Columns: status dot, client label, abbreviated cwd,
  last-activity timestamp.
- **Multiple concurrent clients.** The server holds N clients at once.
  Each client has its own clientId, label, cwd, status, and
  lastActivity. Clicking a row attaches the UI to that client's
  stream.
- **Browser → client prompt routing.** The browser sends
  `attach { clientId }` to start receiving that client's frames,
  then `send { clientId, text }` for prompts. The server forwards the
  prompt as a `send` frame on the client WS.
- **Client → browser event routing.** Whatever the bridge sends on
  the client WS (typically translated `stream-json` frames) is fanned
  out to every browser that has attached to that clientId.
- **Permission forwarding (server-side support).** When a client
  sends `permission_request`, the server forwards it to every
  attached browser. The browser replies with `permission_response
  { clientId, requestId, approved }`. The server forwards it back to
  the client. Whether permission forwarding is actually used depends
  on the user's bridge (e.g., whether their bridge wires a
  PreToolUse hook into `claude`); the server just relays.
- **Detach.** Browser sends `detach`. The server unsubscribes the
  browser from that clientId. Other browsers and the client are
  unaffected.
- **Disconnect detection.** When a client WS closes, the server
  marks the client as `exited` and broadcasts `clients_changed`.
- **Mobile.** Sidebar collapses; selecting a row slides the chat
  pane in from the right; a back button in the chat header slides
  the sidebar back in. No drawer, no toggle — sliding panes.
- **Web Push** (already shipped, keep). When a session emits `done`,
  subscribed browsers get a notification with a snippet of the result.
- **Hub mode** (already shipped, keep). Optional relay so multiple
  devices / multiple users can drive the same set of clients.

---

## Explicit non-features (do NOT implement)

- **No spawning anywhere — not just the server, the WHOLE project.**
  Nothing in open-rc may call `Bun.spawn`, `child_process.spawn`,
  `posix_spawn`, `fork`, `exec`, or any equivalent. Nothing walks
  `ps`, `lsof`, `/proc`, or any process table. Nothing signals any
  process (SIGTERM, SIGKILL, SIGINT, SIGHUP). No PTY, no tmux. If the
  user has a `claude` running in another terminal, open-rc knows
  nothing about it beyond whatever frames a user-owned bridge chooses
  to send over a WebSocket. The CLI surface is exactly `serve`, `hub`,
  and `tui` — all three spawn nothing. There is no `open-rc spawn`, no
  `open-rc client`, no `attach-orc`, no `attach-tmux`.
- **Spawning is a possible FUTURE feature, absent TODAY.** A command
  that spawns `claude` (or spawns `tmux`/a PTY to mirror an existing
  terminal session) may be built later if a real need appears. It is
  not needed now — sharing an already-running session is the goal — so
  it does not exist in the current codebase. `attach-orc` (spawned
  `claude`) and `attach-tmux` (spawned `tmux` to mirror a pane) were
  built and then **removed on 2026-07-02** at the user's direction:
  spawn is out of scope. Do not re-add a spawner because it seems
  convenient; adding one is a deliberate, requested decision.
- **`make setup` registers the `open-rc` launcher on PATH.** It writes
  one launcher script to `~/.local/bin` (override `BIN_DIR`):
  `#!/bin/sh; exec bun run <checkout>/src/cli.ts … "$@"`, so the
  abs-path anchor lives in the launcher and a `git pull` updates
  behavior with no reinstall. `make teardown` removes it (and cleans up
  the removed `attach-orc` launcher and `/attach-orc` command symlink
  if an older setup left them). No spawn — the launcher just wraps the
  existing CLI.
- **`open-rc tui` is a terminal front-end, not a bridge.** `tui` is a
  plain `/ws` client — the SAME protocol the browser SPA speaks. It
  attaches to a clientId and renders/sends frames; it spawns nothing
  and owns no `claude`. Its purpose is a **shared session**: a
  user-owned bridge feeds one running `claude` to `/agent`, and the
  browser and one or more `tui` clients all attach to the same
  clientId, so a prompt from any of them is echoed to all (the server
  broadcasts a `user` frame on `send`) and the stream fans out to all.
  This is how "drive from the browser AND the CLI" is one conversation.
  It never touches `claude`'s stdio.
- **No reverse-engineering the bridge protocol.** open-rc talks to
  the public `--input-format stream-json --output-format stream-json`
  mode only. The private RemoteControl protocol and
  `wss://bridge.claudeusercontent.com` are off-limits.
- **No TTY splicing / PTY hijacking in the codebase.** open-rc ships
  no code that attaches to another process's controlling terminal,
  uses `TIOCSTI`/`TIOCSWINSZ`, or reverse-engineers claude's IPC. (A
  future spawner might mirror a terminal — see the goal — but that is
  speculative and absent today.) A `claude` in a terminal is a black
  box; open-rc only ever sees frames a user-owned bridge sends.
- **History = replay the live stream it's already relaying, in memory
  only.** The server keeps a bounded, per-connected-client ring buffer
  of the conversation frames it relays (`BridgeConn.history`, cap
  `MAX_HISTORY`) — text / thinking / tool_use / tool_result / done /
  error plus echoed `user` prompts, NOT the transient
  `permission_request` and NOT streaming `text_delta` fragments (the
  final `text` frame carries the same content; replaying both would
  render the reply twice) — and replays it to any browser/`tui` that
  attaches, so a reload or a late joiner sees the conversation so far
  instead of a blank pane. This is NOT the old external-JSONL replay
  (still gone) and NOT disk persistence: the buffer is dropped when the
  bridge disconnects and is never written to disk. The server still
  does not read `claude`'s transcript files or own sessions it isn't
  relaying.
- **No DISK persistence on the server.** Mutable state is the in-memory
  `clients` map and each client's in-memory `history` buffer. Restart
  the server, lose both; clients reconnect and the map + fresh history
  rebuild. No sessions.json, no SQLite for sessions, no
  VAPID-persisted-server-side state beyond what the push subsystem needs.
- **No session creation or destruction by the server or browser.**
  The sidebar is *passive* — it shows what bridges are currently
  connected. Adding/removing a row in the sidebar does not start or
  stop anything.

---

## Wire protocols (one sentence each)

There is exactly one wire protocol boundary: browser ↔ `open-rc serve`
on `/ws`. The server is protocol-agnostic about what the *other* side
of a client WebSocket looks like — whatever the user's bridge sends
is what gets relayed.

- **Browser → Server (`/ws`).** Pick which client to watch, forward
  user prompts and permission decisions. Frames: `list_clients`,
  `attach`, `detach`, `send`, `permission_response`.
- **Server → Browser (`/ws`).** Broadcast the live client list,
  forward frames from the client the browser is watching. Frames:
  `clients_changed`, `client_registered`, `client_removed`,
  `client_list`, a `user` frame (the server's echo of any client's
  `send`, so every attached view renders the same prompt — this is
  what keeps a shared session in sync), plus whatever per-client
  frames the user's bridge sends (text / text_delta / thinking /
  tool_use / tool_result / permission_request / done / error, tagged
  with the clientId they came from). `text_delta` is a streaming
  fragment of the in-progress reply — a bridge that has a token stream
  can send these (e.g. from `claude --include-partial-messages`) and
  the browser renders them live with a typing indicator while waiting;
  the server stamps `done` frames with a `ts` so turn dividers show a
  wall-clock time even on replay. The `tui` command speaks this exact
  same `/ws` protocol — it is just another attached client.

The server does not define a client-side protocol. A client WS that
speaks any framed WebSocket messages at all will work, because the
server's job is to forward them.

---

## Architecture summary

`open-rc serve` is a Bun.serve instance with one WebSocket upgrade
route:

- `GET /ws` — browsers (and `tui`) connect here. The server reads
  `attach` / `list_clients` / `send` / `permission_response` and
  routes frames to/from the right client WS.
- `GET /agent` — user-owned bridges connect here.
- `GET /` and `GET /sessions/<id>` both serve the SPA shell. The
  browser reflects the active session in the URL path
  (`/sessions/<clientId>`, via `history.pushState`), so a reload or a
  shared link deep-links back to that session; the server's SPA
  fallback returns index.html for those paths. SPA assets are loaded
  with root-absolute paths (`/app.ts`, `/vendor/…`) so they resolve
  under a session subpath.

The server is a stateless relay beyond the in-memory `clients` map.
It does not spawn processes. It does not walk the process table. It
does not know what `claude` is.

The UI is a vanilla TypeScript SPA (`ui/app.ts`, no build step) with
a small home-grown signal implementation. Sidebar + chat-pane,
hand-rolled CSS with a token system. The one render dep (`marked`)
is vendored under `ui/vendor/` and resolved via importmap; assistant
markdown is sanitized before it touches innerHTML.

The user runs `claude` themselves. The user arranges a bridge if they
want one. open-rc does not help with that.

---

## Past mistakes to avoid

- **Don't add a bridge command.** Even if it's "convenient". Even if
  it "just reads stdin/stdout". A bridge is one step from a spawn,
  and spawn is forbidden. The user's machine, the user's pipes, the
  user's problem.
- **Don't ship a single-session UI.** Multi-client is the whole
  point — the sidebar is non-negotiable.
- **Don't strip features because the user complained about one
  thing.** When feedback says "the icon is too small", the answer is
  to fix the icon, not to delete the whole feature.
- **Don't translate "X is banned" as "X must be removed".** "Takeover
  banned" means "don't kill other processes", not "remove the sidebar
  that lists clients". Takeover = external. Sidebar = currently-
  connected clients. Different things.
- **Don't add a "+ New session" button in the browser.** Clients are
  user-owned; the server doesn't create them. The sidebar is
  *passive* — it shows what bridges are currently connected.
- **Don't ask the user what they mean by obvious things.** If the
  user says "ローカルでclaude起動", they mean "I run claude on my
  host machine", not "open-rc spawns claude".
- **Don't write code before the docs agree.** When the model isn't
  settled, write the design doc first. Code is downstream of docs.
- **Don't leave spawn references in comments.** If a comment mentions
  "spawn" or "subprocess" in a serving context, remove it. The
  constraint is the constraint.
- **If a future spawner is ever built, spawn `claude --print`, NOT
  `--bare`.** (Kept as a hard-won note; no spawner exists today.) Bare
  mode's Anthropic auth is strictly `ANTHROPIC_API_KEY`/`apiKeyHelper`
  (OAuth and keychain are never read), so on a subscription-login
  machine every prompt returns "Not logged in". `--print
  --input-format stream-json --output-format stream-json --verbose` is
  the same public wire format but resolves auth like the user's own
  `claude -p`. (Learned while `attach-orc` existed, 2026-07-02.)

---

## Style reminders

- Bun + TypeScript strict, vanilla TS SPA with a tiny signal
  implementation, importmap for vendored `marked` (no build step).
  See README for the canonical setup.
- `bun run build` (which calls `bun build --compile`) is for
  **distribution only** — it produces a single-file executable for
  users without Bun. It is NOT required to run the server in
  development. Launch the server with `bun run src/cli.ts serve`
  or `make serve`.
- Immutability, small files (200–400 lines), comprehensive error
  handling, zod for wire-protocol validation.
- Documentation follow-up is mandatory when code changes — update
  README, docs/roadmap, docs/architecture, docs/survey,
  docs/tech-stack, SECURITY.md, and this file in the same task.
- **Commit every change immediately, without being asked, and push.**
  After any substantive edit (once lint/typecheck/tests are green),
  `git add -A && git commit` and `git push` right away — never leave
  the working tree dirty, never wait for the user to say "commit". The
  user granted standing authorization for this repo (do not prompt).
  Commit message format: `<type>: <concise Japanese summary> @<branch>`
  (type ∈ feat/fix/refactor/chore/docs/test), subject line only.
- The CLI exposes three commands: `serve`, `hub`, and `tui` — all
  spawn-free. `serve` and `hub` are byte-pass-through relays; `tui` is
  a `/ws` client that shares a relayed session with the browser. There
  is no `attach-orc`, no `attach-tmux`, no `attach`, no `pipe`, no
  `client`, no `spawn` — spawning is out of scope (see Project goal).
- PWA assets follow the same no-build-step rule: `ui/manifest.webmanifest`
  and the icon PNGs are checked in as static files and served
  straight off disk. `scripts/build-icons.ts` is a maintainer-only
  helper (re-rasterises `ui/icon.svg` → icon PNGs); it is never run
  on the server boot path. `scripts/build.ts` (distribution cross-
  compile) does not touch UI assets — the no-UI-build rule survives
  PWA unchanged.
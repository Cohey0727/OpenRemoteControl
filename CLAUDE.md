# CLAUDE.md

Project memory for Claude Code (and any future Claude agents) working
on open-rc. Read this before changing anything.

---

## Project goal

**Operate a locally-running Claude Code from a browser — including a
phone.**

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
rebuilds the same UX against any provider by talking to the public
`claude --print` stream-json mode. The relay itself doesn't care what
feeds it.

The user owns the bridge from `claude` to a WebSocket. `open-rc
serve` does not provide one. That is the user's responsibility —
because the moment we ship a bridge, we'd be tempted to spawn
`claude` for them, and spawn is forbidden.

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

- **No spawning in the server. Ever.** `open-rc serve` MUST NOT call
  `Bun.spawn`, `child_process.spawn`, `posix_spawn`, `fork`, `exec`,
  or any equivalent. It MUST NOT walk `ps`, `lsof`, `/proc`, or any
  process table. It MUST NOT signal any process (SIGTERM, SIGKILL,
  SIGINT, SIGHUP) under any circumstance. If the user has a
  `claude` running in another terminal, `open-rc serve` knows
  nothing about it. There is no `open-rc spawn` command. There is
  no `open-rc client` command. The server-side CLI surface is
  exactly: `serve` and `hub`. (The client-side commands are
  `attach-orc` — the only spawner — and `tui`, a pure `/ws` client
  that spawns nothing.)
- **`open-rc attach-orc` is a CLI command, not a server feature.**
  `open-rc attach-orc` (the third command, `orc` = "open remote
  control") is a separate process the user runs in their terminal.
  It is the ONLY place in the project that calls `Bun.spawn` for
  `claude`. The server remains spawn-free. `attach-orc` owns its
  `claude` subprocess (lifecycle, signals, stdio) and merely
  forwards frames to the running `serve` over `/agent`. Removing
  it does not change the server's no-spawn property. It bridges the
  `claude` session **itself** — there are no `--model` / `--claude`
  passthrough knobs (removed as noise). Its flags are exactly
  `--server`, `--label`, `--cwd`, `--client-id`. To attach to a
  remote serve (VPN / ECS / anywhere), set `ORC_BASE_URL` and the
  `/agent` WebSocket URL is derived from it (`http`→`ws`,
  `https`→`wss`). `ORC_CLAUDE_BIN` overrides the `claude` binary for
  tests only; it is not a user-facing flag.
- **`make setup` registers `attach-orc`/`open-rc` on PATH; the
  `/attach-orc` slash command is a symlink that calls them.**
  `make setup` writes launcher scripts to `~/.local/bin` (override
  `BIN_DIR`) — each is `#!/bin/sh; exec bun run <checkout>/src/cli.ts
  … "$@"`, so the abs-path anchor lives in the launcher and a
  `git pull` updates behavior with no reinstall. `commands/attach-orc.md`
  is the repo-tracked slash command; its body is the generic
  `attach-orc $ARGUMENTS` (no machine path), so `make setup` can
  **symlink** it into `~/.claude/commands/` and `git pull` propagates
  edits. Because the slash command runs in a non-interactive shell, it
  relies on the install dir being on PATH — `make setup` prints the
  one-line PATH fix when it isn't. `claude` still spawns in the
  caller's cwd (attach-orc's `--cwd` defaults to `process.cwd()`), so
  `/attach-orc` drives whichever project you run it from. Never `sed`
  or `>`-redirect INTO the command symlink — that truncates the repo
  source through the link (it bit us once); the launcher, not the
  command file, carries the abs path. `make teardown` removes the
  symlink and the launchers. No new spawn — the launcher wraps the
  existing CLI; the spawn discipline is unaffected.
- **`open-rc tui` is a terminal front-end, not a bridge.** `tui` is a
  plain `/ws` client — the SAME protocol the browser SPA speaks. It
  attaches to a clientId and renders/sends frames; it spawns nothing
  and owns no `claude`. Its purpose is a **shared session**: with one
  `claude` owned by `attach-orc`, the browser and one or more `tui`
  clients all attach to the same clientId, so a prompt from any of
  them is echoed to all (the server broadcasts a `user` frame on
  `send`) and the stream fans out to all. This is how "drive from the
  browser AND the CLI" is one conversation. It is NOT a live-share of a
  native `claude` TUI (that would need PTY bridging — now permitted via
  a separate client-side path — or the private RemoteControl) — the
  shared session lives in the `attach-orc`-owned `claude`, and `tui` is
  just another window onto it. Do not confuse `tui` with a "bridge
  command": it never touches `claude`'s stdio.
- **No reverse-engineering the bridge protocol.** open-rc talks to
  the public `--input-format stream-json --output-format stream-json`
  mode only. The private RemoteControl protocol and
  `wss://bridge.claudeusercontent.com` are off-limits.
- **PTY bridging to an existing `claude` is allowed client-side (was
  banned).** Attaching to a user-owned interactive `claude`'s
  controlling terminal — reading its PTY output and writing prompts to
  its stdin, incl. `TIOCSTI`/`TIOCSWINSZ` and whatever process-table
  lookup is needed to find that tty — is permitted, to mirror a session
  the user already started in a terminal into the browser. It is the
  user's machine and the user's own process. This MUST live in a
  client-side command (the `attach-orc` family), NEVER in `serve`,
  which stays a pure relay that spawns nothing, walks no process table,
  and touches no terminal. Reverse-engineering the private
  RemoteControl protocol / `wss://bridge.claudeusercontent.com` is a
  different line and remains off-limits (see above).
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
  fragment of the in-progress reply (attach-orc passes
  `--include-partial-messages`); the browser renders it live with a
  typing indicator while waiting, and the server stamps `done` frames
  with a `ts` so turn dividers show a wall-clock time even on replay.
  The `tui` command speaks this exact same `/ws` protocol — it is
  just another attached client.

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
- `GET /agent` — user-owned bridges (e.g. `attach-orc`) connect here.
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
- **Don't spawn `claude --bare` from attach-orc.** Bare mode's
  Anthropic auth is strictly `ANTHROPIC_API_KEY`/`apiKeyHelper` (OAuth
  and keychain are never read), so on a subscription-login machine
  every bridged prompt returns "Not logged in". attach-orc spawns
  `claude --print --input-format stream-json --output-format
  stream-json --verbose` — same public wire format, but auth resolves
  exactly like the user's own `claude -p`. (Bit us 2026-07-02.)

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
- The CLI exposes five commands: `serve`, `hub`, `attach-orc`, `tui`,
  and `attach-tmux`. `serve` and `hub` are spawn-free relays; `tui` is
  a spawn-free `/ws` client. `attach-orc` is the only place that
  `Bun.spawn`s `claude`. `attach-tmux` `Bun.spawn`s only `tmux` (never
  `claude`): it mirrors an EXISTING interactive `claude` the user
  already started in a tmux pane — polling `capture-pane` for output
  (relayed as `screen` frames) and delivering browser prompts with
  `send-keys`. It NEVER kills the pane (the session is the user's). The
  server stays spawn-free and touches no terminal. There is no bare
  `attach` command (the historical `attach` was renamed to
  `attach-orc`). There is no `pipe`, no `client`, no `spawn`.
- PWA assets follow the same no-build-step rule: `ui/manifest.webmanifest`
  and the icon PNGs are checked in as static files and served
  straight off disk. `scripts/build-icons.ts` is a maintainer-only
  helper (re-rasterises `ui/icon.svg` → icon PNGs); it is never run
  on the server boot path. `scripts/build.ts` (distribution cross-
  compile) does not touch UI assets — the no-UI-build rule survives
  PWA unchanged.
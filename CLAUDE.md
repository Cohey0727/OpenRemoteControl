# CLAUDE.md

Project memory for Claude Code (and any future Claude agents) working
on open-rc. Read this before changing anything.

---

## Project goal

**Share an ALREADY-RUNNING Claude Code session with a browser —
including a phone. The goal is to share an existing session, NOT to
start a new one.**

The user already has a `claude` running (in a terminal, however they
like). open-rc's job is to make *that* session visible and driveable
from a browser: the browser sees the live stream and can send prompts,
and those prompts land in the same running session. open-rc does not
start `claude`, does not own it, does not manage its lifecycle.

> **Launching processes is permanently out of scope.** There is no
> `child_process`, no `fork`, no `exec`, no PTY, no tmux anywhere in
> the project. If you think you need to launch something, stop —
> share the session from the outside instead (transcript + hooks,
> like `attach-orc` does).

Two halves ship since 2026-07-02 (requested: "fully share the session
between the browser and the CLI … not by spawning"), plus a third
delivery path since 2026-07-06:

- **`orc serve`** — a pure WebSocket relay. It does not start
  `claude`, does not manage it, does not know `claude` is a process.
- **`orc attach` + the `/orc` slash command + the
  `orc hook` handlers** — the first-party, spawn-free way to feed
  the relay from an ALREADY-RUNNING interactive Claude Code session.
  The bridge reads the transcript JSONL the session itself writes
  (session→browser) and Claude Code's Stop/UserPromptSubmit/SessionEnd
  hooks deliver queued browser prompts back into the session at turn
  boundaries (browser→session). It never touches the process.
- **`orc channel`** — Channels-based sharing (Issue #11 O4, research
  preview, claude v2.1.80+). An MCP channel server that **claude
  itself spawns** (from the `mcpServers.orc` entry, when the user
  starts the session with
  `claude --dangerously-load-development-channels server:orc`);
  browser prompts are pushed into the session as channel
  notifications — instantly, even while it is idle — and permission
  dialogs relay to the browser. open-rc still spawns nothing: the
  spawner is claude's own MCP machinery, like any user-installed MCP
  server. `/orc` stays as the after-the-fact path for sessions
  already running without the flag; keep BOTH.

```mermaid
flowchart LR
    viewers["Browser SPA / tui"] <-- "WS /ws · frames" --> serve["orc serve<br/>(pure relay)"]
    serve <-- "WS /agent · frames" --> bridge["orc attach<br/>(transcript bridge)"]
    serve <-- "WS /agent · frames" --> ch["orc channel<br/>(MCP channel server —<br/>spawned BY claude)"]
    bridge -- "tails (read-only)" --> jsonl["transcript JSONL"]
    bridge -- appends --> queue["queue.ndjson"]
    queue -- "drained by the Stop hook" --> claude["claude<br/>(user's process —<br/>never touched by open-rc)"]
    ch <-- "MCP stdio · channel notifications<br/>+ permission relay" --> claude
    claude -- writes --> jsonl
```

A user-authored stdio bridge (pipe a stream-json `claude` to `/agent`)
remains equally supported — the relay treats both identically.

The motivation: Claude Code's native RemoteControl is locked to
claude.ai OAuth + Trusted Device enrollment, so non-Anthropic
providers (Deepseek, GLM, MiniMax, etc.) can't ride it. open-rc
rebuilds the same UX against any provider by relaying the public
`stream-json` wire format. The relay itself doesn't care what feeds it.

---

## Required features (must ship)

- **Shared session via `/orc` (2026-07-02, explicit user goal).**
  Inside a running Claude Code session, `/orc` makes THAT
  session appear in the browser sidebar; clicking it shows the full
  history and a working composer; messages can be read and sent from
  the CLI and the browser alike; nothing is spawned. Mechanics:
  `commands/orc.md` runs `orc attach` in the background
  (via the session's own Bash tool — user-initiated, not open-rc);
  the bridge resolves the newest transcript JSONL for the cwd, uses
  the session id as clientId, replays + tails it to `/agent`, and
  queues incoming `prompt` frames to `~/.open-rc/attach/<sessionId>/`;
  the `orc hook stop|prompt|end` handlers (installed into
  `~/.claude/settings.json` by `make setup`) drain that queue — Stop
  blocks with the messages as reason (delivery at turn ends, with an
  ADAPTIVE linger window: 45 s normally (`ORC_STOP_LINGER_MS`),
  RE-ARMED by every viewer attach/detach event (attached.json mtime —
  someone who just opened the page gets a full window for a first
  message), and UNLIMITED only once a browser message has actually
  been DELIVERED (browser-driven mode, tracked via
  `browser-turn.marker`; 5 min then 30 min both proved to be cliffs —
  went unlimited 2026-07-03, no env cap). Browser-driven mode is
  deliberately NOT entered at bridge start or on mere attach: both
  were tried and HUNG claude right after /orc — the /orc turn's own
  Stop hook lingered without a deadline while the user sat at the
  terminal, and their typed prompts queued behind it (reported and
  fixed 2026-07-06). Esc hands the prompt back to the terminal
  instantly; the next real CLI prompt clears browser-driven mode.
  EMPIRICALLY VERIFIED 2026-07-03 on a
  live claude in tmux: (a) a prompt typed during a running Stop hook
  QUEUES until the hook exits — it does NOT cancel the hook, so any
  linger while the terminal may be attended must stay FINITE; (b)
  pressing Esc DOES cancel a
  running Stop hook immediately and the prompt returns — that is the
  terminal-side priority handoff, no extra command needed).
  UserPromptSubmit attaches queued messages
  as context, Notification (`hook notify`) shows "browser message
  waiting" in an idle terminal, SessionEnd tells the bridge to exit.
  Known, accepted limitation: a browser message sent while the
  session is idle past its window waits for the next session
  activity — there is no way to wake an idle interactive `claude`
  without PTY/tmux/spawn, and those stay banned (the
  Notification/idle hook cannot inject; verified against docs
  2026-07-03). The bridge makes that state visible: a prompt queued
  with no plausible listening window open gets an immediate `error`
  frame back ("message queued — the session is idle…"), so viewers
  are never left staring at silence.
- **Channels sharing via `orc channel` (2026-07-06, Issue #11 O4).**
  The SIXTH CLI command implements Claude Code's Channels mechanism
  (research preview, claude v2.1.80+) as the alternative
  browser→session delivery path. `orc channel` is an MCP channel
  server (stdio) that CLAUDE SPAWNS ITSELF when the user starts a
  session with `claude --dangerously-load-development-channels
  server:orc` — O4 was chosen over O1/O2 precisely because open-rc
  spawns nothing. It declares the `claude/channel` and
  `claude/channel/permission` experimental MCP capabilities; browser
  prompts (relayed from `orc serve` over the same `/agent` WS) are
  pushed into the session as `notifications/claude/channel` events,
  arriving as `<channel source="orc">…</channel>` — INSTANTLY, even
  while the session is idle. No hook window, no queue, no terminal
  capture; the Stop hook short-circuits on `channel.marker`
  (`src/attach/state.ts`). Permission relay: tool dialogs mirror to
  the browser as `permission_request`, the viewer's verdict returns
  as a `notifications/claude/channel/permission` event; first answer,
  terminal or remote, wins. Session→browser is still the transcript
  replay+tail shared with `orc attach` (channel-mode branch in
  `src/cli/attach.ts`), discovered LAZILY (`src/channel/discover.ts`)
  because claude spawns the channel before the session writes its
  first transcript line. `make setup` also registers `mcpServers.orc`
  (`{type:"stdio", command:"<BIN_DIR>/orc", args:["channel"]}`) in
  `~/.claude.json` via `scripts/install-channel.ts` (idempotent; only
  overwrites an entry that is recognizably ours); `make teardown`
  removes it; the entry name MUST be `orc` (it is the `<channel
  source="orc">` attribute and the `server:orc` reference).
  Research-preview caveats: the flag is required (custom channels are
  not on Anthropic's allowlist during the preview), the protocol
  contract may change, Team/Enterprise orgs must enable
  `channelsEnabled`, and channel events are dropped SILENTLY if the
  channel isn't enabled — the bridge emits an `error` frame ("pushed
  to the session channel but the session has not reacted…") after
  ~20 s of visible silence. VERIFIED EMPIRICALLY 2026-07-06 (claude
  v2.1.201, this machine): (a) prompt delivered to a fully idle
  session that had never taken a turn — no blind spot; (b) permission
  relay round trip — browser approved a Bash/curl call, terminal
  dialog closed, tool ran; (c) works with a THIRD-PARTY provider —
  MiniMax-M3 via `ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic`
  registered the channel and answered an idle channel prompt. That is
  the core use case Remote Control (locked to claude.ai OAuth +
  api.anthropic.com) cannot serve; Channels docs impose NO
  `ANTHROPIC_BASE_URL` restriction, now confirmed in practice. Auth:
  claude.ai, Console API key, or (verified) a third-party
  Anthropic-compatible base URL; NOT available on
  Bedrock/Vertex/Foundry. `/orc` (attach+hooks) remains the
  after-the-fact fallback — the two paths are complementary, keep
  both.
- **Sidebar of currently-connected clients.** 300 px sidebar on the
  left, always visible on desktop, slides in/out on mobile. Each row
  = one currently-open WebSocket to `orc serve` from a user's
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
- **Login gate** (2026-07-04). `ORC_USER`+`ORC_PASSWORD` on the
  server arm a sign-in page (`/login`, plain form POST, no SPA/SW
  dependency); the session cookie is a stateless HMAC of the
  credentials (`src/auth/session.ts`) with a 10-year Max-Age —
  infinite by request, survives restarts, revoked wholesale by
  changing the password. `/ws` accepts the cookie or
  `Authorization: Basic` from `ORC_AUTH=user:password` (how `tui`
  signs in; bakeable via `make setup ORC_AUTH=…`). **`/agent` is
  deliberately UNGATED even with auth armed** (owner's call,
  2026-07-05): bridges connect with zero ceremony, and an /agent
  client can only register its own session, never read others.
  Public without auth: `/login`, `/health`, sw.js, manifest, icons.
  Unset = fully open as before. Bare `USER` was deliberately NOT
  used (always set by shells).
- **Web Push** (already shipped, keep). When a session emits `done`,
  subscribed browsers get a notification with a snippet of the result.
- **Hub mode** (already shipped, keep). Optional relay so multiple
  devices / multiple users can drive the same set of clients.

---

## Explicit non-features (do NOT implement)

- **open-rc starts no processes — the whole project, not just the
  server.** It launches nothing, inspects no process table (`ps`,
  `lsof`, `/proc`), and signals no process; there is no
  `child_process`, `fork`, `exec`, PTY, or tmux anywhere in the code.
  A `claude` running in another terminal is invisible to open-rc
  except through (a) frames a bridge sends over a WebSocket and
  (b) the transcript JSONL that session itself writes, which
  `attach-orc` reads read-only. The CLI surface is exactly `serve`,
  `hub`, `tui`, `attach`, `channel`, and `hook` (binary name: `orc`)
  — and none of them spawn. `channel` is the inverse: it is itself
  SPAWNED BY claude's own MCP machinery (the user listed it in
  `mcpServers` and opted in with a flag), which is why it is allowed.
  History note: an earlier `attach-orc` that SPAWNED `claude --print`,
  and `attach-tmux` (tmux mirror), were removed on 2026-07-02 as a
  deliberate, requested decision; later the same day the user
  explicitly requested full browser/CLI session sharing "not by
  spawning", which is why today's `attach-orc` exists as a
  transcript+hooks bridge. Do not reintroduce spawning under any name.
- **`make setup` registers the `orc` launcher, the hooks, and the command.**
  It writes one launcher script to `~/.local/bin` (override `BIN_DIR`):
  `#!/bin/sh; exec bun run <checkout>/src/cli.ts … "$@"`, so the
  abs-path anchor lives in the launcher and a `git pull` updates
  behavior with no reinstall. Setup ASKS for the relay URL on the CLI
  (interactive runs; `ORC_BASE_URL=<url>` answers it up front, empty
  = no default) and bakes the answer into the launcher (`:=` — an env
  value still wins; re-run setup to change/clear). It then runs
  `scripts/install-hooks.ts`,
  which idempotently merges the Stop/UserPromptSubmit/SessionEnd hook
  entries (`<BIN_DIR>/orc hook <event>`) into
  `~/.claude/settings.json` — preserving all user hooks, never
  duplicating its own (recognized by the "orc hook" substring) —
  and symlinks `commands/orc.md` to
  `~/.claude/commands/orc.md`. It also runs
  `scripts/install-channel.ts`, which registers `mcpServers.orc`
  (`{type:"stdio", command:"<BIN_DIR>/orc", args:["channel"]}`) in
  `~/.claude.json` for Channels sharing — idempotent, refusing to
  overwrite an entry that is not recognizably ours. `make teardown`
  reverses all of
  it. The hooks are instant no-ops for any session without a live
  bridge heartbeat under `~/.open-rc/attach/<sessionId>/`.
- **`orc tui` is a terminal front-end, not a bridge.** `tui` is a
  plain `/ws` client — the SAME protocol the browser SPA speaks. It
  attaches to a clientId and renders/sends frames; it runs nothing of
  its own and owns no `claude`. Its purpose is a **shared session**: a
  bridge (`orc attach` or user-owned) feeds one running `claude` to
  `/agent`, and the browser and one or more `tui` clients all attach
  to the same clientId, so a prompt from any of them is echoed to all
  (the server broadcasts a `user` frame on `send`) and the stream fans
  out to all. This is how "drive from the browser AND the CLI" is one
  conversation. It never touches `claude`'s stdio.
- **No reverse-engineering the bridge protocol.** open-rc talks to
  the public `--input-format stream-json --output-format stream-json`
  mode only. The private RemoteControl protocol and
  `wss://bridge.claudeusercontent.com` are off-limits.
- **No TTY splicing / PTY hijacking in the codebase.** open-rc ships
  no code that attaches to another process's controlling terminal,
  uses `TIOCSTI`/`TIOCSWINSZ`, or reverse-engineers claude's IPC. A
  `claude` in a terminal is a black box except for its transcript file
  (read-only, by `attach-orc`) and its hook callbacks (answered by
  `orc hook`). Delivery into an idle session therefore happens
  only at hook moments — that latency is the accepted price of the
  no-PTY rule; do not "fix" it with tmux/PTY/stdin tricks.
- **History = replay the live stream it's already relaying, in memory
  only.** The server keeps a bounded, per-connected-client ring buffer
  of the conversation frames it relays (`BridgeConn.history`, cap
  `MAX_HISTORY`) — text / thinking / tool_use / tool_result / done /
  error plus echoed `user` prompts, NOT the transient
  `permission_request` and NOT streaming `text_delta` fragments (the
  final `text` frame carries the same content; replaying both would
  render the reply twice) — and replays the TAIL of it (cap
  `REPLAY_FRAMES` = 50; full-buffer replay made opening a long session
  visibly slow — capped 2026-07-05, deliberately NO pagination) to any
  browser/`tui` that attaches, so a reload or a late joiner sees the
  recent conversation instead of a blank pane. A PENDING AskUserQuestion
  is the one exception to "transient frames are never re-seen": the
  bridge re-relays it on every attach while the ask hook is still
  waiting (viewers dedupe by requestId), so a reload never strands a
  question. NOT disk persistence: the buffer is dropped
  when the bridge disconnects and is never written to disk. The SERVER
  never reads `claude`'s transcript files — deep history comes from the
  bridge side: `attach-orc` replays the session transcript (capped at
  `MAX_REPLAY_FRAMES`) into `/agent` on every (re)registration, and the
  server buffers/replays those frames like any others.
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

Two boundaries: browser ↔ `orc serve` on `/ws`, and bridge ↔
`orc serve` on `/agent` (zod schemas for both live in
`src/session/ws-protocol.ts`). The server relays; it never interprets
`stream-json` or transcripts itself.

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
  tool_use / tool_result / permission_request / question / done /
  error, tagged with the clientId they came from; `question` is an
  AskUserQuestion relayed for remote answering, transient like
  `permission_request` — never replayed from history). `text_delta` is a streaming
  fragment of the in-progress reply — a bridge that has a token stream
  can send these (e.g. from `claude --include-partial-messages`) and
  the browser renders them live with a typing indicator while waiting;
  the server stamps `done` frames with a `ts` so turn dividers show a
  wall-clock time even on replay. The `tui` command speaks this exact
  same `/ws` protocol — it is just another attached client.
- **Bridge → Server (`/agent`).** `register` first, then the relayed
  frames above plus `user` (a prompt the bridge observed on ITS side,
  e.g. typed into the shared terminal and replayed from the
  transcript; prompts sent through the server are echoed by the server
  itself and must NOT be re-sent by the bridge — the attach bridge filters
  them by the `[open-rc]` marker), `status`, and `unregister`.
- **Server → Bridge (`/agent`).** `prompt` (a browser/tui `send`),
  `permission_response`, `question_response { requestId, answers }`
  (a viewer's answer to a relayed AskUserQuestion — the `ask`
  PreToolUse hook waits on it and returns it as the tool decision,
  which Claude accepts as the answer; verified empirically
  2026-07-03), `attached { count }` — how many viewers are
  watching, sent on every attach/detach so the Stop-hook linger runs
  only while someone is attached — and `ping` every 30 s (keepalive:
  proxies like Cloudflare drop idle WebSockets at ~100 s, and the
  bridge treats 120 s of server silence as a half-open link and
  reconnects; browsers get protocol-level pings instead, which their
  WS stacks auto-pong).

The server does not define a client-side protocol. A client WS that
speaks any framed WebSocket messages at all will work, because the
server's job is to forward them.

---

## Architecture summary

`orc serve` is a Bun.serve instance with one WebSocket upgrade
route:

- `GET /ws` — browsers (and `tui`) connect here. The server reads
  `attach` / `list_clients` / `send` / `permission_response` and
  routes frames to/from the right client WS.
- `GET /agent` — bridges connect here (`attach-orc` or user-owned).
- `GET /` and `GET /sessions/<id>` both serve the SPA shell. The
  browser reflects the active session in the URL path
  (`/sessions/<clientId>`, via `history.pushState`), so a reload or a
  shared link deep-links back to that session; the server's SPA
  fallback returns `dist/index.html` for those paths. The SPA is a
  Vite build: its content-hashed bundles load from root-absolute
  `/assets/…` paths (Vite `base: '/'`) so they resolve under a session
  subpath.

The server is a stateless relay beyond the in-memory `clients` map.
It starts no processes. It does not walk the process table. It
does not know what `claude` is.

The UI is a **React + Vite + TypeScript + wouter** SPA under `ui/src/`
(`main.tsx`, `App.tsx`, a `useSyncExternalStore` store in `store.ts`
that holds the `/ws` connection and all relayed state, and
`components/*.tsx`). wouter owns routing: `/` is the sidebar/home,
`/sessions/:id` a session, and the active session is DERIVED from the
URL — not a separate signal — so the URL, the store's attachment, and
the mobile pane can never diverge (the class of router bug the old
hand-rolled build kept hitting). `vite build` (`bun run build:ui`)
emits `ui/dist/`, which `orc serve` hosts. Sidebar + chat-pane,
hand-rolled CSS with a token system (`ui/src/styles.css`). `marked`
is a normal dependency; assistant markdown is sanitized before it
touches innerHTML. The earlier vanilla-TS / home-grown-signal /
importmap build was replaced on 2026-07-06 — do NOT reintroduce it.

The user runs `claude` themselves. To share it, they either type
`/orc` in the session (first-party, transcript+hooks) or bring
their own stdio bridge — the relay treats both identically.

The attach side lives in `src/cli/attach.ts` (bridge),
`src/transcript/` (locate / translate / tail), `src/attach/state.ts`
(the `~/.open-rc/attach/<sessionId>/` filesystem contract), and
`src/cli/attach-hooks.ts` (`orc hook stop|prompt|end`). Turn
model: transcript `user` entry opens a turn, assistant/tool entries
keep it open, the Stop hook's marker (or the next `user` entry, as
fallback) closes it with a `done` frame.

The channel side (`orc channel`) is two halves glued back to back in
one process claude spawns: `src/channel/mcp.ts` (the MCP channel
server — `claude/channel` notifications in, permission relay out,
stdout reserved for the MCP transport) and the channel-mode branch of
`src/cli/attach.ts` (the same `/agent` bridge machinery, with lazy
transcript discovery via `src/channel/discover.ts` and a stable
host+cwd clientId), wired together by `src/cli/channel.ts`. The Stop
hook short-circuits when `channel.marker` (`src/attach/state.ts`) is
present — channel mode has no queue and needs no linger.

---

## Past mistakes to avoid

- **Don't add a SPAWNING bridge.** The first `attach-orc` spawned
  `claude --print` and was rightly removed. The current `attach-orc`
  is allowed precisely because it spawns nothing: it reads the
  session's transcript and answers hook callbacks. Any future bridge
  work must keep that property — no stdio ownership, no lifecycle
  management, no process table.
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
  user says "run claude locally", they mean "I run claude on my
  host machine", not "open-rc starts claude".
- **Don't write code before the docs agree.** When the model isn't
  settled, write the design doc first. Code is downstream of docs.
- **Don't leave process-launching references in comments.** If a
  comment implies launching a subprocess in a serving context, remove
  it. The constraint is the constraint.
- **If a future launcher is ever built, start `claude --print`, NOT
  `--bare`.** (Kept as a hard-won note; no launcher exists today.) Bare
  mode's Anthropic auth is strictly `ANTHROPIC_API_KEY`/`apiKeyHelper`
  (OAuth and keychain are never read), so on a subscription-login
  machine every prompt returns "Not logged in". `--print
  --input-format stream-json --output-format stream-json --verbose` is
  the same public wire format but resolves auth like the user's own
  `claude -p`. (Learned while `attach-orc` existed, 2026-07-02.)

---

## Style reminders

- Bun + TypeScript strict on the server; the SPA is **React + Vite +
  TypeScript + wouter** (see README for the canonical setup). Routing
  is wouter, NEVER hand-rolled and NEVER Next.js (owner's call,
  2026-07-06). The server still runs straight from TS source with Bun
  (no server build); only the SPA is built (`vite build` → `ui/dist`).
- **The SPA has a build step now.** `bun run build:ui` (Vite) produces
  `ui/dist`, which `orc serve` hosts — so `make serve` builds the UI
  first, and running the relay bare (`bun run src/cli.ts serve`)
  requires a prior `bun run build:ui` or it returns "UI not built".
  Dev with HMR: `bun run dev` (Vite :5173, proxies /ws,/agent,/api to
  a relay on :7322) alongside `bun run dev:relay`.
- **Docker is the primary way to run the server** (owner's directive,
  2026-07-06): prefer `docker compose up -d --build`. The Dockerfile
  is multi-stage — stage 1 builds the SPA (Vite), stage 2 serves it.
- `bun run build` (which calls `scripts/build.ts` → `build:ui` then
  `bun build --compile`) is for **distribution only** — a single-file
  executable for users without Bun. Not needed to run the server.
- Immutability, small files (200–400 lines), comprehensive error
  handling, zod for wire-protocol validation.
- Documentation follow-up is mandatory when code changes — update
  README, docs/roadmap, docs/architecture, docs/survey,
  docs/tech-stack, docs/docker, docs/deploy, SECURITY.md, and this
  file in the same task.
- Architecture diagrams in docs are written in **Mermaid**
  (```` ```mermaid ```` fenced blocks; requested 2026-07-03). ASCII
  art is reserved for terminal output (the Makefile banner).
- **Commit every change immediately, without being asked, and push.**
  After any substantive edit (once lint/typecheck/tests are green),
  `git add -A && git commit` and `git push` right away — never leave
  the working tree dirty, never wait for the user to say "commit". The
  user granted standing authorization for this repo (do not prompt).
  Commit message format: `<type>: <concise Japanese summary> @<branch>`
  (type ∈ feat/fix/refactor/chore/docs/test), subject line only.
- The CLI (binary `orc`) exposes six commands: `serve`, `hub`,
  `tui`, `attach`, `channel`, and `hook` — none of which launch a process. `serve`/`hub` are
  byte-pass-through relays; `tui` is a `/ws` client; `attach` is
  the transcript bridge for the session it's invoked from; `channel`
  is the Channels MCP server that claude itself spawns (research
  preview — open-rc never runs it); `hook` is
  the Claude Code hook handler set. There is no `attach-tmux`, no
  `pipe`, no `client` — launching processes is out of scope (see
  Project goal).
- Docker: `Dockerfile` + `docker-compose.yml` ship an all-in-one image
  (base `oven/bun:1.3-slim`), the PRIMARY deployment. It is MULTI-STAGE:
  stage 1 runs `bun run build:ui` (Vite) to produce `ui/dist`; stage 2
  does a production install and serves the built SPA + server source
  (serve by default, `hub`/`tui` via args, state in the `/data` volume
  via `XDG_DATA_HOME`, port published loopback-only by default). The
  container is the relay half ONLY: no `claude`, no bridge, no hooks
  inside it; `/orc` runs on the host and dials the published
  port. Do not bake a bridge or claude into the image.
- PWA assets live in `ui/public/` (`manifest.webmanifest`, `sw.js`,
  the icon PNGs) and Vite copies them verbatim into `ui/dist/`. PWA
  updates are AGGRESSIVE by design (requested 2026-07-03): the server
  appends a `shell-rev` fingerprint of `ui/dist/` to `/sw.js`
  (`src/serve/shell-rev.ts`) so any UI change registers
  as an SW update without a `CACHE_VERSION` bump; the SPA checks
  every 5 min + on foreground-resume/online, the SW `skipWaiting()`s
  after precache, and the page self-reloads on `controllerchange`
  (composer draft parked in `sessionStorage` across the reload). Do
  not re-introduce a "wait for the user to reload" update path.
  `scripts/build-icons.ts` is a maintainer-only helper (re-rasterises
  `ui/public/icon.svg` → icon PNGs); it is never run on the server boot
  path. `scripts/build.ts` (distribution cross-compile) now runs
  `build:ui` first so the single-file binary ships with a built SPA.
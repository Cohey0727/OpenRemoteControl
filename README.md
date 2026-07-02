# open-rc

> Claude Code's RemoteControl control plane — open, self-hostable, and
> usable against any Claude Code-compatible LLM provider.

[![Status: Server-only relay, no spawn](https://img.shields.io/badge/status-server%20only%20no%20spawn-yellow)](#status)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-bun%201.3+-yellow)](#requirements)

---

## What is open-rc?

Claude Code's RemoteControl (driving a session from the web UI or
mobile app, peer-to-peer `SendUserMessage` across machines, push
notifications, `/teleport`, `/rewind`) is implemented as a **private
control plane** between the CLI and
`wss://bridge.claudeusercontent.com`. That control plane requires
claude.ai OAuth + Trusted Device enrollment, and is not available to
providers who only publish a Claude-Code-API-compatible inference
endpoint.

`open-rc` is a **drop-in replacement for that control plane**, as a
single thing: `open-rc serve`, a pure WebSocket relay.

The relay does not spawn `claude`. It does not manage `claude`. It
does not know `claude` is a process. The user runs `claude`
themselves on whichever machine they want, and arranges for the
`stream-json` frames to flow over a WebSocket to `open-rc serve`. The
browser connects to `open-rc serve`, sees the connected streams, and
sends prompts back.

> **TL;DR.** `open-rc` is the RemoteControl bridge that Claude Code
> normally gets from `wss://bridge.claudeusercontent.com`, but yours
> to host, with any provider. open-rc is the relay. The user brings
> their own `claude` and their own bridge.

---

## Quick start

```bash
# 1. Clone & install
git clone https://github.com/kohei/open-rc.git
cd open-rc
bun install

# 2. Start the relay
bun run src/cli.ts serve --host 127.0.0.1 --port 7322
# → UI:  http://127.0.0.1:7322/
# → WS:  ws://127.0.0.1:7322/ws    (browsers)
# → /agent:  ws://127.0.0.1:7322/agent  (user-owned bridges)
```

That's the entire server. `open-rc serve` is a pure WebSocket
relay — it never spawns anything.

## Drive a `claude` session from your browser

Run `make setup` once. You then start a bridge **from any project**
and it drives *that* project's `claude` — the command is anchored to
the open-rc checkout, but `claude` spawns in whatever directory you
invoke it from.

```bash
make setup                                             # one-time
```

`make setup` does two things:

1. **Registers `attach-orc` and `open-rc` on your PATH** (as launcher
   scripts in `~/.local/bin`, overridable with `make setup
   BIN_DIR=/usr/local/bin`). Each launcher just runs this checkout's
   source, so a `git pull` updates behavior with no reinstall.
2. **Symlinks the `/attach-orc` slash command** into
   `~/.claude/commands/`. Its body is the generic `attach-orc
   $ARGUMENTS`, so the file is machine-independent — the symlink means
   `git pull` propagates any edit with no reinstall — and it resolves
   through the PATH launcher from (1).

Then launch the bridge either way — both work from any project:

```text
/attach-orc                 # inside Claude Code, in any repo
/attach-orc --label macbook

attach-orc                  # in any terminal
```

If `~/.local/bin` isn't already on your PATH, `make setup` prints the
one-line fix; add it and restart your shell (and Claude Code) so both
the terminal `attach-orc` and the `/attach-orc` slash command — which
runs in a non-interactive shell and inherits that PATH — can find it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
```

`attach-orc` is a long-lived bridge (it owns the spawned `claude`
until you stop it). The `/attach-orc` slash command therefore runs it
**in the background**, so the Claude Code session you launched it from
stays free — drive the bridged claude from the browser, and stop it
by ending the background task (or `pkill -f 'cli.ts attach-orc'`). In
a terminal, `attach-orc` runs in the foreground and blocks until you
Ctrl+C (append `&` yourself to detach). The `/attach-orc` command
makes one LLM round-trip (inherent to Claude Code slash commands); the
terminal `attach-orc` has none. Run `make teardown` to remove the
command symlink and the launchers.

`attach-orc` fails fast when it can't reach the relay: if the first
registration doesn't complete within 10 seconds (serve not running,
`ORC_BASE_URL` pointing nowhere, clientId already in use), it prints
the reason and exits nonzero instead of retrying forever. Once
registered, it reconnects with a short backoff for as long as it runs,
so restarting `serve` doesn't kill the bridge.

---

Both paths spawn the same `claude --print --input-format
stream-json --output-format stream-json` subprocess and bridge its
stdio to `ws://127.0.0.1:7322/agent`. The session appears in the
sidebar; type into the composer; the prompt lands on `claude`'s
stdin. (`orc` = "open remote control".) Not `--bare`: bare mode
authenticates only via `ANTHROPIC_API_KEY`, so an OAuth-login machine
would get "Not logged in" for every prompt — `--print` resolves auth
exactly like your own `claude -p`.

`attach-orc` is a separate process the user runs in their terminal.
It is the only place in the project that calls `Bun.spawn` for
`claude`. The server remains spawn-free.

There are no `--model` or `--claude` knobs. `attach-orc` bridges the
`claude` session itself, exactly as `claude` launches it. If you want
a different model or provider, configure that where you already do it
(`ANTHROPIC_BASE_URL`, your `claude` settings) — `attach-orc` doesn't
duplicate it.

Common flags (work whichever way you launch):

```bash
# Point at a non-default server
attach-orc --server ws://192.168.1.10:7322/agent

# Customize label / cwd / explicit clientId
attach-orc --label macbook-pro --cwd ~/code/myproj --client-id work
```

### Attach to a remote serve (VPN / ECS / anywhere)

`open-rc serve` can run wherever you like — a VPS, an ECS task, a box
on your VPN. Point `attach-orc` at it by exporting `ORC_BASE_URL`;
the `/agent` WebSocket URL is derived from it (`http`→`ws`,
`https`→`wss`, `/agent` appended if absent):

```bash
export ORC_BASE_URL=https://orc.internal.example:7322
attach-orc                    # → wss://orc.internal.example:7322/agent

# equivalent, explicit:
attach-orc --server wss://orc.internal.example:7322/agent
```

`--server` always wins over `ORC_BASE_URL`.

### Share one session between the browser and a terminal

`open-rc tui` is a terminal front-end for a session `serve` is already
relaying. It's a plain `/ws` client — the same protocol the browser
speaks — so the browser and any number of `tui` windows attach to the
**same** `claude` (the one `attach-orc` owns) and share one live
conversation: a prompt from either side is echoed to all, and the
stream fans out to all.

```bash
open-rc tui                       # attaches to the only/most-recent session
open-rc tui --client-id work      # or a specific one
open-rc tui --server ws://192.168.1.10:7322/ws   # or a remote serve
```

Inside it, type to send a prompt; `/allow` or `/deny` answer a
permission request; `/clients`, `/attach <id>`, `/quit`, `/help` do the
obvious things. (Under the hood: `attach-orc` owns the single `claude`;
`tui` and the browser are both just clients of `serve`.)

### Mirror an existing terminal `claude` (attach-tmux)

`attach-orc` and `tui` share a *fresh headless* `claude` that
`attach-orc` spawns. If instead you want to drive the **interactive
`claude` you already started in a terminal** — from the browser, with
its live TUI mirrored — run that `claude` inside tmux and bridge the
pane:

```bash
# 1. run claude inside tmux (any session/window name)
tmux new -s work
#    …then inside: claude

# 2. from anywhere, bridge that pane into open-rc
open-rc attach-tmux --target work
#    omit --target to auto-detect the sole claude pane
```

The browser then shows the pane's live screen (polled via
`tmux capture-pane`) and your browser prompts are typed into it with
`tmux send-keys` — so the conversation continues in your real terminal
session, visible in both places. `attach-tmux` spawns no `claude` and
**never kills the pane**: quitting the bridge (Ctrl-C) leaves your
terminal `claude` running untouched. Permission dialogs and slash
commands work by sending the key/text as a normal prompt (e.g. send
`1` to pick the first option), since the mirror forwards keystrokes
verbatim. Wide TUIs scroll horizontally in the browser; this is a
screen mirror, not a reflowing chat transcript.

### Streaming, loading state, and turn timestamps

Replies render as they are generated: `attach-orc` passes
`--include-partial-messages` to `claude`, translates the resulting
`stream_event` token deltas into `text_delta` frames, and the browser
paints them into a live bubble with a blinking caret. Before the first
token arrives, a typing indicator (three pulsing dots) shows that the
session is busy. Deltas are live-only — the final `text` frame
supersedes them, and history replay carries only the final text, so a
reload never renders a reply twice. Each turn divider also shows the
completion wall-clock time (`turn complete · 6.5s · $0.33 · 12:07:32`);
the server stamps it on the `done` frame, so replayed history keeps
the original time.

### Session URLs and history

The browser reflects the session you're watching in the URL path —
`http://127.0.0.1:7322/sessions/<clientId>` — so reloading, bookmarking,
or sharing that link reopens the same session. On attach (a reload, or
a second client joining), `serve` replays a bounded in-memory buffer of
the recent conversation, so you see the history so far rather than a
blank pane. That buffer is ephemeral: it lives only while the bridge is
connected and is never written to disk (restart `serve` and it rebuilds
as new frames arrive). It is the live stream `serve` is already
relaying — not a read of `claude`'s transcript files.

### Bring-your-own bridge

You can also write your own bridge to `/agent` (e.g. via
`websocat` or a custom script) and skip `open-rc attach-orc`
entirely. The wire protocol is just framed JSON: `register`,
`text`, `thinking`, `tool_use`, `tool_result`,
`permission_request`, `done`, `error`. See
`src/session/ws-protocol.ts`.

The browser never creates clients. The browser shows whatever is
currently attached. If you want another "session" in the sidebar,
run another `open-rc attach-orc` from another terminal.

### Multi-machine setup (LAN or VPS)

```bash
# On the host you open the browser against (VPS, ECS task, VPN box…)
open-rc serve --host 0.0.0.0 --port 7322

# On the host that has `claude` installed
export ORC_BASE_URL=http://server.lan:7322
attach-orc --label build-box
```

The server is a dumb relay, so any host with Bun can run it, anywhere
you can reach over the network. `attach-orc` runs next to `claude`
and dials the remote serve's `/agent` endpoint derived from
`ORC_BASE_URL`. The session shows up in the browser attached to that
serve.

### Hub mode (multi-device, multi-user)

```bash
bun run src/cli.ts hub --port 7443 --autoApprove=false
```

Devices enroll via Ed25519 challenge. Browsers connect to `/browser`
and list or send to any registered session. Hub mode is unchanged
from prior phases. See [`SECURITY.md`](./SECURITY.md) for transport
notes — hub does not authenticate browsers by default; put it behind
a TLS proxy.

### Web Push

When a session emits a `done` frame, `open-rc serve` delivers a Web
Push notification to every subscribed browser. The UI exposes a 🔔
button in the header; click it once to enable. VAPID keys are
generated on first run and persisted to
`~/.local/share/open-rc/vapid.json`.

> **iOS note.** Web Push on iOS requires the SPA to be installed as
> a PWA (Safari 16.4+ delivers push only to home-screen-installed
> PWAs). See [PWA install](#pwa-install) below.

---

## CLI flags

```text
open-rc serve
  --host             <h>   Bind host (default 127.0.0.1; LAN access needs 0.0.0.0)
  --port             <n>   Listen port (default 7322)
  --vapidKeyPath     <p>   Path to VAPID key JSON
  --pushStorePath    <p>   Path to push subscription sqlite
  --pushSubject      <s>   VAPID subject (mailto:...)
  --pushDisabled           Skip the entire push subsystem (CI / tests)

open-rc hub
  --port             <n>   Listen port (default 7443)
  --host             <h>   Bind host (default 127.0.0.1)
  --dbPath           <p>   SQLite path (default $XDG_DATA_HOME/open-rc/hub.db)
  --autoApprove            Skip the browser-pair step (insecure; testing only)

open-rc attach-orc
  --server           <u>   /agent WebSocket URL (default from ORC_BASE_URL,
                           else ws://127.0.0.1:7322/agent)
  --label            <s>   Sidebar label (default $USER@hostname)
  --cwd              <p>   Working directory reported to the server
  --client-id        <s>   Explicit clientId (default random UUID)
  # env: ORC_BASE_URL   base URL of a remote serve; /agent is derived from it

open-rc tui
  --server           <u>   /ws WebSocket URL (default from ORC_BASE_URL,
                           else ws://127.0.0.1:7322/ws)
  --client-id        <s>   Session to attach to (auto-picks when omitted)

open-rc attach-tmux
  --server           <u>   /agent WebSocket URL (default from ORC_BASE_URL,
                           else ws://127.0.0.1:7322/agent)
  --target           <t>   tmux target pane (e.g. mysession, sess:1.0, %3);
                           auto-detects the sole claude pane when omitted
  --label            <s>   Sidebar label (default tmux:<target>@hostname)
  --client-id        <s>   Explicit clientId (default random UUID)
  --interval         <ms>  capture-pane poll interval (default 500, floor 100)
  # env: ORC_TMUX_BIN   override the tmux binary (tests only)
```

That is the entire CLI surface. There is no `open-rc client`. There
is no `open-rc spawn`.

> Note: five commands total — `serve` and `hub` (spawn-free relays),
> `attach-orc` (the only command that `Bun.spawn`s `claude`), `tui` (a
> spawn-free `/ws` client that shares a session with the browser), and
> `attach-tmux` (mirrors an existing tmux `claude`; `Bun.spawn`s only
> `tmux`, never `claude`, and never kills the pane).

---

## Architecture

```
                       LOCAL MACHINE (default)
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│   ┌──────────────┐    WS(/ws)    ┌──────────────┐                  │
│   │  Browser     │◀────────────▶│ open-rc serve│                  │
│   │  (SPA)       │    frames    │ (pure relay) │                  │
│   └──────────────┘              └──────────────┘                  │
│                                          ▲                         │
│                                          │ WS (any client)         │
│                                  ┌───────┴─────────────┐           │
│                                  │ user-owned bridge  │           │
│                                  │ (e.g. websocat, a  │           │
│                                  │  small Bun script, │           │
│                                  │  tmux, anything)   │           │
│                                  └───────┬─────────────┘           │
│                                          │ stdio pipes             │
│                                  ┌───────┴─────────────┐           │
│                                  │ claude             │           │
│                                  │  (user's process,  │           │
│                                  │   user spawned it) │           │
│                                  └─────────────────────┘           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

                       LAN / VPS (alternative)
┌──────────────┐                              ┌──────────────────┐
│  Browser     │─── WS(/ws) ────────────────▶│  open-rc serve   │
│  (phone)     │                              │  (any host)      │
└──────────────┘                              └────────▲─────────┘
                                                        │ WS (any client)
                                                ┌───────┴─────────────┐
                                                │ user-owned bridge  │
                                                │ on VPS or laptop   │
                                                └───────┬─────────────┘
                                                        │ stdio
                                                ┌───────┴─────────────┐
                                                │ claude             │
                                                │  (user's process)  │
                                                └─────────────────────┘
```

The server is stateless beyond an in-memory map of currently-
connected clients. Restart the server → clients reconnect → the
sidebar repopulates.

### Source layout

```
src/
├── cli.ts                       # arg parsing, dispatch (serve, hub, attach-orc, tui, attach-tmux)
├── cli/
│   ├── flags.ts                 # shared --k=v / kebab→camel flag parser
│   ├── attach-orc.ts            # spawns claude, bridges stream-json ↔ /agent (only claude spawn)
│   ├── attach-tmux.ts           # mirrors an existing tmux claude (capture-pane ↔ send-keys)
│   └── tui.ts                   # terminal /ws client — shares a session with the browser
├── serve.ts                     # Bun.serve entry: HTTP + WS(/ws) + WS(/agent) + static UI
├── ws.ts                        # WS handlers on /ws (browsers) and /agent (bridges)
├── session/
│   └── ws-protocol.ts           # zod schemas for browser ↔ server, bridge ↔ server
├── permission/
│   └── audit.ts                 # append-only JSONL audit log of permission decisions
├── push/
│   ├── vapid.ts                 # VAPID keypair lifecycle
│   ├── store.ts                 # subscription sqlite CRUD
│   └── notifier.ts              # web-push wrapper (deletes 410-gone)
└── hub/                         # optional relay (unchanged from prior phases)
    ├── crypto.ts                # Ed25519 keys + sign/verify
    ├── store.ts                 # bun:sqlite (devices, sessions, audit)
    ├── server.ts                # Bun.serve WS server
    └── client.ts                # serve-side hub dialer

ui/
├── index.html                   # SPA shell + importmap for vendored deps
├── sw.js                        # service worker (Web Push + app-shell offline cache)
├── manifest.webmanifest         # PWA manifest (install + home-screen integration)
├── icon.svg                     # source of truth for the brand mark
├── icon-192.png                 # PWA manifest icon (any)
├── icon-512.png                 # PWA manifest icon (any)
├── icon-maskable-512.png        # PWA manifest icon (maskable — adaptive launchers)
├── apple-touch-icon.png         # iOS home-screen icon (180×180)
├── vendor/                      # bundled marked (no CDN at runtime)
└── app.ts                       # vanilla TypeScript SPA with ~30-line signal implementation
                                  # (transpiled on the fly by Bun, no build step)

scripts/
├── build.ts                     # DISTRIBUTION ONLY — cross-compile to linux/darwin/windows
└── build-icons.ts               # Rasterise ui/icon.svg into the PWA + iOS PNGs (dev-only)
```

tests/                           # unit + integration (no e2e yet)

Note what is **not** in `src/`: there is no `subprocess.ts`, no
`manager.ts` that spawns. The server does not spawn. The only
`Bun.spawn` call in the project lives in `src/cli/attach-orc.ts`,
which is the third CLI command — `open-rc attach-orc` — the user
runs in their terminal to drive a CLI-launched `claude` from the
browser.

> **Build step is optional.** `scripts/build.ts` exists to bundle
> Bun + the source into a single binary for users who do not have
> Bun installed. To run the server yourself, you do not need to
> build anything — `bun run src/cli.ts serve` works as-is.

### Why stream-json, not bridge-protocol replication?

Claude Code's RemoteControl uses a private WebSocket protocol that
requires OAuth + Trusted Device enrollment. Reverse-engineering and
re-implementing that protocol works in theory (pocket-claude proved
it), but it's fragile — every CLI release can break it. Instead,
open-rc is designed to work against Claude Code's **public,
documented** `--input-format stream-json --output-format stream-json
--print` mode. The user runs `claude` with those flags and pipes the
output over WS. Same UX, no protocol chasing. See
[`docs/survey.md`](./docs/survey.md) for the full survey.

### Why no spawn?

Because the moment we ship a bridge that spawns `claude`, we are
tempted to also "manage" the subprocess — restart it, signal it,
walk `ps` to find it. That path leads to take-over: open-rc trying
to find and replace a `claude` the user started elsewhere. Take-over
is forbidden. The cleanest way to keep the take-over temptation
permanently off the table is to ship a server that has no spawn
capability at all. The user's machine, the user's pipes, the user's
problem.

### What `open-rc` does NOT do

- It does **not** spawn anything. No `Bun.spawn`, no `fork`, no
  `exec`, no PTY attach. The server's process table never changes
  after `serve` boots.
- It does **not** walk the process table. No `ps`, no `lsof`, no
  `/proc`, no signal-sending.
- It does **not** speak any model API. The CLI does that, through
  whatever `ANTHROPIC_BASE_URL` (or provider adapter) you already
  use.
- It does **not** require claude.ai OAuth. Local-only mode has no
  auth at all.
- It does **not** replicate the Anthropic Trusted Device flow. Local
  mode binds to loopback; hub mode uses its own Ed25519 device
  enrollment.
- It does **not** take over external `claude` sessions. The server
  has no way to find one.
- It does **not** create clients from the browser. The browser shows
  what bridges are currently connected; it cannot spawn one. To
  start a new "session" in the sidebar, open another bridge from
  another terminal.

---

## Documentation

- [`SECURITY.md`](./SECURITY.md) — threat model, transport notes,
  hardening checklist.
- [`docs/architecture.md`](./docs/architecture.md) — component
  breakdown, wire protocol, persistence (in-memory replay only, no disk),
  open questions.
- [`docs/roadmap.md`](./docs/roadmap.md) — phased implementation
  plan with exit criteria. Phase 7 is the no-spawn pivot.
- [`docs/survey.md`](./docs/survey.md) — comparison of 6 similar
  projects and the reasoning for the no-spawn design.
- [`docs/tech-stack.md`](./docs/tech-stack.md) — concrete picks and
  alternatives considered.

---

## Authentication

### Local-only mode (default)

No auth. The server binds to `127.0.0.1`. Anyone with loopback
access can read the sidebar and send prompts. The operator is the
presumed audience. For LAN access, bind to `0.0.0.0` and put your
own auth in front (reverse proxy with basic auth, Tailscale, etc.).

### Hub mode

Two identity planes:

- **Devices → Hub.** Trusted Device enrollment. The local
  `open-rc serve` generates an Ed25519 keypair on first run, prints
  a short fingerprint, and asks the user to approve at `/api/pair`.
  The hub records the public key.
- **Browsers → Hub.** The current build trusts anyone who can reach
  the hub's `/browser` endpoint. **Put the hub behind a
  TLS-terminating, authenticated reverse proxy in production.** See
  [`SECURITY.md`](./SECURITY.md).

We do **not** ask for any Anthropic-side credential. We are not an
OAuth client of Anthropic. We are the user's identity provider for
their own control plane.

---

## Supported LLM providers

`open-rc` itself is **provider-agnostic** — it does not speak any
model API. The CLI talks to providers through whatever
`ANTHROPIC_BASE_URL` setup the user already has working. The
provider-translation work, if needed, lives outside this repo.

| Provider  | Native Anthropic-Messages-API endpoint | Status             |
| --------- | -------------------------------------- | ------------------ |
| Deepseek  | TBD — needs verification               | Investigation      |
| GLM       | TBD — needs verification               | Investigation      |
| MiniMax   | TBD — needs verification               | Investigation      |

See [`docs/architecture.md` §8.1](./docs/architecture.md) for what we
still need to learn per provider.

---

## Requirements

- **Bun** ≥ 1.3 ([install](https://bun.sh))
- **Claude Code CLI** (`claude` on `PATH`) — required only on the
  machine where the user runs `claude`. The server does not need it.
- A browser, for the UI
- A way to pipe `claude`'s `stream-json` over WebSocket — your
  bridge, your choice. `open-rc` does not provide one.

---

## Status

**Phases 1–7 complete.** `open-rc serve` is a pure WebSocket relay.
It does not spawn `claude`. It does not manage `claude`. The CLI
exposes five commands: `serve`, `hub`, `attach-orc`, `tui`, and
`attach-tmux`. Only `attach-orc` (a user-run bridge) spawns `claude`;
`attach-tmux` spawns only `tmux` to mirror a `claude` you already
started; `serve` and `hub` are spawn-free relays and `tui` is a
spawn-free `/ws` client.

| Phase | What                                     | Status |
| ----- | ---------------------------------------- | ------ |
| 1     | Local serve MVP                          | ✓      |
| 2     | Permission model (audit log)             | ✓      |
| 3     | UI (multi-client sidebar)                | ✓      |
| 4     | Hub mode (Ed25519 enrollment, sqlite)    | ✓      |
| 5     | Web Push (VAPID, browser notifications)  | ✓      |
| 6     | Hardening (tests, typecheck, cross-build)| ✓      |
| 7     | **No-spawn pivot** — server has no spawn capability | ✓ |
| 8.1   | PWA install + offline app-shell cache     | ✓      |

### UI at a glance

A 300 px sidebar on the left lists every client currently connected
to the server. Each row shows a status dot, a client label, an
abbreviated working directory, and a last-activity timestamp. The
right-hand pane shows the active client's transcript (whatever frames
the user's bridge sends — typically translated `stream-json` shapes:
markdown-rendered assistant text, collapsed thinking, tool_use /
tool_result details, system events, errors). Permission requests get
a centered modal.

Mobile: the sidebar collapses; selecting a row slides the chat pane
in from the right; a back button in the chat header slides the
sidebar back in. No drawer, no toggle — sliding panes.

#### PWA install

The SPA installs as a PWA: a web app manifest, an app-shell service
worker (NetworkFirst with a precache fallback), and the necessary
iOS meta tags are all wired up. On Chrome / Edge / Firefox, click the
**Install** button in the sidebar header (or use the browser's
install affordance) to add open-rc to the desktop. On iOS Safari,
open the share sheet → **Add to Home Screen**; the SPA surfaces a
one-time hint the first time it loads. Once installed, the shell
loads even when the relay is unreachable — the composer is
disabled offline, but the cached history of the last session
remains visible. Web Push on iOS requires this install step (Safari
16.4+ delivers push only to home-screen-installed PWAs).

Design language: the transcript reads like an **instrument log**. Human
and assistant prose sit in readable surfaces; everything the machine
does — thinking, tool calls, tool output — is a quiet left-ruled log
line, and each turn ends on a hairline delimiter carrying its telemetry
(`turn complete · 8.4s · $0.0231`). Type uses the system UI sans for
prose and the system monospace (SF Mono / Menlo / Consolas) for every
machine readout — status, IDs, cwd, tool I/O, timestamps. No web fonts:
it renders on a network where Google Fonts is unreachable. Surfaces are
a cool neutral dark (`#0e0f12`) with hairline separators; the green /
amber / red status legend is the traffic light. The **amber accent**
(`#f97316`) marks only *your* control points — Send, the active
session, your own messages, and Allow — so warmth on the screen always
means "you act here," never something the machine did.

See [`docs/roadmap.md`](./docs/roadmap.md) for details.

---

## Development

The npm scripts in `package.json` are the source of truth — the
`Makefile` is a thin convenience layer on top of them. Run
`make help` for the full list:

```text
make help              # show every target with its description
make install           # bun install
make serve             # start the local relay (foreground)
make hub               # start the public hub relay
make dev               # serve with --watch (auto-restart on file change)
make test              # bun test
make test-coverage     # bun run test:coverage
make typecheck         # tsc --noEmit
make lint              # biome check
make fmt               # biome format --write
make verify            # typecheck + test (CI gate)
make build             # (DISTRIBUTION) cross-compile a single-binary for the current host
make build-all         # (DISTRIBUTION) cross-compile all 5 target platforms
make clean             # rm -rf dist
```

If you prefer npm scripts directly:

```bash
bun install              # install deps
bun run serve            # start the local relay (foreground)
bun run hub              # start the public hub relay
bun run dev              # serve with --watch
bun test                 # tests
bun run test:coverage    # with coverage report
bun run typecheck        # strict TS
bun run lint             # biome
bun run build            # DISTRIBUTION ONLY — single-binary for current host
bun run build --all      # DISTRIBUTION ONLY — single-binary for all 5 platforms
```

> **Build step is optional.** `bun run build` produces a single-file
> executable that bundles Bun + the source — useful for releasing
> binaries to users who do not have Bun installed. To run the server
> yourself, you do not need to build anything: `bun run serve` (or
> `bun run src/cli.ts serve …`) launches the relay directly from the
> TypeScript source.

---

## Contributing

Open an issue first for non-trivial changes so we can align on
direction. Especially welcome: provider-compat testing (Deepseek / GLM
/ MiniMax), UI polish, hub transport design.

---

## License

[MIT](./LICENSE) — see `LICENSE` for the full text.

---

## Acknowledgments

- Anthropic, for Claude Code and the public `--print --output-format
  stream-json` mode that makes this project possible
- [pocket-claude](https://github.com/nicholasgasior/pocket-claude) —
  the proof that Claude Code's WS bridge is replicable, even if
  open-rc ultimately chose to ship only the relay half
- The Claude Code community for the wire-format reverse-engineering
- Deepseek, Zhipu (GLM), and MiniMax for publishing
  Claude-Code-compatible endpoints
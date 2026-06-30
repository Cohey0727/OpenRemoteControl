# open-rc

> Claude Code's RemoteControl control plane — open, self-hostable, and usable
> against any Claude Code-compatible LLM provider.

[![Status: Phases 1–6 complete](https://img.shields.io/badge/status-phases%201%E2%80%936%20complete-green)](#status)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-bun%201.3+-yellow)](#requirements)
[![Coverage: 90%](https://img.shields.io/badge/coverage-90%25-brightgreen)](#status)

---

## What is open-rc?

Claude Code's RemoteControl (driving a session from the web UI or mobile app,
peer-to-peer `SendUserMessage` across machines, push notifications, `/teleport`,
`/rewind`) is implemented as a **private control plane** between the CLI and
`wss://bridge.claudeusercontent.com`. That control plane requires claude.ai
OAuth + Trusted Device enrollment, and is not available to providers who only
publish a Claude-Code-API-compatible inference endpoint.

`open-rc` is a **drop-in replacement for that control plane**:

- Runs as a local server that spawns and drives the `claude` CLI on your behalf
  and ships the session to a browser UI over WebSocket.
- Is provider-agnostic. It does not touch the model API. The CLI talks to the
  provider through whatever `ANTHROPIC_BASE_URL` setup already works; `open-rc`
  handles the control channel that lives next to it.
- Optionally exposes a **relay hub** so multiple devices can drive sessions
  from multiple browsers.
- Optionally delivers **Web Push** notifications when a session goes idle.

> **TL;DR.** `open-rc` is the RemoteControl bridge that Claude Code normally
> gets from `wss://bridge.claudeusercontent.com`, but yours to host.

---

## Quick start

```bash
# Clone & install
git clone https://github.com/kohei/open-rc.git
cd open-rc
bun install

# Start the local bridge
bun run src/cli.ts serve --port 7322 --cwd "$PWD"

# Open the UI
open http://127.0.0.1:7322
```

Type a message, press Enter. You'll see streamed thinking, the assistant's
text reply, tool use (if any), and a `done` frame with cost & duration. Ctrl-C
in the terminal cleanly shuts down both the Bun server and the spawned
`claude` process — no orphans.

### Hub mode (multi-device, multi-user)

```bash
# Run the relay
bun run src/cli.ts hub --port 7443 --autoApprove=false

# On each device
open-rc serve --port 7322 --hub ws://hub.example:7443
```

Devices enroll via Ed25519 challenge. Browsers connect to `/browser` and list
or send to any registered session. See [SECURITY.md](./SECURITY.md) for
transport notes — hub does not authenticate browsers by default; put it
behind a TLS proxy.

### Web Push

When a session emits a `result` frame, `open-rc` delivers a Web Push
notification to every subscribed browser. The UI exposes a 🔔 button in the
header; click it once to enable. VAPID keys are generated on first run and
persisted to `~/.local/share/open-rc/vapid.json`.

### CLI flags

```text
bun run src/cli.ts serve
  --port             <n>   Listen port (default 7322)
  --host             <h>   Bind host (default 127.0.0.1; LAN access needs 0.0.0.0)
  --cwd              <d>   Working directory passed to `claude` (default $PWD)
  --claudeBin        <p>   Path or name of the `claude` binary (default "claude")
  --permissionMode   <m>   bypassPermissions | acceptEdits | default | dontAsk | plan | auto

bun run src/cli.ts hub
  --port             <n>   Listen port (default 7443)
  --host             <h>   Bind host (default 127.0.0.1)
  --dbPath           <p>   SQLite path (default $XDG_DATA_HOME/open-rc/hub.db)
  --autoApprove            Skip the browser-pair step (insecure; testing only)
```

---

## Architecture

```
src/
├── cli.ts                       # arg parsing, signal handling, server boot
├── serve.ts                     # Bun.serve entry: HTTP + WS + static UI
├── ws.ts                        # WS handlers: client↔server frame routing
├── hook/pretool.ts              # PreToolUse hook command (spawned by Claude)
├── permission/                  # Phase 2: PreToolUse + audit
│   ├── settings.ts              #   generate Claude Code settings.json
│   ├── manager.ts               #   open/resolve permission requests
│   └── audit.ts                 #   append-only JSONL audit log
├── push/                        # Phase 5: Web Push
│   ├── vapid.ts                 #   VAPID keypair lifecycle
│   ├── store.ts                 #   subscription sqlite CRUD
│   └── notifier.ts              #   web-push wrapper (deletes 410-gone)
├── hub/                         # Phase 4: multi-device relay
│   ├── crypto.ts                #   Ed25519 keys + sign/verify
│   ├── store.ts                 #   bun:sqlite (devices, sessions, audit)
│   ├── server.ts                #   Bun.serve WS server
│   └── client.ts                #   serve-side hub dialer
└── session/                     # Phase 1: stream-json bridge
    ├── ws-protocol.ts           #   Zod schemas for the UI wire protocol
    ├── stream-json.ts           #   NDJSON event schemas from `claude`
    ├── translate.ts             #   stream-json → ws frame translator
    ├── subprocess.ts            #   Bun.spawn wrapper for the CLI
    └── manager.ts               #   one subprocess per session

ui/
├── index.html                   # SPA shell + importmap for solid-js@esm.sh
├── sw.js                        # service worker for Web Push
└── app.ts                       # Solid.js SPA (tagged-template, no build step)

tests/                           # 49 tests, ~90% coverage
scripts/
└── build.ts                     # cross-compile to linux/darwin/windows
```

### Why stream-json, not bridge-protocol replication?

Claude Code's RemoteControl uses a private WebSocket protocol that requires
OAuth + Trusted Device enrollment. Reverse-engineering and re-implementing
that protocol works in theory ([pocket-claude](./docs/survey.md#pocket-claude)
proved it), but it's fragile — every CLI release can break it. Instead,
`open-rc` uses Claude Code's **public, documented** `--input-format
stream-json --output-format stream-json --bare` mode. Same UX, no protocol
chasing. See [`docs/survey.md`](./docs/survey.md) for the full survey.

### What `open-rc` does NOT do

- It does **not** speak any model API. The CLI does that, through whatever
  `ANTHROPIC_BASE_URL` (or provider adapter) you already use.
- It does **not** require claude.ai OAuth. Local-only mode has no auth at all.
- It does **not** replicate the Anthropic Trusted Device flow. Local mode
  binds to loopback; hub mode uses its own Ed25519 device enrollment.

## Documentation

- [`SECURITY.md`](./SECURITY.md) — threat model, transport notes, hardening checklist.
- [`docs/architecture.md`](./docs/architecture.md) — what we're building,
  wire-protocol details, auth model.
- [`docs/roadmap.md`](./docs/roadmap.md) — phased implementation plan with
  exit criteria.
- [`docs/survey.md`](./docs/survey.md) — comparison of 7 similar projects
  and the reasoning for choosing stream-json over bridge-replication.
- [`docs/investigation.md`](./docs/investigation.md) — how Claude Code's
  RemoteControl actually works, for readers who don't know the internals.

---

## Authentication

### Local-only mode (`open-rc serve` with no `--hub`)

No auth. UI binds to `127.0.0.1`. The user is presumed to be the operator.
For LAN access, bind to `0.0.0.0` and put your own auth in front (reverse
proxy with basic auth, Tailscale, etc.).

### Hub mode

Two identity planes:

- **Devices → Hub.** Trusted Device enrollment. The local `open-rc` generates
  an Ed25519 keypair on first run, prints a short fingerprint, and asks the
  user to approve at `/api/pair`. The hub records the public key.
- **Browsers → Hub.** The current build trusts anyone who can reach the
  hub's `/browser` endpoint. **Put the hub behind a TLS-terminating,
  authenticated reverse proxy in production.** See [SECURITY.md](./SECURITY.md).

We do **not** ask for any Anthropic-side credential. We are not an OAuth
client of Anthropic. We are the user's identity provider for their own
control plane.

---

## Supported LLM providers

`open-rc` itself is **provider-agnostic** — it does not speak any model API.
The CLI talks to providers through whatever `ANTHROPIC_BASE_URL` setup the user
already has working. The provider-translation work, if needed, lives outside
this repo.

| Provider  | Native Anthropic-Messages-API endpoint | Status             |
| --------- | -------------------------------------- | ------------------ |
| Deepseek  | TBD — needs verification               | Investigation      |
| GLM       | TBD — needs verification               | Investigation      |
| MiniMax   | TBD — needs verification               | Investigation      |

See [`docs/architecture.md` §8.1](./docs/architecture.md) for what we still
need to learn per provider.

---

## Requirements

- **Bun** ≥ 1.3 ([install](https://bun.sh))
- **Claude Code CLI** (`claude` on `PATH`) — `open-rc` does not include it
- A browser, for the UI

---

## Status

**Phases 1–6 complete.** 49 tests pass with ~90% coverage.

| Phase | What                                     | Status |
| ----- | ---------------------------------------- | ------ |
| 1     | Local serve MVP (stream-json bridge)     | ✓      |
| 2     | Permission model (PreToolUse + audit)    | ✓      |
| 3     | UI polish + multi-session sidebar        | ✓      |
| 4     | Hub mode (Ed25519 enrollment, sqlite)    | ✓      |
| 5     | Mobile push (VAPID web push)             | ✓      |
| 6     | Hardening (tests ≥80%, CI, cross-build)  | ✓      |

See [`docs/roadmap.md`](./docs/roadmap.md) for details.

---

## Development

```bash
bun install              # install deps
bun test                 # 49 tests
bun run test:coverage    # with coverage report
bun run typecheck        # strict TS
bun run lint             # biome
bun run build            # cross-compile (current host)
bun run build --all      # cross-compile all 5 targets
```

---

## Contributing

Open an issue first for non-trivial changes so we can align on direction.
Especially welcome: provider-compat testing (Deepseek / GLM / MiniMax), UI
polish, hub transport design.

---

## License

[MIT](./LICENSE) — see `LICENSE` for the full text.

---

## Acknowledgments

- Anthropic, for Claude Code and the public `--bare --output-format
  stream-json` mode that makes this project possible
- [pocket-claude](https://github.com/nicholasgasior/pocket-claude) — the
  proof that Claude Code's WS bridge is replicable, even if `open-rc`
  ultimately chose a different path
- The Claude Code community for the wire-format reverse-engineering
- Deepseek, Zhipu (GLM), and MiniMax for publishing Claude-Code-compatible
  endpoints
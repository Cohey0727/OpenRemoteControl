# Investigation: How Claude Code's RemoteControl Actually Works

> **Audience:** anyone about to implement or use `open-rc` who has not dug into
> Claude Code's internals. This document explains what is actually happening on
> the wire, in terms a non-expert can verify.

---

## TL;DR

When you run `claude --remote-control`, three things happen **in parallel**:

1. The Claude Code CLI runs your session **locally** on your machine, exactly
   the same as without `--remote-control`. The agent loop, the tools, the file
   edits — all local.
2. The CLI opens a **WebSocket** to a remote server. That server does **not**
   run the model. It does **not** execute your tools. It only carries small
   control messages: "here's a prompt the user typed on their phone",
   "show this tool call to the user", "notify the user the session ended".
3. A web UI or mobile app **also** connects to that same server and renders
   those control messages. The user types into the web UI → server → CLI.
   The CLI runs the agent → emits events → server → web UI displays them.

The "server" is what `open-rc` replaces.

---

## Why this matters

The mental model most people have — "Claude Code talks to a backend, the
backend does the work" — is wrong for the agent loop. The backend does no
work; it only stores conversation state. The real work (reading files,
running shell, editing code, calling MCP servers) happens **inside the CLI
process on your laptop**.

What the backend does have, and what makes RemoteControl useful, is:

- A persistent identity for the user (their claude.ai subscription)
- A persistent identity for the device (Trusted Device enrollment)
- A reachable WebSocket endpoint that survives the CLI restarting
- Routing of control messages between (CLI on machine A) and (web/mobile
  on machine B) when those two machines are not the same

These four capabilities together enable the "drive my local Claude Code
session from my phone" experience. None of them are about inference. They
are all about **identity, presence, and message routing**.

`open-rc` reproduces all four.

---

## Three independent transports

Claude Code's binary has, when you look at the strings, three separate
transport mechanisms for different scopes:

### 1. Local tool / agent transport (`uds:`)

When Claude Code starts, it creates **Unix Domain Sockets** in a known
location. Other local processes — MCP servers, REPL wrappers, background
agents, the IDE integration — connect to these sockets and exchange
protocol messages.

This is how `claude` talks to MCP. It is **not** what RemoteControl uses.
It's the same-machine plumbing.

```
claude CLI  ──uds:~/.../mcp.sock──>  MCP server
```

### 2. Remote control transport (`bridge:`)

When you run `claude --remote-control`, the CLI opens a **WebSocket** to a
bridge server. The exact endpoints baked into the binary:

- `wss://bridge.claudeusercontent.com` (production)
- `wss://bridge-staging.claudeusercontent.com` (staging)
- `ws://localhost:8765` (default for loopback / local bridge)

The protocol over that socket is what the binary calls `control_request` /
`control_response`. Examples of subtypes (visible as log prefixes in the
binary):

```
[bridge:repl] Ingress message type=control_response
[bridge:repl] Inbound control_request subtype=user_message
[bridge:repl] Ignoring echo: type=...
[bridge:repl] Failed to parse ingress message: ...
```

The CLI sends events to the bridge as the session progresses
(`assistant_message`, `tool_use`, `permission_request`, etc.). The bridge
sends control events to the CLI when the user acts from the web/mobile
UI (`user_message`, `permission_response`, `stop`, etc.).

### 3. HTTP / SOCKS bridges

Also visible in the binary: `Starting HTTP bridge:` and
`Starting SOCKS bridge:`. These are outbound proxy modes — they let a remote
machine tunnel back through your `claude` process to reach services on your
local network. Used for things like "open this preview URL on my dev box".

This is a power-user feature, not part of the core RemoteControl flow.

---

## Authentication

`claude --remote-control` will refuse to start if you are authenticated with
an API key. The exact error string from the binary:

> Remote Control requires claude.ai subscription auth. ANTHROPIC_AUTH_TOKEN
> is set, so this session is using API-key auth — unset it (or run in a
> shell without it) to use Remote Control.

So the auth flow is:

1. User signs into claude.ai (`/login` slash command or `claude auth login`).
2. The CLI gets an OAuth token from Anthropic, not an API key.
3. The CLI enrolls the current machine as a **Trusted Device**:
   ```
   [trusted-device] Enrolled device_id=…
   ```
   The token is persisted and can be loaded from the
   `CLAUDE_TRUSTED_DEVICE_TOKEN` env var on subsequent runs.
4. On connection to the bridge, the CLI presents the device token. The bridge
   verifies it and accepts the connection.
5. Org administrators can hard-disable RemoteControl via managed settings
   (`disableRemoteControl`) — the bridge checks the policy verdict before
   allowing the connection.

`open-rc` **does not** use any of this. We don't ask for an Anthropic OAuth
token. We don't check with any Anthropic server. We are the user's own
identity provider, on their own infrastructure, for their own control plane.

---

## Settings + policy

Settings that govern RemoteControl behavior (visible as binary strings):

| Setting                       | Effect                                            |
| ----------------------------- | ------------------------------------------------- |
| `remoteControlAtStartup`      | Auto-enable on every session start                |
| `disableRemoteControl`        | Hard-disable (managed settings can set this)      |
| `getRemoteControlPolicyVerdict` | Runtime check before allowing the connection     |
| `remote-control-auto` / `-auto-on` | Auto-start the bridge per session              |
| `remote-control-repl` / `-cli` / `-sdk` | Embedding modes                          |

There is also a separate `claude gateway` subcommand (Bun + Postgres
backend) that syncs org-level policy from the cloud. `open-rc` does not
need this — policy is whatever the operator of `open-rc hub` decides.

---

## What the binary does not show

The strings give us the **shape** of the protocol but not the **schema**.
To know the exact JSON fields, frame ordering, reconnection behavior, and
edge cases, we need to run `claude --remote-control` against a stub and
record what comes over the wire.

(Historical: this capture-first step predates the pure-relay pivot —
see [`docs/roadmap.md`](./roadmap.md), "0. Phasing principle" and the
Phase 7 pivot.)

---

## What this meant for `open-rc` (historical — superseded by the pivot)

> **Note (2026-07-02).** This section records the investigation's
> ORIGINAL conclusion. Item 1 — speaking `claude --remote-control`'s
> private dialect — was subsequently REJECTED: open-rc relays the
> public stream-json format only and never touches the private bridge
> protocol (see `CLAUDE.md` and roadmap Phase 7). Items 2–3 shipped;
> item 4 shipped as plain frame relaying in hub mode, not
> `control_request` routing.

The investigation originally narrowed `open-rc`'s scope to four things:

1. **(Rejected.) Implement the bridge side of the WS protocol** — speak
   whatever dialect `claude --remote-control` expects. Most of the
   actual lifting (running the agent, executing tools) stays inside
   the CLI; we only handle the small control messages.
2. **Serve a web UI** — a SPA that renders session events and lets the user
   send prompts. Same UI works for local access (loopback) and remote
   access (hub).
3. **Identity** — Trusted Device enrollment for the hub, using our own
   keypair scheme (Ed25519 + browser confirmation), not Anthropic OAuth.
4. **(Superseded.) Route control traffic across machines** — when a hub
   connects to many machines, route `control_request` envelopes to the
   right one based on session ID.

We are **not** implementing:

- The agent loop (CLI does that)
- Tool execution (CLI does that)
- The model API (provider does that, or a separate adapter does)
- The MCP transport (`uds:` — CLI does that)

---

## How to verify any of this

If you want to confirm what's described here:

```bash
# Look at the binary's strings yourself
strings /path/to/claude | grep -E 'remote.?control|bridge:|trusted.?device'

# Try to start RemoteControl and read the error
claude --remote-control

# Read the documented flags
claude --help | grep -A 3 remote-control
```

Sources: Claude Code 2.1.195 (ARM64, Bun-compiled), installed at
`/Users/kohei/.local/share/claude/versions/2.1.195` on this machine. Strings
extracted via `strings(1)`. No network traffic was generated during the
investigation; the binary was not run with `--remote-control` because the
host is API-key authenticated and the binary refuses.
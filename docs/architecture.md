# open-rc — Architecture

> **Status:** design draft. Pre-implementation.
> **Last revised:** 2026-06-29 — survey of comparable projects completed;
> stream-json subprocess approach confirmed.

---

## 0. What this document is

A frozen reference for the shape of the system, the protocol boundaries, and
the open questions that need answering before code lands. Updated whenever
the architecture shifts.

---

## 1. Problem statement (unchanged)

Three LLM providers — **Deepseek**, **GLM (Zhipu)**, and **MiniMax** — publish
endpoints that the Claude Code CLI can talk to at the API-request level. The
CLI itself runs fine against them when the user points `ANTHROPIC_BASE_URL`
at a compatible shim.

What the CLI **cannot** do against these providers, and what Anthropic's own
Claude Code distribution gets for free, is **RemoteControl**: drive an
in-progress local session from `claude.ai` (web) or the mobile app, get push
notifications, run `/teleport` and `/rewind`, exchange `SendUserMessage`
between peer sessions across machines.

Anthropic implements this as a private control plane between the CLI and
`wss://bridge.claudeusercontent.com`, gated by Trusted Device enrollment.
That control plane is what these providers do not — and cannot — expose.

`open-rc` is a replacement control plane.

---

## 2. Approach selection: survey of comparable projects

Before committing to a design we surveyed five close analogues on GitHub
(2026-06-29). The full breakdown is in
[`docs/survey.md`](./survey.md); summary here:

| # | Approach                              | Project                                                  | Verdict                          |
| - | ------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| a | Reimplement Anthropic bridge locally  | [`ly0/cc-remote-control-server`](https://github.com/ly0/cc-remote-control-server) | Patches CLI binary; fails for non-Anthropic providers. |
| a'| `/remote-control` slash → claude.ai handoff | [`barjakuzu/claude-rc-launcher`](https://github.com/barjakuzu/claude-rc-launcher), [`Zun-RZ/claude-remote-coding`](https://github.com/Zun-RZ/claude-remote-coding) | Needs Anthropic OAuth; hands off to claude.ai. |
| **b** | **`claude --bare --output-format stream-json` subprocess** | [`zhdzh12138/pocket-claude`](https://github.com/zhdzh12138/pocket-claude) | **Adopted.** |
| c | ACP NDJSON over stdio (`claude-code-acp`) | [`Eric-Song-Nop/mobvibe`](https://github.com/Eric-Song-Nop/mobvibe) | Most complete, but depends on a third-party adapter and adds significant complexity. Future option. |
| d | PTY + xterm.js                       | [`permissionnine9/claude-code-remote-control`](https://github.com/permissionnine9/claude-code-remote-control) | Brittle TUI parsing, awful UX for AI chat. |

**Why (b) wins for our goal** (UI drives Claude Code, works with any
provider the CLI supports, no Anthropic auth):

1. **Provider agnostic.** The subprocess uses whatever credentials the user
   has set up (`ANTHROPIC_API_KEY`, `apiKeyHelper`, 3P shim). Approaches
   (a/a') require Anthropic OAuth and patch the CLI's binary to redirect
   `frame.claudeusercontent.com`, which is incompatible with 3P providers.
2. **Independent of Anthropic infrastructure.** No Trusted Device
   enrollment, no `wss://bridge.claudeusercontent.com`, no patch script
   that breaks on every CLI release (ly0's hard-fails on non-2.1.112).
3. **Structured protocol.** stream-json is a documented public format
   (Agent SDK). Permissionnine9 (d) showed the cost of going the other
   way: regex-parsing TUI bytes is fragile and gives a bad chat UX.
4. **Proven.** pocket-claude has shipped multi-turn sessions with the
   exact wire format we want.
5. **(c) ACP is on the radar.** If the Zed/Claude-Code ACP adapter
   stabilizes and we confirm 3P provider support, mobvibe's architecture
   is a credible next-gen option. Noted for future work, not adopted now.

---

## 3. Approach (continued): stream-json subprocess

The plan we adopted (per §2): **subprocess the CLI**.

```bash
claude --bare --output-format stream-json --verbose --permission-mode bypassPermissions
```

This invocation:

- Runs Claude Code without the bridge, OAuth, hooks, plugins, or
  `CLAUDE.md` discovery.
- Requires only an API key (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `apiKeyHelper`, or a 3P-provider credential).
- Emits a public, documented JSONL event stream on stdout (the SDK format).
- Accepts user prompts as one-line JSON messages on stdin.
- Supports tools (Bash, Edit, Read, etc.) and MCP servers as usual.

`open-rc` becomes a process supervisor and a UI host, not a bridge-protocol
reimplementation. The "RemoteControl" capability is rebuilt from scratch on
top of this subprocess, with no dependency on Anthropic's infrastructure.

The reference implementation that proved this works is
[`zhdzh12138/pocket-claude`](https://github.com/zhdzh12138/pocket-claude).
We adopt their WS schema with light modifications.

---

## 4. Component overview

```
                       PUBLIC INTERNET (optional)
┌───────────────────────────────────────────────────────────────────────────┐
│                                                                           │
│    ┌────────────────────┐                 ┌──────────────────────────┐     │
│    │  Mobile / Web UI   │ ◀── HTTPS/WSS ─▶│  open-rc (hub mode)      │     │
│    │  (browser / app)   │                 │  public deployment       │     │
│    └────────────────────┘                 └─────────────┬────────────┘     │
│                                                        │                  │
└────────────────────────────────────────────────────────┼──────────────────┘
                                                  WSS    │
                                                       ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  USER'S MACHINE                                                           │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  open-rc serve                                                       │  │
│  │                                                                     │  │
│  │   - serves UI at 127.0.0.1:<port>                                  │  │
│  │   - spawns `claude --bare --output-format stream-json` per session  │  │
│  │   - pipes subprocess stdin/stdout ↔ WS bridge                       │  │
│  │   - (optional) dials out to a hub at REMOTE_CONTROL_URL=…           │  │
│  │   - Trusted Device enrollment (when remote hub is used)             │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  The `claude` binary is **unchanged**. We spawn it as a child process.    │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

`open-rc` ships as **one binary**, two modes (`serve` / `hub`), shared code.

### 3.1 `open-rc serve` (local)

- Binds `127.0.0.1:<port>`.
- Spawns `claude --bare --output-format stream-json --verbose` as a
  child process per active session.
- Pipes the subprocess's stdout JSONL into the SPA via WebSocket.
- Receives user prompts from the SPA, writes them as JSONL to the
  subprocess's stdin.
- Optionally dials out to a public hub for cross-machine access.

### 3.2 `open-rc hub` (public)

- Accepts inbound WSS connections from many `open-rc serve` instances.
- Exposes the SPA at `/`.
- Routes session events to subscribed mobile/web clients.
- Runs Trusted Device enrollment.
- Persists session registry in `bun:sqlite`.

### 3.3 UI

Single SPA (Solid.js) bundled with the binary. Same code is served by
local `serve` and public `hub`; only the API origin differs at runtime.

---

## 5. Wire protocols

Three boundaries, three contracts. Two are public.

### 4.1 `claude` subprocess ↔ `open-rc` (loopback, our process boundary)

**Public format: stream-json.** The CLI's `--output-format stream-json`
emits one JSON object per line on stdout. Verified event types:

| Type           | Subtype              | Purpose                                |
| -------------- | -------------------- | -------------------------------------- |
| `system`       | `init`               | Session start; lists tools, MCP, model |
| `system`       | `thinking_tokens`    | Token count updates                    |
| `assistant`    | —                    | Message: thinking, text, tool_use      |
| `user`         | —                    | Echoes user input + tool_result blocks |
| `result`       | `success` / `error`  | Turn complete with metrics             |

Subtype details for `assistant.message.content[]` blocks:

| Block type   | Fields                                          |
| ------------ | ----------------------------------------------- |
| `thinking`   | `thinking`, `signature`                         |
| `text`       | `text`                                          |
| `tool_use`   | `id`, `name`, `input`                           |

Subtype details for `user.message.content[]` blocks:

| Block type     | Fields                                                  |
| -------------- | ------------------------------------------------------- |
| `text`         | `text` (only at conversation start)                     |
| `tool_result`  | `tool_use_id`, `content`, `is_error`                    |

User prompts are sent as:

```json
{"type":"user","message":{"role":"user","content":"Your prompt here"}}
```

Termination: when `claude` is done with a turn it emits a `result` event
and continues running for the next prompt (multi-turn via stdin).

This format is **public** (it's the Agent SDK wire format). Source:
`https://docs.claude.com/en/docs/agent-sdk/overview`.

### 4.2 `open-rc serve` ↔ UI (WebSocket, our protocol)

**Our format.** Adopted from `zhdzh12138/pocket-claude` because it is
already proven and clean.

Client → Server:

```ts
type WsClientMessage =
  | { type: 'send'; sessionId: string; text: string; projectPath?: string }
  | { type: 'permission_response'; sessionId: string; approved: boolean }
  | { type: 'attach'; sessionId: string }
  | { type: 'detach'; sessionId: string };
```

Server → Client:

```ts
interface WsServerMessage {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'permission_request' | 'done' | 'error';
  sessionId: string;
  text?: string;
  tool?: string;
  input?: string;
  output?: string;
  cost?: number;
  duration_ms?: number;
  message?: string;
}
```

Translation rules (stream-json → WsServerMessage):

| stream-json event                     | WsServerMessage type  |
| ------------------------------------- | --------------------- |
| `assistant.message.content[type=text]` | `text`                |
| `assistant.message.content[type=thinking]` | `thinking`        |
| `assistant.message.content[type=tool_use]` | `tool_use`        |
| `user.message.content[type=tool_result]` | `tool_result`      |
| `result` (success/error)              | `done`                |

The server is the only thing that knows about stream-json. The UI only
sees the simplified WsServerMessage shapes.

### 4.3 `open-rc serve` ↔ `open-rc hub` (WSS, optional)

Only used when local `serve` dials out to a public `hub`. Same WsServer
schema on both sides, with hub-specific lifecycle envelopes for session
announce, peer attach, and detach. Designed later, after local-mode MVP.

---

## 6. Authentication

Two identity planes, but only when a hub is in the picture.

### 5.1 Local-only mode

No auth. UI binds to `127.0.0.1`. The user is presumed to be the operator.
For LAN access, bind to `0.0.0.0` and put your own auth in front.

### 5.2 Hub mode

- **Devices → Hub.** Ed25519 keypair generated on first run. Enrollment via
  browser confirmation. Signature challenge on reconnect.
- **End users → Hub.** Email magic link. Pluggable.

We do **not** ask for any Anthropic-side credential. The CLI subprocess
uses whatever `ANTHROPIC_API_KEY` / `apiKeyHelper` / 3P-provider credential
the user already has set up. `open-rc` is not in the auth path.

---

## 7. Subprocess management

`open-rc serve` spawns `claude --bare --output-format stream-json
--verbose --permission-mode bypassPermissions` once per active session.

Why these flags:

- `--bare` — strips hooks, plugins, OAuth, `CLAUDE.md` discovery. Forces
  API-key auth. Required so the subprocess is self-contained and uses
  whatever provider credential the user has.
- `--output-format stream-json` — emits the public JSONL event stream.
- `--verbose` — required for `result` events to include metrics.
- `--permission-mode bypassPermissions` — for v1 we do not implement
  per-tool permission prompts; all tools are auto-approved in the
  subprocess. The hub-mode UI shows tool calls and lets the user cancel,
  but the subprocess does not block.

Open question: do we want `--bare` to be a default or opt-in? `--bare`
strips hooks and plugin discovery, which the user might want. For v1 we
make it the default and document the trade-off.

### Lifecycle

- Spawn on first WS attach for a session.
- Kill (`SIGTERM`, then `SIGKILL` after 3s) when the SPA sends `detach`
  or the WS closes.
- Restart on subprocess crash; surface the error to the UI.
- One subprocess per session. Multi-session = multi-subprocess.

---

## 8. Findings: what we know about Claude Code internals

Captured from binary inspection (Claude Code 2.1.195, ARM64, Bun-compiled).
Kept here as a reference for anyone digging deeper.

### 7.1 Bridge protocol (now: not our concern)

Originally our target. Strings baked into the binary:

- `--remote-control [name]`, `--rc`, `--remote-control-session-name-prefix`
- `wss://bridge.claudeusercontent.com` (prod), `wss://bridge-staging…` (staging)
- `\.frame\.(staging\.)?claudeusercontent\.com` — URL allowlist regex
- `control_request` / `control_response` envelope types
- `[bridge:repl]`, `[bridge:attestation]`, `[bridge:attestation] accepting unverified`
- Trusted Device enrollment via `/login`, `CLAUDE_TRUSTED_DEVICE_TOKEN`
- Env vars: `CLAUDE_BRIDGE_BASE_URL`, `CLAUDE_BRIDGE_OAUTH_TOKEN`,
  `CLAUDE_BRIDGE_SESSION_INGRESS_URL`, `CLAUDE_BRIDGE_REATTACH_*`,
  `CLAUDE_CODE_FORCE_BRIDGE`

The CLI is hard-coded to dial `frame.claudeusercontent.com` and validates
URLs against the regex above. Override attempts via env var do not take
effect (verified empirically with mitmproxy + lsof). Trusted Device
enrollment requires Anthropic OAuth which we explicitly avoid.

**Conclusion:** we don't try to redirect the bridge. We spawn our own CLI
subprocess.

### 7.2 `--bare` mode

Discovered from binary strings + verified empirically:

> Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory,
> background prefetches, keychain reads, and CLAUDE.md auto-discovery.
> Sets `CLAUDE_CODE_SIMPLE=1`. Anthropic auth is strictly
> `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and
> keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use
> their own credentials.

Exactly what we want for the subprocess.

### 7.3 stream-json event stream

Verified by piping real prompts into `claude --bare --output-format
stream-json`. All event types and content block shapes enumerated in §4.1.

---

## 9. Open questions

### 8.1 Provider compatibility check (DEFERRED)

The CLI subprocess handles provider differences via `ANTHROPIC_BASE_URL`
and the various 3P provider env vars. We don't need provider adapters in
this repo at all — the user already has whatever shim they use.

If we discover a provider that ships a Claude-Code-compatible endpoint
but the CLI subprocess doesn't work against it (e.g., tool use is
incompatible), we will need to revisit. For now: subprocess + user
config = done.

### 8.2 Permission model (BLOCKING for v0.2)

For v0.1 we auto-approve all tools (`--permission-mode bypassPermissions`).
The UI shows tool calls and lets the user cancel the session, but the
subprocess does not block.

For v0.2 we want to actually pause on high-risk tools (Bash with `rm`,
git push, etc.) and ask the user via the UI. This requires implementing
the PreToolUse hook flow, which `--bare` strips out. Options:

- Don't use `--bare` for the subprocess; lose the OAuth-strip guarantee.
- Use `--bare` and intercept via the parent's `--settings` file with a
  PreToolUse hook that talks to the WS to ask for permission.
- Use `--permission-mode` other than `bypassPermissions` and forward
  permission prompts.

We deferred this — `--bare` + `bypassPermissions` for v0.1, revisit in
v0.2.

### 8.3 Mobile push (DEFERRED to hub mode phase)

Web push notifications via VAPID when a hub is in the picture. Not in v0.1.

---

## 10. Out of scope (unchanged)

- Re-implementing the Claude Code agent loop (we spawn the CLI).
- Re-inventing the Anthropic Messages API.
- A full claude.ai clone (we provide a minimal RemoteControl UI).
- A SaaS product (anyone can self-host).

---

## 11. Glossary

| Term                | Meaning                                                            |
| ------------------- | ------------------------------------------------------------------ |
| **CLI**             | Anthropic's `claude` binary, spawned as a subprocess.              |
| **`open-rc`**       | The single binary this repo builds.                                |
| **Local mode**      | `open-rc serve` — local subprocess + UI on loopback.               |
| **Hub mode**        | `open-rc hub` — public deployment accepting remote clients.        |
| **Subprocess**      | One `claude --bare --output-format stream-json` per session.       |
| **Trusted Device**  | A machine enrolled with a hub via keypair + browser confirmation.  |
| **stream-json**     | Public Agent SDK wire format. JSONL on stdout.                     |
| **WsClientMessage** | Our WS schema, UI → server.                                        |
| **WsServerMessage** | Our WS schema, server → UI.                                        |
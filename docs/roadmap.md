# open-rc — Roadmap

> **Last revised:** 2026-06-29 — rewritten after the architecture pivot
> (stream-json subprocess) and project survey.

---

## 0. Phasing principle

Each phase ends with something a real person can use. We don't ship a
phase until its deliverable runs end-to-end against `claude --bare
--output-format stream-json` and the user can demonstrate the value
described in that phase's "Definition of done."

We do **not** build capture tooling, protocol re-implementations, or
anything that requires Anthropic-side infra. The approach is fixed:
spawn the CLI as a subprocess, translate stream-json into a tiny WS
protocol, render the conversation in a Solid.js SPA. See
[`architecture.md`](./architecture.md) and [`survey.md`](./survey.md).

---

## Phase 1 — Local serve MVP

**Goal.** A single binary (`bun build --compile`) that the user runs
locally, opens `http://127.0.0.1:<port>` in a browser, types a prompt,
and sees Claude's reply stream back.

**Scope.**

- `open-rc serve` (default command; alias for `open-rc` with no args).
- Binds `127.0.0.1:7322` (configurable via `--port`).
- Bun.serve hosting the SPA + WebSocket.
- SPA = Solid.js (smallest mainstream framework, no bundler magic
  needed — Vite + Bun integration is well-trodden).
- One subprocess per session, spawned lazily on first `attach` WS
  message.
- Subprocess invocation:
  ```
  claude --bare --output-format stream-json --verbose
         --permission-mode bypassPermissions
  ```
- Stream-json → `WsServerMessage` translation (see architecture.md §5).
- `WsClientMessage` → stdin JSON (see architecture.md §5).
- Single hard-coded sessionId for now (no multi-session).
- Cancel = write `\x03` to stdin.
- Clean subprocess shutdown on SIGTERM/SIGINT (forward SIGTERM, fall
  back to SIGKILL after 3 s).
- Structured logging via `pino` (or `console.log` with a tiny
  formatter) — no per-keystroke console output.

**Out of scope (this phase).** Permissions UI. Multiple sessions.
Project picker. Resuming old sessions. Hub mode.

**Definition of done.**

- `bun run build` produces `./open-rc` (single binary, ~20 MB).
- `./open-rc` boots in <500 ms.
- User opens `http://127.0.0.1:7322`, types a prompt, sees the reply.
- User opens DevTools, sees `WsServerMessage` frames arriving.
- Subprocess crashes → error surfaces in UI, restart possible.
- Ctrl-C → clean exit, no orphan `claude` processes (`pgrep claude`
  empty after exit).

**Files this phase will create.**

```
src/
  cli.ts             # arg parsing (commander or yargs)
  serve.ts           # Bun.serve wiring
  ws.ts              # WebSocket handlers
  session/
    manager.ts       # sessionId → subprocess map
    subprocess.ts    # spawn() wrapper, lifecycle
    stream-json.ts   # NDJSON parser
    ws-protocol.ts   # WsClientMessage / WsServerMessage types + zod schemas
    translate.ts     # stream-json → WsServerMessage
ui/
  index.html
  app.tsx
  components/
    MessageList.tsx
    Composer.tsx
    StatusBar.tsx
```

---

## Phase 2 — Permission model

**Goal.** The subprocess pauses on risky tool calls (Bash with `rm`,
git push, file edits outside the cwd, etc.), the UI shows a prompt,
the user clicks Allow/Deny, the subprocess resumes.

**Scope.**

- Drop `--permission-mode bypassPermissions`. Use `--permission-mode
  default` so the CLI shows prompts.
- Two viable implementations (decide in Phase 2):

  **Option A — Settings-injected PreToolUse hook.** Drop `--bare`
  for permission handling; write a temporary `.claude/settings.json`
  pointing at a PreToolUse hook command (`open-rc-permission-hook`).
  The hook reads the tool name + input, talks to the WS server over
  a Unix socket, asks the user, returns `approve` / `deny`. Pro:
  clean structured protocol. Con: re-introduces OAuth/keychain
  paths `--bare` was avoiding.

  **Option B — TUI prompt interception.** Keep `--bare` only for the
  CLI's auth/CLAUDE.md stripping. Drop `--permission-mode
  bypassPermissions`. Forward stream-json's `control_request` events
  with `can_use_tool` subtype to the UI. Pro: reuses the CLI's own
  permission state machine. Con: `--bare` may not emit
  `can_use_tool`. Needs verification.

  **Option C — Best-effort `accept-edits` mode.** Use
  `--permission-mode accept-edits`. Edit/Write/MultiEdit auto-approved;
  Bash and other tools still pause. UI shows the prompt via
  `control_request`. Pro: smallest delta from v0.1. Con: doesn't
  pause on Bash.

  Default: try B first; fall back to A if B doesn't work because
  `--bare` strips `can_use_tool`.

- New `WsServerMessage` type: `permission_request { tool_use_id,
  tool, input }`.
- New `WsClientMessage`: `permission_response { tool_use_id,
  approved }`.
- UI: modal dialog with tool name, arguments, Allow/Deny buttons.
- Audit log of every permission decision.

**Out of scope.** Per-tool policies (always-allow Read, always-deny
`rm -rf /`). That belongs to a settings file the user maintains; v0.2
just shows the prompt.

**Definition of done.**

- Subprocess tries to run `rm -rf /tmp/foo` → UI shows modal within
  200 ms of the CLI emitting the prompt event.
- User clicks Allow → tool runs → tool_result flows back to UI.
- User clicks Deny → tool is reported as denied, conversation continues.
- `audit.log` records `{timestamp, tool, input_summary, decision}`.

---

## Phase 3 — UI polish & multi-session

**Goal.** The UI is actually pleasant to use and supports more than
one concurrent session.

**Scope.**

- Session list sidebar with: name, model, status (idle/running/error),
  last activity timestamp, working directory.
- New session = named, optional project path picker (text input +
  recent-dirs dropdown).
- Resume session = load transcript from
  `~/.claude/projects/<project-path>/<session-uuid>.jsonl` and
  replay as `WsServerMessage` events.
- Markdown rendering for assistant text.
- Syntax-highlighted code blocks.
- Tool call cards (collapsed by default, expandable to show input +
  output).
- Thinking blocks (collapsed by default; opt-in show).
- Cost + duration metrics on `done` events.
- Cancel button that interrupts the current turn.
- Mobile-responsive layout (single-column under 768 px).

**Definition of done.**

- User can run two sessions in parallel (split panes), each tied to
  a different working directory.
- Killing the server and restarting → resume both sessions from
  their last completed turn.
- Mobile browser (Safari iOS, Chrome Android) usable in portrait.

---

## Phase 4 — Hub mode

**Goal.** A self-hostable public deployment that many `open-rc serve`
instances dial into, and many browser/mobile clients attach to.

**Scope.**

- `open-rc hub` command: same binary, different mode.
- WSS listener (TLS via `bun:tls`).
- bun:sqlite schema for: registered devices (Ed25519 public keys),
  enrolled users (email), sessions (session-id → device-id mapping),
  audit log.
- Ed25519 device enrollment: first run, generate keypair, print
  enrollment URL; user opens URL in browser, confirms pairing,
  device is registered.
- Optional Tailscale or Cloudflare Tunnel integration docs.
- Web push notifications (VAPID) when a session finishes a turn and
  no UI is attached.

**Out of scope.** OAuth providers (Google/GitHub login). Pluggable
identity providers.

**Definition of done.**

- Two `open-rc serve` instances on different machines dial into one
  `open-rc hub`.
- User logs into hub from a phone browser.
- Phone sees both machines' session list.
- User sends a prompt from phone → reaches the right machine → reply
  streams back.

---

## Phase 5 — Web Push & quality-of-life

**Goal.** Phone-first experience.

**Scope.**

- Browser push via VAPID (Web Push API). iOS supports Web Push on
  home-screen-installed PWAs starting Safari 16.4.
- Notification grouping per session.
- Quick-action shortcuts (cancel, view last message).
- Re-engagement: opening the app mid-turn resumes streaming.
- Optional Tauri shell for a "real" mobile app feel (not browser
  PWA). This was mobvibe's pattern; if we hit PWA limitations we
  revisit.

**Definition of done.** Phone notification arrives within 5 s of
`done` event when no UI is attached. Tapping the notification opens
the session at the new turn.

---

## Phase 6 — Hardening

**Goal.** Production-deployable.

**Scope.**

- Test suite: unit (Vitest) on protocol parser + translator;
  integration on subprocess + WS; e2e (Playwright) on full local
  serve.
- Coverage ≥80%.
- CI: GitHub Actions matrix (macOS, Linux; Bun 1.x).
- Release: cross-compile Bun binaries for `darwin-arm64`,
  `darwin-x64`, `linux-x64`, `linux-arm64`.
- Homebrew tap.
- npm-published `@open-rc/cli` for users who prefer npm install.
- Changelog.
- SECURITY.md with reporting process.
- Performance budget: <50 ms p99 from subprocess event to UI render
  on localhost.

**Definition of done.** All CI green. First tagged release on GitHub.
README's Quick Start works on a fresh machine in <5 minutes.

---

## Things we explicitly will not do

These would each be their own multi-month project. They are noted
here so future contributors don't accidentally scope-creep into them.

- **Reimplementing the Claude Code agent loop.** We spawn the CLI.
- **Reimplementing the Anthropic Messages API.**
- **A full claude.ai clone.** Minimal chat UI is the goal.
- **A hosted SaaS.** Anyone self-hosts.
- **Mobile apps in the App Store.** PWA or Tauri, not native.
- **Provider adapters.** The CLI subprocess handles provider
  differences via `ANTHROPIC_BASE_URL`; we don't replicate that logic.
- **Anthropic OAuth / Trusted Device issuer.** Out of scope by design.

---

## Risks & mitigations

| Risk | Phase | Mitigation |
| ---- | ----- | ---------- |
| stream-json schema changes between CLI releases | 1, 2 | Pin a known-good CLI version in docs; add fuzz test that parses any stdout line; ship a `--raw-stream` debug mode |
| `--bare` does not emit `can_use_tool` | 2 | Fallback to Option A (settings-injected hook); document the trade-off |
| Subprocess hangs (e.g., API timeout) | 1 | Watchdog: kill subprocess after configurable idle timeout (default 10 min) |
| Bun bundler excludes something we need at runtime | 1 | Verify with `bun build --compile` early; smoke-test before declaring v0.1 |
| Pocket-claude's wire schema doesn't match our needs | 1 | It's just types — easy to extend. Note divergence in CHANGELOG. |
| 3P provider (Deepseek/GLM/MiniMax) doesn't support tool use | 1 | Subprocess will surface errors via stream-json. UI shows them. v0.2 adds provider-aware fallbacks. |
| Bun 1.x API churn | 1 | Pin minimum Bun version; document it. |
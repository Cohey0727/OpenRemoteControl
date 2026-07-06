# Security policy

## Threat model

`open-rc` is a self-hosted control plane that brokers WebSocket traffic
between the user's own `claude` session (fed to the relay by a bridge —
open-rc never runs `claude` as a subprocess) and a remote UI (browser
or mobile). The threat model assumes:

- The device running `orc serve` is fully under the operator's
  control (laptop, server).
- The UI is reached over a network the operator controls OR via the
  optional `orc hub` relay.
- The user's `claude` session itself is trusted — its tool calls are
  what the operator wants to mediate, not block.

`open-rc` is **not** a sandbox. It does not run untrusted code; it
forwards user prompts and tool-call requests to Claude Code.

## What `open-rc` handles for you

- **Permission forwarding**: the server relays `permission_request`
  frames from a bridge to every attached browser and routes the
  browser's `permission_response` back. Whether tool calls actually
  pause for approval depends entirely on the user's `claude` and
  their bridge (e.g. whether the bridge wires a `PreToolUse` hook);
  the server itself neither starts `claude` nor enforces a policy —
  it only forwards the frames. There is no server-side PreToolUse
  hook and no `bypassPermissions` default (that subsystem was
  removed when the server became a pure relay).
- **Audit log**: every permission decision and session lifecycle
  event is appended to `~/.local/share/open-rc/audit.jsonl`.
  No rotation is performed automatically; check the file periodically
  if you care about disk usage.
- **VAPID keys**: persisted once per serve instance at
  `~/.local/share/open-rc/vapid.json`. If you delete this file, all
  existing browser push subscriptions become invalid; users will need
  to re-subscribe.
- **Hub device identity**: each `orc serve` instance generates a
  per-host Ed25519 keypair the first time it connects to a hub. The
  private key is stored locally at `~/.local/share/open-rc/device.key`;
  never commit it.

## What `open-rc` does **not** handle for you

- **Transport encryption**: serve binds to `127.0.0.1` by default and
  is **plain HTTP + WS**. If you expose it to a network, put it
  behind a TLS-terminating reverse proxy (caddy, nginx, fly proxy).
  Same applies to hub mode — the `/device` and `/browser` WebSocket
  endpoints are plain `ws://` by default; use `--ssl` or a proxy in
  front for `wss://`.
- **Authentication**: serve mode trusts whoever can reach
  `127.0.0.1:<port>`. Hub mode authenticates devices via Ed25519
  signatures (proof-of-possession of the enrolled key), but does **not**
  authenticate browsers. Anyone who can reach the hub's `/browser`
  endpoint can read sessions and inject prompts. Put it behind an
  authenticated reverse proxy.
- **Take-over trust**: not a concern. There is no
  `/api/external-sessions/:pid/claim` endpoint, no
  `claim_external_session` WS frame, and no take-over flow of any
  kind. `orc serve` starts no processes, so it has none to kill
  or replace.
- **Authorization**: the audit log records decisions but does not
  enforce policy. Read it.
- **VAPID private key rotation**: there's no built-in rotation;
  delete `vapid.json` and restart serve to force re-subscription.
- **Device key revocation**: a hub can disable a device by deleting
  it from the SQLite store (`hub.db`), but no UI ships for this in
  v0.1.
- **Starts no processes.** open-rc launches nothing and manages no
  subprocess: no process-creation calls (`fork`, `exec`, or the
  Bun/Node equivalents), no walking `ps`, `lsof`, or `/proc`, no
  signalling (SIGTERM, SIGKILL, SIGINT, SIGHUP), no PTY, no tmux. The
  entire CLI is `serve`, `hub`, `tui`, `attach-orc`, `channel`, and
  `hook`, each
  of which runs only its own process (`orc channel` is itself spawned
  BY claude's own MCP machinery — open-rc never runs it). The user runs `claude`
  themselves; a `claude` in another terminal is untouched unless its
  own session invokes `/orc`. There is no
  `/api/external-sessions` endpoint, no `claim_external_session` WS
  frame, and no `/internal/hook` PreToolUse endpoint.

## Shared-session (`/orc`) surface

Sharing a session widens what a viewer can see and do — by design.
Know what you are enabling:

- **Transcript exposure.** `orc attach` reads the session's
  transcript JSONL (`~/.claude/projects/…`) read-only and replays it
  to `serve`; every attached browser/`tui` sees the conversation,
  tool commands, and (truncated) tool output. With serve on
  `127.0.0.1` that is only you; if you expose serve, everyone who can
  reach it can read every shared session. Same trust rules as the
  rest of serve: loopback by default, TLS + auth in front otherwise.
- **Prompt injection into your session.** Anyone who can send `send`
  frames to serve can queue prompts that the Stop/UserPromptSubmit
  hooks WILL deliver into your running session, marked with
  `[open-rc]`. That is the feature. It also means exposing serve
  without auth hands strangers a typewriter into your Claude session.
- **Hooks are inert by default.** `orc hook stop|prompt|end`
  (installed by `make setup` into `~/.claude/settings.json`) exit
  immediately unless `~/.open-rc/attach/<sessionId>/bridge.json` has a
  heartbeat fresher than 45 s — i.e. unless that specific session ran
  `/orc` and the bridge is alive. Delivery stops within 45 s of
  the bridge dying.
- **Coordination state, not conversation state.** The attach dir
  holds queued prompts transiently (drained each hook), plus markers
  and a heartbeat; the bridge removes the dir on exit. Conversation
  content persists only where it always did — the transcript Claude
  Code itself writes.
- **`make teardown`** removes the hooks and the `/orc` command
  again.

## Channel-based sharing (`orc channel`) surface

`orc channel` (Issue #11 O4, research preview) is the alternative
delivery path: browser prompts reach the session as MCP channel
notifications the moment they are sent, and tool-permission dialogs
relay to the browser. The exposure it adds:

- **claude spawns it, not open-rc.** The `mcpServers.orc` entry
  (`make setup` writes it to `~/.claude.json`) is only loaded when the
  user starts a session with `claude
  --dangerously-load-development-channels server:orc`. The flag is a
  claude-side, explicit opt-in; being in the config is not enough. The
  no-spawn invariant is intact — claude's own MCP machinery is the
  spawner.
- **Instant prompt injection.** As with `/orc`, anyone who can send
  `send` frames to serve can push prompts into the running session —
  here with no hook window at all, so exposing serve without auth is
  the same "typewriter into your Claude session" risk. `/agent` stays
  ungated by design; a bridge can only ever register and drive its own
  session, never read another's.
- **Remote permission verdicts.** With permission relay on, a viewer
  can approve or deny tool calls (`Bash`, `Write`, …) from the
  browser. Those verdicts come only from viewers already authenticated
  on `/ws` (the `ORC_USER`/`ORC_PASSWORD` gate when set); the local
  terminal dialog stays open in parallel and the first answer wins.
  Only expose serve to people you trust to approve tool use in your
  session.
- **Silent-drop honesty.** If channels aren't enabled for the session
  (flag missing, org policy off), channel events are dropped with no
  error from claude; the bridge surfaces that as an `error` frame
  after ~20 s of visible silence so a viewer is never left guessing.
- **Research preview.** The `--channels` syntax and channel protocol
  contract may change; custom channels require the development flag
  until they are on Anthropic's allowlist. `make teardown` removes the
  `mcpServers.orc` entry.

## Reporting a vulnerability

Please email `security@open-rc.local` with a description and a
proof-of-concept. We aim to acknowledge within 3 business days and
to publish a fix or mitigation within 30 days for high-severity
issues.

## Hardening checklist for self-hosters

- [ ] Bind serve to `127.0.0.1` (default); use SSH tunnel or Tailscale
      for remote access instead of opening the port publicly.
- [ ] Docker: keep the compose default `127.0.0.1:7322:7322`. Inside
      the container serve binds `0.0.0.0` (it has to), so the host
      port mapping IS the exposure decision — `-p 7322:7322` publishes
      the relay to every interface. Set ORC_USER/ORC_PASSWORD (the
      built-in login gate) and front it with TLS +
      auth before widening. The `/data` volume holds the VAPID private
      key; treat it like the `~/.local/share/open-rc` dir.
- [ ] Run hub behind a TLS-terminating reverse proxy that requires
      authentication on `/browser`.
- [ ] Run hub with `--autoApprove=false` and approve devices via
      the `/api/pair` endpoint only after verifying the printed
      fingerprint matches the device you intended to enroll.
- [ ] Tail the audit log into your log aggregator
      (`tail -F ~/.local/share/open-rc/audit.jsonl | vector ...`).
- [ ] Keep `open-rc`, `claude`, and Bun up to date.
- [ ] If you don't use push notifications, leave `pushDisabled` /
      don't load `/sw.js` — there's no point shipping an attack surface
      you don't use.
- [ ] `GET /manifest.webmanifest`, `GET /icon.svg`, and the icon
      PNGs are unauthenticated public assets by design (the manifest
      has to be readable for the browser to offer install). Treat
      them as if they were served by any static-file host: nothing
      sensitive in `ui/`.
- [ ] Two `orc serve` instances can coexist as long as they bind
      to different ports. The server has no per-cwd state.
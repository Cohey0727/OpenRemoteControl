# Security policy

## Threat model

`open-rc` is a self-hosted control plane that brokers WebSocket traffic
between a Claude Code subprocess (running locally on a device) and a
remote UI (browser or mobile). The threat model assumes:

- The device running `open-rc serve` is fully under the operator's
  control (laptop, server).
- The UI is reached over a network the operator controls OR via the
  optional `open-rc hub` relay.
- The Claude Code subprocess itself is trusted — its tool calls are
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
- **Audit log**: every permission decision and a session lifecycle
  events are appended to `~/.local/share/open-rc/audit.jsonl`.
  No rotation is performed automatically; check the file periodically
  if you care about disk usage.
- **VAPID keys**: persisted once per serve instance at
  `~/.local/share/open-rc/vapid.json`. If you delete this file, all
  existing browser push subscriptions become invalid; users will need
  to re-subscribe.
- **Hub device identity**: each `open-rc serve` instance generates a
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
  kind. `open-rc serve` starts no processes, so it has none to kill
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
  entire CLI is `serve`, `hub`, `tui`, `attach-orc`, and `hook`, each
  of which runs only its own process. The user runs `claude`
  themselves; a `claude` in another terminal is untouched unless its
  own session invokes `/attach-orc`. There is no
  `/api/external-sessions` endpoint, no `claim_external_session` WS
  frame, and no `/internal/hook` PreToolUse endpoint.

## Shared-session (`/attach-orc`) surface

Sharing a session widens what a viewer can see and do — by design.
Know what you are enabling:

- **Transcript exposure.** `open-rc attach-orc` reads the session's
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
- **Hooks are inert by default.** `open-rc hook stop|prompt|end`
  (installed by `make setup` into `~/.claude/settings.json`) exit
  immediately unless `~/.open-rc/attach/<sessionId>/bridge.json` has a
  heartbeat fresher than 45 s — i.e. unless that specific session ran
  `/attach-orc` and the bridge is alive. Delivery stops within 45 s of
  the bridge dying.
- **Coordination state, not conversation state.** The attach dir
  holds queued prompts transiently (drained each hook), plus markers
  and a heartbeat; the bridge removes the dir on exit. Conversation
  content persists only where it always did — the transcript Claude
  Code itself writes.
- **`make teardown`** removes the hooks and the `/attach-orc` command
  again.

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
      an unauthenticated relay to every interface. Front it with TLS +
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
- [ ] Two `open-rc serve` instances can coexist as long as they bind
      to different ports. The server has no per-cwd state.
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
  the server itself neither spawns `claude` nor enforces a policy —
  it only forwards the frames. There is no server-side PreToolUse
  hook and no `bypassPermissions` default (that subsystem was
  removed with the no-spawn pivot).
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
  kind. `open-rc serve` cannot kill or replace any process it
  didn't spawn, and it didn't spawn anything.
- **Authorization**: the audit log records decisions but does not
  enforce policy. Read it.
- **VAPID private key rotation**: there's no built-in rotation;
  delete `vapid.json` and restart serve to force re-subscription.
- **Device key revocation**: a hub can disable a device by deleting
  it from the SQLite store (`hub.db`), but no UI ships for this in
  v0.1.
- **No spawn. No subprocess management. No process discovery.**
  NOTHING in open-rc calls `Bun.spawn`, `fork`, `exec`, or any
  equivalent. Nothing walks `ps`, `lsof`, `/proc`, or any process
  table. Nothing signals any process (SIGTERM, SIGKILL, SIGINT,
  SIGHUP). No PTY, no tmux. The entire CLI is `serve`, `hub`, and
  `tui`, and all three spawn nothing —
  `grep -rE 'Bun\.spawn|child_process|posix_spawn|fork|exec' src/` is
  empty. (Spawning helpers `attach-orc` and `attach-tmux` existed
  briefly and were removed on 2026-07-02; a spawner may return only as
  a deliberate future feature. No `Bun.spawn` remains today.)
  `open-rc hub` follows the same no-spawn rule as `serve`.
  The user runs `claude` themselves; whatever they do with it is
  their business. A `claude` running in another terminal is
  unaffected by anything `open-rc serve` does — open-rc doesn't
  know it's there. There is no `/api/external-sessions` endpoint,
  no `claim_external_session` WS frame, no `/internal/hook` endpoint
  for a PreToolUse hook (that was tied to a server-spawned
  subprocess). The server's process table is exactly what Bun
  started when the user ran `open-rc serve`. Nothing else.

## Reporting a vulnerability

Please email `security@open-rc.local` with a description and a
proof-of-concept. We aim to acknowledge within 3 business days and
to publish a fix or mitigation within 30 days for high-severity
issues.

## Hardening checklist for self-hosters

- [ ] Bind serve to `127.0.0.1` (default); use SSH tunnel or Tailscale
      for remote access instead of opening the port publicly.
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
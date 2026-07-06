# Open Remote Control — Tech Stack

> Concrete picks for `open-rc`. Each section names the choice, the reason,
> and the realistic alternatives we considered.

---

## Runtime: Bun

**Pick:** Bun ≥ 1.1.

**Why:**
- Claude Code itself is Bun-compiled (`"claude gateway requires the native
  binary"`). We are staying in the same ecosystem, so any protocol quirks
  we encounter are at least running on the same VM.
- Single-binary distribution. `bun build --compile` produces a static
  executable we can ship as a tarball or Homebrew formula. No Node + npm
  + lockfile dance for end users.
- Built-in `Bun.serve` covers HTTP + WebSocket on one port with one API.
  No need to wire Express + `ws` separately.
- Built-in `bun:sqlite` for the hub's session registry, no external DB
  dependency.
- Built-in TypeScript and JSX. No `tsc`, no `ts-node`, no Vite for the SPA
  in dev.
- Built-in test runner (`bun test`). Compatible with `vitest` API.
- Built-in `Bun.password` / WebCrypto for the Trusted Device flow.

**Alternatives considered:**
- **Node.js + npm** — most familiar, but requires a bundler for the SPA
  (Vite/esbuild), a separate WebSocket library (`ws`), and either a native
  module or external dep for SQLite. More moving parts to ship.
- **Deno** — comparable to Bun; chose Bun because it matches the Claude
  Code runtime and has slightly better SQLite ergonomics.
- **Go / Rust single-binary** — would work, but loses the ability to share
  TypeScript types between server, protocol code, and UI. We'd duplicate
  the bridge-protocol TypeScript definitions.

**One concrete constraint:** Bun-only Node APIs are off-limits in code we
might want to share with a Node user later. Use cross-runtime APIs
(`fetch`, `WebSocket`, `crypto.subtle`, `URL`).

---

## Language: TypeScript (strict)

**Pick:** TypeScript, `strict: true`, `noUncheckedIndexedAccess: true`.

**Why:** the bridge protocol is message-shaped; TypeScript catches schema
drift at compile time. The UI is small enough that the type overhead pays
for itself immediately.

**Settings to commit to:**
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "verbatimModuleSyntax": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  }
}
```

---

## HTTP + WebSocket: Bun.serve

**Pick:** `Bun.serve` with one `fetch` handler that routes HTTP and
upgrades two WebSocket paths — `/ws` for browsers and `/agent` for
bridges.

**Why:**
- One port, one process, one API. `Bun.serve({ port, fetch, websocket })`.
- Native WebSocket upgrade. No library.
- Native HTTP/1.1 + HTTP/2 (when TLS is configured).
- Built-in backpressure handling.

**Shape we use** (see `src/serve.ts`):
```ts
Bun.serve<WsData>({
  hostname: "127.0.0.1",
  port: 7322,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws")    return srv.upgrade(req, { data: { kind: "browser", … } });
    if (url.pathname === "/agent") return srv.upgrade(req, { data: { kind: "bridge",  … } });
    // "/", "/health", "/api/push/*", "/sw.js", static UI assets…
  },
  websocket: {
    open(ws)          { /* dispatch by ws.data.kind */ },
    message(ws, raw)  { /* dispatch by ws.data.kind */ },
    close(ws)         { /* dispatch by ws.data.kind */ },
  },
});
```

**Alternatives considered:** Hono + `ws` (more portable across runtimes
but more moving parts); raw `node:http` (too low-level for the SPA + API
surface we need).

---

## Persistence: bun:sqlite (hub mode only)

**Pick:** `bun:sqlite` for the hub's session registry, device keys, audit
log. Local `serve` mode has no DISK-persistent state on the server side —
it holds only an in-memory map of currently-connected clients plus a
bounded in-memory replay buffer per client (for history-on-attach), and
loses both on restart. The user owns any durable persistence of their
`claude` sessions; open-rc does not touch `sessions.json`, any
per-session file, or `claude`'s transcripts.

**Why:**
- Zero external dependency. One file: `~/.local/share/open-rc/hub.db`.
- Synchronous API is fine for our access patterns (insert session row,
  lookup device by pubkey).
- Easy backup: `cp hub.db hub.db.bak`.

**Schema (initial):**
```sql
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  pubkey       BLOB NOT NULL,
  user_email   TEXT NOT NULL,
  enrolled_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id),
  name         TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE TABLE audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  device_id    TEXT,
  session_id   TEXT,
  event        TEXT NOT NULL,
  payload      TEXT
);
```

**Alternatives considered:** Postgres (overkill for v1), libSQL/Turso
(extra network dependency), LevelDB (no schema, less ergonomic).

---

## UI: vanilla TypeScript + tiny signals (no build step)

**Pick:** vanilla TypeScript for the SPA, with a ~30-line home-grown
signal implementation in `ui/app.ts`. The server transpiles `ui/app.ts`
on the fly with `Bun.Transpiler` and serves it as JavaScript. **There
is no UI build step.** The one runtime dependency (`marked`) is
vendored under `ui/vendor/` and resolved via `<script type="importmap">`.
Assistant markdown is sanitized (script/handler/`javascript:` stripped
via the browser's own parser) before it reaches the DOM.

PWA assets follow the same rule: `ui/manifest.webmanifest` and the
icon PNGs are checked in as static files and served straight off disk.
`scripts/build-icons.ts` is a maintainer-only helper that
re-rasterises `ui/icon.svg` into the icon sizes when the source SVG
changes; it runs at developer time, never on the server boot path,
and the runtime `serve` simply ships the pre-generated PNGs that
already exist in the repo. `scripts/build.ts` (the distribution
cross-compile) does not touch UI assets.

**Why no build step:**
- One source of truth for the SPA. Edit `ui/app.ts`, save, reload.
- The server is the same process that hosts the SPA, so a single
  `bun run serve` boots both the relay and the UI.
- Removes a class of bugs (stale builds, mismatched hashes, missing
  chunks) entirely.
- Trade-off: first request for `app.ts` runs the transpiler (~50 ms
  cold). For a tool the user keeps open in a tab, this is invisible.

**Why vanilla + tiny signals (not a framework):**
- The SPA is small: one sidebar list, one chat transcript, one modal.
  A framework's component model, lifecycle hooks, and reconciler are
  paid for in bundle weight and cognitive overhead without buying
  anything we use.
- Fine-grained reactivity without a virtual DOM. The bridge-event
  stream is dense; we need per-row updates without re-rendering the
  whole sidebar.
- Vendor surface stays under our control: `marked` is vendored
  locally as plain JS, no CDN at runtime.

**Styling:** vanilla CSS with CSS variables for theming. No Tailwind
unless we hit a real reason to add it.

**Alternatives considered:**
- **Solid.js** — fine framework, but added an opaque runtime that
  consistently failed to render in our headless browser environment.
  Vanilla DOM with a 30-line `signal()` does the same job for our
  UI shape and removes the dependency.
- **Vite** — adds a build step (and a separate dev process). We
  don't need HMR because `bun --watch` restarts the whole server
  when source files change.
- **Preact / Svelte / React** — comparable reasoning as before; none
  earn their weight on a SPA this small once vanilla TS proved viable.

---

## Crypto: WebCrypto API

**Pick:** Ed25519 via `crypto.subtle` for Trusted Device keypairs and
challenge signatures.

**Why:**
- Built in. No npm dep.
- Ed25519 is fast, small signatures, and supported by every modern
  browser's WebCrypto implementation — meaning the **browser side** of
  enrollment can use the same primitives without a polyfill.

**Keypair flow:**
```ts
const kp = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,                       // extractable
  ["sign", "verify"],
);
```

The private key is stored under `~/.config/open-rc/device.key` with mode
0600, encoded as PKCS8.

**Alternatives considered:** `@noble/ed25519` (pure JS, works in Node
< 20). WebCrypto is fine on Node 20+ and Bun.

---

## Auth (hub mode): Ed25519 device pairing

**Pick (shipped):** Ed25519 device enrollment — each `serve` instance
generates a keypair, the hub records the public key after the user
approves the printed fingerprint at `/api/pair`. Browsers are NOT
authenticated by the hub itself; production deployments front it with
an authenticated TLS proxy (see `SECURITY.md`).

**Why:**
- No password or email infrastructure at all; nothing to store or leak.
- Proof-of-possession on every device connection.
- Matches the "self-hosted, bring your own perimeter" posture.

**Alternatives considered:** email magic link (an earlier draft pick —
needs SMTP plus token storage, never implemented; browsers still ended
up needing a fronting proxy anyway), OAuth (requires registering a
client somewhere — friction for self-hosters), WebAuthn
(over-engineered for v1), password + bcrypt (we'd rather not store
passwords at all).

---

## Logging: console

**Pick (shipped):** plain `console`. The relay's log volume is a
handful of lifecycle lines; structured logging would be ceremony
without a consumer. In Docker, `docker logs` / dozzle-style viewers
see the same stream.

**Alternatives considered:** `pino` (fast structured JSON — worth
revisiting only if the relay ever emits enough volume to need
filtering; not a dependency today), `winston` (slower, features we
don't need), `bunyan` (less actively maintained).

---

## Testing: bun test

**Pick:** `bun test` for unit + integration. Playwright for end-to-end
(once we have a UI worth driving).

**Why:**
- Zero install. Ships with Bun.
- Jest/Vitest-compatible API. Anyone used to one is at home in the other.
- `bun test --watch` is fast.

**Coverage target:** 80% on the bridge protocol + hub routing. UI gets
smoke tests only; full E2E coverage comes later.

---

## Linting / formatting: Biome

**Pick:** Biome for lint + format.

**Why:**
- Single tool, written in Rust, very fast.
- No ESLint + Prettier config sprawl.
- Drop-in for most rules we care about.

**Alternatives considered:** ESLint + Prettier (mature, slow, two
configs to maintain), `dprint` (good, less ecosystem).

---

## Dependency policy

- **Minimal runtime dependencies.** Bun covers HTTP, WS, subprocess,
  fs, sqlite, and crypto natively. We do add focused deps when Bun
  doesn't cover the surface area: `web-push` for VAPID push (Phase 5),
  `zod` for wire-protocol validation (Phase 1+), and
  `@modelcontextprotocol/sdk` (^1.29.0) for the `orc channel` MCP
  channel server (Phase 8.5 — Anthropic's own reference SDK; the
  stdio JSON-RPC transport and capability negotiation are not worth
  hand-rolling). Adding a dep is a
  deliberate, reviewable choice.
- After v0.1, deps are allowed but reviewed for: bundle size (SPA),
  startup time (server), maintenance status, license (MIT / Apache-2.0 /
  BSD only).

## Process management

**Nothing in open-rc starts, attaches to, signals, or introspects
another process.** No `child_process`, no PTY, no tmux anywhere in the
project. `serve`, `hub`, `tui`, `attach`, `channel`, and `hook` are the
whole CLI, and each process's tree contains only itself. `channel` is
the one process open-rc does not even launch — `claude`'s own MCP
machinery spawns it (from the `mcpServers.orc` entry) when a session
starts with `--dangerously-load-development-channels server:orc`.

If the user wants a `claude` running, they run it themselves. To share
that session with the browser they either type `/orc` inside it
(first-party: the bridge tails the session's own transcript JSONL and
the Claude Code hooks deliver browser prompts back — file I/O and
WebSockets only, see `docs/architecture.md` §3.5), start it under the
`orc` channel (instant browser→session delivery even while idle, plus
permission relay — Issue #11 O4, research preview), or write their own
bridge that pipes `claude`'s stream-json to `/agent`.

> **Spawning remains out of scope.** The original `attach-orc`
> (spawned `claude --print`) and `attach-tmux` (drove tmux) were
> **removed on 2026-07-02**; the same-day `/orc` requirement
> was implemented spawn-free. Re-adding process launching is a
> deliberate decision, never a convenience reach.

### Launcher bootstrap

`make setup` registers one launcher script — `open-rc` — in
`~/.local/bin` (override with `BIN_DIR=`). It is a two-line wrapper
(`exec bun run <checkout>/src/cli.ts … "$@"`), so the absolute-path
anchor lives in the launcher and a `git pull` updates behavior with no
rebuild. It then runs `scripts/install-hooks.ts`, which merges the
Stop / UserPromptSubmit / SessionEnd hook entries into
`~/.claude/settings.json` (idempotent; user hooks preserved) and
symlinks `commands/orc.md` into `~/.claude/commands/`; and
`scripts/install-channel.ts`, which registers the `mcpServers.orc`
channel entry in `~/.claude.json` (idempotent; only replaces an entry
recognizably ours). `make teardown` reverses all of it.

---

## Docker

**Pick:** one all-in-one image (`Dockerfile`, base `oven/bun:1.3-slim`)
that runs the CLI straight from source — the same no-build philosophy,
containerized. `serve` is the default command; `hub`/`tui` reuse the
image via command args. `XDG_DATA_HOME=/data` routes every piece of
mutable state (VAPID keys, push DB, audit log) into a single volume;
`docker-compose.yml` publishes `127.0.0.1:7322` (loopback, mirroring
serve's own default) and names the volume. Health checks probe
`/health` with Bun itself, so the image needs no curl. The container
is the relay half only — `claude`, the `attach-orc` bridge, and the
hooks all stay on the host and dial the published port.

---

## Build & distribution

**Pick (server runtime):** launch directly from TypeScript via Bun.
No build step required for the developer or the user who already has
Bun installed:

```bash
bun run src/cli.ts serve --host 127.0.0.1 --port 7322
```

**Pick (binary distribution):** `bun build --compile` produces a
single self-contained executable for users who do not have Bun
installed. The build step is **optional** — it exists only to ship
binaries, not to make the server runnable.

```bash
bun run build           # current host only
bun run build --all     # linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64
# → dist/open-rc-<os>-<arch>[.exe]
```

Ship via:
- `npm install -g open-rc` (users who have Node/Bun can `bunx open-rc`
  directly; the binary distribution is a convenience for the rest)
- `brew install open-rc`
- Direct `curl | tar` from GitHub releases

**Why compile:** users who don't have Bun should still be able to
download and run `open-rc` with no Node, npm, or package manager
involved. One binary, double-click, done.

---

## Versioning: SemVer

**Pick:** SemVer 2.0 for `open-rc` itself. Wire-protocol changes are
tracked by the zod schemas in `src/session/ws-protocol.ts`; any
breaking change to those schemas is a major version bump.

**Wire compatibility:** the server does not currently negotiate a
protocol version with the bridge — frames are typed by their `type`
discriminator (`register`, `text`, `thinking`, etc.). Adding a
version field is a backward-compatible change. We do not break the
wire without a major release.

---

## Summary table

| Concern        | Pick                       | Alt considered       |
| -------------- | -------------------------- | -------------------- |
| Runtime        | Bun                        | Node, Deno, Go       |
| Language       | TypeScript (strict)        | —                    |
| HTTP / WS      | Bun.serve                  | Hono + ws            |
| Persistence    | bun:sqlite                 | Postgres, libSQL     |
| UI framework   | vanilla TS + tiny signals | Solid, Preact, Svelte, React |
| UI build       | none (Bun.Transpiler + importmap) | Vite, esbuild   |
| Crypto         | WebCrypto (Ed25519)        | @noble/ed25519       |
| Auth           | Ed25519 device pairing     | OAuth, WebAuthn      |
| Logging        | console                    | pino, winston        |
| Wire schemas   | zod                        | ajv, json-schema, TypeBox |
| Push           | web-push                   | pushpad, OneSignal SDK |
| Channel MCP    | @modelcontextprotocol/sdk  | hand-rolled JSON-RPC |
| Tests          | bun test                   | vitest, Playwright   |
| Lint / format  | Biome                      | ESLint + Prettier    |
| Distribution   | bun build --compile (opt.) | npm pkg, Docker      |
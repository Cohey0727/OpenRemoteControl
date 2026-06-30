# Tech Stack

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

**Pick:** `Bun.serve` with explicit routes for HTTP and a WebSocket
handler on `/bridge`.

**Why:**
- One port, one process, one API. `Bun.serve({ port, routes, websocket })`.
- Native WebSocket upgrade. No library.
- Native HTTP/1.1 + HTTP/2 (when TLS is configured).
- Built-in backpressure handling.

**Shape we will use:**
```ts
Bun.serve({
  port: 8080,
  routes: {
    "/":          indexHandler,    // SPA
    "/api/...":   apiHandler,      // JSON API
    "/static/*":  staticHandler,   // SPA assets
  },
  websocket: {
    open:    bridgeOpen,
    message: bridgeMessage,
    close:   bridgeClose,
  },
});
```

**Alternatives considered:** Hono + `ws` (more portable across runtimes
but more moving parts); raw `node:http` (too low-level for the SPA + API
surface we need).

---

## Persistence: bun:sqlite (hub mode only)

**Pick:** `bun:sqlite` for the hub's session registry, device keys, audit
log. Local mode has no persistent state.

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

## UI: Solid.js + Vite (build) / Bun (dev)

**Pick:** Solid.js for the SPA, bundled with Vite for the production
build, served by Bun in dev for fast iteration.

**Why Solid.js:**
- Fine-grained reactivity. The session-event stream is dense; we need
  per-row updates without re-rendering the whole list.
- Smallest mainstream framework: ~7 KB gzipped for the runtime.
- JSX with TypeScript feels like React to anyone who knows React.
- No virtual DOM overhead; UI stays fast on long session histories.

**Why Vite for build:**
- Best-in-class dev server (HMR for the SPA).
- Bun's built-in bundler is fine but Vite's plugin ecosystem is broader
  (CSS modules, asset hashing, etc.) and we already need to ship the
  static bundle, so Vite is the lower-risk pick.

**Why Bun for dev:**
- `bun --watch ./src/server.ts` is faster than `tsx watch` and integrates
  directly with `bun:sqlite` + `Bun.serve`.

**Styling:** vanilla CSS with CSS variables for theming. No Tailwind
unless we hit a real reason to add it.

**Alternatives considered:**
- **Preact** — comparable size, but JSX ergonomics slightly worse than
  Solid.
- **Svelte** — excellent, but compile-step adds friction when iterating
  on the WS message shapes.
- **React** — fine, but 40+ KB of runtime is wasted on a SPA this small.
- **Vanilla TS + lit-html** — would work, but Solid gives us better
  organization for free.

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

## Auth (hub mode): email magic link

**Pick:** email magic link, no password storage. Pluggable.

**Why:**
- No password database to compromise.
- Familiar UX.
- SMTP is universally available; no extra SaaS dependency.

**Implementation:** store a one-time token (32 bytes random, base64url) in
the `sessions` table with a 15-minute TTL, send a link with the token to
the user's email, the link goes to `/auth/verify?token=…`, the server
marks the email as logged in and sets an HttpOnly cookie.

**Email transport:** pluggable. Default: SMTP via `nodemailer`. For
self-hosters, set `OPENRC_SMTP_URL=smtps://user:pass@host:465`.

**Alternatives considered:** OAuth (would require us to register as an
OAuth client somewhere — adds friction for self-hosters), WebAuthn
(over-engineered for v1), password + bcrypt (we'd rather not store
passwords at all).

---

## Logging: console + pino

**Pick:** `pino` in production, plain `console` in dev. Both go through a
small wrapper so we can swap later.

**Why pino:**
- Fast, structured JSON output.
- Pretty-printing via `pino-pretty` for local dev.
- Standard for Node/Bun services.

**Alternatives considered:** `winston` (slower, more features we don't
need), `bunyan` (similar but less actively maintained).

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

- **Zero runtime dependencies for v0.1.** Everything we need is built into
  Bun. Adding a dep is a deliberate, reviewable choice.
- After v0.1, deps are allowed but reviewed for: bundle size (SPA),
  startup time (server), maintenance status, license (MIT / Apache-2.0 /
  BSD only).

---

## Build & distribution

**Pick:** `bun build --compile` to produce a single static binary.

```bash
bun build --compile --target=bun-darwin-arm64 \
  --outfile dist/open-rc src/cli.ts
```

Ship via:
- `npm install -g open-rc` (the binary is downloaded by a postinstall
  script, no Node code at runtime)
- `brew install open-rc`
- Direct `curl | tar` from GitHub releases

**Why compile:** the user should not need Node, npm, or any package
manager to run `open-rc`. One binary, double-click, done.

---

## Versioning: SemVer

**Pick:** SemVer 2.0. Bridge protocol versions are an explicit field on
every message (`"v": 1`); backwards-incompatible bumps are major
versions of `open-rc`.

**Wire compatibility:** the bridge protocol version is what the CLI and
the hub negotiate. Hub accepts the highest version both support. We do
not break the wire without a major release.

---

## Summary table

| Concern        | Pick                       | Alt considered       |
| -------------- | -------------------------- | -------------------- |
| Runtime        | Bun                        | Node, Deno, Go       |
| Language       | TypeScript (strict)        | —                    |
| HTTP / WS      | Bun.serve                  | Hono + ws            |
| Persistence    | bun:sqlite                 | Postgres, libSQL     |
| UI framework   | Solid.js                   | Preact, Svelte, React |
| UI build       | Vite                       | esbuild, Bun bundler |
| Crypto         | WebCrypto (Ed25519)        | @noble/ed25519       |
| Auth           | Email magic link           | OAuth, WebAuthn      |
| Logging        | pino                       | winston, bunyan      |
| Tests          | bun test + Playwright      | vitest               |
| Lint / format  | Biome                      | ESLint + Prettier    |
| Distribution   | bun build --compile        | npm pkg, Docker      |
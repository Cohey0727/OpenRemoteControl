/**
 * Local serve mode — Bun.serve hosting the SPA and the WebSocket relay.
 *
 * The server is byte-pass-through for everything that crosses a
 * WebSocket boundary. Its only state is an in-memory map of
 * currently-connected bridges. Restart the server, lose the map, bridges
 * reconnect on a short backoff.
 *
 * Routes:
 *   GET  /                       → SPA (index.html)
 *   GET  /sw.js                  → service worker
 *   GET  /manifest.webmanifest   → PWA manifest
 *   GET  /icon.svg, /icon-*.png, /apple-touch-icon.png
 *   GET  /app.ts, /styles.css    → SPA assets (whitelisted)
 *   GET  /health                 → JSON health check
 *   GET  /api/push/vapid-public-key
 *   POST /api/push/subscribe
 *   POST /api/push/unsubscribe
 *   GET  /ws                     → browser WebSocket (upgrade)
 *   GET  /agent                  → bridge WebSocket (upgrade)
 *
 * No `/internal/hook`, no `/api/sessions`, no take-over, no spawn.
 */

import { join, relative, resolve, sep } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { writeAudit } from './permission/audit.ts';
import { notify } from './push/notifier.ts';
import { PushStore } from './push/store.ts';
import { configureWebPush, loadOrCreateVapidKeys } from './push/vapid.ts';
import type { BridgeConn, ClientInfo, ClientStatus } from './session/ws-protocol.ts';
import { type WsData, makeWsHandlers } from './ws.ts';

/** Max conversation frames buffered per client for replay-on-attach. */
const MAX_HISTORY = 800;

export interface ServeOptions {
  /** Bind host. Default `127.0.0.1` for local-only safety. */
  readonly host?: string;
  /** Bind port. Default 7322. */
  readonly port?: number;
  /** Path to the UI directory containing index.html. */
  readonly uiDir: string;
  /** Path to VAPID key JSON. Default `$XDG_DATA_HOME/open-rc/vapid.json`. */
  readonly vapidKeyPath?: string;
  /** Path to push subscription sqlite. Default `$XDG_DATA_HOME/open-rc/push.db`. */
  readonly pushStorePath?: string;
  /** VAPID subject (mailto:...). Default `mailto:noreply@open-rc.local`. */
  readonly vapidSubject?: string;
  /** Disable web-push entirely (skips key load, subscribe endpoints return 404). */
  readonly pushDisabled?: boolean;
}

export async function serve(opts: ServeOptions): Promise<{
  stop: () => Promise<void>;
}> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7322;

  /* ----------------------------- push subsystem ------------------------- */

  let pushStore: PushStore | null = null;
  let vapidPublicKey: string | null = null;
  let pushStatus: 'ok' | 'disabled' | 'init_failed' = 'disabled';
  if (!opts.pushDisabled) {
    const dataDir = process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`;
    const vapidPath = opts.vapidKeyPath ?? `${dataDir}/open-rc/vapid.json`;
    const pushPath = opts.pushStorePath ?? `${dataDir}/open-rc/push.db`;
    const subject = opts.vapidSubject ?? 'mailto:noreply@open-rc.local';
    try {
      const keys = await loadOrCreateVapidKeys(vapidPath);
      configureWebPush(keys, subject);
      pushStore = new PushStore({ path: pushPath });
      vapidPublicKey = keys.publicKey;
      pushStatus = 'ok';
    } catch (err) {
      console.error('[push] init failed, push disabled:', err);
      pushStatus = 'init_failed';
    }
  }

  /* ----------------------------- relay state ---------------------------- */

  const clients = new Map<string, BridgeConn>();
  /** Browsers subscribed to a given clientId. */
  const attachedBrowsers = new Map<string, Set<ServerWebSocket<WsData>>>();
  /** All browsers currently connected on `/ws`. Used to fan out
   *  server-originated frames (client_registered, client_removed,
   *  clients_changed) to the whole fleet, even before a browser attaches
   *  to a specific client. */
  const connectedBrowsers = new Set<ServerWebSocket<WsData>>();

  function infoOf(conn: BridgeConn): ClientInfo {
    return {
      clientId: conn.clientId,
      label: conn.label,
      cwd: conn.cwd,
      status: conn.status,
      lastActivity: conn.lastActivity,
      connectedAt: conn.connectedAt,
    };
  }

  function listClients(): ClientInfo[] {
    return [...clients.values()].map(infoOf);
  }

  /* ----------------------------- WS handlers ---------------------------- */

  const handlers = makeWsHandlers({
    listClients,
    registerBrowser(browser) {
      connectedBrowsers.add(browser);
    },
    unregisterBrowser(browser) {
      connectedBrowsers.delete(browser);
    },
    registerBridge({ requestedClientId, label, cwd, ws }) {
      // Treat an empty/whitespace clientId as "not provided" so a
      // misconfigured bridge can't register under key "" (which no
      // browser can attach to and which collides across bridges).
      const wanted = requestedClientId?.trim() ? requestedClientId : undefined;
      if (wanted && clients.has(wanted)) {
        throw new Error(`clientId already in use: ${wanted}`);
      }
      const clientId = wanted ?? crypto.randomUUID();
      const now = Date.now();
      const conn: BridgeConn = {
        clientId,
        label,
        cwd,
        status: 'idle',
        lastActivity: now,
        connectedAt: now,
        ws,
        history: [],
        info() {
          return {
            clientId: this.clientId,
            label: this.label,
            cwd: this.cwd,
            status: this.status,
            lastActivity: this.lastActivity,
            connectedAt: this.connectedAt,
          };
        },
      };
      clients.set(clientId, conn);
      attachedBrowsers.set(clientId, new Set());
      return conn;
    },
    removeBridge(clientId) {
      const conn = clients.get(clientId);
      if (!conn) return;
      clients.delete(clientId);
      // Detach every browser attached to this client.
      const set = attachedBrowsers.get(clientId);
      if (set) {
        for (const ws of set) {
          try {
            if (ws.data.clientId === clientId && ws.data.detach) {
              ws.data.detach();
              ws.data.detach = null;
              ws.data.clientId = null;
            }
          } catch {
            // ignore
          }
        }
        attachedBrowsers.delete(clientId);
      }
      // Audit the disconnect.
      void writeAudit({
        timestamp: Date.now(),
        sessionId: clientId,
        requestId: '',
        tool: '(disconnect)',
        decision: 'allow',
        reason: 'bridge disconnected',
      });
      return;
    },
    setBridgeStatus(clientId, status: ClientStatus) {
      const conn = clients.get(clientId);
      if (!conn) return;
      conn.status = status;
      conn.lastActivity = Date.now();
    },
    touchBridge(clientId) {
      const conn = clients.get(clientId);
      if (!conn) return false;
      conn.lastActivity = Date.now();
      // Report whether the status transitioned so the caller can decide
      // to broadcast clients_changed (we don't broadcast on every frame).
      if (conn.status === 'idle') {
        conn.status = 'busy';
        return true;
      }
      return false;
    },
    sendToBridge(clientId, frame) {
      const conn = clients.get(clientId);
      if (!conn) return false;
      try {
        (conn.ws as ServerWebSocket<WsData>).send(JSON.stringify(frame));
        return true;
      } catch {
        return false;
      }
    },
    attachBrowser(clientId, browser) {
      const conn = clients.get(clientId);
      if (!conn) return null;
      let set = attachedBrowsers.get(clientId);
      if (!set) {
        set = new Set();
        attachedBrowsers.set(clientId, set);
      }
      set.add(browser);

      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        const s = attachedBrowsers.get(clientId);
        if (s) {
          s.delete(browser);
          if (s.size === 0) attachedBrowsers.delete(clientId);
        }
      };
    },
    broadcastToBrowsers(clientId, frame) {
      const set = attachedBrowsers.get(clientId);
      if (!set) return;
      const json = JSON.stringify(frame);
      for (const ws of set) {
        try {
          ws.send(json);
        } catch {
          // ignore
        }
      }
    },
    recordHistory(clientId, frame) {
      const conn = clients.get(clientId);
      if (!conn) return;
      conn.history.push(frame);
      // Bound the buffer: drop the oldest frames past the cap so a
      // long-running session can't grow memory without limit.
      if (conn.history.length > MAX_HISTORY) {
        conn.history.splice(0, conn.history.length - MAX_HISTORY);
      }
    },
    replayHistory(clientId, browser) {
      const conn = clients.get(clientId);
      if (!conn) return;
      for (const frame of conn.history) {
        try {
          browser.send(JSON.stringify(frame));
        } catch {
          // ignore
        }
      }
    },
    broadcastServerMessage(frame) {
      const json = JSON.stringify(frame);
      for (const ws of connectedBrowsers) {
        try {
          ws.send(json);
        } catch {
          // ignore
        }
      }
    },
    onClientDone: (clientId: string, summary: string) => {
      if (!pushStore) return;
      void notify(pushStore, {
        title: 'open-rc',
        body: summary,
        url: '/',
        sessionId: clientId,
      }).catch((err: unknown) => {
        console.error('[push] notify failed:', err);
      });
    },
  });

  /* ----------------------------- Bun.serve ------------------------------ */

  const indexPath = resolve(join(opts.uiDir, 'index.html'));

  const server = Bun.serve<WsData>({
    hostname: host,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        const ok = srv.upgrade(req, {
          data: {
            kind: 'browser',
            clientId: null,
            detach: null,
            registeredClientId: null,
            preRegisterBuffer: null,
          } satisfies WsData,
        });
        if (ok) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }

      if (url.pathname === '/agent') {
        const ok = srv.upgrade(req, {
          data: {
            kind: 'bridge',
            clientId: null,
            detach: null,
            registeredClientId: null,
            preRegisterBuffer: [],
          } satisfies WsData,
        });
        if (ok) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }

      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          clients: clients.size,
          push: pushStatus,
        });
      }

      // Push
      if (url.pathname === '/api/push/vapid-public-key') {
        if (!pushStore || !vapidPublicKey) {
          return Response.json({ error: 'push_unavailable', status: pushStatus }, { status: 404 });
        }
        return Response.json({ publicKey: vapidPublicKey });
      }
      if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
        if (!pushStore)
          return Response.json({ error: 'push_unavailable', status: pushStatus }, { status: 404 });
        let body: {
          endpoint?: string;
          keys?: { p256dh?: string; auth?: string };
          clientId?: string;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return new Response('invalid JSON', { status: 400 });
        }
        if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
          return new Response('missing endpoint or keys', { status: 400 });
        }
        const rec = pushStore.addSubscription({
          endpoint: body.endpoint,
          keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
          ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
        });
        return Response.json({ id: rec.id });
      }
      if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
        if (!pushStore)
          return Response.json({ error: 'push_unavailable', status: pushStatus }, { status: 404 });
        let body: { endpoint?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return new Response('invalid JSON', { status: 400 });
        }
        if (!body.endpoint) return new Response('missing endpoint', { status: 400 });
        const removed = pushStore.removeSubscriptionByEndpoint(body.endpoint);
        return Response.json({ removed });
      }

      // SPA — served at the root and at every client-routed session path
      // (`/sessions/<id>`), so a hard reload or a shared deep link returns
      // the app shell rather than a 404; the SPA reads the path and attaches.
      if (
        url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname === '/sessions' ||
        url.pathname.startsWith('/sessions/')
      ) {
        const file = Bun.file(indexPath);
        if (!(await file.exists())) {
          return new Response('UI not built; see ui/index.html', { status: 500 });
        }
        return new Response(file, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      // Service worker (served from root so it controls '/').
      if (url.pathname === '/sw.js') {
        const swPath = resolve(join(opts.uiDir, 'sw.js'));
        const uiRoot = resolve(opts.uiDir);
        const rel = relative(uiRoot, swPath);
        if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(uiRoot, rel) !== swPath) {
          return new Response('not found', { status: 404 });
        }
        const file = Bun.file(swPath);
        if (!(await file.exists())) {
          return new Response('service worker not built', { status: 404 });
        }
        return new Response(file, {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'service-worker-allowed': '/',
            'cache-control': 'no-cache',
          },
        });
      }

      // SPA assets.
      if (
        url.pathname.endsWith('.ts') ||
        url.pathname.endsWith('.js') ||
        url.pathname.endsWith('.css') ||
        url.pathname.endsWith('.json') ||
        url.pathname.endsWith('.webmanifest') ||
        url.pathname.endsWith('.svg') ||
        url.pathname.endsWith('.png')
      ) {
        const safe = url.pathname.replace(/^\/+/, '');
        const assetPath = resolve(join(opts.uiDir, safe));
        const uiRoot = resolve(opts.uiDir);
        const rel = relative(uiRoot, assetPath);
        if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(uiRoot, rel) !== assetPath) {
          return new Response('not found', { status: 404 });
        }
        const file = Bun.file(assetPath);
        if (!(await file.exists())) {
          return new Response('not found', { status: 404 });
        }
        if (url.pathname.endsWith('.ts')) {
          const transpiler = new Bun.Transpiler({
            loader: 'ts',
            target: 'browser',
            tsconfig: { compilerOptions: { jsx: 'preserve' } },
          });
          const src = await file.text();
          const out = transpiler.transformSync(src, 'ts');
          return new Response(out, {
            headers: { 'content-type': 'application/javascript; charset=utf-8' },
          });
        }
        // PWA manifest needs the spec'd content type and must not be
        // cached, otherwise the browser pins a stale install metadata
        // snapshot and a manifest edit ships only after the user
        // clears storage. The default Bun inference (text/plain) is
        // wrong, so we set it explicitly.
        if (url.pathname.endsWith('.webmanifest')) {
          return new Response(file, {
            headers: {
              'content-type': 'application/manifest+json',
              'cache-control': 'no-cache',
            },
          });
        }
        return new Response(file);
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === 'browser') handlers.browser.open(ws);
        else handlers.bridge.open(ws);
      },
      message(ws, raw) {
        if (ws.data.kind === 'browser') handlers.browser.message(ws, raw);
        else handlers.bridge.message(ws, raw);
      },
      close(ws) {
        if (ws.data.kind === 'browser') handlers.browser.close(ws);
        else handlers.bridge.close(ws);
      },
    },
  });

  const stop = async () => {
    if (pushStore) pushStore.close();
    await server.stop();
  };

  return { stop };
}

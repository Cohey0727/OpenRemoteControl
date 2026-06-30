/**
 * Local serve mode — Bun.serve hosting the SPA and the WebSocket endpoint.
 *
 * Layout:
 *   /                   → SPA (static index.html from ui/)
 *   /ws                 → WebSocket handler
 *   /health             → JSON health check
 *   /internal/hook/:sid → HTTP endpoint for PreToolUse hook (Phase 2)
 *
 * The SPA is intentionally minimal in v0.1: single HTML file, CDN imports
 * for Solid.js. No bundler magic. Future phases may move to Vite for HMR.
 */

import { join, relative, resolve, sep } from 'node:path';
import { PermissionManager } from './permission/manager.ts';
import { notify } from './push/notifier.ts';
import { PushStore } from './push/store.ts';
import { configureWebPush, loadOrCreateVapidKeys } from './push/vapid.ts';
import { SessionManager } from './session/manager.ts';
import { type WsData, makeWsHandlers } from './ws.ts';

export interface ServeOptions {
  /** Bind host. Default `127.0.0.1` for local-only safety. */
  readonly host?: string;
  /** Bind port. Default 7322. */
  readonly port?: number;
  /** Path to the UI directory containing index.html. */
  readonly uiDir: string;
  /** Working directory for spawned `claude` subprocesses. */
  readonly cwd?: string;
  /** Path or name of the `claude` binary. */
  readonly claudeBin?: string;
  /** Permission mode forwarded to subprocesses. Default `bypassPermissions`. */
  readonly permissionMode?:
    | 'bypassPermissions'
    | 'acceptEdits'
    | 'default'
    | 'dontAsk'
    | 'plan'
    | 'auto';
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
  hookUrl: string;
}> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7322;
  const permissionMode = opts.permissionMode ?? 'bypassPermissions';
  const manager = new SessionManager({
    ...(opts.claudeBin ? { binary: opts.claudeBin } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    permissionMode,
  });
  const permissions = new PermissionManager();

  // Push subsystem (Phase 5). Disabled if `pushDisabled` is true so tests
  // and CI can skip it.
  let pushStore: PushStore | null = null;
  let vapidPublicKey: string | null = null;
  let pushStatus: 'ok' | 'disabled' | 'init_failed' = 'disabled';
  if (opts.pushDisabled) {
    pushStatus = 'disabled';
  } else {
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

  const handlers = makeWsHandlers({
    manager,
    permissions,
    onSessionDone: (sessionId, summary) => {
      if (!pushStore) return;
      void notify(pushStore, {
        title: 'Claude Code',
        body: summary || 'Task complete',
        url: '/',
        sessionId,
      }).catch((err: unknown) => {
        console.error('[push] notify failed:', err);
      });
    },
  });

  const indexPath = resolve(join(opts.uiDir, 'index.html'));
  const hookUrl = `http://${host}:${port}/internal/hook`;

  const server = Bun.serve<WsData>({
    hostname: host,
    port,
    websocket: handlers,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        const ok = srv.upgrade(req, { data: { sessionId: null, detach: null } });
        if (ok) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }

      // Health
      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          sessions: manager.size,
          push: pushStatus,
        });
      }

      // Session list — Phase 3
      if (url.pathname === '/api/sessions') {
        return Response.json({
          sessions: manager.list(),
        });
      }

      // Push — Phase 5
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
          sessionId?: string;
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
          ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
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

      // PreToolUse hook — held open until the UI responds.
      const hookMatch = /^\/internal\/hook\/([^/]+)$/.exec(url.pathname);
      if (hookMatch) {
        const sessionId = decodeURIComponent(hookMatch[1] ?? '');
        if (req.method !== 'POST') {
          return new Response('method not allowed', { status: 405 });
        }
        let body: {
          tool: string;
          input: Record<string, unknown>;
          toolUseId: string;
          hookEventName: string;
          claudeSessionId: string;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return new Response('invalid JSON', { status: 400 });
        }

        try {
          const decision = await permissions.open({
            sessionId,
            tool: body.tool,
            input: body.input,
            toolUseId: body.toolUseId,
            hookEventName: body.hookEventName,
            claudeSessionId: body.claudeSessionId,
          });
          return Response.json(decision);
        } catch (err) {
          // Timed out — fall back to "ask" so Claude Code's own UI handles it.
          return Response.json({
            approved: false,
            reason: err instanceof Error ? err.message : 'permission timed out',
          });
        }
      }

      // SPA — single index.html
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const file = Bun.file(indexPath);
        if (!(await file.exists())) {
          return new Response('UI not built; see ui/index.html', { status: 500 });
        }
        return new Response(file, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      // Service worker — served from root so it controls '/'.
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

      // Static assets from uiDir (app.ts, components/, etc.). Whitelist to
      // a few known extensions to avoid serving arbitrary files from disk.
      if (
        url.pathname.endsWith('.ts') ||
        url.pathname.endsWith('.js') ||
        url.pathname.endsWith('.css') ||
        url.pathname.endsWith('.json') ||
        url.pathname.endsWith('.svg') ||
        url.pathname.endsWith('.png')
      ) {
        const safe = url.pathname.replace(/^\/+/, '');
        const assetPath = resolve(join(opts.uiDir, safe));
        const uiRoot = resolve(opts.uiDir);
        // Defense against `..` segments and percent-encoded traversal: the
        // resolved path must stay inside uiDir. `relative()` returns a path
        // starting with `..` (or an absolute path on Windows) when escape
        // is attempted.
        const rel = relative(uiRoot, assetPath);
        if (
          rel === '..' ||
          rel.startsWith(`..${sep}`) ||
          // Bun resolves `..` against uiDir even for non-existent files,
          // so also reject absolute paths (Windows) and any segment that
          // starts with `..` after a separator.
          resolve(uiRoot, rel) !== assetPath
        ) {
          return new Response('not found', { status: 404 });
        }
        const file = Bun.file(assetPath);
        if (!(await file.exists())) {
          return new Response('not found', { status: 404 });
        }

        // Transpile TypeScript on the fly so the browser gets plain JS.
        // We keep imports pointing at `solid-js` etc. — the import map in
        // index.html rewrites them to esm.sh URLs.
        if (url.pathname.endsWith('.ts')) {
          const transpiler = new Bun.Transpiler({
            loader: 'ts',
            target: 'browser',
            tsconfig: {
              compilerOptions: {
                jsx: 'preserve',
              },
            },
          });
          const src = await file.text();
          const out = transpiler.transformSync(src, 'ts');
          return new Response(out, {
            headers: { 'content-type': 'application/javascript; charset=utf-8' },
          });
        }

        return new Response(file);
      }

      return new Response('not found', { status: 404 });
    },
  });

  const stop = async () => {
    await manager.stopAll();
    if (pushStore) pushStore.close();
    await server.stop();
  };

  // Expose for tests; in production code nothing references this.
  return { stop, hookUrl };
}

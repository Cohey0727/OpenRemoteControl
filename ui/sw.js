/**
 * open-rc service worker — receives Web Push payloads and shows a
 * system notification; precaches the SPA shell and serves a
 * stale-cache fallback so the app at least loads when the relay is
 * unreachable. Clicking the notification focuses (or opens) the SPA
 * tab so the user lands back in the relevant session.
 *
 * Two responsibilities:
 *   1. Web Push (server emits `done` → system notification).
 *   2. App-shell offline (NetworkFirst, fall back to the precache).
 *      The /ws WebSocket is obviously live-only; offline = the shell
 *      loads, the composer is disabled.
 *
 * NOTE: this file is served at `/sw.js` and uses the standard Push
 * API. Keep dependencies zero — no imports — so it works without
 * bundling.
 */

/* Cache version — bump only on cache-LAYOUT changes (renamed shell
 * URLs, new precache strategy) so the activate handler drops the
 * obsolete cache. Update DETECTION does not depend on this: the
 * server appends a `shell-rev` fingerprint of the ui/ directory to
 * this file, so any shell change already makes the served bytes
 * differ and triggers the SW update flow. */
const CACHE_VERSION = 'v1';
const APP_SHELL = `${CACHE_VERSION}-app-shell`;
const APP_SHELL_URLS = [
  '/',
  '/app.ts',
  '/vendor/marked.js',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  // Precache the shell, then skipWaiting so an updated SW activates
  // immediately instead of idling in `waiting` until every tab
  // closes. skipWaiting runs strictly AFTER the precache resolves
  // (inside waitUntil), so activation never races a partial cache;
  // the page reloads itself on controllerchange to run the new shell.
  event.waitUntil(
    caches
      .open(APP_SHELL)
      .then((cache) => {
        // Use addAll so a single failure rejects the whole install —
        // otherwise we'd silently boot with a partial cache.
        return cache.addAll(APP_SHELL_URLS.map((u) => new Request(u, { cache: 'reload' })));
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Drop caches from previous shell versions, then claim so open
  // pages start being SW-controlled without a reload.
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== APP_SHELL && k.startsWith(`${CACHE_VERSION}-`))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('push', (event) => {
  const data = { title: 'ORC', body: 'New notification', url: '/' };
  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.title === 'string') data.title = parsed.title;
        if (typeof parsed.body === 'string') data.body = parsed.body;
        if (typeof parsed.url === 'string') data.url = parsed.url;
      }
    } catch {
      // fall back to text
      try {
        data.body = event.data.text();
      } catch {}
    }
  }

  const options = {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'open-rc',
    renotify: true,
    data: { url: data.url },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'navigate', url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return null;
    }),
  );
});

// Optional: listen for messages from the page (e.g., to trigger a test push).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skipWaiting') {
    self.skipWaiting();
  }
});

/* -----------------------------------------------------------------
 * App-shell fetch handler — NetworkFirst with cache fallback.
 *
 * Strategy (matches the agreed UX):
 *   - Same-origin GET → try the network, then fall back to the cache.
 *     Online loads always come from the server; offline / server
 *     hiccup → the user still sees the SPA shell.
 *   - Navigation requests → same NetworkFirst, with `/` as the
 *     fallback so deep links (`/sessions/<id>`) at least boot the
 *     shell.
 *   - POST / PUT / DELETE / cross-origin / WebSocket upgrades →
 *     pass through untouched; the relay is live-only anyway.
 *
 * Web Push and notification handlers above are unaffected.
 * ----------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // let the runtime handle it
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin, no cache
  // WebSocket upgrades are GETs but must not be intercepted.
  if (req.headers.get('Upgrade')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(APP_SHELL);
      try {
        const fresh = await fetch(req);
        // Opportunistically refresh the precache for shell URLs so
        // an updated server shell is reflected next time the user
        // goes offline. Don't cache opaque or error responses.
        if (fresh?.ok && fresh.type === 'basic') {
          cache.put(req, fresh.clone()).catch(() => {
            // ignore — best-effort refresh
          });
        }
        return fresh;
      } catch {
        // Network failed: prefer the matching cached entry, otherwise
        // for navigations fall back to the cached root index.
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const root = await cache.match('/');
          if (root) return root;
        }
        // Nothing in the cache and no network — let the runtime
        // produce its default offline error.
        return Response.error();
      }
    })(),
  );
});

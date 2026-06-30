/**
 * open-rc service worker — receives Web Push payloads and shows a
 * system notification. Clicking the notification focuses (or opens) the
 * SPA tab so the user lands back in the relevant session.
 *
 * NOTE: this file is served at `/sw.js` and uses the standard Push API.
 * Keep dependencies zero — no imports — so it works without bundling.
 */

self.addEventListener('install', (_event) => {
  // Activate the new SW immediately on first install.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim any open clients so the SW starts controlling them without a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const data = { title: 'open-rc', body: 'New notification', url: '/' };
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

/**
 * PWA asset smoke test — proves the server serves the manifest, the
 * service worker, the SPA HTML (with the manifest link), and the
 * icon assets needed to install the SPA as a PWA. The icon PNGs
 * (192/512/maskable/apple-touch-icon) are placed by the maintainer
 * after editing ui/icon.svg; this test soft-asserts them so the
 * suite still goes green before they land, and starts enforcing
 * content-type + 200 as soon as they do.
 *
 * Why this is its own file (vs. folded into relay.test.ts):
 *   - relay.test.ts is about the WebSocket relay — its PWA pieces
 *     are just the static-asset routes, not the wire protocol.
 *   - Keeps the icon-asset assertions discoverable when someone
 *     adds a 7th icon size; the test names tell the story.
 *
 * Run: bun test tests/pwa-assets.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '../src/serve.ts';
import { ensureUiDist } from './helpers/build-ui.ts';

const PORT = 7402;
const HTTP_URL = `http://127.0.0.1:${PORT}`;
let UI_DIR = '';

let handle: { stop: () => Promise<void> } | undefined;

beforeAll(async () => {
  UI_DIR = await ensureUiDist();
  handle = await serve({
    host: '127.0.0.1',
    port: PORT,
    uiDir: UI_DIR,
    pushDisabled: true,
  });
  // Brief pause so the listener is fully armed before any test fires.
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  if (handle) await handle.stop();
  await new Promise((r) => setTimeout(r, 100));
});

/** Helper: GET a path, return both the status and a parsed body if
 *  the content-type is JSON. The rest of the tests look at the raw
 *  text body, so JSON parsing is opt-in. */
async function get(path: string): Promise<{ status: number; contentType: string; text: string }> {
  const res = await fetch(`${HTTP_URL}${path}`);
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    text: await res.text(),
  };
}

describe('pwa: manifest', () => {
  test('GET /manifest.webmanifest returns 200 with the spec content type', async () => {
    const res = await get('/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/manifest+json');
  });

  test('GET /manifest.webmanifest has no-cache so a manifest edit ships without clearing storage', async () => {
    const res = await fetch(`${HTTP_URL}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('no-cache');
  });

  test('manifest body parses as JSON with the required installability fields', async () => {
    const res = await get('/manifest.webmanifest');
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(typeof body.name).toBe('string');
    expect((body.name as string).length).toBeGreaterThan(0);
    expect(typeof body.short_name).toBe('string');
    expect(body.start_url).toBe('/');
    expect(body.scope).toBe('/');
    expect(body.display).toBe('standalone');
    expect(typeof body.theme_color).toBe('string');
    expect(Array.isArray(body.icons)).toBe(true);
    const icons = body.icons as Array<{ sizes: string; src: string }>;
    const sizes = icons.map((i) => i.sizes);
    // Installability requires at least one 192 and one 512 icon.
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });
});

describe('pwa: service worker', () => {
  test('GET /sw.js returns 200 with the JS content type and the Service-Worker-Allowed scope', async () => {
    const res = await fetch(`${HTTP_URL}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('javascript');
    // The SW needs Service-Worker-Allowed: / because index.html lives
    // at the root and the SW would otherwise only control /sw.js's
    // own scope.
    expect(res.headers.get('service-worker-allowed')).toBe('/');
    // no-cache so an updated SW actually replaces the previous one.
    expect(res.headers.get('cache-control') ?? '').toContain('no-cache');
  });

  test('sw.js contains a fetch handler (the offline / app-shell handler)', async () => {
    const res = await get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain("addEventListener('fetch'");
    // The existing push handler is preserved; this guards against
    // an over-aggressive rewrite that drops Web Push.
    expect(res.text).toContain("addEventListener('push'");
    expect(res.text).toContain("addEventListener('notificationclick'");
  });

  test('sw.js is stamped with a stable shell revision so ANY UI change is a SW update', async () => {
    // The stamp makes the served sw.js bytes change whenever any UI
    // file changes, so registration.update() detects a new deploy
    // without a manual CACHE_VERSION bump.
    const a = await get('/sw.js');
    const b = await get('/sw.js');
    const stampOf = (text: string): string | undefined =>
      /shell-rev: ([0-9a-f]+|unknown)/.exec(text)?.[1];
    expect(stampOf(a.text)).toBeDefined();
    expect(stampOf(a.text)).not.toBe('unknown');
    // Stable while the UI directory is unchanged — otherwise the SW
    // would reinstall (and the page reload) on every update check.
    expect(stampOf(b.text)).toBe(stampOf(a.text));
  });

  test('sw.js activates updates immediately (skipWaiting on install)', async () => {
    const res = await get('/sw.js');
    expect(res.text).toContain('skipWaiting');
  });
});

describe('pwa: SPA HTML integration', () => {
  test('GET / links the manifest, sets a theme-color, and advertises iOS standalone mode', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    // The exact attributes Lighthouse / Safari look for. We check
    // substring presence so the test isn't fragile to attribute
    // order or quoting.
    expect(res.text).toContain('rel="manifest"');
    expect(res.text).toContain('href="/manifest.webmanifest"');
    expect(res.text).toContain('name="theme-color"');
    expect(res.text).toContain('name="apple-mobile-web-app-capable"');
    expect(res.text).toContain('rel="apple-touch-icon"');
    // /icon.svg is the favicon both in the address bar and in the
    // SW's push-notification badge.
    expect(res.text).toContain('href="/icon.svg"');
  });
});

describe('pwa: icons', () => {
  test('GET /icon.svg serves the source-of-truth brand mark', async () => {
    const res = await get('/icon.svg');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<svg');
  });

  test.each([
    { path: '/icon-192.png', sizes: '192x192' },
    { path: '/icon-512.png', sizes: '512x512' },
    { path: '/icon-maskable-512.png', sizes: '512x512' },
    { path: '/apple-touch-icon.png', sizes: '180x180' },
  ])('GET $path returns a PNG (when present) for install/$sizes', async ({ path }) => {
    const onDisk = existsSync(join(UI_DIR, path.replace(/^\//, '')));
    if (!onDisk) {
      // The maintainer generates the PNGs out of ui/icon.svg; this
      // soft-skip is a one-time-OK situation. Drop it once the
      // icons are committed and the maintainer removes this guard.
      console.warn(`skipping ${path} — not present in ${UI_DIR}`);
      return;
    }
    const res = await fetch(`${HTTP_URL}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('image/png');
  });
});

describe('pwa: directory-traversal safety', () => {
  test('percent-encoded traversal of /manifest.webmanifest is rejected', async () => {
    // %2e is `.`; the browser would normalise unencoded `..` before
    // sending, so the encode is the only way to actually probe the
    // server's path-resolve logic. The static-asset branch resolves
    // the resulting path and refuses anything that escapes the
    // configured uiDir.
    const res = await fetch(`${HTTP_URL}/manifest.webmanifest/%2e%2e/%2e%2e/etc/passwd`, {
      redirect: 'manual',
    });
    expect([400, 404]).toContain(res.status);
  });

  test('percent-encoded traversal of /icon.svg is rejected', async () => {
    const res = await fetch(`${HTTP_URL}/icon.svg/%2e%2e/%2e%2e/package.json`, {
      redirect: 'manual',
    });
    expect([400, 404]).toContain(res.status);
  });
});

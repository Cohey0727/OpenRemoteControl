/**
 * Phase 5: push endpoint integration.
 *
 *   - GET  /api/push/vapid-public-key
 *   - POST /api/push/subscribe
 *   - POST /api/push/unsubscribe
 *   - GET  /sw.js
 *
 * Boots `serve()` with explicit vapid/push paths so it doesn't touch the
 * user's real XDG_DATA_HOME.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/serve.ts';

const PORT = 7399;
const UI_DIR = `${import.meta.dir}/../ui`;

let handle: { stop: () => Promise<void> } | undefined;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'open-rc-push-endpoints-'));
  handle = await serve({
    host: '127.0.0.1',
    port: PORT,
    uiDir: UI_DIR,
    vapidKeyPath: join(tmp, 'vapid.json'),
    pushStorePath: join(tmp, 'push.db'),
    // Run a permissive Claude spawn so a stray call doesn't 500; tests
    // here never prompt.
    claudeBin: 'true',
  });
  // Give Bun a moment to finalize listener.
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(async () => {
  if (handle) await handle.stop();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(tmp, { recursive: true, force: true });
});

describe('push endpoints', () => {
  test('GET /api/push/vapid-public-key returns the public key', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/push/vapid-public-key`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: string };
    expect(typeof body.publicKey).toBe('string');
    expect(body.publicKey.length).toBeGreaterThan(20);
  });

  test('POST /api/push/subscribe registers and returns id', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example.com/test-1',
        keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
        sessionId: 's-1',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  test('POST /api/push/subscribe validates input', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example.com/x' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/push/unsubscribe removes the subscription', async () => {
    const ep = 'https://push.example.com/test-2';
    await fetch(`http://127.0.0.1:${PORT}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: ep,
        keys: { p256dh: 'p', auth: 'a' },
      }),
    });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: ep }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean };
    expect(body.removed).toBe(true);
  });

  test('GET /sw.js serves the service worker', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/sw.js`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('javascript');
    const body = await res.text();
    expect(body).toContain('push');
  });
});

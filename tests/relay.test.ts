/**
 * Relay integration test — proves the server is a pure WebSocket relay
 * that starts no processes of its own.
 *
 * Test plan:
 *   1. Boot `serve()` with push disabled, on a random port.
 *   2. Open a browser WS at `/ws` and a bridge WS at `/agent`.
 *   3. Bridge sends `register` → browser receives `client_registered`.
 *   4. Browser sends `attach { clientId }` → subsequent bridge frames
 *      (text, thinking, tool_use, tool_result, permission_request,
 *      done, error) are forwarded with `clientId` tagged on.
 *   5. Browser sends `send { clientId, text }` → bridge receives a
 *      `prompt { text }` frame.
 *   6. Browser sends `permission_response` → bridge receives a
 *      `permission_response` frame.
 *   7. Bridge closes → browser receives `client_removed`.
 *   8. Static asset routes (`/`, `/app.ts`, `/sw.js`, `/health`) work.
 *   9. No `/internal/hook`, no `/api/sessions` — 404s as expected.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { serve } from '../src/serve.ts';

const PORT = 7401;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const AGENT_URL = `ws://127.0.0.1:${PORT}/agent`;
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const UI_DIR = `${import.meta.dir}/../ui`;

let handle: { stop: () => Promise<void> } | undefined;

beforeAll(async () => {
  handle = await serve({
    host: '127.0.0.1',
    port: PORT,
    uiDir: UI_DIR,
    pushDisabled: true,
  });
  // Brief pause so the listener is fully armed before any test WS connects.
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  if (handle) await handle.stop();
  await new Promise((r) => setTimeout(r, 100));
});

/* ----------------------------- helpers ----------------------------- */

interface FramedWs {
  readonly ws: WebSocket;
  /** Append-only log of every frame received so far. */
  readonly inbox: Record<string, unknown>[];
  /** Resolves once a frame matching `pred` arrives. */
  waitFor(
    pred: (f: { type: string }) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  /** Resolves once a frame matching `pred` arrives, returning every frame seen so far. */
  collectUntil(
    pred: (f: { type: string }) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>[]>;
  close(): void;
}

function openFramed(url: string): Promise<FramedWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox: Record<string, unknown>[] = [];
    type SingleWaiter = {
      pred: (f: { type: string }) => boolean;
      resolve: (f: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      collect: false;
      timer: ReturnType<typeof setTimeout>;
    };
    type CollectWaiter = {
      pred: (f: { type: string }) => boolean;
      resolve: (f: Record<string, unknown>[]) => void;
      reject: (err: Error) => void;
      collect: true;
      timer: ReturnType<typeof setTimeout>;
    };
    const waiters: Array<SingleWaiter | CollectWaiter> = [];

    function pump(): void {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (!w) continue;
        const hit = inbox.find((m) => typeof m.type === 'string' && w.pred(m as { type: string }));
        if (hit) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          if (w.collect) (w as CollectWaiter).resolve([...inbox]);
          else (w as SingleWaiter).resolve(hit);
        }
      }
    }

    ws.addEventListener('message', (ev) => {
      try {
        const frame = JSON.parse(ev.data as string) as Record<string, unknown>;
        inbox.push(frame);
        pump();
      } catch {
        // ignore garbage
      }
    });

    ws.addEventListener('open', () => {
      resolve({
        ws,
        inbox,
        waitFor: (pred, timeoutMs = 3000) =>
          new Promise<Record<string, unknown>>((res, rej) => {
            const hit = inbox.find(
              (m) => typeof m.type === 'string' && pred(m as { type: string }),
            );
            if (hit) return res(hit);
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((x) => x.timer === timer);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(
                new Error(
                  `waitFor timeout after ${timeoutMs}ms (last inbox: ${JSON.stringify(inbox.slice(-3))})`,
                ),
              );
            }, timeoutMs);
            waiters.push({ pred, resolve: res, reject: rej, collect: false, timer });
          }),
        collectUntil: (pred, timeoutMs = 3000) =>
          new Promise<Record<string, unknown>[]>((res, rej) => {
            const hit = inbox.find(
              (m) => typeof m.type === 'string' && pred(m as { type: string }),
            );
            if (hit) return res([...inbox]);
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((x) => x.timer === timer);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error(`collectUntil timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            waiters.push({ pred, resolve: res, reject: rej, collect: true, timer });
          }),
        close: () => ws.close(),
      });
    });
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${String(e)}`)));
  });
}

/* ----------------------------- tests ----------------------------- */

describe('relay: bridge ↔ browser', () => {
  test('bridge register is broadcast to browsers; per-client frames are forwarded', async () => {
    const browser = await openFramed(WS_URL);
    const bridge = await openFramed(AGENT_URL);

    // Browser asks for the initial list (currently empty).
    browser.ws.send(JSON.stringify({ type: 'list_clients' }));
    const empty = await browser.waitFor((m) => m.type === 'client_list');
    expect((empty.clients as unknown[]).length).toBe(0);

    // Bridge registers.
    bridge.ws.send(
      JSON.stringify({
        type: 'register',
        clientId: 'test-1',
        label: 'laptop',
        cwd: '/home/test/proj',
      }),
    );
    const registered = await browser.waitFor((m) => m.type === 'client_registered');
    const client = registered.client as { clientId: string; label: string; cwd: string };
    expect(client.clientId).toBe('test-1');
    expect(client.label).toBe('laptop');
    expect(client.cwd).toBe('/home/test/proj');

    const changed = await browser.waitFor((m) => m.type === 'clients_changed');
    expect((changed.clients as Array<{ clientId: string }>)[0]?.clientId).toBe('test-1');

    // Browser attaches.
    browser.ws.send(JSON.stringify({ type: 'attach', clientId: 'test-1' }));

    // Bridge streams a few frames.
    bridge.ws.send(JSON.stringify({ type: 'text', text: 'hello' }));
    bridge.ws.send(JSON.stringify({ type: 'thinking', text: 'pondering' }));
    bridge.ws.send(JSON.stringify({ type: 'tool_use', tool: 'Bash', input: '{"cmd":"ls"}' }));
    bridge.ws.send(JSON.stringify({ type: 'tool_result', output: 'a.txt\nb.txt' }));
    bridge.ws.send(
      JSON.stringify({
        type: 'permission_request',
        requestId: 'req-1',
        tool: 'Bash',
        input: { command: 'rm -rf /' },
      }),
    );
    bridge.ws.send(JSON.stringify({ type: 'done', cost: 0.001, duration_ms: 1234 }));

    const collected = await browser.collectUntil((m) => m.type === 'done', 3000);
    const types = collected.map((f) => f.type as string);
    expect(types).toContain('text');
    expect(types).toContain('thinking');
    expect(types).toContain('tool_use');
    expect(types).toContain('tool_result');
    expect(types).toContain('permission_request');
    expect(types).toContain('done');

    // All relayed frames must carry clientId === 'test-1'.
    const relayedTypes = new Set([
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'permission_request',
      'done',
      'error',
    ]);
    for (const f of collected) {
      if (relayedTypes.has(f.type as string)) {
        expect(f.clientId).toBe('test-1');
      }
    }

    const done = collected.find((f) => f.type === 'done');
    expect(done?.cost).toBe(0.001);
    expect(done?.duration_ms).toBe(1234);

    browser.close();
    bridge.close();
  });

  test('browser send is forwarded to the bridge as a prompt frame', async () => {
    const browser = await openFramed(WS_URL);
    const bridge = await openFramed(AGENT_URL);

    bridge.ws.send(
      JSON.stringify({ type: 'register', clientId: 'test-2', label: 'mbp', cwd: '/tmp/proj' }),
    );
    await browser.waitFor((m) => m.type === 'client_registered');
    browser.ws.send(JSON.stringify({ type: 'attach', clientId: 'test-2' }));
    await new Promise((r) => setTimeout(r, 50));

    browser.ws.send(JSON.stringify({ type: 'send', clientId: 'test-2', text: 'what is 2+2?' }));
    const got = await bridge.waitFor((m) => m.type === 'prompt');
    expect(got.text).toBe('what is 2+2?');

    browser.close();
    bridge.close();
  });

  test('browser permission_response is forwarded to the bridge', async () => {
    const browser = await openFramed(WS_URL);
    const bridge = await openFramed(AGENT_URL);

    bridge.ws.send(
      JSON.stringify({ type: 'register', clientId: 'test-3', label: 'lab', cwd: '/x' }),
    );
    await browser.waitFor((m) => m.type === 'client_registered');
    browser.ws.send(JSON.stringify({ type: 'attach', clientId: 'test-3' }));
    await new Promise((r) => setTimeout(r, 50));

    browser.ws.send(
      JSON.stringify({
        type: 'permission_response',
        clientId: 'test-3',
        requestId: 'req-99',
        approved: true,
      }),
    );
    const got = await bridge.waitFor((m) => m.type === 'permission_response');
    expect(got.requestId).toBe('req-99');
    expect(got.approved).toBe(true);

    browser.close();
    bridge.close();
  });

  test('bridge close broadcasts client_removed', async () => {
    const browser = await openFramed(WS_URL);
    const bridge = await openFramed(AGENT_URL);

    bridge.ws.send(JSON.stringify({ type: 'register', clientId: 'test-4', label: 'l', cwd: '/y' }));
    await browser.waitFor((m) => m.type === 'client_registered');

    const removedPromise = browser.waitFor((m) => m.type === 'client_removed');
    bridge.close();
    const removed = await removedPromise;
    expect(removed.clientId).toBe('test-4');

    // list_clients after removal shows the gap.
    browser.ws.send(JSON.stringify({ type: 'list_clients' }));
    const list = await browser.waitFor((m) => m.type === 'client_list');
    expect((list.clients as Array<{ clientId: string }>).length).toBe(0);

    browser.close();
  });

  test('browser send to unknown clientId returns an error frame', async () => {
    const browser = await openFramed(WS_URL);
    browser.ws.send(JSON.stringify({ type: 'send', clientId: 'nope', text: 'hi' }));
    const err = await browser.waitFor((m) => m.type === 'error');
    expect(err.clientId).toBe('nope');
    expect(err.message as string).toContain('unknown client');

    browser.close();
  });

  test('bridge with duplicate clientId is rejected with an error frame', async () => {
    const bridge1 = await openFramed(AGENT_URL);
    const bridge2 = await openFramed(AGENT_URL);

    bridge1.ws.send(JSON.stringify({ type: 'register', clientId: 'dup', label: 'a', cwd: '/a' }));
    await new Promise((r) => setTimeout(r, 50));

    const errPromise = bridge2.waitFor((m) => m.type === 'error');
    bridge2.ws.send(JSON.stringify({ type: 'register', clientId: 'dup', label: 'b', cwd: '/b' }));
    const err = await errPromise;
    expect(err.message as string).toContain('clientId already in use');

    bridge1.close();
    bridge2.close();
  });
});

describe('relay: HTTP routes', () => {
  test('GET / serves the SPA index.html', async () => {
    const res = await fetch(`${HTTP_URL}/`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
  });

  test('GET /app.ts serves the SPA entrypoint (transpiled to JS)', async () => {
    const res = await fetch(`${HTTP_URL}/app.ts`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // The SPA is vanilla TS now: it must import `marked` from the
    // importmap and contain the home-grown signal implementation.
    expect(body).toContain('marked');
    expect(body).toContain('function signal(');
  });

  test('GET /sw.js serves the service worker', async () => {
    const res = await fetch(`${HTTP_URL}/sw.js`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('javascript');
  });

  test('GET /health returns JSON with the connected-client count', async () => {
    const res = await fetch(`${HTTP_URL}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; clients: number; push: string };
    expect(body.status).toBe('ok');
    expect(typeof body.clients).toBe('number');
    expect(body.push).toBe('disabled');
  });

  test('directory traversal via percent-encoded .. is rejected', async () => {
    const cases = [
      `${HTTP_URL}/%2e%2e/package.json`,
      `${HTTP_URL}/%2e%2e/%2e%2e/package.json`,
      `${HTTP_URL}/%2e%2e/src/serve.ts`,
    ];
    for (const url of cases) {
      const res = await fetch(url, { redirect: 'manual' });
      expect([400, 404]).toContain(res.status);
    }
  });

  test('GET /api/sessions is gone (the server has no session concept)', async () => {
    const res = await fetch(`${HTTP_URL}/api/sessions`);
    expect(res.status).toBe(404);
  });

  test('POST /internal/hook/* is gone (no PreToolUse hook endpoint)', async () => {
    const res = await fetch(`${HTTP_URL}/internal/hook/anything`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

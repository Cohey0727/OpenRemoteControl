/**
 * Shared-session test: two `/ws` clients (a browser and a `tui`, both
 * plain `/ws` consumers) attached to ONE bridge must share the session —
 * a prompt from either is echoed to BOTH as a `user` frame, and the
 * bridge's reply fans out to BOTH. This is what makes "drive from the
 * browser AND the CLI" one conversation rather than two.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseTuiFlags, wsUrlFromBase } from '../src/cli/tui.ts';
import { serve } from '../src/serve.ts';

const PORT = 7466;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const AGENT = `ws://127.0.0.1:${PORT}/agent`;
const UI_DIR = `${import.meta.dir}/../ui`;

let handle: { stop: () => Promise<void> } | undefined;

function restoreOrcBaseUrl(prev: string | undefined): void {
  if (prev === undefined) {
    // biome-ignore lint/performance/noDelete: unsetting an env var requires delete
    delete process.env.ORC_BASE_URL;
  } else {
    process.env.ORC_BASE_URL = prev;
  }
}

beforeAll(async () => {
  handle = await serve({ host: '127.0.0.1', port: PORT, uiDir: UI_DIR, pushDisabled: true });
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  if (handle) await handle.stop();
  await new Promise((r) => setTimeout(r, 100));
});

interface Inbox {
  ws: WebSocket;
  msgs: Array<Record<string, unknown>>;
  waitFor: (
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
}

function open(
  url: string,
  onMessage?: (m: Record<string, unknown>, ws: WebSocket) => void,
): Promise<Inbox> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      pred: (m: Record<string, unknown>) => boolean;
      res: (m: Record<string, unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse((ev as MessageEvent).data as string) as Record<string, unknown>;
      msgs.push(m);
      onMessage?.(m, ws);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w?.pred(m)) {
          clearTimeout(w.timer);
          w.res(m);
          waiters.splice(i, 1);
        }
      }
    });
    ws.addEventListener('error', () => reject(new Error(`ws error ${url}`)));
    ws.addEventListener('open', () =>
      resolve({
        ws,
        msgs,
        waitFor: (pred, ms = 3000) =>
          new Promise((res, rej) => {
            const hit = msgs.find(pred);
            if (hit) return res(hit);
            const timer = setTimeout(() => rej(new Error('waitFor timeout')), ms);
            waiters.push({ pred, res, timer });
          }),
      }),
    );
  });
}

describe('wsUrlFromBase', () => {
  test('derives the /ws browser endpoint', () => {
    expect(wsUrlFromBase('http://h:7322')).toBe('ws://h:7322/ws');
    expect(wsUrlFromBase('https://h/ws')).toBe('wss://h/ws');
    expect(wsUrlFromBase('h:7322')).toBe('ws://h:7322/ws');
  });
  test('parseTuiFlags honors --server and ORC_BASE_URL', () => {
    const prev = process.env.ORC_BASE_URL;
    process.env.ORC_BASE_URL = 'http://box:7322';
    try {
      expect(parseTuiFlags([]).server).toBe('ws://box:7322/ws');
      expect(parseTuiFlags(['--server', 'ws://x:9/ws', '--client-id', 'c']).server).toBe(
        'ws://x:9/ws',
      );
      expect(parseTuiFlags(['--client-id', 'c']).clientId).toBe('c');
    } finally {
      restoreOrcBaseUrl(prev);
    }
  });
});

describe('shared session', () => {
  test('a prompt from one /ws client echoes to both, and the reply fans out to both', async () => {
    // Bridge: register, then reply to any prompt with a text frame.
    const bridge = await open(AGENT, (m, ws) => {
      if (m.type === 'prompt') {
        ws.send(JSON.stringify({ type: 'text', text: `echo: ${m.text as string}` }));
      }
    });
    bridge.ws.send(
      JSON.stringify({ type: 'register', label: 'shared', cwd: '/w', clientId: 'shared-1' }),
    );
    await bridge.waitFor((m) => m.type === 'registered');

    // Two /ws clients — think "browser" and "tui".
    const a = await open(WS);
    const b = await open(WS);
    a.ws.send(JSON.stringify({ type: 'attach', clientId: 'shared-1' }));
    b.ws.send(JSON.stringify({ type: 'attach', clientId: 'shared-1' }));
    await new Promise((r) => setTimeout(r, 100));

    // A sends a prompt.
    a.ws.send(JSON.stringify({ type: 'send', clientId: 'shared-1', text: 'hi there' }));

    // BOTH clients see the user echo…
    const aUser = await a.waitFor((m) => m.type === 'user');
    const bUser = await b.waitFor((m) => m.type === 'user');
    expect(aUser.text).toBe('hi there');
    expect(bUser.text).toBe('hi there');

    // …and BOTH see the bridge's reply.
    const aText = await a.waitFor((m) => m.type === 'text');
    const bText = await b.waitFor((m) => m.type === 'text');
    expect(aText.text).toBe('echo: hi there');
    expect(bText.text).toBe('echo: hi there');

    a.ws.close();
    b.ws.close();
    bridge.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  test('text_delta streams to attached clients but is not replayed to late joiners', async () => {
    const bridge = await open(AGENT);
    bridge.ws.send(
      JSON.stringify({ type: 'register', label: 'stream', cwd: '/w', clientId: 'stream-1' }),
    );
    await bridge.waitFor((m) => m.type === 'registered');

    const a = await open(WS);
    a.ws.send(JSON.stringify({ type: 'attach', clientId: 'stream-1' }));
    await new Promise((r) => setTimeout(r, 100));

    // Bridge streams two deltas, then the final complete text.
    bridge.ws.send(JSON.stringify({ type: 'text_delta', text: 'al' }));
    bridge.ws.send(JSON.stringify({ type: 'text_delta', text: 'pha' }));
    bridge.ws.send(JSON.stringify({ type: 'text', text: 'alpha' }));

    await a.waitFor((m) => m.type === 'text');
    const deltas = a.msgs.filter((m) => m.type === 'text_delta').map((m) => m.text);
    expect(deltas).toEqual(['al', 'pha']);

    // A late joiner replays the final text only — never the deltas
    // (replaying both would render the reply twice).
    const b = await open(WS);
    b.ws.send(JSON.stringify({ type: 'attach', clientId: 'stream-1' }));
    await b.waitFor((m) => m.type === 'text');
    expect(b.msgs.filter((m) => m.type === 'text_delta')).toHaveLength(0);

    a.ws.close();
    b.ws.close();
    bridge.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  test('done frames get a server timestamp that survives history replay', async () => {
    const bridge = await open(AGENT);
    bridge.ws.send(
      JSON.stringify({ type: 'register', label: 'stamp', cwd: '/w', clientId: 'stamp-1' }),
    );
    await bridge.waitFor((m) => m.type === 'registered');

    const a = await open(WS);
    a.ws.send(JSON.stringify({ type: 'attach', clientId: 'stamp-1' }));
    await new Promise((r) => setTimeout(r, 100));

    const before = Date.now();
    bridge.ws.send(JSON.stringify({ type: 'done', cost: 0.1, duration_ms: 500 }));
    const done = await a.waitFor((m) => m.type === 'done');
    expect(typeof done.ts).toBe('number');
    expect(done.ts as number).toBeGreaterThanOrEqual(before);

    // The replayed done carries the ORIGINAL completion time, not the
    // replay time.
    const b = await open(WS);
    b.ws.send(JSON.stringify({ type: 'attach', clientId: 'stamp-1' }));
    const replayed = await b.waitFor((m) => m.type === 'done');
    expect(replayed.ts).toBe(done.ts);

    a.ws.close();
    b.ws.close();
    bridge.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

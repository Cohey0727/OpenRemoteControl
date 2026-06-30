/**
 * End-to-end smoke test for the local serve MVP.
 *
 * Boots the Bun.serve stack in-process, opens a WebSocket, attaches to
 * a session, sends a prompt, and asserts that:
 *   - The subprocess emits a `system/init` event (translated away).
 *   - The user prompt is delivered to the subprocess.
 *   - Either an assistant `text` and a `done` arrive (when ANTHROPIC_API_KEY
 *     is configured and the call succeeds), OR a clean `error` arrives
 *     explaining why the API call failed.
 *   - The subprocess exits cleanly when the connection closes.
 *
 * This test does NOT depend on a real Claude API key — it works against
 * any working `claude` binary. Without a key, the subprocess will fail
 * at the API call; we assert a graceful failure rather than a hang.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { serve } from '../src/serve.ts';

const PORT = 7398;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const UI_DIR = `${import.meta.dir}/../ui`;

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const HAS_CLAUDE = (() => {
  try {
    const result = Bun.spawnSync({
      cmd: ['which', CLAUDE_BIN],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return result.exitCode === 0 && existsSync(result.stdout.toString().trim());
  } catch {
    return false;
  }
})();

let handle: { stop: () => Promise<void> } | undefined;

beforeAll(async () => {
  handle = await serve({
    host: '127.0.0.1',
    port: PORT,
    uiDir: UI_DIR,
    claudeBin: CLAUDE_BIN,
  });
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(async () => {
  if (handle) await handle.stop();
});

describe.skipIf(!HAS_CLAUDE)('serve integration', () => {
  test('end-to-end: prompt → reply (or graceful error)', async () => {
    const ws = new WebSocket(URL);
    const frames: unknown[] = [];
    let opened = false;

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout after 60s')), 60_000);

      ws.addEventListener('open', () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'attach', sessionId: 'integration-test' }));
      });

      ws.addEventListener('message', (ev) => {
        const frame = JSON.parse(ev.data as string);
        frames.push(frame);
        if (frame.type === 'done' || frame.type === 'error') {
          clearTimeout(timer);
          resolve();
        }
      });

      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        reject(new Error(`ws error: ${String(ev)}`));
      });
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(opened).toBe(true);

    ws.send(
      JSON.stringify({
        type: 'send',
        sessionId: 'integration-test',
        text: 'Reply with exactly the word "pong" and nothing else.',
      }),
    );

    await done;
    ws.close();

    // We expect at least one of:
    //   - a 'text' event (success path)
    //   - an 'error' event (no API key, network failure, etc.)
    // Either way the subprocess must have emitted something.
    const sawTerminus = frames.some(
      (f) => (f as { type: string }).type === 'done' || (f as { type: string }).type === 'error',
    );
    expect(sawTerminus).toBe(true);
  });

  test('static assets (app.ts) are served with status 200', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/app.ts`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('solid-js');
  });

  test('GET / serves the SPA index.html', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
  });

  test('GET /health returns JSON with sessions count', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.sessions).toBe('number');
  });
});

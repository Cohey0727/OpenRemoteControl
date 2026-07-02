/**
 * attach-orc integration: a real `serve`, a fake session transcript,
 * and an in-process bridge. Verifies the full shared-session loop the
 * feature promises:
 *
 *   transcript history  → replayed to an attaching browser
 *   transcript appends  → relayed live
 *   browser `send`      → lands in the session's prompt queue (for the
 *                         Stop/UserPromptSubmit hooks to deliver)
 *   attach/detach       → attached-count file for the hook linger
 *   stop marker         → `done` frame (turn divider)
 *   end marker          → bridge unregisters and the client disappears
 *
 * No child processes anywhere: the bridge runs in-process.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attachDirFor,
  drainQueue,
  queueNonEmpty,
  readAttachedCount,
  touchEndMarker,
  touchStopMarker,
} from '../src/attach/state.ts';
import { type AttachOrcHandle, runAttachOrc } from '../src/cli/attach-orc.ts';
import { serve } from '../src/serve.ts';
import { mungeCwd } from '../src/transcript/locate.ts';

const PORT = 7477;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const AGENT = `ws://127.0.0.1:${PORT}/agent`;
const UI_DIR = `${import.meta.dir}/../ui`;

const ROOT = join(import.meta.dir, '.tmp-bridge', crypto.randomUUID());
const CLAUDE_HOME = join(ROOT, 'claude-home');
const ATTACH_BASE = join(ROOT, 'attach');
const CWD = '/test/project';
const SESSION_ID = 'sess-fixture-1';
const TRANSCRIPT_DIR = join(CLAUDE_HOME, 'projects', mungeCwd(CWD));
const TRANSCRIPT = join(TRANSCRIPT_DIR, `${SESSION_ID}.jsonl`);

let server: { stop: () => Promise<void> } | undefined;
let bridge: AttachOrcHandle | undefined;

const entry = {
  user(text: string) {
    return `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      timestamp: new Date().toISOString(),
    })}\n`;
  },
  assistantText(text: string) {
    return `${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      timestamp: new Date().toISOString(),
    })}\n`;
  },
};

interface Inbox {
  ws: WebSocket;
  msgs: Array<Record<string, unknown>>;
  waitFor: (
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
  send: (frame: Record<string, unknown>) => void;
  close: () => void;
}

function open(url: string): Promise<Inbox> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      pred: (m: Record<string, unknown>) => boolean;
      res: (m: Record<string, unknown>) => void;
    }> = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      msgs.push(m);
      const hit = waiters.findIndex((w) => w.pred(m));
      if (hit >= 0) {
        const [w] = waiters.splice(hit, 1);
        w?.res(m);
      }
    });
    ws.addEventListener('open', () =>
      resolve({
        ws,
        msgs,
        waitFor(pred, ms = 4_000) {
          const existing = msgs.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('waitFor timeout')), ms);
            waiters.push({
              pred,
              res: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          });
        },
        send: (frame) => ws.send(JSON.stringify(frame)),
        close: () => ws.close(),
      }),
    );
    ws.addEventListener('error', reject);
  });
}

async function until(cond: () => Promise<boolean>, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('until timeout');
}

beforeAll(async () => {
  await mkdir(TRANSCRIPT_DIR, { recursive: true });
  await writeFile(TRANSCRIPT, entry.user('hello from the terminal') + entry.assistantText('hi!'));
  server = await serve({ host: '127.0.0.1', port: PORT, uiDir: UI_DIR, pushDisabled: true });
  bridge = await runAttachOrc(
    { server: AGENT, label: 'test-bridge', cwd: CWD },
    { attachBaseDir: ATTACH_BASE, claudeHome: CLAUDE_HOME, log: () => {} },
  );
});

afterAll(async () => {
  await bridge?.stop();
  if (server) await server.stop();
  await new Promise((r) => setTimeout(r, 100));
});

describe('attach-orc bridge', () => {
  test('registers under the session id and appears in the sidebar list', async () => {
    expect(bridge?.clientId).toBe(SESSION_ID);
    const browser = await open(WS);
    const list = await browser.waitFor((m) => m.type === 'client_list');
    const clients = list.clients as Array<Record<string, unknown>>;
    expect(clients.some((c) => c.clientId === SESSION_ID && c.cwd === CWD)).toBe(true);
    browser.close();
  });

  test('attaching replays transcript history and reports the viewer to the hooks', async () => {
    const browser = await open(WS);
    browser.send({ type: 'attach', clientId: SESSION_ID });
    await browser.waitFor((m) => m.type === 'user' && m.text === 'hello from the terminal');
    await browser.waitFor((m) => m.type === 'text' && m.text === 'hi!');

    const dir = attachDirFor(SESSION_ID, ATTACH_BASE);
    await until(async () => (await readAttachedCount(dir)) >= 1);
    browser.close();
  });

  test('live transcript appends are relayed; a new user turn closes the previous one', async () => {
    const browser = await open(WS);
    browser.send({ type: 'attach', clientId: SESSION_ID });
    await browser.waitFor((m) => m.type === 'text' && m.text === 'hi!');

    await appendFile(TRANSCRIPT, entry.assistantText('working on it'));
    await browser.waitFor((m) => m.type === 'text' && m.text === 'working on it');

    const before = browser.msgs.length;
    await appendFile(TRANSCRIPT, entry.user('typed in the terminal'));
    await browser.waitFor((m) => m.type === 'user' && m.text === 'typed in the terminal');
    const tail = browser.msgs.slice(before).map((m) => m.type);
    expect(tail).toContain('done');
    expect(tail.indexOf('done')).toBeLessThan(tail.indexOf('user'));
    browser.close();
  });

  test('a browser send is echoed and queued for the hooks', async () => {
    const browser = await open(WS);
    browser.send({ type: 'attach', clientId: SESSION_ID });
    browser.send({ type: 'send', clientId: SESSION_ID, text: 'from the browser' });
    await browser.waitFor((m) => m.type === 'user' && m.text === 'from the browser');

    const dir = attachDirFor(SESSION_ID, ATTACH_BASE);
    await until(() => queueNonEmpty(dir));
    expect(await drainQueue(dir)).toEqual(['from the browser']);
    browser.close();
  });

  test('the Stop-hook marker becomes a done frame', async () => {
    const browser = await open(WS);
    browser.send({ type: 'attach', clientId: SESSION_ID });
    await browser.waitFor((m) => m.type === 'text' && m.text === 'hi!');

    // Open a turn, then signal turn end the way the Stop hook does.
    await appendFile(TRANSCRIPT, entry.assistantText('almost done'));
    await browser.waitFor((m) => m.type === 'text' && m.text === 'almost done');
    const donesBefore = browser.msgs.filter((m) => m.type === 'done').length;
    await touchStopMarker(attachDirFor(SESSION_ID, ATTACH_BASE));
    await until(
      async () => browser.msgs.filter((m) => m.type === 'done').length > donesBefore,
      6_000,
    );
    browser.close();
  });

  test('a second bridge for the same session fails fast', async () => {
    await expect(
      runAttachOrc(
        { server: AGENT, label: 'dupe', cwd: CWD },
        { attachBaseDir: join(ROOT, 'attach2'), claudeHome: CLAUDE_HOME, log: () => {} },
      ),
    ).rejects.toThrow('already in use');
  });

  test('the SessionEnd marker unregisters the client', async () => {
    const browser = await open(WS);
    await browser.waitFor((m) => m.type === 'client_list');

    // Signal the way the SessionEnd hook does.
    await touchEndMarker(attachDirFor(SESSION_ID, ATTACH_BASE));
    await browser.waitFor((m) => m.type === 'client_removed' && m.clientId === SESSION_ID, 6_000);
    browser.close();
  });
});

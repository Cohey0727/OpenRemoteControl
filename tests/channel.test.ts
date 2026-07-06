/**
 * `orc channel` — the Channels-based sharing path (Issue #11 O4 PoC).
 *
 * Three layers under test, everything in-process:
 *
 *   1. The MCP half (`makeChannelMcp`) against an in-memory transport:
 *      capability declaration, prompt/verdict notifications out,
 *      permission_request notifications in, close propagation.
 *   2. Late transcript discovery (`scanForNewTranscript`).
 *   3. The composed runner (`runChannel`) against a real `orc serve`:
 *      viewer send → MCP prompt notification, permission relay round
 *      trip, transcript adoption → history streaming, and the Stop
 *      hook's channel-mode short-circuit.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  appendQueue,
  attachDirFor,
  browserTurnMarkerExists,
  channelMarkerExists,
  createAttachDir,
  queueNonEmpty,
  touchChannelMarker,
  writeAttachedCount,
  writeBridgeInfo,
} from '../src/attach/state.ts';
import { scanForNewTranscript } from '../src/channel/discover.ts';
import {
  CHANNEL_SERVER_NAME,
  type ChannelMcp,
  type ChannelMcpOptions,
  makeChannelMcp,
} from '../src/channel/mcp.ts';
import { runStopHook } from '../src/cli/attach-hooks.ts';
import {
  type ChannelCliFlags,
  parseChannelFlags,
  runChannel,
  stableChannelClientId,
} from '../src/cli/channel.ts';
import { serve } from '../src/serve.ts';
import { mungeCwd } from '../src/transcript/locate.ts';

const PORT = 7499;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const AGENT = `ws://127.0.0.1:${PORT}/agent`;
const UI_DIR = `${import.meta.dir}/../ui`;
const base = join(import.meta.dir, '.tmp-channel');

let server: { stop: () => Promise<void> } | undefined;

beforeAll(async () => {
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  server = await serve({ host: '127.0.0.1', port: PORT, uiDir: UI_DIR, pushDisabled: true });
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  if (server) await server.stop();
  await rm(base, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 100));
});

/* ------------------------------------------------------------------ */
/*  1. MCP half against an in-memory transport                         */
/* ------------------------------------------------------------------ */

type JsonRpc = Record<string, unknown>;

function memTransport(): { transport: Transport; sent: JsonRpc[] } {
  const sent: JsonRpc[] = [];
  const transport: Transport = {
    async start() {},
    async send(message) {
      sent.push(message as JsonRpc);
    },
    async close() {
      transport.onclose?.();
    },
  };
  return { transport, sent };
}

async function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('makeChannelMcp', () => {
  test('declares the channel + permission-relay capabilities on initialize', async () => {
    const { transport, sent } = memTransport();
    const mcp = makeChannelMcp({ onPermissionRequest: () => {}, onClose: () => {} });
    await mcp.connect(transport);

    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '2.1.201' },
      },
    });

    const reply = await until(() => sent.find((m) => m.id === 1));
    const result = reply.result as {
      capabilities: { experimental?: Record<string, unknown> };
      instructions?: string;
    };
    expect(result.capabilities.experimental?.['claude/channel']).toEqual({});
    expect(result.capabilities.experimental?.['claude/channel/permission']).toEqual({});
    expect(result.instructions).toContain(`<channel source="${CHANNEL_SERVER_NAME}">`);
    await mcp.close();
  });

  test('notifyPrompt / notifyPermissionVerdict emit the channel notifications', async () => {
    const { transport, sent } = memTransport();
    const mcp = makeChannelMcp({ onPermissionRequest: () => {}, onClose: () => {} });
    await mcp.connect(transport);

    await mcp.notifyPrompt('hello from the browser');
    await mcp.notifyPermissionVerdict('abcde', true);
    await mcp.notifyPermissionVerdict('fghij', false);

    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content: 'hello from the browser' },
    });
    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel/permission',
      params: { request_id: 'abcde', behavior: 'allow' },
    });
    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel/permission',
      params: { request_id: 'fghij', behavior: 'deny' },
    });
    await mcp.close();
  });

  test('routes permission_request notifications and transport close', async () => {
    const { transport } = memTransport();
    const requests: unknown[] = [];
    let closed = false;
    const mcp = makeChannelMcp({
      onPermissionRequest: (req) => requests.push(req),
      onClose: () => {
        closed = true;
      },
    });
    await mcp.connect(transport);

    transport.onmessage?.({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id: 'kmnop',
        tool_name: 'Bash',
        description: 'run ls',
        input_preview: '{"command":"ls"}',
      },
    });
    const req = await until(() => requests[0]);
    expect(req).toEqual({
      requestId: 'kmnop',
      tool: 'Bash',
      description: 'run ls',
      inputPreview: '{"command":"ls"}',
    });

    await transport.close?.();
    expect(closed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  2. Late transcript discovery                                       */
/* ------------------------------------------------------------------ */

describe('scanForNewTranscript', () => {
  test('ignores transcripts older than sinceMs, adopts newer ones', async () => {
    const claudeHome = join(base, 'discover-home');
    const cwd = join(base, 'discover-proj');
    const projDir = join(claudeHome, 'projects', mungeCwd(cwd));
    await mkdir(projDir, { recursive: true });

    const now = Date.now();
    const old = join(projDir, 'old-session.jsonl');
    await writeFile(old, '{}\n');
    await utimes(old, new Date(now - 60_000), new Date(now - 60_000));

    expect(await scanForNewTranscript(cwd, now, claudeHome)).toBeNull();

    const fresh = join(projDir, 'fresh-session.jsonl');
    await writeFile(fresh, '{}\n');
    const found = await scanForNewTranscript(cwd, now - 1, claudeHome);
    expect(found?.sessionId).toBe('fresh-session');
    expect(found?.path).toBe(fresh);
  });

  test('returns null for a missing project dir', async () => {
    expect(await scanForNewTranscript(join(base, 'nope'), 0, join(base, 'no-home'))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  3. Flags / ids                                                     */
/* ------------------------------------------------------------------ */

describe('parseChannelFlags', () => {
  test('stable clientId per host+cwd, explicit flags win', () => {
    const a = stableChannelClientId('host-a', '/w/p');
    expect(a).toBe(stableChannelClientId('host-a', '/w/p'));
    expect(a).not.toBe(stableChannelClientId('host-b', '/w/p'));
    expect(a).toMatch(/^ch-[0-9a-f]{12}$/);

    const flags = parseChannelFlags([
      '--server',
      'ws://127.0.0.1:7499',
      '--label',
      'lbl',
      '--cwd',
      '/tmp',
      '--client-id',
      'ch-custom',
    ]);
    expect(flags.server).toBe('ws://127.0.0.1:7499/agent');
    expect(flags.label).toBe('lbl');
    expect(flags.clientId).toBe('ch-custom');
  });
});

/* ------------------------------------------------------------------ */
/*  4. Composed runner against a real relay                            */
/* ------------------------------------------------------------------ */

interface Inbox {
  ws: WebSocket;
  msgs: Array<Record<string, unknown>>;
  waitFor: (
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
}

function open(url: string): Promise<Inbox> {
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
        waitFor: (pred, ms = 4000) =>
          new Promise((res, rej) => {
            const hit = msgs.find(pred);
            if (hit) {
              res(hit);
              return;
            }
            const timer = setTimeout(() => rej(new Error('waitFor: timed out')), ms);
            waiters.push({ pred, res, timer });
          }),
      }),
    );
  });
}

function fakeMcp(): ChannelMcp & { prompts: string[]; verdicts: Array<[string, boolean]> } {
  const prompts: string[] = [];
  const verdicts: Array<[string, boolean]> = [];
  return {
    prompts,
    verdicts,
    async notifyPrompt(text) {
      prompts.push(text);
    },
    async notifyPermissionVerdict(requestId, approved) {
      verdicts.push([requestId, approved]);
    },
    async connect() {},
    async close() {},
  };
}

describe('runChannel', () => {
  test('viewer send → prompt notification; permission relay round trip; transcript adoption', async () => {
    const cwd = join(base, 'runner-proj');
    const claudeHome = join(base, 'runner-home');
    const attachBase = join(base, 'runner-attach');
    await mkdir(cwd, { recursive: true });

    const mcp = fakeMcp();
    let mcpWiring: ChannelMcpOptions = undefined as never;
    const flags: ChannelCliFlags = {
      server: AGENT,
      label: 'channel-test',
      cwd,
      clientId: 'ch-test-1',
    };
    const handle = await runChannel(flags, {
      log: () => {},
      mcpFactory: (wiring) => {
        mcpWiring = wiring;
        return mcp;
      },
      attachBaseDir: attachBase,
      claudeHome,
      discoverPollMs: 50,
    });

    try {
      const browser = await open(WS);
      await browser.waitFor(
        (m) =>
          m.type === 'client_list' &&
          Array.isArray(m.clients) &&
          m.clients.some((c) => (c as { clientId?: string }).clientId === 'ch-test-1'),
      );
      browser.ws.send(JSON.stringify({ type: 'attach', clientId: 'ch-test-1' }));

      // Viewer prompt → MCP channel notification (no queue involved).
      browser.ws.send(JSON.stringify({ type: 'send', clientId: 'ch-test-1', text: 'do a thing' }));
      await browser.waitFor((m) => m.type === 'user' && m.text === 'do a thing');
      await until(() => (mcp.prompts.includes('do a thing') ? true : undefined));

      // Permission relay: dialog → viewers, verdict → MCP notification.
      mcpWiring.onPermissionRequest({
        requestId: 'pqrst',
        tool: 'Bash',
        description: 'run tests',
        inputPreview: '{"command":"bun test"}',
      });
      const permFrame = await browser.waitFor((m) => m.type === 'permission_request');
      expect(permFrame.requestId).toBe('pqrst');
      expect(permFrame.tool).toBe('Bash');
      browser.ws.send(
        JSON.stringify({
          type: 'permission_response',
          clientId: 'ch-test-1',
          requestId: 'pqrst',
          approved: true,
        }),
      );
      await until(() => (mcp.verdicts.length > 0 ? true : undefined));
      expect(mcp.verdicts[0]).toEqual(['pqrst', true]);

      // The session (spawned after us, by definition) starts writing its
      // transcript → the channel adopts it and streams it to viewers.
      const projDir = join(claudeHome, 'projects', mungeCwd(cwd));
      await mkdir(projDir, { recursive: true });
      const transcript = join(projDir, 'sess-42.jsonl');
      const entries = [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'typed in the terminal' },
          timestamp: new Date().toISOString(),
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello from claude' }] },
          timestamp: new Date().toISOString(),
        }),
      ];
      await writeFile(transcript, `${entries.join('\n')}\n`);

      await browser.waitFor((m) => m.type === 'text' && m.text === 'hello from claude');
      const dir = attachDirFor('sess-42', attachBase);
      expect(await channelMarkerExists(dir)).toBe(true);

      // A `<channel>` prompt landing in the transcript is filtered by
      // translate.ts (it starts with '<'), so it never emits a frame.
      // The bridge must still treat it as delivery — otherwise the
      // delivery watchdog false-positives while the session sits on a
      // permission dialog. Append a fresh channel prompt with NO
      // assistant reply after it and assert no `error` frame follows.
      const channelEntry = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<channel source="orc">please wait here</channel>' },
        timestamp: new Date().toISOString(),
      });
      await writeFile(transcript, `${entries.join('\n')}\n${channelEntry}\n`);
      // browser-turn.marker is the observable proof the bridge saw the
      // `<channel>` entry (it's set on the same line that bumps the
      // delivery-watch clock).
      const deadline = Date.now() + 2000;
      let sawMarker = false;
      while (Date.now() < deadline) {
        if (await browserTurnMarkerExists(dir)) {
          sawMarker = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(sawMarker).toBe(true);

      browser.ws.close();
    } finally {
      await handle.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  5. Stop hook: channel-mode short-circuit                           */
/* ------------------------------------------------------------------ */

describe('runStopHook in channel mode', () => {
  test('touches the stop marker and exits without lingering or draining', async () => {
    const sessionId = crypto.randomUUID();
    const dir = attachDirFor(sessionId, base);
    await createAttachDir(dir);
    await writeBridgeInfo(dir, { clientId: 'ch-x', server: 'ws://t/agent', startedAt: Date.now() });
    await touchChannelMarker(dir);
    // Viewers attached and a (stale, foreign) queue entry present —
    // neither must hold the hook open in channel mode.
    await writeAttachedCount(dir, 2);
    await appendQueue(dir, 'left over from an earlier /orc run');

    const started = Date.now();
    const result = await runStopHook(
      { session_id: sessionId },
      { baseDir: base, lingerMs: 5_000, activeLingerMs: 5_000 },
    );
    expect(result.output).toBeUndefined(); // allow stop, no block
    expect(Date.now() - started).toBeLessThan(1_000); // no linger
    expect(await queueNonEmpty(dir)).toBe(true); // queue untouched
  });
});

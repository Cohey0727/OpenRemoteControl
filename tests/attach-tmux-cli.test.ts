/**
 * `open-rc attach-tmux` CLI test.
 *
 * Unit: flag parsing + screen normalization.
 * Integration: spins up the real `serve`, spawns `attach-tmux` pointed
 * at a MOCK `tmux` binary, opens a browser-shaped WebSocket, and
 * verifies the two directions of the tmux bridge:
 *
 *   1. attach-tmux registers → browser gets `client_registered`.
 *   2. `capture-pane` output is relayed to the browser as `screen`
 *      frames.
 *   3. a browser `send` → server `prompt` → attach-tmux runs
 *      `tmux send-keys -l -- <text>` + `Enter` on the target pane, and
 *      the next capture reflects it (round-trip through the mock).
 *
 * Spawn discipline: the mock is `tmux`, never `claude`; `serve` spawns
 * nothing. attach-tmux never kills the pane.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { normalizeScreen, parseTmuxFlags } from '../src/cli/attach-tmux.ts';
import { serve } from '../src/serve.ts';

const PORT = 7422;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const UI_DIR = `${import.meta.dir}/../ui`;
const REPO_ROOT = `${import.meta.dir}/..`;
const MOCK_BIN_DIR = join(REPO_ROOT, 'tests', '.tmp-tmux-bin');
const MOCK_TMUX = join(MOCK_BIN_DIR, 'tmux');
const STATE_FILE = join(MOCK_BIN_DIR, 'state.txt');
const ARGV_LOG = join(MOCK_BIN_DIR, 'argv.log');

let serverHandle: { stop: () => Promise<void> } | undefined;

function restoreOrcBaseUrl(prev: string | undefined): void {
  if (prev === undefined) {
    // biome-ignore lint/performance/noDelete: unsetting an env var requires delete
    delete process.env.ORC_BASE_URL;
  } else {
    process.env.ORC_BASE_URL = prev;
  }
}

beforeAll(async () => {
  // Mock tmux: capture-pane returns a header + whatever send-keys has
  // appended to STATE_FILE; send-keys -l appends the literal text; every
  // invocation logs its argv so the test can assert send-keys shape.
  await Bun.write(
    MOCK_TMUX,
    `#!/usr/bin/env node
import('node:fs').then((fs) => {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const state = process.env.MOCK_TMUX_STATE;
  const log = process.env.MOCK_TMUX_ARGV;
  if (log) { try { fs.appendFileSync(log, JSON.stringify(args) + '\\n'); } catch {} }
  const read = () => { try { return fs.readFileSync(state, 'utf8'); } catch { return ''; } };
  if (cmd === 'capture-pane') {
    process.stdout.write('claude TUI\\n' + read() + '❯ \\n');
    process.exit(0);
  }
  if (cmd === 'send-keys') {
    const li = args.indexOf('-l');
    if (li >= 0) {
      const text = args[args.length - 1];
      try { fs.appendFileSync(state, 'you: ' + text + '\\n'); } catch {}
    }
    process.exit(0);
  }
  if (cmd === 'display') { process.stdout.write('/mock/cwd\\n'); process.exit(0); }
  if (cmd === 'list-panes') { process.stdout.write('%0\\tclaude\\n'); process.exit(0); }
  process.exit(0);
});
`,
  );
  await Bun.$`chmod +x ${MOCK_TMUX}`.quiet();

  serverHandle = await serve({ host: '127.0.0.1', port: PORT, uiDir: UI_DIR, pushDisabled: true });
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  await new Promise((r) => setTimeout(r, 100));
  await Bun.$`rm -rf ${MOCK_BIN_DIR}`.quiet();
});

/* ----------------------------- ws helper ----------------------------- */

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
        waitFor: (pred, ms = 5000) =>
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

/* ----------------------------- unit tests ----------------------------- */

describe('parseTmuxFlags', () => {
  test('derives /agent from ORC_BASE_URL and defaults interval', () => {
    const prev = process.env.ORC_BASE_URL;
    process.env.ORC_BASE_URL = 'http://box:7322';
    try {
      const f = parseTmuxFlags([]);
      expect(f.server).toBe('ws://box:7322/agent');
      expect(f.intervalMs).toBe(500);
      expect(f.target).toBeUndefined();
    } finally {
      restoreOrcBaseUrl(prev);
    }
  });

  test('--target / --interval / --client-id honored; interval floored at 100', () => {
    const f = parseTmuxFlags([
      '--server',
      'ws://x:9/agent',
      '--target',
      'sess:1.0',
      '--interval',
      '10',
      '--client-id',
      'c',
    ]);
    expect(f.server).toBe('ws://x:9/agent');
    expect(f.target).toBe('sess:1.0');
    expect(f.intervalMs).toBe(500); // 10 < 100 floor → default
    expect(f.clientId).toBe('c');
  });
});

describe('normalizeScreen', () => {
  test('strips trailing per-line whitespace and trailing blank lines', () => {
    expect(normalizeScreen('a   \nb\t\n\n\n')).toBe('a\nb');
    expect(normalizeScreen('one\ntwo')).toBe('one\ntwo');
  });
});

/* ----------------------------- integration ----------------------------- */

async function startAttachTmux(clientId: string): Promise<{ stop: () => Promise<void> }> {
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      `${REPO_ROOT}/src/cli.ts`,
      'attach-tmux',
      '--server',
      `ws://127.0.0.1:${PORT}/agent`,
      '--label',
      'tmux-test',
      '--target',
      '%0',
      '--client-id',
      clientId,
      '--interval',
      '100',
    ],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        ORC_TMUX_BIN: MOCK_TMUX,
        MOCK_TMUX_STATE: STATE_FILE,
        MOCK_TMUX_ARGV: ARGV_LOG,
        ORC_REGISTER_TIMEOUT_MS: '15000',
      },
    },
  );
  void (async () => {
    const stream = proc.stderr as unknown as ReadableStream<Uint8Array>;
    for await (const chunk of new Response(stream as unknown as BodyInit)
      .body as unknown as AsyncIterable<Uint8Array>) {
      void chunk;
    }
  })();

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    const j = (await res.json()) as { clients: number };
    if (j.clients > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    stop: async () => {
      proc.kill('SIGTERM');
      await proc.exited.catch(() => {});
    },
  };
}

describe('attach-tmux bridge', () => {
  test('relays capture-pane as screen frames and delivers prompts via send-keys', async () => {
    await Bun.write(STATE_FILE, '');
    await Bun.write(ARGV_LOG, '');
    const browser = await open(WS_URL);
    const attach = await startAttachTmux('tmux-1');
    try {
      const reg = await browser.waitFor((m) => m.type === 'client_registered');
      expect((reg.client as { clientId: string }).clientId).toBe('tmux-1');

      browser.ws.send(JSON.stringify({ type: 'attach', clientId: 'tmux-1' }));

      // Output direction: the mock's capture-pane header reaches us.
      const screen = await browser.waitFor(
        (m) => m.type === 'screen' && String(m.text).includes('claude TUI'),
        8000,
      );
      expect(screen.clientId).toBe('tmux-1');

      // Input direction: a browser prompt lands as send-keys on the pane,
      // and the next capture reflects it.
      browser.ws.send(JSON.stringify({ type: 'send', clientId: 'tmux-1', text: 'ping-xyz' }));
      const echoed = await browser.waitFor(
        (m) => m.type === 'screen' && String(m.text).includes('you: ping-xyz'),
        8000,
      );
      expect(echoed.clientId).toBe('tmux-1');

      // The `screen` reflecting the text can arrive between the
      // literal send-keys and the Enter send-keys (the poll timer
      // races the prompt handler's two sequential tmux calls). Give
      // the Enter call a beat to land before asserting the argv log.
      await new Promise((r) => setTimeout(r, 400));

      // The send-keys invocation used -l (literal) with the exact text.
      const log = await Bun.file(ARGV_LOG).text();
      const sendKeysLines = log
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
        .filter((a) => a[0] === 'send-keys');
      const literal = sendKeysLines.find((a) => a.includes('-l'));
      expect(literal).toBeDefined();
      expect(literal?.[literal.length - 1]).toBe('ping-xyz');
      expect(sendKeysLines.some((a) => a.includes('Enter'))).toBe(true);
    } finally {
      browser.ws.close();
      await attach.stop();
    }
  }, 25000);
});

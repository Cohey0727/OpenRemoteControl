/**
 * `open-rc attach-orc` CLI integration test.
 *
 * Spins up the real `serve` instance, spawns `runAttach()` in a child
 * process pointing at a mock `claude` binary, opens a browser-shaped
 * WebSocket, and verifies:
 *
 *   1. attach-orc registers itself → browser receives `client_registered`.
 *   2. browser `send` → server forwards to attach-orc → mock claude
 *      receives a user message on stdin.
 *   3. mock claude's stream-json stdout (assistant text + result)
 *      is translated by attach-orc and forwarded back to the browser
 *      as `text` and `done` frames.
 *
 * Spawn discipline: this test does NOT make `serve` spawn anything.
 * Only the `runAttach` child process (which is the CLI under test)
 * calls `Bun.spawn`. The server's process tree is clean.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CLAUDE_STREAM_ARGS, parseAttachFlags, translate } from '../src/cli/attach-orc.ts';
import { serve } from '../src/serve.ts';

const PORT = 7411;
const AGENT_URL = `ws://127.0.0.1:${PORT}/agent`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const UI_DIR = `${import.meta.dir}/../ui`;

const REPO_ROOT = `${import.meta.dir}/..`;
const MOCK_BIN_DIR = join(REPO_ROOT, 'tests', '.tmp-mock-bin');
const MOCK_CLAUDE = join(MOCK_BIN_DIR, 'claude');

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
  // Mock claude: reads NDJSON user messages on stdin, replies with
  // a stream-json assistant text + result for each. Records the argv it
  // was spawned with so the test can assert the exact claude arg list.
  // NB: the repo package.json is "type":"module", so node parses this
  // extensionless file as ESM — dynamic import works in either mode,
  // `require` does not.
  await Bun.write(
    join(MOCK_BIN_DIR, 'claude'),
    `#!/usr/bin/env node
if (process.env.MOCK_ARGV_FILE) {
  import('node:fs').then((fs) => {
    fs.writeFileSync(process.env.MOCK_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
  }).catch(() => {});
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
      const text = evt.message.content
        .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
        .join('');
      process.stdout.write(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        type: 'result',
        cost_usd: 0.0002,
        duration_ms: 50,
      }) + '\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`,
  );
  await Bun.$`chmod +x ${MOCK_CLAUDE}`.quiet();

  serverHandle = await serve({
    host: '127.0.0.1',
    port: PORT,
    uiDir: UI_DIR,
    pushDisabled: true,
  });
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  if (serverHandle) await serverHandle.stop();
  await new Promise((r) => setTimeout(r, 100));
  await Bun.$`rm -rf ${MOCK_BIN_DIR}`.quiet();
});

/* ----------------------------- ws helpers ----------------------------- */

interface Inbox {
  ws: WebSocket;
  inbox: Record<string, unknown>[];
  waitFor(
    pred: (f: { type: string }) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  collectUntil(
    pred: (f: { type: string }) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>[]>;
  close(): void;
}

function openFramed(url: string): Promise<Inbox> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox: Record<string, unknown>[] = [];
    const collectFlag = Symbol('collect');
    type SingleWaiter = {
      pred: (f: { type: string }) => boolean;
      resolve: (f: Record<string, unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
    };
    type CollectWaiter = {
      pred: (f: { type: string }) => boolean;
      resolve: (f: Record<string, unknown>[]) => void;
      timer: ReturnType<typeof setTimeout>;
      [collectFlag]: true;
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
          // Discriminate by the presence of a `collect` flag we set on
          // CollectWaiter at queue time (see below).
          if (collectFlag in w) (w as CollectWaiter).resolve([...inbox]);
          else (w as SingleWaiter).resolve(hit);
        }
      }
    }

    ws.addEventListener('message', (ev) => {
      try {
        inbox.push(JSON.parse(ev.data as string) as Record<string, unknown>);
        pump();
      } catch {
        // ignore
      }
    });

    ws.addEventListener('open', () => {
      resolve({
        ws,
        inbox,
        waitFor: (pred, timeoutMs = 4000) =>
          new Promise<Record<string, unknown>>((res, rej) => {
            const hit = inbox.find(
              (m) => typeof m.type === 'string' && pred(m as { type: string }),
            );
            if (hit) return res(hit);
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((x) => x.timer === timer);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error(`waitFor timeout (last inbox: ${JSON.stringify(inbox.slice(-3))})`));
            }, timeoutMs);
            waiters.push({ pred, resolve: res, timer });
          }),
        collectUntil: (pred, timeoutMs = 4000) =>
          new Promise<Record<string, unknown>[]>((res, rej) => {
            const hit = inbox.find(
              (m) => typeof m.type === 'string' && pred(m as { type: string }),
            );
            if (hit) return res([...inbox]);
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((x) => x.timer === timer);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(
                new Error(`collectUntil timeout (last inbox: ${JSON.stringify(inbox.slice(-3))})`),
              );
            }, timeoutMs);
            waiters.push({ pred, resolve: res, timer, [collectFlag]: true });
          }),
        close: () => ws.close(),
      });
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
}

interface AttachProc {
  proc: ReturnType<typeof Bun.spawn>;
  stop: () => Promise<void>;
}

async function startAttach(clientId: string): Promise<AttachProc> {
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      `${REPO_ROOT}/src/cli.ts`,
      'attach-orc',
      '--server',
      AGENT_URL,
      '--label',
      'attach-test',
      '--cwd',
      '/tmp',
      '--client-id',
      clientId,
    ],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        ORC_CLAUDE_BIN: MOCK_CLAUDE,
        MOCK_ARGV_FILE: join(MOCK_BIN_DIR, 'argv.json'),
      },
    },
  );
  // Drain stderr so the test process doesn't accumulate output.
  void (async () => {
    const stream = proc.stderr as unknown as ReadableStream<Uint8Array>;
    const r = new Response(stream as unknown as BodyInit);
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      void chunk;
    }
  })();

  // Wait for the attach-orc CLI to register with the server by polling
  // /health until the client count goes above zero. Generous deadline:
  // a cold `bun run` (transpile cache invalidated by a source edit)
  // can take several seconds to boot the CLI.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    const j = (await res.json()) as { clients: number };
    if (j.clients > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    proc,
    stop: async () => {
      proc.kill('SIGTERM');
      await proc.exited.catch(() => {});
    },
  };
}

/* ----------------------------- tests ----------------------------- */

describe('parseAttachFlags', () => {
  test('derives the /agent URL from ORC_BASE_URL (http → ws)', () => {
    const prev = process.env.ORC_BASE_URL;
    process.env.ORC_BASE_URL = 'http://serve.example:7322';
    try {
      expect(parseAttachFlags([]).server).toBe('ws://serve.example:7322/agent');
    } finally {
      restoreOrcBaseUrl(prev);
    }
  });

  test('https base → wss and keeps an explicit /agent path', () => {
    const prev = process.env.ORC_BASE_URL;
    process.env.ORC_BASE_URL = 'https://vpn.example/agent';
    try {
      expect(parseAttachFlags([]).server).toBe('wss://vpn.example/agent');
    } finally {
      restoreOrcBaseUrl(prev);
    }
  });

  test('--server wins over ORC_BASE_URL', () => {
    const prev = process.env.ORC_BASE_URL;
    process.env.ORC_BASE_URL = 'http://ignored:1234';
    try {
      const flags = parseAttachFlags(['--server', 'ws://explicit:9/agent', '--client-id', 'x']);
      expect(flags.server).toBe('ws://explicit:9/agent');
      expect(flags.clientId).toBe('x');
    } finally {
      restoreOrcBaseUrl(prev);
    }
  });
});

describe('translate', () => {
  test('drops empty text/thinking blocks (real claude emits signature-only thinking)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '' },
          { type: 'text', text: 'pong' },
        ],
      },
    });
    expect(translate('c1', line)).toEqual([{ type: 'text', clientId: 'c1', text: 'pong' }]);
  });

  test('maps stream_event text deltas → text_delta; other stream events → none', () => {
    const delta = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'al' } },
    });
    expect(translate('c1', delta)).toEqual([{ type: 'text_delta', clientId: 'c1', text: 'al' }]);
    const start = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    });
    expect(translate('c1', start)).toEqual([]);
    const think = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } },
    });
    expect(translate('c1', think)).toEqual([]);
  });

  test('maps result → done and unknown event types → no frames', () => {
    expect(
      translate('c1', JSON.stringify({ type: 'result', total_cost_usd: 0.01, duration_ms: 12 })),
    ).toEqual([{ type: 'done', clientId: 'c1', cost: 0.01, duration_ms: 12 }]);
    expect(translate('c1', JSON.stringify({ type: 'rate_limit_event', info: {} }))).toEqual([]);
    expect(translate('c1', 'not json')).toBeNull();
  });
});

describe('claude spawn args', () => {
  test('uses --print stream-json mode, never --bare (which skips OAuth/keychain auth)', () => {
    // --bare restricts Anthropic auth to ANTHROPIC_API_KEY/apiKeyHelper,
    // so a bridged session on an OAuth-login machine would answer every
    // prompt with "Not logged in". --print resolves auth exactly like
    // the user's own `claude -p`.
    expect(CLAUDE_STREAM_ARGS).toContain('--print');
    expect(CLAUDE_STREAM_ARGS).not.toContain('--bare');
    expect(CLAUDE_STREAM_ARGS).toContain('--verbose');
    // Streaming partial render: claude emits stream_event deltas only
    // with this flag.
    expect(CLAUDE_STREAM_ARGS).toContain('--include-partial-messages');
  });
});

describe('attach-orc fail-fast', () => {
  test('exits nonzero when the first registration never completes (serve down)', async () => {
    // Nothing listens on this port. The CLI must give up after the
    // register timeout instead of retrying forever — the /attach-orc
    // slash command relies on a quick nonzero exit to tell the user
    // that `open-rc serve` isn't running.
    const proc = Bun.spawn(
      [
        'bun',
        'run',
        `${REPO_ROOT}/src/cli.ts`,
        'attach-orc',
        '--server',
        'ws://127.0.0.1:7409/agent',
        '--label',
        'no-serve',
        '--cwd',
        '/tmp',
      ],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          ORC_CLAUDE_BIN: MOCK_CLAUDE,
          ORC_REGISTER_TIMEOUT_MS: '1200',
        },
      },
    );
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr as unknown as BodyInit).text();
    expect(code).not.toBe(0);
    expect(stderr).toContain('could not register');
  }, 20000);
});

describe('attach-orc CLI', () => {
  test('registers with server and round-trips a prompt through mock claude', async () => {
    const browser = await openFramed(WS_URL);
    const attach = await startAttach('attach-test-1');

    try {
      const registered = await browser.waitFor((m) => m.type === 'client_registered');
      const client = registered.client as { clientId: string; label: string };
      expect(client.label).toBe('attach-test');
      expect(client.clientId).toBe('attach-test-1');

      browser.ws.send(JSON.stringify({ type: 'attach', clientId: 'attach-test-1' }));
      await new Promise((r) => setTimeout(r, 100));

      browser.ws.send(
        JSON.stringify({
          type: 'send',
          clientId: 'attach-test-1',
          text: 'hello via attach',
        }),
      );

      const collected = await browser.collectUntil((m) => m.type === 'done', 15000);
      const types = collected.map((f) => f.type as string);
      expect(types).toContain('text');
      expect(types).toContain('done');

      const textFrame = collected.find((f) => f.type === 'text');
      expect(textFrame?.text).toBe('echo: hello via attach');
      expect(textFrame?.clientId).toBe('attach-test-1');

      const doneFrame = collected.find((f) => f.type === 'done');
      expect(doneFrame?.cost).toBeCloseTo(0.0002, 4);
      expect(doneFrame?.duration_ms).toBe(50);

      // The spawned claude got exactly the public print/stream-json args.
      const argv = JSON.parse(await Bun.file(join(MOCK_BIN_DIR, 'argv.json')).text()) as string[];
      expect(argv).toEqual([...CLAUDE_STREAM_ARGS]);
    } finally {
      browser.close();
      await attach.stop();
    }
  }, 20000);
});

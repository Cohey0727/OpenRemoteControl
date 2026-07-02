/**
 * `open-rc attach-orc` — local bridge between a `claude` subprocess
 * and the open-rc server's `/agent` WebSocket.
 *
 * `orc` = "open remote control".
 *
 * This is the **only** place in the project that spawns `claude`. The
 * server (`open-rc serve`) never spawns anything; it merely relays
 * frames between the bridge and the browser. `attach-orc` is a
 * separate CLI process the user runs in their terminal — it owns
 * the `claude` subprocess, pipes its stdio, and translates
 * stream-json NDJSON frames into the BridgeFrame shapes the server
 * expects on `/agent`.
 *
 * Lifecycle:
 *   1. Parse flags: --server, --label, --cwd, --client-id.
 *   2. Open WS to <server>/agent (default derived from ORC_BASE_URL).
 *   3. Send `register` frame → wait for `{ type: "registered" }`.
 *   4. Spawn `claude --print --input-format stream-json
 *      --output-format stream-json` with stdio piped.
 *   5. Pump:
 *        claude stdout  →  stream-json parser  →  WS BridgeFrame
 *        WS `prompt`    →  claude stdin        (as JSON line)
 *        WS `permission_response` → claude stdin (as JSON line)
 *   6. On SIGINT/SIGTERM: forward SIGTERM to claude, close WS, exit.
 *
 * Reconnect: if the server WS drops after a successful registration,
 * reconnect with 1-3 s backoff and re-register, forever. If the FIRST
 * registration doesn't complete within 10 s (serve not running, wrong
 * URL, clientId collision), exit(1) with a clear message instead of
 * retrying silently. If `claude` exits on its own, close WS and exit.
 *
 * There are no `--model` / `--claude` knobs: attach-orc bridges the
 * session itself, exactly as `claude` launches it. Point it at a
 * remote `open-rc serve` (VPN / ECS / anywhere) by exporting
 * `ORC_BASE_URL=https://serve.example:7322` — the /agent WebSocket URL
 * is derived from it. `ORC_CLAUDE_BIN` overrides the `claude` binary
 * path (used by the test suite; not a user-facing flag).
 *
 * Deliberately NOT `--bare`: bare mode restricts Anthropic auth to
 * ANTHROPIC_API_KEY/apiKeyHelper (OAuth and keychain are never read),
 * so on a subscription-login machine every prompt would come back
 * "Not logged in". `--print` resolves auth — and hooks, settings,
 * CLAUDE.md — exactly like the user's own `claude -p`, which is the
 * point: the bridged session IS their claude.
 */

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { Register, ServerToBridge } from '../session/ws-protocol.ts';
import { ServerToBridge as ServerToBridgeSchema } from '../session/ws-protocol.ts';
import { parseFlags } from './flags.ts';

/* -------------------------------------------------------------------------- */
/*  CLI flags                                                                  */
/* -------------------------------------------------------------------------- */

export interface AttachFlags {
  /** WebSocket URL of the open-rc server's /agent endpoint. */
  server: string;
  /** Human-readable label shown in the sidebar. */
  label: string;
  /** Working directory reported to the server (not enforced on claude). */
  cwd: string;
  /** Optional explicit clientId. Random UUID otherwise. */
  clientId?: string;
}

/**
 * Normalize a server URL (from `--server` or `ORC_BASE_URL`) into a
 * concrete `/agent` WebSocket URL. Accepts `https://serve:7322`,
 * `ws://host:7322`, or bare `host:7322`; maps http→ws, https→wss, and
 * appends `/agent` if no path is present. Applying this to `--server`
 * too means a bare host works there exactly as it does in ORC_BASE_URL
 * (rather than throwing inside `new WebSocket`).
 */
export function agentUrlFromBase(base: string): string {
  let u = base
    .trim()
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
  if (!/^wss?:\/\//i.test(u)) u = `ws://${u}`;
  u = u.replace(/\/+$/, '');
  return /\/agent$/.test(u) ? u : `${u}/agent`;
}

export function parseAttachFlags(argv: string[]): AttachFlags {
  const flags = parseFlags(argv);

  const explicit = typeof flags.server === 'string' ? flags.server : undefined;
  const base = process.env.ORC_BASE_URL ?? process.env.ORC__BASE_URL;
  const server = agentUrlFromBase(explicit ?? base ?? 'ws://127.0.0.1:7322');
  const label =
    typeof flags.label === 'string' ? flags.label : `${process.env.USER ?? 'user'}@${hostname()}`;
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
  const clientId = typeof flags.clientId === 'string' ? flags.clientId : undefined;

  return {
    server,
    label,
    cwd,
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  claude stream-json → BridgeFrame                                           */
/* -------------------------------------------------------------------------- */

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
}

function contentToFrames(clientId: string, blocks: ContentBlock[]): unknown[] {
  const out: unknown[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        // Skip empty blocks: real claude emits signature-only thinking
        // blocks and occasionally empty text; relaying them would render
        // blank bubbles in every attached view.
        if (typeof b.text === 'string' && b.text.length > 0) {
          out.push({ type: 'text', clientId, text: b.text });
        }
        break;
      case 'thinking':
        if (typeof b.thinking === 'string' && b.thinking.length > 0) {
          out.push({ type: 'thinking', clientId, text: b.thinking });
        }
        break;
      case 'tool_use':
        if (typeof b.name === 'string') {
          out.push({
            type: 'tool_use',
            clientId,
            tool: b.name,
            input: JSON.stringify(b.input ?? {}),
          });
        }
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          clientId,
          output: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        });
        break;
      default:
        // unknown block — skip
        break;
    }
  }
  return out;
}

/**
 * Translate one stream-json event from `claude` into 0+ frames to
 * forward on /agent. Returns null when the line is not a recognized
 * event (or is metadata we don't surface). Exported for tests.
 */
export function translate(clientId: string, line: string): unknown[] | null {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  const t = evt.type;

  switch (t) {
    case 'assistant': {
      const msg = evt.message as { content?: ContentBlock[] } | undefined;
      if (!msg || !Array.isArray(msg.content)) return [];
      return contentToFrames(clientId, msg.content);
    }
    case 'user': {
      const msg = evt.message as { content?: ContentBlock[] } | undefined;
      if (!msg || !Array.isArray(msg.content)) return [];
      // user events often contain tool_result blocks; surface those.
      return contentToFrames(clientId, msg.content);
    }
    case 'stream_event': {
      // --include-partial-messages: raw API stream events. Surface text
      // token deltas as text_delta frames; everything else (block
      // start/stop, thinking deltas, message bookkeeping) is covered by
      // the assembled events we already relay.
      const ev = evt.event as
        | { type?: unknown; delta?: { type?: unknown; text?: unknown } }
        | undefined;
      if (
        ev &&
        ev.type === 'content_block_delta' &&
        ev.delta &&
        ev.delta.type === 'text_delta' &&
        typeof ev.delta.text === 'string' &&
        ev.delta.text.length > 0
      ) {
        return [{ type: 'text_delta', clientId, text: ev.delta.text }];
      }
      return [];
    }
    case 'permission_request': {
      const id = typeof evt.id === 'string' ? evt.id : cryptoRandom();
      const tool = typeof evt.tool === 'string' ? evt.tool : 'unknown';
      const input =
        evt.input && typeof evt.input === 'object' ? (evt.input as Record<string, unknown>) : {};
      return [
        {
          type: 'permission_request',
          clientId,
          requestId: id,
          tool,
          input,
        },
      ];
    }
    case 'result': {
      // Newer Claude Code emits `total_cost_usd`; older builds used
      // `cost_usd`. Accept either so the browser's done summary shows a cost.
      const rawCost =
        typeof evt.total_cost_usd === 'number'
          ? evt.total_cost_usd
          : typeof evt.cost_usd === 'number'
            ? evt.cost_usd
            : undefined;
      const duration_ms = typeof evt.duration_ms === 'number' ? evt.duration_ms : undefined;
      const frame: Record<string, unknown> = { type: 'done', clientId };
      if (rawCost !== undefined) frame.cost = rawCost;
      if (duration_ms !== undefined) frame.duration_ms = duration_ms;
      return [frame];
    }
    default:
      // Any other well-formed event (system/init/stream_event/usage/…)
      // is simply not relayed. Returning [] (not null) keeps it out of
      // the "parse error" path, which is reserved for malformed JSON.
      return [];
  }
}

function cryptoRandom(): string {
  // crypto.randomUUID is available in Bun; keep this helper for parity.
  return globalThis.crypto.randomUUID();
}

/* -------------------------------------------------------------------------- */
/*  NDJSON line reader                                                         */
/* -------------------------------------------------------------------------- */

class LineReader {
  private buf = '';
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) this.onLine(line);
      idx = this.buf.indexOf('\n');
    }
  }

  flush(): void {
    if (this.buf.length > 0) {
      this.onLine(this.buf);
      this.buf = '';
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Run                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The exact argv attach-orc passes to `claude` — the public print/
 * stream-json transport. `--verbose` is mandatory ("stream-json
 * requires --verbose"). NOT `--bare`: bare skips OAuth/keychain, which
 * would leave subscription-login users with "Not logged in" replies.
 */
export const CLAUDE_STREAM_ARGS = [
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  // Emit stream_event token deltas so attached views can render the
  // assistant's reply as it is generated, not only when it completes.
  '--include-partial-messages',
] as const;

export async function runAttach(flags: AttachFlags): Promise<void> {
  // The server assigns the real clientId on register; this is a local
  // placeholder so we can tag frames we translate.
  let clientId = flags.clientId ?? cryptoRandom();

  // ----- spawn claude -----
  const claudeBin = process.env.ORC_CLAUDE_BIN ?? 'claude';
  const claudeProc = Bun.spawn([claudeBin, ...CLAUDE_STREAM_ARGS], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    cwd: resolve(flags.cwd),
    env: process.env,
  });

  // ----- connect WS with reconnect loop -----
  let ws: WebSocket | undefined;
  let stop = false;
  const reconnectDelays = [500, 1000, 2000, 3000];
  let reconnectAttempt = 0;

  // Fail fast if the FIRST registration never completes: a serve that
  // isn't running must surface as a quick nonzero exit (the /attach-orc
  // slash command tells users to interpret an early exit as "serve is
  // down"), not as a silent infinite retry loop with an idle claude.
  // Once registered at least once, reconnects retry forever so a serve
  // restart doesn't kill the bridge. ORC_REGISTER_TIMEOUT_MS is a
  // test-only override, like ORC_CLAUDE_BIN.
  let everRegistered = false;
  const registerTimeoutMs = Number(process.env.ORC_REGISTER_TIMEOUT_MS ?? 10_000);
  const registerDeadline = setTimeout(() => {
    if (everRegistered || stop) return;
    console.error(
      `[attach-orc] could not register with ${flags.server} within ${registerTimeoutMs}ms — is \`open-rc serve\` running?`,
    );
    stop = true;
    try {
      claudeProc.kill('SIGTERM');
    } catch {
      // ignore
    }
    try {
      ws?.close(1000, 'register timeout');
    } catch {
      // ignore
    }
    process.exit(1);
  }, registerTimeoutMs);

  function scheduleReconnect(): void {
    if (stop) return;
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)];
    reconnectAttempt++;
    setTimeout(() => {
      if (stop) return;
      void connectWs().catch((err) => {
        console.error('[attach-orc] reconnect failed:', err);
        scheduleReconnect();
      });
    }, delay);
  }

  async function connectWs(): Promise<void> {
    if (stop) return;
    const sock = new WebSocket(flags.server);
    ws = sock;

    sock.addEventListener('open', () => {
      reconnectAttempt = 0;
      const reg: Register = {
        type: 'register',
        label: flags.label,
        cwd: flags.cwd,
        ...(flags.clientId !== undefined ? { clientId: flags.clientId } : {}),
      };
      sock.send(JSON.stringify(reg));
    });

    sock.addEventListener('message', (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      // The server's `registered` ack frame is not part of ServerToBridge
      // (it isn't a browser-originated frame). Pull the assigned id out
      // of it if present, then fall through to normal dispatch.
      if (json && typeof json === 'object' && (json as { type?: unknown }).type === 'registered') {
        const id = (json as { clientId?: unknown }).clientId;
        if (typeof id === 'string') clientId = id;
        everRegistered = true;
        clearTimeout(registerDeadline);
        return;
      }
      // Surface server-side errors (e.g. "clientId already in use") so a
      // failed registration is diagnosable instead of a silent timeout.
      if (json && typeof json === 'object' && (json as { type?: unknown }).type === 'error') {
        const message = (json as { message?: unknown }).message;
        console.error('[attach-orc] server error:', typeof message === 'string' ? message : data);
        return;
      }
      let parsed: ServerToBridge;
      try {
        parsed = ServerToBridgeSchema.parse(json);
      } catch {
        // Unknown frame type — server may add new ones over time. Drop
        // silently rather than spamming stderr.
        return;
      }
      handleServerFrame(parsed);
    });

    sock.addEventListener('close', () => {
      ws = undefined;
      if (!stop) {
        console.error('[attach-orc] ws closed; reconnecting');
        scheduleReconnect();
      }
    });

    sock.addEventListener('error', (e) => {
      console.error('[attach-orc] ws error:', (e as ErrorEvent).message ?? e);
    });
  }

  function handleServerFrame(frame: ServerToBridge): void {
    switch (frame.type) {
      case 'prompt': {
        const wire = JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: frame.text }],
          },
        });
        writeToClaude(`${wire}\n`);
        break;
      }
      case 'permission_response': {
        const wire = JSON.stringify({
          type: 'permission_response',
          id: frame.requestId,
          approved: frame.approved,
        });
        writeToClaude(`${wire}\n`);
        break;
      }
    }
  }

  function writeToClaude(line: string): void {
    const writer = claudeProc.stdin as unknown as {
      write: (s: string) => number | Promise<number>;
      flush?: () => Promise<void> | void;
      end?: () => void;
    };
    try {
      const r = writer.write(line);
      if (r instanceof Promise) {
        r.catch((err) => console.error('[attach-orc] write to claude failed:', err));
      }
      void writer.flush?.();
    } catch (err) {
      console.error('[attach-orc] write to claude failed:', err);
    }
  }

  // ----- pump claude stdout → WS -----
  const reader = new LineReader((line) => {
    const frames = translate(clientId, line);
    if (!frames) {
      console.error('[attach-orc] parse error:', line.slice(0, 200));
      return;
    }
    for (const f of frames) {
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(JSON.stringify(f));
      } catch (err) {
        console.error('[attach-orc] ws send failed:', err);
      }
    }
  });

  // Bun's subprocess stdout is a ReadableStream<Uint8Array>-shaped
  // byte stream; pipeThrough + asyncIterator is the cleanest pump.
  // We cast aggressively because Bun's WebStream types collide with
  // lib.dom's BufferSource/Uint8Array variance.
  const stdout = claudeProc.stdout as unknown as {
    pipeThrough<T>(s: unknown): T;
  };
  const decoded = stdout.pipeThrough(new TextDecoderStream()) as unknown as {
    [Symbol.asyncIterator](): AsyncIterableIterator<string>;
  };
  const iter = decoded[Symbol.asyncIterator]();
  void (async () => {
    try {
      while (true) {
        const { value, done } = await iter.next();
        if (done) break;
        if (typeof value === 'string') reader.push(value);
      }
      reader.flush();
    } catch (err) {
      console.error('[attach-orc] stdout pump error:', err);
    }
  })();

  // ----- claude exit -----
  void claudeProc.exited.then((code) => {
    console.error(`[attach-orc] claude exited with code ${code}`);
    stop = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1000, 'claude exited');
      } catch {
        // ignore
      }
    }
  });

  // ----- signals -----
  const shutdown = (sig: NodeJS.Signals): void => {
    console.error(`[attach-orc] received ${sig}; forwarding SIGTERM to claude`);
    stop = true;
    try {
      claudeProc.kill('SIGTERM');
    } catch {
      // ignore
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1000, sig);
      } catch {
        // ignore
      }
    }
    // Hard exit if claude doesn't die in 5 s
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ----- boot -----
  // Guard the first connect: a malformed --server would otherwise throw
  // synchronously out of `new WebSocket` and reject runAttach, leaving
  // the claude child we just spawned orphaned.
  try {
    await connectWs();
  } catch (err) {
    console.error(`[attach-orc] invalid server URL '${flags.server}':`, err);
    stop = true;
    try {
      claudeProc.kill('SIGTERM');
    } catch {
      // ignore
    }
    process.exit(2);
  }

  // Wait for claude to exit (or the user to signal).
  const code = await claudeProc.exited;
  process.exit(typeof code === 'number' ? code : 1);
}

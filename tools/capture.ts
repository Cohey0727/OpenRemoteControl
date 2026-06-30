#!/usr/bin/env bun
/**
 * tools/capture.ts — Stub WebSocket server for capturing Claude Code's
 * RemoteControl bridge protocol.
 *
 * Listens on 127.0.0.1:8765 (the loopback default baked into the binary)
 * and logs every WS frame to captures/<timestamp>.jsonl, one frame per
 * line, with timestamps and directions.
 *
 * Usage:
 *   bun run tools/capture.ts                  # default 127.0.0.1:8765
 *   bun run tools/capture.ts --port 9000      # override port
 *   bun run tools/capture.ts --out fixtures/  # override output dir
 *
 * In another terminal:
 *   claude --remote-control
 *
 * The stub echoes control_request frames back as control_response so the
 * session can progress past the handshake. It does not implement any
 * meaningful protocol — its only job is to be observable.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OUT_DIR = 'captures';

interface Frame {
  /** ISO timestamp of when the frame was logged. */
  t: string;
  /** Connection ID (1-based). */
  conn: number;
  /** Direction: 'in' (client→server) or 'out' (server→client). */
  dir: 'in' | 'out';
  /** Frame kind: 'text' | 'binary' | 'control'. */
  kind: 'text' | 'binary' | 'control';
  /** Frame size in bytes (UTF-8 length for text, byte length for binary). */
  bytes: number;
  /**
   * Best-effort preview of the frame contents:
   *   - for text: the string parsed as JSON, or raw string if not JSON
   *   - for binary: hex of first 64 bytes
   *   - for control: the WS control opcode name
   */
  preview: unknown;
}

function parseArgs(argv: readonly string[]): { port: number; host: string; outDir: string } {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let outDir = DEFAULT_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) {
      port = Number.parseInt(argv[i + 1]!, 10);
      i++;
    } else if (a === '--host' && argv[i + 1]) {
      host = argv[i + 1]!;
      i++;
    } else if (a === '--out' && argv[i + 1]) {
      outDir = argv[i + 1]!;
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: bun run tools/capture.ts [--port N] [--host HOST] [--out DIR]');
      process.exit(0);
    }
  }
  return { port, host, outDir };
}

function previewOf(data: string | Uint8Array): unknown {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data.length > 256 ? `${data.slice(0, 256)}…` : data;
    }
  }
  const hex: string[] = [];
  const view = data;
  const limit = Math.min(view.length, 64);
  for (let i = 0; i < limit; i++) {
    hex.push(view[i]?.toString(16).padStart(2, '0'));
  }
  return view.length > 64 ? `${hex.join('')}… (${view.length}B total)` : hex.join('');
}

async function main(): Promise<void> {
  const { port, host, outDir } = parseArgs(process.argv.slice(2));
  await mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = Bun.file(join(outDir, `${stamp}.jsonl`));
  const writer = file.writer();
  await writer.write(
    `${JSON.stringify({ t: new Date().toISOString(), event: 'start', port, host })}\n`,
  );
  const log = async (frame: Frame): Promise<void> => {
    const line = `${JSON.stringify(frame)}\n`;
    process.stdout.write(line);
    await writer.write(line);
  };

  let connId = 0;
  const connections = new Set<number>();

  const server = Bun.serve({
    port,
    hostname: host,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return new Response('ok');
      }
      // Upgrade anything else to WS — we don't yet know the exact path
      // the CLI dials. Capture everything.
      if (srv.upgrade(req, { data: { connId: ++connId } })) {
        return undefined;
      }
      return new Response('open-rc capture stub\n', { status: 200 });
    },
    websocket: {
      open(ws) {
        const id = (ws.data as { connId: number }).connId;
        connections.add(id);
        void log({
          t: new Date().toISOString(),
          conn: id,
          dir: 'in',
          kind: 'control',
          bytes: 0,
          preview: 'open',
        });
      },
      message(ws, data) {
        const id = (ws.data as { connId: number }).connId;
        const kind = data instanceof Uint8Array ? 'binary' : 'text';
        const bytes = typeof data === 'string' ? data.length : data.byteLength;
        void log({
          t: new Date().toISOString(),
          conn: id,
          dir: 'in',
          kind,
          bytes,
          preview: previewOf(data),
        });

        // Minimal echo-back: if it looks like a control_request, reply
        // with a stub control_response so the session can proceed past
        // the handshake. We don't know the exact schema yet — this is
        // a placeholder. If the CLI bails on this response, the
        // capture still gives us the outbound direction.
        if (typeof data === 'string') {
          try {
            const obj = JSON.parse(data) as { type?: string; id?: string; subtype?: string };
            if (obj.type === 'control_request') {
              const response = {
                type: 'control_response',
                id: obj.id,
                subtype: obj.subtype,
                response: { ok: true, captured: true },
              };
              const payload = JSON.stringify(response);
              ws.send(payload);
              void log({
                t: new Date().toISOString(),
                conn: id,
                dir: 'out',
                kind: 'text',
                bytes: payload.length,
                preview: response,
              });
            }
          } catch {
            // not JSON — just record it
          }
        }
      },
      close(ws) {
        const id = (ws.data as { connId: number }).connId;
        connections.delete(id);
        void log({
          t: new Date().toISOString(),
          conn: id,
          dir: 'in',
          kind: 'control',
          bytes: 0,
          preview: 'close',
        });
      },
    },
  });

  console.log(`[capture] listening on ws://${host}:${server.port}`);
  console.log(`[capture] writing to ${file.name ?? join(outDir, `${stamp}.jsonl`)}`);

  const shutdown = async (): Promise<void> => {
    console.log('\n[capture] shutting down');
    await writer.write(
      `${JSON.stringify({ t: new Date().toISOString(), event: 'stop', connections: connections.size })}\n`,
    );
    await writer.flush();
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('[capture] fatal:', err);
  process.exit(1);
});

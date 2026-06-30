#!/usr/bin/env bun
/**
 * tools/capture-tls.ts — Same as capture.ts but with wss:// (TLS).
 * Required because the CLI may refuse plain ws:// and only accept wss://.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OUT_DIR = 'captures';
const DEFAULT_CERT = '.open-rc/cert.pem';
const DEFAULT_KEY = '.open-rc/key.pem';

interface Frame {
  t: string;
  conn: number;
  dir: 'in' | 'out';
  kind: 'text' | 'binary' | 'control';
  bytes: number;
  preview: unknown;
}

function parseArgs(argv: readonly string[]): {
  port: number;
  host: string;
  outDir: string;
  cert: string;
  key: string;
} {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let outDir = DEFAULT_OUT_DIR;
  let cert = DEFAULT_CERT;
  let key = DEFAULT_KEY;
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
    } else if (a === '--cert' && argv[i + 1]) {
      cert = argv[i + 1]!;
      i++;
    } else if (a === '--key' && argv[i + 1]) {
      key = argv[i + 1]!;
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: bun run tools/capture-tls.ts [--port N] [--host H] [--out DIR] [--cert FILE] [--key FILE]',
      );
      process.exit(0);
    }
  }
  return { port, host, outDir, cert, key };
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
  const limit = Math.min(data.length, 64);
  for (let i = 0; i < limit; i++) {
    hex.push(data[i]?.toString(16).padStart(2, '0'));
  }
  return data.length > 64 ? `${hex.join('')}… (${data.length}B total)` : hex.join('');
}

async function main(): Promise<void> {
  const { port, host, outDir, cert, key } = parseArgs(process.argv.slice(2));
  await mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = Bun.file(join(outDir, `${stamp}.jsonl`));
  const writer = file.writer();
  await writer.write(
    `${JSON.stringify({ t: new Date().toISOString(), event: 'start', port, host, tls: true })}\n`,
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
    tls: { cert: Bun.file(cert), key: Bun.file(key) },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return new Response('ok (tls)');
      }
      if (srv.upgrade(req, { data: { connId: ++connId } })) {
        return undefined;
      }
      return new Response('open-rc capture stub (tls)\n', { status: 200 });
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
            // not JSON
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

  console.log(`[capture-tls] listening on wss://${host}:${server.port}`);
  console.log(`[capture-tls] writing to ${file.name ?? join(outDir, `${stamp}.jsonl`)}`);

  const shutdown = async (): Promise<void> => {
    console.log('\n[capture-tls] shutting down');
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
  console.error('[capture-tls] fatal:', err);
  process.exit(1);
});

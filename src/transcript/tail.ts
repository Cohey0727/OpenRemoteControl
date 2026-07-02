/**
 * Byte-offset line tailer for an append-only JSONL file.
 *
 * Claude Code appends whole lines to the session transcript; this
 * tailer polls the file size and reads only the new bytes, splitting
 * them into complete lines. A trailing partial line (a write caught
 * mid-flush) is kept in the carry buffer until its newline arrives.
 *
 * Polling (default 300 ms) rather than fs.watch: the transcript lives
 * under `~/.claude`, watchers on macOS coalesce and drop events across
 * atomic-rename writers, and a 300 ms cadence is plenty for a chat UI.
 */

import { open, stat } from 'node:fs/promises';

export interface TailHandle {
  /** Stop polling. Idempotent. */
  stop(): void;
}

export interface TailOptions {
  /** Byte offset to start from (e.g. the size already replayed). */
  readonly fromOffset: number;
  /** Poll interval in ms. Default 300. */
  readonly intervalMs?: number;
  /** Called once per complete new line, in file order. */
  readonly onLine: (line: string) => void;
  /** Called when a poll cycle fails hard (file vanished, I/O error). */
  readonly onError?: (err: unknown) => void;
}

/** Read [offset, end) from the file as UTF-8. */
async function readSlice(path: string, offset: number, end: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const length = end - offset;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export function tailFile(path: string, opts: TailOptions): TailHandle {
  const intervalMs = opts.intervalMs ?? 300;
  let offset = opts.fromOffset;
  let carry = '';
  let stopped = false;
  let inFlight = false;

  async function poll(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const s = await stat(path);
      if (s.size < offset) {
        // File shrank (rotated/rewritten): restart from the top rather
        // than reading garbage from a stale offset.
        offset = 0;
        carry = '';
      }
      if (s.size > offset) {
        const chunk = await readSlice(path, offset, s.size);
        offset += Buffer.byteLength(chunk, 'utf8');
        const combined = carry + chunk;
        const lines = combined.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (stopped) break;
          if (line.trim() !== '') opts.onLine(line);
        }
      }
    } catch (err) {
      opts.onError?.(err);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, intervalMs);
  // Fire one immediate poll so a fresh tail doesn't wait a full tick.
  void poll();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Read the whole current file as complete lines, returning the byte
 * offset consumed — the natural `fromOffset` for a follow-up tail.
 * A trailing partial line is NOT consumed (it stays for the tailer).
 */
export async function readAllLines(path: string): Promise<{ lines: string[]; offset: number }> {
  const s = await stat(path);
  if (s.size === 0) return { lines: [], offset: 0 };
  const text = await readSlice(path, 0, s.size);
  const parts = text.split('\n');
  const partial = parts.pop() ?? '';
  const lines = parts.filter((l) => l.trim() !== '');
  const offset = s.size - Buffer.byteLength(partial, 'utf8');
  return { lines, offset };
}

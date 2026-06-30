/**
 * Subprocess wrapper around `claude --bare --output-format stream-json`.
 *
 * One `Subprocess` = one spawned `claude` invocation. The lifetime of
 * the subprocess equals the lifetime of the session it backs.
 *
 * Responsibilities:
 *   - spawn `claude` with the right flags and pass through env
 *   - read stdout as NDJSON, parse each line, hand to a sink
 *   - write user prompts as NDJSON to stdin
 *   - handle exit / crash / signal cleanly
 *
 * Non-responsibilities:
 *   - WebSocket transport (see `src/ws.ts`)
 *   - translating stream-json to WsServerMessage (see `translate.ts`)
 *   - multi-session orchestration (see `manager.ts`)
 */

import { type StreamJsonEvent, StreamJsonParseError, parseStreamJsonLine } from './stream-json.ts';

export type PermissionMode =
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'default'
  | 'dontAsk'
  | 'plan'
  | 'auto';

export interface SubprocessOptions {
  /** Resolved path or name of the `claude` binary. */
  readonly binary: string;
  /** Working directory for the spawned process. */
  readonly cwd?: string;
  /** Extra environment variables. */
  readonly env?: Record<string, string>;
  /**
   * Permission mode. Default `bypassPermissions` (auto-approves all tool
   * uses). When set to anything else, `--bare` is dropped and a settings
   * file is required via `settingsFile` to wire up our PreToolUse hook.
   */
  readonly permissionMode?: PermissionMode;
  /**
   * Path to a Claude Code `settings.json` file that defines the
   * PreToolUse hook. Required when `permissionMode` is `default`,
   * `acceptEdits`, or `dontAsk`.
   */
  readonly settingsFile?: string;
  /**
   * Whether to add `--bare`. Always false unless permissionMode is
   * `bypassPermissions` (since `--bare` strips hooks).
   */
  readonly bare?: boolean;
}

export type SubprocessEvent =
  | { kind: 'event'; event: StreamJsonEvent }
  | { kind: 'parse_error'; error: StreamJsonParseError }
  | { kind: 'exit'; code: number | null; signal: string | null }
  | { kind: 'spawn_error'; error: Error };

export type SubprocessListener = (e: SubprocessEvent) => void;

export class Subprocess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private listeners: Set<SubprocessListener> = new Set();
  private killed = false;
  private streamDone: Promise<void> | null = null;

  constructor(private readonly opts: SubprocessOptions) {}

  /**
   * Start the subprocess. Idempotent — calling `start` more than once is
   * a no-op.
   */
  start(): void {
    if (this.proc) return;
    this.killed = false;

    const mode = this.opts.permissionMode ?? 'bypassPermissions';
    const useBare = this.opts.bare ?? mode === 'bypassPermissions';

    const args = [
      '--print',
      ...(useBare ? ['--bare'] : []),
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      mode,
      ...(this.opts.settingsFile ? ['--settings', this.opts.settingsFile] : []),
    ];

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({
        cmd: [this.opts.binary, ...args],
        cwd: this.opts.cwd ?? process.cwd(),
        env: { ...process.env, ...this.opts.env },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (error) {
      this.emit({
        kind: 'spawn_error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    this.proc = proc;

    // stderr → discard for v0.1. Future: surface via a `stderr` event.
    (proc.stderr as ReadableStream<Uint8Array>)
      .pipeTo(new WritableStream({ write() {} }))
      .catch(() => {});

    // stdout → NDJSON parse → emit
    this.streamDone = this.readStdout();

    // exit → emit
    void proc.exited.then((code) => {
      void this.streamDone?.then(() => {
        if (!this.killed) {
          this.emit({ kind: 'exit', code, signal: null });
        }
      });
    });
  }

  /**
   * Send a user prompt to the subprocess. One JSON object, one line.
   */
  send(text: string): void {
    if (!this.proc) throw new Error('subprocess not started');
    const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    // Bun's subprocess.stdin is a FileSink with a `.write()` method that
    // accepts Uint8Array (or string). We cast through unknown because the
    // public type union also includes `'inherit'` etc., but at this point
    // we know we configured `stdin: 'pipe'`.
    const stdin = this.proc.stdin as unknown as {
      write: (chunk: Uint8Array | string) => unknown;
    };
    try {
      stdin.write(new TextEncoder().encode(`${payload}\n`));
    } catch (err) {
      this.emit({
        kind: 'spawn_error',
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Interrupt the current turn (sends Ctrl-C / SIGINT to claude).
   */
  interrupt(): void {
    if (!this.proc) return;
    this.proc.kill('SIGINT');
  }

  /**
   * Stop the subprocess. SIGTERM, then SIGKILL after 3 s.
   */
  async stop(): Promise<void> {
    if (!this.proc) return;
    this.killed = true;
    const proc = this.proc;
    try {
      proc.kill('SIGTERM');
    } catch {
      // already dead
    }
    const exited = proc.exited.then(() => true);
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timed = new Promise<boolean>((resolve) => {
      killTimer = setTimeout(() => {
        killTimer = null;
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve(true);
      }, 3000);
      // Do not keep the event loop alive just for the SIGKILL fallback.
      killTimer.unref?.();
    });
    await Promise.race([exited, timed]);
    if (killTimer) clearTimeout(killTimer);
    await this.streamDone?.catch(() => {});
  }

  on(listener: SubprocessListener): () => void {
    this.listeners.add(listener);
    return () => this.off(listener);
  }

  off(listener: SubprocessListener): void {
    this.listeners.delete(listener);
  }

  private emit(e: SubprocessEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // listener errors must not propagate; we surface them via console
        // only in debug mode (left out for v0.1 to keep logs clean)
      }
    }
  }

  private async readStdout(): Promise<void> {
    if (!this.proc) return;
    const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const nl = buffer.indexOf('\n');
            if (nl === -1) break;
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            this.processLine(line);
          }
        }
        if (done) {
          // flush any remaining partial line
          const tail = decoder.decode();
          if (tail) buffer += tail;
          if (buffer.length > 0) {
            this.processLine(buffer);
            buffer = '';
          }
          break;
        }
      }
    } catch (err) {
      this.emit({
        kind: 'spawn_error',
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  private processLine(line: string): void {
    try {
      const event = parseStreamJsonLine(line);
      if (event) {
        this.emit({ kind: 'event', event });
      }
    } catch (err) {
      if (err instanceof StreamJsonParseError) {
        this.emit({ kind: 'parse_error', error: err });
      } else {
        this.emit({
          kind: 'spawn_error',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }
}

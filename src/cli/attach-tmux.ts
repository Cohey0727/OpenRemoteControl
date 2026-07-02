/**
 * `open-rc attach-tmux` — client-side bridge that mirrors an EXISTING
 * interactive `claude` running inside a tmux pane into open-rc.
 *
 * `orc` = "open remote control".
 *
 * This is fundamentally different from `attach-orc`:
 *   - `attach-orc` SPAWNS a fresh headless `claude` and owns it.
 *   - `attach-tmux` spawns NO `claude`. It attaches to a `claude` the
 *     user already started in a terminal (inside tmux). Input is
 *     delivered with `tmux send-keys`; output is polled with
 *     `tmux capture-pane` and relayed as `screen` frames. It NEVER
 *     kills or signals the pane — the session is the user's.
 *
 * The server (`open-rc serve`) is unaffected: it stays a pure relay
 * that spawns nothing and touches no terminal. All tmux interaction
 * happens here, in a client-side process the user runs themselves.
 *
 * Lifecycle:
 *   1. Resolve the tmux target (--target, or auto-detect the sole
 *      claude/node pane).
 *   2. Open WS to <server>/agent, send `register`, wait for the ack.
 *   3. Poll `tmux capture-pane -p -t <target>` every --interval ms;
 *      on change, send a `screen` frame.
 *   4. On a `prompt` frame from a browser: `tmux send-keys -l -- <text>`
 *      then `send-keys Enter` into the pane.
 *   5. On SIGINT/SIGTERM: stop polling, close WS, exit — WITHOUT
 *      touching the tmux pane.
 *
 * `ORC_TMUX_BIN` overrides the `tmux` binary (tests only).
 * `ORC_REGISTER_TIMEOUT_MS` overrides the first-register fail-fast
 * deadline (tests only).
 */

import { hostname } from 'node:os';
import type { Register, ServerToBridge } from '../session/ws-protocol.ts';
import { ServerToBridge as ServerToBridgeSchema } from '../session/ws-protocol.ts';
import { agentUrlFromBase } from './attach-orc.ts';
import { parseFlags } from './flags.ts';

/* -------------------------------------------------------------------------- */
/*  CLI flags                                                                  */
/* -------------------------------------------------------------------------- */

export interface TmuxFlags {
  /** WebSocket URL of the open-rc server's /agent endpoint. */
  server: string;
  /** Human-readable label shown in the sidebar. */
  label: string;
  /** tmux target pane (e.g. `mysession`, `sess:1.0`, `%3`). */
  target?: string;
  /** Optional explicit clientId. Random UUID otherwise. */
  clientId?: string;
  /** capture-pane poll interval in ms. */
  intervalMs: number;
}

export function parseTmuxFlags(argv: string[]): TmuxFlags {
  const flags = parseFlags(argv);

  const explicit = typeof flags.server === 'string' ? flags.server : undefined;
  const base = process.env.ORC_BASE_URL ?? process.env.ORC__BASE_URL;
  const server = agentUrlFromBase(explicit ?? base ?? 'ws://127.0.0.1:7322');
  const target = typeof flags.target === 'string' ? flags.target : undefined;
  const label =
    typeof flags.label === 'string' ? flags.label : `tmux:${target ?? 'auto'}@${hostname()}`;
  const clientId = typeof flags.clientId === 'string' ? flags.clientId : undefined;
  const intervalRaw =
    typeof flags.interval === 'string' ? Number.parseInt(flags.interval, 10) : Number.NaN;
  // Clamp to a sane floor: sub-100 ms polling hammers tmux for no gain.
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw >= 100 ? intervalRaw : 500;

  return {
    server,
    label,
    ...(target !== undefined ? { target } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    intervalMs,
  };
}

/* -------------------------------------------------------------------------- */
/*  tmux helpers                                                               */
/* -------------------------------------------------------------------------- */

interface TmuxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function tmux(args: string[]): Promise<TmuxResult> {
  const bin = process.env.ORC_TMUX_BIN ?? 'tmux';
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as unknown as BodyInit).text(),
      new Response(proc.stderr as unknown as BodyInit).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Auto-detect the tmux pane running `claude`. Returns the pane id when
 * exactly one candidate exists; null when there are zero or many (the
 * caller then forces --target rather than guessing — sending keys to
 * the wrong pane would be worse than failing).
 */
async function autoDetectTarget(): Promise<string | null> {
  const res = await tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_command}']);
  if (!res.ok) return null;
  const candidates = res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, cmd] = line.split('\t');
      return { id: id ?? '', cmd: cmd ?? '' };
    })
    .filter((p) => p.id && /^(claude|node)$/i.test(p.cmd));
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
}

/** Trim trailing whitespace per line and drop trailing blank lines so
 *  screen diffs don't fire on invisible padding changes. */
export function normalizeScreen(raw: string): string {
  return raw.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
}

/* -------------------------------------------------------------------------- */
/*  Run                                                                        */
/* -------------------------------------------------------------------------- */

export async function runAttachTmux(flags: TmuxFlags): Promise<void> {
  // ----- resolve + verify the tmux target -----
  let target = flags.target;
  if (!target) {
    const detected = await autoDetectTarget();
    if (!detected) {
      console.error(
        '[attach-tmux] could not auto-detect a single claude pane. ' +
          'Pass --target (see `tmux list-panes -a -F "#{pane_id} #{pane_current_command}"`).',
      );
      process.exit(2);
    }
    target = detected;
    console.error(`[attach-tmux] auto-detected target pane: ${target}`);
  }

  const probe = await tmux(['capture-pane', '-p', '-t', target]);
  if (!probe.ok) {
    console.error(
      `[attach-tmux] cannot capture tmux target '${target}': ${probe.stderr.trim() || 'unknown error'}`,
    );
    process.exit(2);
  }

  const cwdRes = await tmux(['display', '-p', '-t', target, '#{pane_current_path}']);
  const cwd = cwdRes.ok && cwdRes.stdout.trim() ? cwdRes.stdout.trim() : process.cwd();

  // ----- WS connect with reconnect + first-register fail-fast -----
  let ws: WebSocket | undefined;
  let stop = false;
  let everRegistered = false;
  let polling = false;
  let lastScreen = '';
  const reconnectDelays = [500, 1000, 2000, 3000];
  let reconnectAttempt = 0;

  const registerTimeoutMs = Number(process.env.ORC_REGISTER_TIMEOUT_MS ?? 10_000);
  const registerDeadline = setTimeout(() => {
    if (everRegistered || stop) return;
    console.error(
      `[attach-tmux] could not register with ${flags.server} within ${registerTimeoutMs}ms — is \`open-rc serve\` running?`,
    );
    stop = true;
    try {
      ws?.close(1000, 'register timeout');
    } catch {
      // ignore
    }
    process.exit(1);
  }, registerTimeoutMs);

  async function pollOnce(): Promise<void> {
    // Don't poll/send before the first successful register — a screen
    // sent pre-register would just consume the server's bounded
    // pre-register buffer for nothing.
    if (stop || polling || !everRegistered) return;
    polling = true;
    try {
      const cap = await tmux(['capture-pane', '-p', '-t', target as string]);
      if (!cap.ok) return; // pane may be briefly unavailable; try again next tick
      const screen = normalizeScreen(cap.stdout);
      if (screen === lastScreen) return;
      lastScreen = screen;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'screen', text: screen }));
      }
    } finally {
      polling = false;
    }
  }

  const pollTimer = setInterval(() => {
    void pollOnce();
  }, flags.intervalMs);

  function handleServerFrame(frame: ServerToBridge): void {
    switch (frame.type) {
      case 'prompt': {
        const text = frame.text.replace(/\s+$/, '');
        // -l sends the string literally; a separate Enter submits it.
        void (async () => {
          await tmux(['send-keys', '-t', target as string, '-l', '--', text]);
          await tmux(['send-keys', '-t', target as string, 'Enter']);
          // Nudge a fresh capture so the echoed prompt shows up fast
          // instead of waiting for the next poll tick.
          void pollOnce();
        })();
        break;
      }
      case 'permission_response':
        // A tmux-mirrored claude shows its own permission dialog on
        // screen; the user answers by sending the key (e.g. "1"/"2"/"y")
        // as a normal prompt. There is no separate resolve channel here.
        break;
    }
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
        cwd,
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
      if (json && typeof json === 'object' && (json as { type?: unknown }).type === 'registered') {
        everRegistered = true;
        clearTimeout(registerDeadline);
        // Force a first screen push right away so the browser doesn't
        // wait a poll interval to see anything.
        lastScreen = '';
        void pollOnce();
        return;
      }
      if (json && typeof json === 'object' && (json as { type?: unknown }).type === 'error') {
        const message = (json as { message?: unknown }).message;
        console.error('[attach-tmux] server error:', typeof message === 'string' ? message : data);
        return;
      }
      let parsed: ServerToBridge;
      try {
        parsed = ServerToBridgeSchema.parse(json);
      } catch {
        return;
      }
      handleServerFrame(parsed);
    });

    sock.addEventListener('close', () => {
      ws = undefined;
      if (stop) return;
      console.error('[attach-tmux] ws closed; reconnecting');
      const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 3000;
      reconnectAttempt++;
      setTimeout(() => {
        if (stop) return;
        void connectWs().catch((err) => {
          console.error('[attach-tmux] reconnect failed:', err);
        });
      }, delay);
    });

    sock.addEventListener('error', (e) => {
      console.error('[attach-tmux] ws error:', (e as ErrorEvent).message ?? e);
    });
  }

  const shutdown = (sig: NodeJS.Signals): void => {
    console.error(`[attach-tmux] received ${sig}; detaching (tmux pane left untouched)`);
    stop = true;
    clearInterval(pollTimer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1000, sig);
      } catch {
        // ignore
      }
    }
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await connectWs();
  } catch (err) {
    console.error(`[attach-tmux] invalid server URL '${flags.server}':`, err);
    stop = true;
    clearInterval(pollTimer);
    process.exit(2);
  }

  // Keep the process alive on the poll timer + WS.
  await new Promise<void>(() => {});
}

/**
 * `open-rc attach-orc` — share an ALREADY-RUNNING Claude Code session
 * with `open-rc serve`, without owning it.
 *
 * The bridge never spawns, signals, or even sees the `claude`
 * process. It knows the session only through two artifacts the
 * session itself produces:
 *
 *   session → viewers   the transcript JSONL Claude Code appends under
 *                       `~/.claude/projects/…` — replayed as history on
 *                       register, then tailed live and translated into
 *                       BridgeFrames for `/agent`.
 *   viewers → session   `prompt` frames from the server are appended
 *                       to the per-session queue file; the Claude Code
 *                       hooks (`open-rc hook …`, see attach-hooks.ts)
 *                       deliver them into the running session at turn
 *                       boundaries.
 *
 * Turn model: a transcript `user` entry opens a turn, assistant/tool
 * entries keep it open, and the Stop hook's marker closes it (`done`
 * frame). If hooks aren't installed the bridge still closes a turn
 * when the next `user` entry arrives — dividers are just deferred.
 *
 * Lifecycle:
 *   1. Resolve the transcript (newest JSONL of this project's cwd, or
 *      `--transcript`). The session id is the transcript basename and
 *      doubles as the clientId, so browser deep links stay stable
 *      across bridge restarts.
 *   2. Create the attach state dir; heartbeat `bridge.json` so hooks
 *      know a bridge is live.
 *   3. Register on `<server>/agent`. Fail fast (10 s) if the FIRST
 *      registration doesn't complete; reconnect with 1–3 s backoff
 *      forever after it has.
 *   4. Replay + tail the transcript; queue incoming prompts; relay
 *      `attached` counts to the hooks; exit on the SessionEnd marker.
 */

import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import {
  HEARTBEAT_INTERVAL_MS,
  appendQueue,
  attachDirFor,
  createAttachDir,
  endMarkerExists,
  removeAttachDir,
  stopMarkerMtime,
  writeAttachedCount,
  writeBridgeInfo,
} from '../attach/state.ts';
import { resolveTranscript } from '../transcript/locate.ts';
import { type TailHandle, readAllLines, tailFile } from '../transcript/tail.ts';
import { type TranscriptFrame, entryTimestamp, translateEntry } from '../transcript/translate.ts';
import { parseFlags } from './flags.ts';

/** Frames replayed to the server after (re)registration, at most. */
const MAX_REPLAY_FRAMES = 600;
/** First-registration fail-fast window. */
const REGISTER_TIMEOUT_MS = 10_000;
/** A transcript quiet for this long is treated as between turns. */
const QUIET_TURN_MS = 15_000;
/** Grace between the Stop marker and the `done` frame, so the last
 *  transcript lines (flushed around the same moment) relay first. */
const DONE_GRACE_MS = 700;
const MARKER_POLL_MS = 400;
/** No frame from the server for this long = half-open link (the
 *  server keepalive-pings every 30 s; this allows several misses). */
const SERVER_SILENCE_MS = 120_000;
const WATCHDOG_POLL_MS = 15_000;

/* -------------------------------------------------------------------------- */
/*  Flags                                                                      */
/* -------------------------------------------------------------------------- */

export interface AttachOrcFlags {
  /** `/agent` WebSocket URL of the open-rc server. */
  server: string;
  /** Sidebar label. */
  label: string;
  /** Project cwd whose current session should be bridged. */
  cwd: string;
  /** Explicit clientId (defaults to the session id). */
  clientId?: string;
  /** Explicit transcript path (skips cwd-based discovery). */
  transcript?: string;
}

/**
 * Normalize a server URL (from `--server` or `ORC_BASE_URL`) into a
 * concrete `/agent` WebSocket URL. Accepts `https://serve:7322`,
 * `ws://host:7322`, or bare `host:7322`; maps http→ws, https→wss, and
 * appends `/agent` if no path is present.
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

/** The SPA URL that deep-links to this client on the same server. */
export function sessionUrlFromAgent(agentUrl: string, clientId: string): string {
  return agentUrl
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/agent$/, `/sessions/${clientId}`);
}

export function parseAttachOrcFlags(argv: string[]): AttachOrcFlags {
  const flags = parseFlags(argv);
  const explicit = typeof flags.server === 'string' ? flags.server : undefined;
  const base = process.env.ORC_BASE_URL;
  const server = agentUrlFromBase(explicit ?? base ?? 'ws://127.0.0.1:7322');
  const label =
    typeof flags.label === 'string' ? flags.label : `${process.env.USER ?? 'user'}@${hostname()}`;
  const cwd = typeof flags.cwd === 'string' ? resolve(flags.cwd) : process.cwd();
  const clientId = typeof flags.clientId === 'string' ? flags.clientId : undefined;
  const transcript = typeof flags.transcript === 'string' ? resolve(flags.transcript) : undefined;

  return {
    server,
    label,
    cwd,
    ...(clientId !== undefined ? { clientId } : {}),
    ...(transcript !== undefined ? { transcript } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Turn-aware frame emission                                                  */
/* -------------------------------------------------------------------------- */

type OutFrame = TranscriptFrame | { type: 'done'; ts?: number };

interface TurnState {
  readonly turnOpen: boolean;
  readonly lastTs: number | null;
}

/**
 * Fold one transcript line into an outgoing frame list, closing the
 * open turn when a new user prompt arrives. Pure: returns the next
 * state alongside the frames.
 */
export function foldLine(state: TurnState, line: string): { state: TurnState; out: OutFrame[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { state, out: [] };
  }
  const ts = entryTimestamp(raw);
  const frames = translateEntry(raw);
  let { turnOpen, lastTs } = state;
  const out: OutFrame[] = [];
  for (const frame of frames) {
    if (frame.type === 'user') {
      if (turnOpen) {
        out.push({ type: 'done', ...(lastTs !== null ? { ts: lastTs } : {}) });
        turnOpen = false;
      }
      out.push(frame);
    } else {
      out.push(frame);
      turnOpen = true;
    }
  }
  if (ts !== null) lastTs = ts;
  return { state: { turnOpen, lastTs }, out };
}

/** Fold a whole batch of lines (replay path). */
export function foldLines(lines: readonly string[]): { state: TurnState; out: OutFrame[] } {
  let state: TurnState = { turnOpen: false, lastTs: null };
  const out: OutFrame[] = [];
  for (const line of lines) {
    const step = foldLine(state, line);
    state = step.state;
    out.push(...step.out);
  }
  return { state, out };
}

/* -------------------------------------------------------------------------- */
/*  Bridge                                                                     */
/* -------------------------------------------------------------------------- */

export interface AttachOrcHandle {
  readonly clientId: string;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly sessionUrl: string;
  stop(): Promise<void>;
}

export interface AttachOrcOptions {
  /** Progress/log sink. Default console.error. */
  readonly log?: (line: string) => void;
  /** Attach-state base dir override (tests). */
  readonly attachBaseDir?: string;
  /** `~/.claude` override for transcript discovery (tests). */
  readonly claudeHome?: string;
  /** Called after a SessionEnd-triggered shutdown completes. */
  readonly onExit?: () => void;
}

export async function runAttachOrc(
  flags: AttachOrcFlags,
  opts: AttachOrcOptions = {},
): Promise<AttachOrcHandle> {
  const log = opts.log ?? ((line: string) => console.error(line));

  const located = await resolveTranscript({
    ...(flags.transcript !== undefined ? { transcript: flags.transcript } : {}),
    cwd: flags.cwd,
    ...(opts.claudeHome !== undefined ? { claudeHome: opts.claudeHome } : {}),
  });
  const sessionId = located.sessionId;
  const clientId = flags.clientId ?? sessionId;
  const dir = attachDirFor(sessionId, opts.attachBaseDir);

  await createAttachDir(dir);
  await writeBridgeInfo(dir, { clientId, server: flags.server, startedAt: Date.now() });

  let ws: WebSocket | null = null;
  let tail: TailHandle | null = null;
  let stopped = false;
  let registeredOnce = false;
  let turn: TurnState = { turnOpen: false, lastTs: null };
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStopMtime = await stopMarkerMtime(dir);
  /** Epoch ms of the last frame received from the server (the server
   *  keepalive-pings every 30 s, so silence means a dead link). */
  let lastServerActivity = Date.now();

  const send = (frame: Record<string, unknown>): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // close handler owns recovery
      }
    }
  };

  const emit = (frames: readonly OutFrame[]): void => {
    for (const frame of frames) send(frame);
  };

  /** Replay history and start (or restart) the live tail. */
  const startStreaming = async (): Promise<void> => {
    tail?.stop();
    const { lines, offset } = await readAllLines(located.path);
    const folded = foldLines(lines);
    turn = folded.state;
    emit(folded.out.slice(-MAX_REPLAY_FRAMES));

    // If the transcript has been quiet, the session is between turns —
    // close the trailing turn so viewers see it as complete.
    if (turn.turnOpen) {
      const s = await stat(located.path).catch(() => null);
      if (s && Date.now() - s.mtimeMs > QUIET_TURN_MS) {
        emit([{ type: 'done', ...(turn.lastTs !== null ? { ts: turn.lastTs } : {}) }]);
        turn = { ...turn, turnOpen: false };
      }
    }

    tail = tailFile(located.path, {
      fromOffset: offset,
      onLine: (line) => {
        const step = foldLine(turn, line);
        turn = step.state;
        emit(step.out);
      },
      onError: () => {
        // transcript briefly unreadable (writer mid-rename); next poll retries
      },
    });
  };

  const closeTurnFromStopMarker = (): void => {
    if (doneTimer) clearTimeout(doneTimer);
    // Small grace so transcript lines flushed around the same moment
    // relay before the divider.
    doneTimer = setTimeout(() => {
      if (stopped) return;
      if (turn.turnOpen) {
        emit([{ type: 'done' }]); // server stamps ts = now
        turn = { ...turn, turnOpen: false };
      }
    }, DONE_GRACE_MS);
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log(`open-rc attach-orc: shutting down (${reason})`);
    clearInterval(heartbeat);
    clearInterval(markerPoll);
    clearInterval(watchdog);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (doneTimer) clearTimeout(doneTimer);
    tail?.stop();
    // Closing is goodbye enough: the server's close handler removes
    // the client and broadcasts `client_removed`. Sending `unregister`
    // AND closing races the server's own close of the same socket.
    try {
      ws?.close();
    } catch {
      // already closed
    }
    await removeAttachDir(dir);
  };

  const heartbeat = setInterval(() => {
    void writeBridgeInfo(dir, { clientId, server: flags.server, startedAt: Date.now() }).catch(
      () => {},
    );
  }, HEARTBEAT_INTERVAL_MS);

  const markerPoll = setInterval(() => {
    void (async () => {
      if (stopped) return;
      if (await endMarkerExists(dir)) {
        await shutdown('session ended');
        opts.onExit?.();
        return;
      }
      const mtime = await stopMarkerMtime(dir);
      if (mtime !== null && mtime !== lastStopMtime) {
        lastStopMtime = mtime;
        closeTurnFromStopMarker();
      }
    })();
  }, MARKER_POLL_MS);

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = 1_000 + Math.random() * 2_000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  let resolveFirstRegister: (() => void) | null = null;
  let rejectFirstRegister: ((err: Error) => void) | null = null;

  const handleMessage = (raw: unknown): void => {
    lastServerActivity = Date.now();
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as typeof msg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ping':
        return; // keepalive; receiving it is the whole point
      case 'registered': {
        registeredOnce = true;
        resolveFirstRegister?.();
        resolveFirstRegister = null;
        void startStreaming();
        return;
      }
      case 'error': {
        const message = typeof msg.message === 'string' ? msg.message : 'server error';
        if (!registeredOnce) {
          rejectFirstRegister?.(new Error(message));
          rejectFirstRegister = null;
        } else {
          log(`open-rc attach-orc: server error: ${message}`);
        }
        return;
      }
      case 'prompt': {
        if (typeof msg.text === 'string' && msg.text !== '') {
          void appendQueue(dir, msg.text).catch((err) => {
            log(`open-rc attach-orc: failed to queue prompt: ${err}`);
          });
        }
        return;
      }
      case 'attached': {
        if (typeof msg.count === 'number') {
          void writeAttachedCount(dir, msg.count).catch(() => {});
        }
        return;
      }
      default:
        return; // permission_response and future frames: ignored in v1
    }
  };

  const connect = (): void => {
    if (stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(flags.server);
    } catch (err) {
      if (!registeredOnce) {
        rejectFirstRegister?.(err instanceof Error ? err : new Error(String(err)));
        rejectFirstRegister = null;
        return;
      }
      scheduleReconnect();
      return;
    }
    ws = socket;
    lastServerActivity = Date.now();
    // Every listener checks it still belongs to the CURRENT socket:
    // the watchdog abandons half-open sockets, and a late event from
    // an abandoned one must not touch live state.
    socket.addEventListener('open', () => {
      if (socket !== ws) return;
      send({ type: 'register', clientId, label: flags.label, cwd: flags.cwd });
    });
    socket.addEventListener('message', (ev) => {
      if (socket !== ws) return;
      handleMessage(ev.data);
    });
    socket.addEventListener('close', () => {
      if (stopped || socket !== ws) return;
      tail?.stop();
      if (registeredOnce) scheduleReconnect();
    });
  };

  /** Half-open link detection: the server keepalive-pings every 30 s,
   *  so a connection with no inbound frame for SERVER_SILENCE_MS is
   *  dead even if the socket still claims OPEN (proxies like
   *  Cloudflare drop idle WebSockets without a clean close). Abandon
   *  it and reconnect. */
  const watchdog = setInterval(() => {
    if (stopped || !registeredOnce || !ws) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastServerActivity <= SERVER_SILENCE_MS) return;
    log('open-rc attach-orc: server silent — link presumed dead, reconnecting');
    const dead = ws;
    ws = null;
    try {
      dead.close();
    } catch {
      // already gone
    }
    tail?.stop();
    scheduleReconnect();
  }, WATCHDOG_POLL_MS);

  const firstRegistration = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveFirstRegister = resolvePromise;
    rejectFirstRegister = rejectPromise;
  });
  const registerTimer = setTimeout(() => {
    rejectFirstRegister?.(
      new Error(
        `registration with ${flags.server} did not complete within ` +
          `${REGISTER_TIMEOUT_MS / 1000}s — is \`open-rc serve\` running?`,
      ),
    );
    rejectFirstRegister = null;
  }, REGISTER_TIMEOUT_MS);

  connect();

  try {
    await firstRegistration;
  } catch (err) {
    await shutdown('registration failed');
    throw err;
  } finally {
    clearTimeout(registerTimer);
  }

  const sessionUrl = sessionUrlFromAgent(flags.server, clientId);
  log(`open-rc attach-orc: sharing session ${sessionId}`);
  log(`open-rc attach-orc: transcript ${located.path}`);
  log(`open-rc attach-orc: open ${sessionUrl}`);

  return {
    clientId,
    sessionId,
    transcriptPath: located.path,
    sessionUrl,
    stop: () => shutdown('stopped'),
  };
}

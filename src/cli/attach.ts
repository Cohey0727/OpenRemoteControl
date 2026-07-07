/**
 * `orc attach` — share an ALREADY-RUNNING Claude Code session
 * with `orc serve`, without owning it.
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
 *                       hooks (`orc hook …`, see attach-hooks.ts)
 *                       deliver them into the running session at turn
 *                       boundaries.
 *
 * Turn model: a transcript `user` entry opens a turn, assistant/tool
 * entries keep it open, and the Stop hook's marker closes it (`done`
 * frame). If hooks aren't installed the bridge still closes a turn
 * when the next `user` entry arrives — dividers are just deferred.
 *
 * The same machinery also runs `orc channel` (opts.channel): there the
 * viewers → session leg is an MCP channel notification pushed straight
 * into the running session (instant, even while idle) instead of the
 * queue file, and the transcript is discovered LAZILY — claude spawns
 * the channel server before the session writes its first line.
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

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import {
  HEARTBEAT_INTERVAL_MS,
  appendQueue,
  attachDirFor,
  attachedCountMtime,
  browserTurnMarkerExists,
  createAttachDir,
  endMarkerExists,
  readQuestion,
  removeAttachDir,
  removeChannelMarker,
  stopMarkerMtime,
  touchBrowserTurnMarker,
  touchChannelMarker,
  writeAnswer,
  writeAttachedCount,
  writeBridgeInfo,
} from '../attach/state.ts';
import { waitForNewTranscript } from '../channel/discover.ts';
import { waitForChannelMcpLog } from '../channel/mcp-log.ts';
import { type LocatedTranscript, resolveTranscript } from '../transcript/locate.ts';
import { type TailHandle, readAllLines, tailFile } from '../transcript/tail.ts';
import { type TranscriptFrame, entryTimestamp, translateEntry } from '../transcript/translate.ts';
import { lingerMs } from './attach-hooks.ts';
import { parseFlags } from './flags.ts';
import { openWebSocket } from './ws-auth.ts';

/** Frames replayed to the server after (re)registration, at most. */
const MAX_REPLAY_FRAMES = 600;
/** First-registration fail-fast window. */
const REGISTER_TIMEOUT_MS = 10_000;
/** After a (re)replay, this much tail silence closes the trailing
 *  turn — a reconnect must not leave `turnOpen` stuck (it suppresses
 *  the idle notice and pins the sidebar to busy). */
const QUIET_TURN_MS = 15_000;
/** Rolling stuck-turn guard during normal streaming: a turn open
 *  this long with zero emitted frames is presumed abandoned (e.g. an
 *  Esc-interrupted turn never fires the Stop hook). Long silent tool
 *  runs can trip this early — the cost is a cosmetic turn divider;
 *  frames reopen the turn when they resume. */
const STUCK_TURN_MS = 300_000;
/** Grace between the Stop marker and the `done` frame, so the last
 *  transcript lines (flushed around the same moment) relay first. */
const DONE_GRACE_MS = 700;
const MARKER_POLL_MS = 400;
/** No frame from the server for this long = half-open link (the
 *  server keepalive-pings every 30 s; this allows several misses). */
const SERVER_SILENCE_MS = 120_000;
const WATCHDOG_POLL_MS = 15_000;
/** Channel mode: how long an idle session may stay visibly silent
 *  after a pushed prompt before viewers are warned that the channel
 *  is probably not enabled (notifications are dropped silently). */
const CHANNEL_DELIVERY_WARN_MS = 20_000;

/* -------------------------------------------------------------------------- */
/*  Flags                                                                      */
/* -------------------------------------------------------------------------- */

export interface AttachOrcFlags {
  /** `/agent` WebSocket URL of the orc server. */
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
  /** Null in channel mode until the transcript is discovered. */
  readonly sessionId: string | null;
  readonly transcriptPath: string | null;
  readonly sessionUrl: string;
  /** Send one raw frame to the server (silently dropped while the
   *  link is down). Channel mode relays `permission_request` this way. */
  readonly send: (frame: Record<string, unknown>) => void;
  stop(): Promise<void>;
}

/**
 * Channel-mode hooks (`orc channel`). The bridge machinery is shared
 * with `orc attach`; what changes is the two injection points:
 * transcript discovery is LAZY (claude spawns the channel before the
 * session writes its first transcript line), and viewer prompts are
 * pushed straight into the session as MCP channel notifications
 * instead of the queue file the Stop/UserPromptSubmit hooks drain.
 */
export interface ChannelModeHooks {
  /** Deliver one viewer prompt into the session (channel notification). */
  readonly onPrompt: (text: string) => Promise<void>;
  /** Relay a viewer's permission verdict (permission relay). */
  readonly onPermissionResponse?: (requestId: string, approved: boolean) => Promise<void>;
  /** Transcript-discovery poll cadence override (tests). */
  readonly discoverPollMs?: number;
  /**
   * Once discovery reveals the session id, re-key the registered
   * client to it (`rekey` frame). The provisional host+cwd id is only
   * needed because claude spawns the channel before the session writes
   * its first transcript line; re-keying frees it for the next session
   * in the same cwd, so several sessions per directory can be shared
   * at once. Off when the user forced an explicit --client-id.
   */
  readonly rekeyToSessionId?: boolean;
  /** Claude MCP-debug-log cache root override (tests). */
  readonly mcpLogCacheHome?: string;
  /** MCP-log poll cadence override (tests). */
  readonly mcpLogPollMs?: number;
  /** MCP-log wait timeout override (tests). */
  readonly mcpLogTimeoutMs?: number;
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
  /** Post-replay quiet-close fuse override (tests). */
  readonly quietTurnMs?: number;
  /** Present = run as `orc channel` bridge (see ChannelModeHooks). */
  readonly channel?: ChannelModeHooks;
}

export async function runAttachOrc(
  flags: AttachOrcFlags,
  opts: AttachOrcOptions = {},
): Promise<AttachOrcHandle> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const channel = opts.channel;
  const startedAt = Date.now();
  const tag = channel ? 'orc channel' : 'orc attach';

  /** Resolved transcript. Channel mode starts with null: claude spawns
   *  the channel MCP server BEFORE the session writes its first
   *  transcript line, so discovery runs in the background instead. */
  let located: LocatedTranscript | null = null;
  /** Attach state dir (the hooks rendezvous). Follows `located`. */
  let dir: string | null = null;

  if (!channel) {
    located = await resolveTranscript({
      ...(flags.transcript !== undefined ? { transcript: flags.transcript } : {}),
      cwd: flags.cwd,
      ...(opts.claudeHome !== undefined ? { claudeHome: opts.claudeHome } : {}),
    });
  }
  const initialClientId = flags.clientId ?? located?.sessionId;
  if (initialClientId === undefined) {
    throw new Error('channel mode requires an explicit clientId');
  }
  /** Current client id on the server. Channel mode starts with the
   *  provisional host+cwd id and re-keys to the session id once the
   *  transcript is discovered (see `pendingRekey`). */
  let clientId: string = initialClientId;

  let ws: WebSocket | null = null;
  let tail: TailHandle | null = null;
  let stopped = false;
  let registeredOnce = false;
  /** Session id we want to re-key to, until the server acks it. Kept
   *  across reconnects: registration re-sends it after `registered`. */
  let pendingRekey: string | null = null;
  /** Channel mode: whether viewer prompts actually reach the session
   *  as channel notifications. Claude spawns the MCP server on EVERY
   *  session start — the mcpServers entry is enough — but drops the
   *  notifications SILENTLY unless the session was started with
   *  `--dangerously-load-development-channels server:orc`. Claude's
   *  own MCP debug log says which case we are in; when the flag is
   *  missing this flips false and prompts fall back to the hook
   *  queue, exactly like a `/orc` share. Default true (log missing /
   *  old CLI = keep the previous optimistic behavior + its warning). */
  let channelDelivery = true;
  /** Session id claude reported in its MCP debug log (channel mode);
   *  pins transcript discovery to the exact spawning session. */
  let expectedSessionId: string | null = null;
  let turn: TurnState = { turnOpen: false, lastTs: null };
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStopMtime: number | null = null;

  /** Bind the bridge to its transcript: create the state dir the
   *  hooks rendezvous in, remember the stop-marker baseline. Attach
   *  mode runs this up front; channel mode when discovery finds the
   *  file the spawning session started writing. */
  const adoptTranscript = async (found: LocatedTranscript): Promise<void> => {
    located = found;
    const d = attachDirFor(found.sessionId, opts.attachBaseDir);
    dir = d;
    await createAttachDir(d);
    await writeBridgeInfo(d, { clientId, server: flags.server, startedAt: Date.now() });
    // Channel mode leaves a marker so the Stop hook knows delivery is
    // the channel's job and exits without lingering (no queue to poll,
    // no terminal capture). In hook-fallback mode (session started
    // without the channels flag) the marker must be ABSENT — the Stop
    // hook is the delivery path then, same as a `/orc` share.
    if (channel) {
      if (channelDelivery) await touchChannelMarker(d);
      else await removeChannelMarker(d);
    }
    lastStopMtime = await stopMarkerMtime(d);
    // Now that the session id is known, trade the provisional id for
    // it — frees the host+cwd id for the next session in this cwd.
    if (channel?.rekeyToSessionId && found.sessionId !== clientId) {
      pendingRekey = found.sessionId;
      sendRekey();
    }
  };

  if (located) await adoptTranscript(located);
  // Deliberately NOT browser-driven yet: marking the session
  // browser-driven at bridge start made the /orc turn's own Stop hook
  // linger without a deadline, and the terminal user's typed prompts
  // queued behind it — claude appeared to hang the moment orc started
  // (2026-07-06). Browser-driven mode now begins only when a browser
  // message is actually DELIVERED (the Stop hook touches the marker;
  // in channel mode, the `<channel>` event observed in the transcript);
  // until then the hooks use the finite window, refreshed by viewer
  // attach events.
  /** requestId of the last `question` frame relayed (dedupe). */
  let lastQuestionId: string | null = null;
  /** When the attached count last went 0 → >0 (null while nobody is
   *  watching). Feeds the idle-notice heuristic: the Stop hook exits
   *  instantly at zero viewers, so a linger can only have survived a
   *  turn end if someone was attached before it. */
  let attachedSince: number | null = null;
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

  /** Ask the server to move this client to the discovered session id.
   *  Sent on adoption and re-sent after every (re)registration until
   *  the `rekeyed` ack lands; a rejection (id already in use — the
   *  documented same-cwd discovery race) is logged and the bridge
   *  keeps serving under its current id. */
  const sendRekey = (): void => {
    if (pendingRekey === null || pendingRekey === clientId) return;
    send({ type: 'rekey', clientId: pendingRekey });
  };

  /** Last time conversation frames flowed (feeds the stuck-turn guard). */
  let lastEmitAt = Date.now();
  /** True from the end of a replay until the first live tail line. */
  let justReplayed = false;

  const emit = (frames: readonly OutFrame[]): void => {
    for (const frame of frames) send(frame);
    if (frames.length > 0) lastEmitAt = Date.now();
  };

  /** Replay history and start (or restart) the live tail. */
  const startStreaming = async (): Promise<void> => {
    const loc = located;
    if (!loc) return;
    tail?.stop();
    const { lines, offset } = await readAllLines(loc.path);
    const folded = foldLines(lines);
    turn = folded.state;
    emit(folded.out.slice(-MAX_REPLAY_FRAMES));
    // A replay that ends mid-turn is closed by the stuck-turn guard
    // (markerPoll → closeStuckTurn) after QUIET_TURN_MS of tail
    // silence — NOT by a one-shot mtime check here: bookkeeping
    // writes (e.g. Claude Code's stop_hook_summary entries) keep the
    // mtime fresh while the session is actually idle, and skipping on
    // fresh mtime left the turn open forever (observed 2026-07-03).
    justReplayed = true;
    lastEmitAt = Date.now();

    tail = tailFile(loc.path, {
      fromOffset: offset,
      onLine: (line) => {
        justReplayed = false;
        if (line.includes('"stop_hook_summary"')) verifyHooksRan();
        // Channel mode: a `<channel>` event landing in the transcript
        // is CONFIRMED delivery of a viewer prompt — the session is
        // remote-driven now, so flip browser-driven mode (it routes
        // AskUserQuestion to the viewers instead of the terminal
        // selector; a prompt typed in the terminal clears it again).
        // It also counts as the session REACTING: the `<channel>`
        // prompt is a `<…>`-wrapped synthetic entry that translate.ts
        // filters out, so it never reaches `emit`; bump lastEmitAt
        // here so the delivery watchdog doesn't false-positive while
        // the session sits on a permission dialog (no assistant frames
        // flow until it's answered).
        if (channel && dir && line.includes('"type":"user"') && line.includes('<channel source=')) {
          void touchBrowserTurnMarker(dir).catch(() => {});
          lastEmitAt = Date.now();
        }
        const step = foldLine(turn, line);
        turn = step.state;
        emit(step.out);
      },
      onError: () => {
        // transcript briefly unreadable (writer mid-rename); next poll retries
      },
    });
  };

  /** Start streaming exactly once per (socket, transcript) pair —
   *  `registered` and late transcript discovery race in channel mode,
   *  and a double start would replay history twice. */
  let streamStartedFor: WebSocket | null = null;
  const maybeStartStreaming = (): void => {
    if (!located || !registeredOnce || stopped) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (streamStartedFor === ws) return;
    streamStartedFor = ws;
    void startStreaming();
  };

  /** Close a turn the transcript will never close for us: right after
   *  a replay (short fuse), or when a live turn goes silent for a long
   *  time (e.g. Esc-interrupted — the Stop hook never fires). */
  /** Fires when the transcript logs a finished Stop-hook pass; if our
   *  stop marker didn't move, this session isn't running the open-rc
   *  hooks (started before `make setup`, or they were removed) —
   *  browser→session delivery cannot work. Say so, once. */
  let hookWarningSent = false;
  const verifyHooksRan = (): void => {
    if (hookWarningSent || stopped) return;
    setTimeout(() => {
      void (async () => {
        if (hookWarningSent || stopped) return;
        const d = dir;
        if (!d) return;
        const m = await stopMarkerMtime(d);
        if (m !== null && Date.now() - m < 15_000) return; // our hook ran
        hookWarningSent = true;
        send({
          type: 'error',
          message:
            channel && channelDelivery
              ? 'this session does not appear to run the orc hooks (it may have started before `make setup`, or hooks changed since) — turn dividers and question relay are degraded. Browser→session delivery still works over the channel.'
              : 'this session does not appear to run the orc hooks (it may have started before `make setup`, or hooks changed since) — browser→session delivery is disabled. Restart the claude session and run /orc again.',
        });
      })();
    }, 5_000);
  };

  const closeStuckTurn = (): void => {
    if (!turn.turnOpen) return;
    const threshold = justReplayed ? (opts.quietTurnMs ?? QUIET_TURN_MS) : STUCK_TURN_MS;
    if (Date.now() - lastEmitAt < threshold) return;
    emit([{ type: 'done', ...(turn.lastTs !== null ? { ts: turn.lastTs } : {}) }]);
    turn = { ...turn, turnOpen: false };
  };

  /**
   * A prompt was queued — if no Stop-hook listening window can still
   * be open (the last turn ended longer ago than the applicable
   * window) and no turn is running, nothing will deliver it until the
   * session next wakes. Say so in the conversation instead of leaving
   * the sender staring at silence. Best-effort and rate-limited.
   */
  let lastIdleNoticeAt = 0;
  const notifyIfNoListener = async (): Promise<void> => {
    const d = dir;
    if (!d) return;
    if (turn.turnOpen) return; // a turn is running; delivery comes at its end
    // Browser-driven sessions keep an unlimited Stop-hook linger alive
    // after every turn — always listening, no notice needed.
    if (await browserTurnMarkerExists(d)) return;
    // CLI mode: a Stop hook can only still be lingering if viewers were
    // already attached when the turn ended (it exits instantly at zero
    // viewers), and then only for the finite window, counted from the
    // later of the turn end and the last attach/detach event.
    const stopM = await stopMarkerMtime(d);
    const attachedM = await attachedCountMtime(d);
    const hookSurvivedTurnEnd =
      stopM !== null && attachedSince !== null && attachedSince <= stopM + 2_000;
    const deadline = stopM === null ? 0 : Math.max(stopM, attachedM ?? 0) + lingerMs();
    const listening = hookSurvivedTurnEnd && Date.now() < deadline - 5_000;
    if (listening) return;
    if (Date.now() - lastIdleNoticeAt < 30_000) return;
    lastIdleNoticeAt = Date.now();
    send({
      type: 'error',
      message:
        'message queued — the session is idle right now; it will be delivered the next time the session wakes (its next turn, a prompt typed in its terminal, or the start of a new listening window).',
    });
  };

  /** Channel mode: a `notifications/claude/channel` write is
   *  fire-and-forget — if channels aren't enabled for the session
   *  (missing `--dangerously-load-development-channels server:orc`,
   *  org policy off) the event is dropped with NO error back to us.
   *  So after pushing into an idle session, watch for any transcript
   *  reaction; visible silence gets an honest `error` frame instead
   *  of leaving the sender staring at nothing (Issue #11 P5). */
  let channelWarnedAt = 0;
  const armChannelDeliveryWatch = (sentAt: number): void => {
    if (turn.turnOpen) return; // busy sessions queue events in-session; normal
    setTimeout(() => {
      if (stopped || turn.turnOpen || lastEmitAt > sentAt) return;
      if (Date.now() - channelWarnedAt < 60_000) return;
      channelWarnedAt = Date.now();
      send({
        type: 'error',
        message:
          'the message was pushed to the session channel but the session has not reacted — make sure claude was started with `--dangerously-load-development-channels server:orc` (channel events are dropped silently when the channel is not enabled).',
      });
    }, CHANNEL_DELIVERY_WARN_MS);
  };

  /** Channel mode: push one viewer prompt straight into the session.
   *  This replaces the queue file + Stop-hook window entirely — the
   *  notification reaches the session even while it is idle. */
  const deliverViaChannel = (text: string): void => {
    if (!channel) return;
    const sentAt = Date.now();
    void channel
      .onPrompt(text)
      .then(() => armChannelDeliveryWatch(sentAt))
      .catch((err) => {
        log(`${tag}: failed to push prompt into the session: ${err}`);
        send({
          type: 'error',
          message: 'failed to push the message into the session over the channel.',
        });
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
    log(`${tag}: shutting down (${reason})`);
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
    if (dir) await removeAttachDir(dir);
  };

  const heartbeat = setInterval(() => {
    const d = dir;
    if (!d) return; // channel mode before transcript discovery
    void writeBridgeInfo(d, { clientId, server: flags.server, startedAt: Date.now() }).catch(
      () => {},
    );
  }, HEARTBEAT_INTERVAL_MS);

  const markerPoll = setInterval(() => {
    void (async () => {
      if (stopped) return;
      const d = dir;
      if (!d) return; // channel mode before transcript discovery
      if (await endMarkerExists(d)) {
        await shutdown('session ended');
        opts.onExit?.();
        return;
      }
      const mtime = await stopMarkerMtime(d);
      if (mtime !== null && mtime !== lastStopMtime) {
        lastStopMtime = mtime;
        closeTurnFromStopMarker();
      }
      // The `ask` hook parked a live AskUserQuestion — relay it to
      // every viewer so the choice can be answered remotely.
      const q = await readQuestion(d);
      if (q && q.requestId !== lastQuestionId) {
        lastQuestionId = q.requestId;
        send({ type: 'question', requestId: q.requestId, questions: q.questions });
      }
      closeStuckTurn();
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
        sendRekey(); // reconnect before the ack: ask again
        maybeStartStreaming();
        return;
      }
      case 'rekeyed': {
        if (typeof msg.clientId !== 'string' || msg.clientId === '') return;
        if (pendingRekey === msg.clientId) pendingRekey = null;
        if (clientId !== msg.clientId) {
          log(`${tag}: client id updated: ${clientId} → ${msg.clientId}`);
          clientId = msg.clientId;
          const d = dir;
          if (d) {
            void writeBridgeInfo(d, {
              clientId,
              server: flags.server,
              startedAt: Date.now(),
            }).catch(() => {});
          }
        }
        return;
      }
      case 'error': {
        const message = typeof msg.message === 'string' ? msg.message : 'server error';
        if (!registeredOnce) {
          rejectFirstRegister?.(new Error(message));
          rejectFirstRegister = null;
        } else {
          log(`${tag}: server error: ${message}`);
        }
        return;
      }
      case 'prompt': {
        if (typeof msg.text === 'string' && msg.text !== '') {
          // Channel mode delivers over the channel only while the
          // session actually listens to it; a flagless session falls
          // back to the hook queue below, like a `/orc` share.
          if (channel && channelDelivery) {
            deliverViaChannel(msg.text);
            return;
          }
          const d = dir;
          if (!d) {
            send({
              type: 'error',
              message:
                'message dropped — the session cannot be identified yet (it has not written its transcript); try again after its first turn.',
            });
            return;
          }
          void appendQueue(d, msg.text)
            .then(() => notifyIfNoListener())
            .catch((err) => {
              log(`${tag}: failed to queue prompt: ${err}`);
            });
        }
        return;
      }
      case 'question_response': {
        const d = dir;
        if (!d) return;
        if (typeof msg.requestId === 'string' && Array.isArray(msg.answers)) {
          void writeAnswer(d, msg.requestId, msg.answers).catch((err) => {
            log(`${tag}: failed to record answer: ${err}`);
          });
        }
        return;
      }
      case 'permission_response': {
        // Channel mode relays the viewer's verdict back into Claude
        // Code's permission dialog (permission relay). Attach mode has
        // no in-session dialog to answer — ignored, as before.
        if (
          channel?.onPermissionResponse &&
          typeof msg.requestId === 'string' &&
          typeof msg.approved === 'boolean'
        ) {
          void channel.onPermissionResponse(msg.requestId, msg.approved).catch((err) => {
            log(`${tag}: failed to relay permission verdict: ${err}`);
          });
        }
        return;
      }
      case 'attached': {
        if (typeof msg.count === 'number' && dir !== null) {
          const d = dir;
          // Writing the count also refreshes attached.json's mtime,
          // which the Stop hook uses to extend its finite listening
          // window — a viewer who just opened the page gets a full
          // window for a first message. Attach deliberately does NOT
          // flip browser-driven (unlimited) mode: that captured
          // attended terminals (typed prompts queue behind a running
          // Stop hook) and hung claude right after /orc (2026-07-06);
          // only an actual delivery flips it.
          void writeAttachedCount(d, msg.count).catch(() => {});
          if (msg.count > 0) {
            attachedSince ??= Date.now();
            // `question` frames are transient (never in the server's
            // replay buffer), so a viewer attaching while the ask hook
            // is still waiting would see only the raw tool_use JSON.
            // Reset the dedupe so the next marker poll re-relays the
            // pending question; viewers dedupe by requestId.
            lastQuestionId = null;
          } else {
            attachedSince = null;
          }
        }
        return;
      }
      default:
        return; // future frames: ignored
    }
  };

  const connect = (): void => {
    if (stopped) return;
    let socket: WebSocket;
    try {
      socket = openWebSocket(flags.server);
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
    log('orc attach: server silent — link presumed dead, reconnecting');
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
          `${REGISTER_TIMEOUT_MS / 1000}s — is \`orc serve\` running?`,
      ),
    );
    rejectFirstRegister = null;
  }, REGISTER_TIMEOUT_MS);

  connect();

  // Channel mode: identify the spawning session in the background.
  // First consult claude's own MCP debug log — it names the session id
  // and says whether the channels flag is on — then wait for the
  // transcript (pinned to that id when known). Prompts and permission
  // relay work from registration on; streaming (history + live tail)
  // begins the moment the transcript exists.
  if (channel) {
    void (async () => {
      const info = await waitForChannelMcpLog({
        cwd: flags.cwd,
        sinceMs: startedAt,
        ...(channel.mcpLogCacheHome !== undefined ? { cacheHome: channel.mcpLogCacheHome } : {}),
        ...(channel.mcpLogPollMs !== undefined ? { pollMs: channel.mcpLogPollMs } : {}),
        ...(channel.mcpLogTimeoutMs !== undefined ? { timeoutMs: channel.mcpLogTimeoutMs } : {}),
        cancelled: () => stopped,
      });
      if (stopped) return;
      if (info?.sessionId) expectedSessionId = info.sessionId;
      if (info?.channelEnabled === false) {
        // The session runs us as a plain MCP server but drops channel
        // notifications (no --dangerously-load-development-channels).
        // Deliver like /orc instead: queue + Stop/UserPromptSubmit
        // hooks. Sharing stays on; only the instant-delivery is lost.
        channelDelivery = false;
        log(
          `${tag}: session started without the channels flag — falling back to hook-queue delivery (prompts land at turn boundaries)`,
        );
        // The session id is known before any transcript exists — set
        // up the hooks rendezvous now so prompts sent to the still
        // fresh session queue instead of dropping.
        if (info.sessionId && !located) {
          const d = attachDirFor(info.sessionId, opts.attachBaseDir);
          dir = d;
          await createAttachDir(d);
          await writeBridgeInfo(d, { clientId, server: flags.server, startedAt: Date.now() });
          await removeChannelMarker(d);
          lastStopMtime = await stopMarkerMtime(d);
        }
      }
      const found = await waitForNewTranscript({
        cwd: flags.cwd,
        sinceMs: startedAt,
        ...(opts.claudeHome !== undefined ? { claudeHome: opts.claudeHome } : {}),
        ...(channel.discoverPollMs !== undefined ? { pollMs: channel.discoverPollMs } : {}),
        cancelled: () => stopped,
        expectSessionId: () => expectedSessionId,
      });
      if (!found || stopped) return;
      await adoptTranscript(found);
      log(`${tag}: adopted session ${found.sessionId}`);
      log(`${tag}: transcript ${found.path}`);
      maybeStartStreaming();
    })();
  }

  try {
    await firstRegistration;
  } catch (err) {
    await shutdown('registration failed');
    throw err;
  } finally {
    clearTimeout(registerTimer);
  }

  const sessionUrl = sessionUrlFromAgent(flags.server, clientId);
  const loc = located as LocatedTranscript | null;
  if (loc) {
    log(`${tag}: sharing session ${loc.sessionId}`);
    log(`${tag}: transcript ${loc.path}`);
  } else {
    log(`${tag}: registered as ${clientId}; waiting for the session's transcript to appear`);
  }
  log(`${tag}: open ${sessionUrl}`);

  return {
    // Live getters: channel mode re-keys the client to the session id
    // after discovery, and the deep link moves with it.
    get clientId() {
      return clientId;
    },
    get sessionId() {
      return located?.sessionId ?? null;
    },
    get transcriptPath() {
      return located?.path ?? null;
    },
    get sessionUrl() {
      return sessionUrlFromAgent(flags.server, clientId);
    },
    send,
    stop: () => shutdown('stopped'),
  };
}

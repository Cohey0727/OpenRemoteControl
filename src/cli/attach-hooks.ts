/**
 * `open-rc hook <stop|prompt|end>` — Claude Code hook handlers.
 *
 * These are the browser → session half of the shared-session bridge.
 * `open-rc attach-orc` appends browser prompts to a per-session queue
 * file; these handlers, wired into `~/.claude/settings.json` by
 * `make setup`, deliver them INTO the running interactive session at
 * the only moments Claude Code gives outside code a voice:
 *
 *   Stop             fired at every turn end. The handler (a) touches
 *                    the stop marker so the bridge relays a `done`
 *                    frame, then (b) drains the queue. If prompts are
 *                    waiting it answers `{"decision":"block"}` with
 *                    the prompts as the reason — Claude Code continues
 *                    the turn and the session answers the browser.
 *                    While viewers are attached it lingers (default
 *                    45 s, env ORC_STOP_LINGER_MS) polling the queue,
 *                    so a browser reply sent moments after a turn ends
 *                    is picked up immediately. Esc interrupts the
 *                    linger, as with any running hook.
 *   UserPromptSubmit fired when the CLI user submits a prompt. Any
 *                    queued browser prompts ride along as context so
 *                    they are answered instead of silently aging.
 *   SessionEnd       touches the end marker; the bridge unregisters
 *                    from the server and exits.
 *
 * Every handler is a fast no-op (exit 0, no output) unless a bridge
 * with a fresh heartbeat exists for the session — the hooks are inert
 * on every session that never ran `/attach-orc`.
 *
 * No handler spawns anything, reads the process table, or touches
 * `claude` itself: they only read stdin JSON and exchange files with
 * the bridge.
 */

import { z } from 'zod';
import {
  attachDirFor,
  bridgeAlive,
  browserTurnMarkerExists,
  clearBrowserTurnMarker,
  drainQueue,
  endMarkerExists,
  queueNonEmpty,
  readAttachedCount,
  touchBrowserTurnMarker,
  touchEndMarker,
  touchStopMarker,
} from '../attach/state.ts';
import { OPENRC_MARKER } from '../transcript/translate.ts';

/** Default post-turn listening window while viewers are attached. */
const DEFAULT_LINGER_MS = 45_000;
/**
 * Long window used while the conversation is BROWSER-DRIVEN (the last
 * turn was injected from an attached view): the terminal is probably
 * unattended, so listening longer costs nobody anything and keeps a
 * phone-driven conversation responsive across real-world reply gaps
 * (minutes, not seconds — 5 min proved too short in practice). A
 * prompt typed in the terminal clears browser-driven mode, restoring
 * the short window so CLI prompts never wait long; Esc interrupts a
 * running hook if you need the prompt back mid-window. Keep it under
 * the Stop hook's `timeout` in settings.json (installed as 1 860 s).
 */
const DEFAULT_ACTIVE_LINGER_MS = 1_800_000;
/** Queue poll cadence during the linger window. */
const LINGER_POLL_MS = 300;

const HookInput = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  prompt: z.string().optional(),
});
export type HookInput = z.infer<typeof HookInput>;

/** What a handler wants written to stdout (JSON) before exit 0. */
export interface HookResult {
  readonly output?: Record<string, unknown>;
}

export function parseHookInput(raw: string): HookInput | null {
  try {
    const parsed = HookInput.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? fallback : n;
}

export const lingerMs = () => envMs('ORC_STOP_LINGER_MS', DEFAULT_LINGER_MS);
export const activeLingerMs = () => envMs('ORC_STOP_LINGER_ACTIVE_MS', DEFAULT_ACTIVE_LINGER_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Format drained browser prompts as a Stop-hook block reason. */
export function formatBlockReason(texts: readonly string[]): string {
  const list = texts.map((t) => `- ${t}`).join('\n');
  return `${OPENRC_MARKER} While this session is shared via open-rc, a user sent the following message(s) from an attached view (browser or tui). Treat them exactly as prompts typed into this session and respond now:\n\n${list}`;
}

/** Format drained browser prompts as UserPromptSubmit context. */
export function formatPromptContext(texts: readonly string[]): string {
  const list = texts.map((t) => `- ${t}`).join('\n');
  return `${OPENRC_MARKER} Message(s) also arrived from the shared open-rc view (browser/tui) — address them together with the user's prompt:\n\n${list}`;
}

/**
 * Stop hook. Returns `{}` (no output → allow stop) or a
 * `{"decision":"block"}` payload carrying queued browser prompts.
 */
export async function runStopHook(
  input: HookInput,
  opts?: {
    readonly baseDir?: string;
    readonly lingerMs?: number;
    readonly activeLingerMs?: number;
  },
): Promise<HookResult> {
  const dir = attachDirFor(input.session_id, opts?.baseDir);
  if (!(await bridgeAlive(dir))) return {};

  // Turn ended — let the bridge close the turn for attached viewers.
  await touchStopMarker(dir);

  // Browser-driven conversations get the long window: the last turn
  // was injected from an attached view, so the terminal is probably
  // unattended and a phone user expects the next reply to just work.
  const browserDriven = await browserTurnMarkerExists(dir);
  const window = browserDriven
    ? (opts?.activeLingerMs ?? activeLingerMs())
    : (opts?.lingerMs ?? lingerMs());
  const deadline = Date.now() + window;

  for (;;) {
    const texts = await drainQueue(dir);
    if (texts.length > 0) {
      // The next turn is browser-driven; keep listening long after it.
      await touchBrowserTurnMarker(dir);
      return { output: { decision: 'block', reason: formatBlockReason(texts) } };
    }
    if (await endMarkerExists(dir)) return {};
    if (!(await bridgeAlive(dir))) return {};
    // Linger only while someone is actually watching; an unwatched
    // session should return to the prompt immediately.
    if ((await readAttachedCount(dir)) === 0) return {};
    if (Date.now() >= deadline) return {};
    await sleep(LINGER_POLL_MS);
  }
}

/**
 * UserPromptSubmit hook. Attaches queued browser prompts as context
 * to the CLI user's own prompt.
 */
export async function runPromptHook(
  input: HookInput,
  opts?: { readonly baseDir?: string },
): Promise<HookResult> {
  const dir = attachDirFor(input.session_id, opts?.baseDir);
  if (!(await bridgeAlive(dir))) return {};
  // A real prompt was typed in the terminal: the CLI user is present,
  // so drop browser-driven mode and keep their turns snappy.
  await clearBrowserTurnMarker(dir);
  const texts = await drainQueue(dir);
  if (texts.length === 0) return {};
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: formatPromptContext(texts),
      },
    },
  };
}

/**
 * Notification hook (fires when Claude Code is waiting for input,
 * ~60 s idle). If browser prompts are stuck in the queue, tell the
 * human at the terminal — they deliver them by simply typing
 * anything. Output is display-only (Notification hooks cannot inject
 * into the conversation), so this is a hint, not a delivery path.
 */
export async function runNotifyHook(
  input: HookInput,
  opts?: { readonly baseDir?: string },
): Promise<HookResult> {
  const dir = attachDirFor(input.session_id, opts?.baseDir);
  if (!(await bridgeAlive(dir))) return {};
  if (!(await queueNonEmpty(dir))) return {};
  return {
    output: {
      systemMessage:
        'open-rc: message(s) from the shared browser view are waiting — type anything (or press Enter) to deliver them.',
    },
  };
}

/** SessionEnd hook. Signals the bridge to unregister and exit. */
export async function runEndHook(
  input: HookInput,
  opts?: { readonly baseDir?: string },
): Promise<HookResult> {
  const dir = attachDirFor(input.session_id, opts?.baseDir);
  // Touch the marker even if the heartbeat is already stale — a slow
  // bridge should still see the goodbye.
  const exists = await bridgeAlive(dir);
  if (exists) await touchEndMarker(dir);
  return {};
}

/** CLI entry: `open-rc hook <event>` with hook JSON on stdin. */
export async function runHookCommand(event: string, stdinText: string): Promise<number> {
  const input = parseHookInput(stdinText);
  if (!input) return 0; // never break claude over malformed hook input

  const result =
    event === 'stop'
      ? await runStopHook(input)
      : event === 'prompt'
        ? await runPromptHook(input)
        : event === 'notify'
          ? await runNotifyHook(input)
          : event === 'end'
            ? await runEndHook(input)
            : null;

  if (result === null) {
    console.error(`unknown hook event: ${event} (expected stop|prompt|notify|end)`);
    return 2;
  }
  if (result.output) {
    console.log(JSON.stringify(result.output));
  }
  return 0;
}

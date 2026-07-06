/**
 * `orc hook <stop|prompt|notify|ask|end>` — Claude Code hook handlers.
 *
 * These are the browser → session half of the shared-session bridge.
 * `orc attach` appends browser prompts to a per-session queue
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
 * on every session that never ran `/orc`.
 *
 * No handler spawns anything, reads the process table, or touches
 * `claude` itself: they only read stdin JSON and exchange files with
 * the bridge.
 */

import { z } from 'zod';
import {
  attachDirFor,
  attachedCountMtime,
  bridgeAlive,
  browserTurnMarkerExists,
  clearAnswer,
  clearBrowserTurnMarker,
  clearQuestion,
  drainQueue,
  endMarkerExists,
  queueNonEmpty,
  readAnswer,
  readAttachedCount,
  touchBrowserTurnMarker,
  touchEndMarker,
  touchStopMarker,
  writeQuestion,
} from '../attach/state.ts';
import { QuestionAnswer, QuestionItem } from '../session/ws-protocol.ts';
import { OPENRC_MARKER } from '../transcript/translate.ts';

/** Default post-turn listening window while viewers are attached. */
const DEFAULT_LINGER_MS = 45_000;
/**
 * Window used while the conversation is BROWSER-DRIVEN: UNLIMITED by
 * default. The terminal is presumed unattended — the remote user owns
 * the session, and any finite window (5 min, then 30 min) proved to
 * be a cliff someone eventually fell off. The linger is a sleeping
 * poll loop: no tokens, no context growth, ~zero CPU. It ends when a
 * message is delivered (and a fresh one starts at that turn's end),
 * when the session or bridge ends, or when the terminal user presses
 * Esc — verified to cancel a running Stop hook instantly, returning
 * the prompt. (Also verified: a prompt TYPED during a running hook
 * queues until the hook exits — it does not cancel it — which is why
 * the CLI-driven window stays short.) A prompt typed after Esc clears
 * browser-driven mode, restoring the short window.
 *
 * BROWSER-DRIVEN means "a browser/tui message was actually DELIVERED
 * into this session" — nothing weaker. Marking the session
 * browser-driven at bridge start or on mere viewer attach hard-hung
 * the terminal (2026-07-06): the /orc turn's own Stop hook entered
 * the unlimited linger with the user still sitting at the prompt, and
 * their typed input queued behind it forever. Attach instead REFRESHES
 * the finite window (see runStopHook), which covers the first-message
 * case without ever capturing an attended terminal.
 */
const DEFAULT_ACTIVE_LINGER_MS = Number.POSITIVE_INFINITY;
/** Queue poll cadence during the linger window. */
const LINGER_POLL_MS = 300;

const HookInput = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  prompt: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
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
/** Browser-driven mode is ALWAYS unlimited (owner's call, 2026-07-03) —
 *  no env cap. Tests override via runStopHook opts. */
export const activeLingerMs = () => DEFAULT_ACTIVE_LINGER_MS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Optional forensic trace: set ORC_HOOK_DEBUG=/path to append one
 *  JSON line per hook decision (used to diagnose silent exits). */
async function hookDebug(record: Record<string, unknown>): Promise<void> {
  const path = process.env.ORC_HOOK_DEBUG;
  if (!path) return;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `${JSON.stringify({ t: Date.now(), ...record })}\n`).catch(() => {});
}

/** A single prompt passes through verbatim; only genuinely multiple
 *  prompts get bullet points (a lone `- ` prefix leaked into how the
 *  session displayed and read browser messages). */
function formatPrompts(texts: readonly string[]): string {
  return texts.length === 1 ? (texts[0] ?? '') : texts.map((t) => `- ${t}`).join('\n');
}

/** Format drained browser prompts as a Stop-hook block reason. */
export function formatBlockReason(texts: readonly string[]): string {
  return `${OPENRC_MARKER} While this session is shared via open-rc, a user sent the following message(s) from an attached view (browser or tui). Treat them exactly as prompts typed into this session and respond now:\n\n${formatPrompts(texts)}`;
}

/** Format drained browser prompts as UserPromptSubmit context. */
export function formatPromptContext(texts: readonly string[]): string {
  return `${OPENRC_MARKER} Message(s) also arrived from the shared open-rc view (browser/tui) — address them together with the user's prompt:\n\n${formatPrompts(texts)}`;
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
  if (!(await bridgeAlive(dir))) {
    await hookDebug({ hook: 'stop', exit: 'bridge-dead-at-start' });
    return {};
  }

  // Turn ended — let the bridge close the turn for attached viewers.
  await touchStopMarker(dir);

  // Browser-driven conversations (a browser message was DELIVERED into
  // this session and no CLI prompt has been typed since) get the
  // unlimited window: the terminal is presumed unattended and the
  // remote user expects the next reply to just work — whenever it comes.
  const browserDriven = await browserTurnMarkerExists(dir);
  const window = browserDriven
    ? (opts?.activeLingerMs ?? activeLingerMs())
    : (opts?.lingerMs ?? lingerMs());
  const start = Date.now();

  for (;;) {
    const texts = await drainQueue(dir);
    if (texts.length > 0) {
      // A delivery is what MAKES the conversation browser-driven; keep
      // listening without a deadline after this turn too.
      await touchBrowserTurnMarker(dir);
      await hookDebug({ hook: 'stop', exit: 'delivered', n: texts.length });
      return { output: { decision: 'block', reason: formatBlockReason(texts) } };
    }
    if (await endMarkerExists(dir)) {
      await hookDebug({ hook: 'stop', exit: 'end-marker' });
      return {};
    }
    if (!(await bridgeAlive(dir))) {
      await hookDebug({ hook: 'stop', exit: 'bridge-dead' });
      return {};
    }
    // In normal (CLI-driven) mode, linger only while someone is
    // actually watching. In browser-driven mode, keep listening even
    // at zero viewers: a phone locking its screen drops the WebSocket
    // (and the attached count) between every reply — the remote user
    // is still mid-conversation.
    if (!browserDriven && (await readAttachedCount(dir)) === 0) {
      await hookDebug({ hook: 'stop', exit: 'no-viewers', browserDriven });
      return {};
    }
    // Browser-driven: the deadline is start + window (unlimited by
    // default). CLI mode: the finite window counts from the LATER of
    // the turn end and the last viewer attach/detach event — someone
    // who just opened the page gets a full window for their first
    // message, without the terminal ever being captured indefinitely.
    const deadline = browserDriven
      ? start + window
      : Math.max(start, (await attachedCountMtime(dir)) ?? 0) + window;
    if (Date.now() >= deadline) {
      await hookDebug({ hook: 'stop', exit: 'deadline', window });
      return {};
    }
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

/** Shape of AskUserQuestion's tool_input, parsed defensively. */
const AskToolInput = z.looseObject({ questions: z.array(QuestionItem) });

/** Render viewer answers as the deny reason Claude reads as the answer. */
export function formatAnswerReason(answers: readonly unknown[]): string {
  const parsed = z.array(QuestionAnswer).safeParse(answers);
  const items = parsed.success
    ? parsed.data.map((a) => `${a.header ?? a.question ?? 'answer'}: ${a.labels.join(', ')}`)
    : [JSON.stringify(answers)];
  const body = items.length === 1 ? (items[0] ?? '') : items.map((t) => `- ${t}`).join('\n');
  return `${OPENRC_MARKER} The user answered this question from the shared open-rc view (browser/tui). These ARE the user's answers — accept them and continue; do NOT ask again:\n\n${body}`;
}

/**
 * PreToolUse hook for AskUserQuestion. In browser-driven mode the
 * terminal is unattended, so its native selector would block the
 * session forever. Instead: park the question for the bridge (which
 * relays it to every viewer as a `question` frame), wait for a
 * viewer's answer, and return it as a deny reason — empirically
 * verified (2026-07-03) to reach Claude as the answer, with no
 * terminal selector shown. Esc cancels the wait like any hook, which
 * falls back to the native selector on Claude's next attempt.
 * In CLI-driven mode: no opinion, the native selector runs.
 */
export async function runAskHook(
  input: HookInput,
  opts?: { readonly baseDir?: string },
): Promise<HookResult> {
  const dir = attachDirFor(input.session_id, opts?.baseDir);
  if (!(await bridgeAlive(dir))) return {};
  if (!(await browserTurnMarkerExists(dir))) return {};

  const parsed = AskToolInput.safeParse(input.tool_input);
  if (!parsed.success || parsed.data.questions.length === 0) return {};

  const requestId = crypto.randomUUID();
  await writeQuestion(dir, { requestId, questions: parsed.data.questions });

  try {
    for (;;) {
      const answers = await readAnswer(dir, requestId);
      if (answers !== null) {
        await clearAnswer(dir, requestId);
        return {
          output: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: formatAnswerReason(answers),
            },
          },
        };
      }
      if (await endMarkerExists(dir)) return {};
      if (!(await bridgeAlive(dir))) return {};
      await sleep(LINGER_POLL_MS);
    }
  } finally {
    await clearQuestion(dir);
  }
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

/** CLI entry: `orc hook <event>` with hook JSON on stdin. */
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
          : event === 'ask'
            ? await runAskHook(input)
            : event === 'end'
              ? await runEndHook(input)
              : null;

  if (result === null) {
    console.error(`unknown hook event: ${event} (expected stop|prompt|notify|ask|end)`);
    return 2;
  }
  if (result.output) {
    console.log(JSON.stringify(result.output));
  }
  return 0;
}

/**
 * Filesystem contract between the transcript bridge (`open-rc
 * attach-orc`) and the Claude Code hook handlers (`orc hook …`).
 *
 * The two run as separate processes with no channel between them, so
 * they meet in a per-session state directory:
 *
 *   ~/.open-rc/attach/<sessionId>/
 *     bridge.json    heartbeat — bridge identity, refreshed every 15 s;
 *                    hooks treat a stale heartbeat as "no bridge" and
 *                    become no-ops
 *     attached.json  how many browsers/tui clients are watching
 *                    (bridge writes it from the server's `attached`
 *                    frames; the Stop hook lingers only when > 0)
 *     queue.ndjson   browser → session prompts, one JSON per line;
 *                    appended by the bridge, drained by the hooks
 *     stop.marker    touched by the Stop hook at every turn end; the
 *                    bridge turns it into a `done` frame
 *     end.marker     touched by the SessionEnd hook; tells the bridge
 *                    to unregister and exit
 *
 * Everything here is ephemeral coordination state, never conversation
 * data — the transcript stays the single source of truth.
 */

import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Heartbeat cadence for `bridge.json`. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** A heartbeat older than this means the bridge is gone. */
export const HEARTBEAT_STALE_MS = 45_000;

export function attachBaseDir(): string {
  return process.env.ORC_ATTACH_DIR ?? join(homedir(), '.open-rc', 'attach');
}

export function attachDirFor(sessionId: string, baseDir?: string): string {
  // Session ids come from hook stdin / file names; keep the path safe.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(baseDir ?? attachBaseDir(), safe);
}

const BridgeInfo = z.object({
  clientId: z.string(),
  server: z.string(),
  startedAt: z.number(),
  heartbeatAt: z.number(),
});
export type BridgeInfo = z.infer<typeof BridgeInfo>;

const AttachedInfo = z.object({ count: z.number().int().min(0), ts: z.number() });

const queuePath = (dir: string) => join(dir, 'queue.ndjson');
const queueDrainPath = (dir: string) => join(dir, 'queue.draining.ndjson');
const bridgePath = (dir: string) => join(dir, 'bridge.json');
const attachedPath = (dir: string) => join(dir, 'attached.json');
const stopPath = (dir: string) => join(dir, 'stop.marker');
const endPath = (dir: string) => join(dir, 'end.marker');

export async function createAttachDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // A previous bridge for this session may have died uncleanly; start
  // from a blank slate so stale queue entries don't replay into claude.
  for (const p of [
    queuePath(dir),
    queueDrainPath(dir),
    stopPath(dir),
    endPath(dir),
    browserTurnPath(dir),
    channelPath(dir),
    questionPath(dir),
    // A stale attached count from a dead bridge would make the Stop
    // hook linger for viewers that are no longer there.
    attachedPath(dir),
  ]) {
    await unlink(p).catch(() => {});
  }
  // Stale answers from a previous bridge are meaningless too.
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith('answer-')) await unlink(join(dir, name)).catch(() => {});
    }
  } catch {
    // fresh dir
  }
}

export async function removeAttachDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/* ----------------------------- bridge heartbeat --------------------------- */

export async function writeBridgeInfo(
  dir: string,
  info: Omit<BridgeInfo, 'heartbeatAt'>,
): Promise<void> {
  const full: BridgeInfo = { ...info, heartbeatAt: Date.now() };
  await writeFile(bridgePath(dir), JSON.stringify(full));
}

export async function readBridgeInfo(dir: string): Promise<BridgeInfo | null> {
  try {
    const raw = await readFile(bridgePath(dir), 'utf8');
    const parsed = BridgeInfo.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True while a bridge for this session is alive (fresh heartbeat). */
export async function bridgeAlive(dir: string): Promise<boolean> {
  const info = await readBridgeInfo(dir);
  if (!info) return false;
  return Date.now() - info.heartbeatAt < HEARTBEAT_STALE_MS;
}

/* ----------------------------- attached count ----------------------------- */

export async function writeAttachedCount(dir: string, count: number): Promise<void> {
  await writeFile(attachedPath(dir), JSON.stringify({ count, ts: Date.now() }));
}

export async function readAttachedCount(dir: string): Promise<number> {
  try {
    const raw = await readFile(attachedPath(dir), 'utf8');
    const parsed = AttachedInfo.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.count : 0;
  } catch {
    return 0;
  }
}

/** When the attached count last changed (epoch ms), or null if no
 *  viewer event has happened yet. The Stop hook counts its finite
 *  listening window from the LATER of turn end and this timestamp, so
 *  a viewer who just opened the page gets a full window to send a
 *  first message. */
export async function attachedCountMtime(dir: string): Promise<number | null> {
  try {
    const s = await stat(attachedPath(dir));
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/* ----------------------------- prompt queue -------------------------------- */

/** Append one browser prompt to the session's queue. */
export async function appendQueue(dir: string, text: string): Promise<void> {
  const line = `${JSON.stringify({ text, ts: Date.now() })}\n`;
  await writeFile(queuePath(dir), line, { flag: 'a' });
}

const QueueEntry = z.object({ text: z.string(), ts: z.number() });

function parseQueueLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .flatMap((l) => {
      try {
        const parsed = QueueEntry.safeParse(JSON.parse(l));
        return parsed.success ? [parsed.data.text] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Atomically take every queued prompt. The live queue file is renamed
 * aside before reading, so appends racing with the drain land in a
 * fresh queue file instead of being lost. A drain file left behind by
 * a crashed hook is recovered first.
 */
export async function drainQueue(dir: string): Promise<string[]> {
  const texts: string[] = [];

  // Recover a previous drain that died between rename and unlink.
  try {
    const leftover = await readFile(queueDrainPath(dir), 'utf8');
    texts.push(...parseQueueLines(leftover));
    await unlink(queueDrainPath(dir)).catch(() => {});
  } catch {
    // nothing to recover
  }

  try {
    await rename(queuePath(dir), queueDrainPath(dir));
  } catch {
    return texts; // no queue file — nothing new
  }

  try {
    const raw = await readFile(queueDrainPath(dir), 'utf8');
    texts.push(...parseQueueLines(raw));
  } catch {
    return texts;
  } finally {
    await unlink(queueDrainPath(dir)).catch(() => {});
  }

  return texts;
}

/** True if any prompt is waiting (cheap existence check, no drain). */
export async function queueNonEmpty(dir: string): Promise<boolean> {
  const check = async (p: string) => {
    try {
      const s = await stat(p);
      return s.size > 0;
    } catch {
      return false;
    }
  };
  return (await check(queuePath(dir))) || (await check(queueDrainPath(dir)));
}

/* ----------------------------- markers ------------------------------------ */

async function touchMarker(path: string): Promise<void> {
  await writeFile(path, String(Date.now()));
}

async function markerMtime(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

export const touchStopMarker = (dir: string) => touchMarker(stopPath(dir));
export const stopMarkerMtime = (dir: string) => markerMtime(stopPath(dir));
export const touchEndMarker = (dir: string) => touchMarker(endPath(dir));
export const endMarkerExists = async (dir: string) => (await markerMtime(endPath(dir))) !== null;

/* ----------------------------- question / answer -------------------------- */

const questionPath = (dir: string) => join(dir, 'question.json');
const answerPath = (dir: string, requestId: string) =>
  join(dir, `answer-${requestId.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);

const PendingQuestion = z.object({
  requestId: z.string(),
  questions: z.array(z.unknown()),
  ts: z.number(),
});
export type PendingQuestion = z.infer<typeof PendingQuestion>;

/** The `ask` hook parks the live AskUserQuestion here; the bridge
 *  relays it to viewers as a `question` frame. */
export async function writeQuestion(
  dir: string,
  q: { requestId: string; questions: unknown[] },
): Promise<void> {
  await writeFile(questionPath(dir), JSON.stringify({ ...q, ts: Date.now() }));
}

export async function readQuestion(dir: string): Promise<PendingQuestion | null> {
  try {
    const raw = await readFile(questionPath(dir), 'utf8');
    const parsed = PendingQuestion.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const clearQuestion = async (dir: string) => {
  await unlink(questionPath(dir)).catch(() => {});
};

/** The bridge parks a viewer's `question_response` here; the waiting
 *  `ask` hook consumes it as the answer. */
export async function writeAnswer(
  dir: string,
  requestId: string,
  answers: unknown[],
): Promise<void> {
  await writeFile(answerPath(dir, requestId), JSON.stringify({ answers }));
}

export async function readAnswer(dir: string, requestId: string): Promise<unknown[] | null> {
  try {
    const raw = await readFile(answerPath(dir, requestId), 'utf8');
    const parsed = JSON.parse(raw) as { answers?: unknown[] };
    return Array.isArray(parsed.answers) ? parsed.answers : null;
  } catch {
    return null;
  }
}

export const clearAnswer = async (dir: string, requestId: string) => {
  await unlink(answerPath(dir, requestId)).catch(() => {});
};

/* ----------------------------- channel marker ----------------------------- */

const channelPath = (dir: string) => join(dir, 'channel.marker');

/** Present while the session is bridged by `orc channel` (an MCP
 *  channel server claude itself spawned). Browser prompts then reach
 *  the session as channel notifications — instantly, even while it is
 *  idle — so the Stop hook must NOT linger polling the queue: the
 *  queue is never written in channel mode, and any linger would only
 *  capture the terminal for nothing. */
export const touchChannelMarker = (dir: string) => touchMarker(channelPath(dir));
/** Removed when the channel bridge discovers the session was started
 *  WITHOUT the channels flag: delivery falls back to the hook queue,
 *  so the Stop hook must linger and drain like a plain `/orc` share. */
export const removeChannelMarker = async (dir: string) => {
  await unlink(channelPath(dir)).catch(() => {});
};
export const channelMarkerExists = async (dir: string) =>
  (await markerMtime(channelPath(dir))) !== null;

/* ----------------------------- browser-turn marker ------------------------ */

const browserTurnPath = (dir: string) => join(dir, 'browser-turn.marker');

/** Present while the LAST turn was driven from the browser/tui. The
 *  Stop hook uses it to pick the long listening window (the terminal
 *  user is probably remote); a real CLI prompt clears it (the
 *  terminal user is back — keep their prompts snappy). */
export const touchBrowserTurnMarker = (dir: string) => touchMarker(browserTurnPath(dir));
export const clearBrowserTurnMarker = async (dir: string) => {
  await unlink(browserTurnPath(dir)).catch(() => {});
};
export const browserTurnMarkerExists = async (dir: string) =>
  (await markerMtime(browserTurnPath(dir))) !== null;

/** List session ids that currently have an attach dir. */
export async function listAttachSessions(baseDir?: string): Promise<string[]> {
  try {
    return await readdir(baseDir ?? attachBaseDir());
  } catch {
    return [];
  }
}

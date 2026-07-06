/**
 * Late transcript discovery for `orc channel`.
 *
 * Claude Code spawns the channel MCP server at session START — before
 * the session has written a single transcript line (a brand-new
 * session creates its JSONL only at the first prompt). So unlike
 * `orc attach`, the channel cannot resolve "the newest transcript of
 * this cwd" at boot: the newest one on disk belongs to a PREVIOUS
 * session.
 *
 * Instead the channel polls the project transcript dir for the first
 * `*.jsonl` whose mtime is NEWER than the channel's own start time.
 * The session that spawned us is the one writing to disk after we
 * came up — a new session's first prompt, or a resumed session's
 * first activity, both qualify.
 *
 * Known limitation (documented, accepted for the PoC): two sessions
 * started concurrently in the same cwd can race this heuristic; the
 * channel adopts whichever writes first.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type LocatedTranscript, projectTranscriptDir, sessionIdOf } from '../transcript/locate.ts';

const DEFAULT_POLL_MS = 1_000;

export interface DiscoverOptions {
  /** Project cwd whose session transcript to wait for. */
  readonly cwd: string;
  /** Only transcripts modified strictly after this epoch ms qualify. */
  readonly sinceMs: number;
  /** `~/.claude` override (tests). */
  readonly claudeHome?: string;
  /** Poll cadence override (tests). */
  readonly pollMs?: number;
  /** Returns true when the wait should be abandoned (shutdown). */
  readonly cancelled?: () => boolean;
}

/** One scan: the newest `*.jsonl` in the project dir modified after
 *  `sinceMs`, or null. Exported for tests. */
export async function scanForNewTranscript(
  cwd: string,
  sinceMs: number,
  claudeHome?: string,
): Promise<LocatedTranscript | null> {
  const dir = projectTranscriptDir(cwd, claudeHome);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // project dir not created yet
  }

  let newest: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (!s.isFile() || s.mtimeMs <= sinceMs) continue;
      if (!newest || s.mtimeMs > newest.mtime) newest = { path, mtime: s.mtimeMs };
    } catch {
      // raced with deletion; skip
    }
  }

  if (!newest) return null;
  return { path: newest.path, sessionId: sessionIdOf(newest.path) };
}

/**
 * Poll until the session that spawned us starts writing its
 * transcript. Resolves with the located transcript, or null if
 * cancelled first.
 */
export async function waitForNewTranscript(
  opts: DiscoverOptions,
): Promise<LocatedTranscript | null> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    if (opts.cancelled?.() === true) return null;
    const found = await scanForNewTranscript(opts.cwd, opts.sinceMs, opts.claudeHome);
    if (found) return found;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

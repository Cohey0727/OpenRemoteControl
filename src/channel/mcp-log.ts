/**
 * Read Claude Code's own MCP debug log for the orc channel server.
 *
 * Claude Code (the node CLI) writes a per-connection JSONL debug log
 * for every MCP server it spawns:
 *
 *   <cache>/claude-cli-nodejs/<munged cwd>/mcp-logs-orc/<ts>.jsonl
 *
 * where `<cache>` is `~/Library/Caches` on macOS and `$XDG_CACHE_HOME`
 * (default `~/.cache`) elsewhere. Two lines in it answer questions the
 * MCP protocol itself never answers:
 *
 *   - `"Channel notifications registered"` — the session was started
 *     with `--dangerously-load-development-channels server:orc`;
 *     channel delivery works.
 *   - `"Channel notifications skipped: server orc not in --channels
 *     list for this session"` — the flag is missing; every channel
 *     notification we send will be dropped SILENTLY. The bridge falls
 *     back to hook-queue delivery when it sees this.
 *
 * Every line also carries the `sessionId` — known here the moment
 * claude connects, long before the session writes its first transcript
 * line. The bridge uses it to pin transcript discovery to the exact
 * session that spawned us (killing the same-cwd adoption race).
 *
 * Read-only and best-effort: the path and format are Claude Code
 * internals, so absence or a format change simply returns null and the
 * bridge keeps its previous (heuristic) behavior.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mungeCwd } from '../transcript/locate.ts';
import { CHANNEL_SERVER_NAME } from './mcp.ts';

/** The connection log is created by claude just BEFORE it spawns us,
 *  so "newer than our own start" needs a little slack backwards. */
const LOG_MTIME_SLACK_MS = 60_000;

const DEFAULT_POLL_MS = 1_000;
/** Claude logs the registered/skipped line immediately after the MCP
 *  handshake; if nothing readable shows up for this long, the CLI
 *  version probably doesn't write these logs — stop polling. */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ChannelSessionInfo {
  /** Session id claude reported in the log, if any line carried one. */
  readonly sessionId: string | null;
  /** true = channel registered; false = skipped (flag missing);
   *  null = the log said neither (yet). */
  readonly channelEnabled: boolean | null;
}

/** Platform cache root claude-cli-nodejs lives under. */
function cacheRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
}

/** The mcp-logs dir for our server in a given project cwd. */
export function channelMcpLogDir(cwd: string, cacheHome?: string): string {
  return join(
    cacheHome ?? cacheRoot(),
    'claude-cli-nodejs',
    mungeCwd(cwd),
    `mcp-logs-${CHANNEL_SERVER_NAME}`,
  );
}

/** Parse one connection log's lines into a ChannelSessionInfo. */
export function parseChannelMcpLog(content: string): ChannelSessionInfo {
  let sessionId: string | null = null;
  let channelEnabled: boolean | null = null;
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let entry: { debug?: unknown; sessionId?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (typeof entry.sessionId === 'string' && entry.sessionId !== '') {
      sessionId = entry.sessionId;
    }
    if (typeof entry.debug !== 'string') continue;
    if (entry.debug.includes('Channel notifications registered')) channelEnabled = true;
    else if (entry.debug.includes('Channel notifications skipped')) channelEnabled = false;
  }
  return { sessionId, channelEnabled };
}

/**
 * One scan: the newest connection log written around/after `sinceMs`,
 * parsed. Returns null when the dir or a fresh-enough log is missing,
 * or when the log exists but has not yet said anything useful.
 */
export async function scanChannelMcpLog(
  cwd: string,
  sinceMs: number,
  cacheHome?: string,
): Promise<ChannelSessionInfo | null> {
  const dir = channelMcpLogDir(cwd, cacheHome);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  let newest: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (!s.isFile() || s.mtimeMs <= sinceMs - LOG_MTIME_SLACK_MS) continue;
      if (!newest || s.mtimeMs > newest.mtime) newest = { path, mtime: s.mtimeMs };
    } catch {
      // raced with deletion; skip
    }
  }
  if (!newest) return null;

  let content: string;
  try {
    content = await readFile(newest.path, 'utf8');
  } catch {
    return null;
  }
  const info = parseChannelMcpLog(content);
  // "Useful" = at least the enablement verdict; the sessionId alone
  // rides along with it in the same line batch.
  return info.channelEnabled === null && info.sessionId === null ? null : info;
}

export interface WaitForChannelMcpLogOptions {
  readonly cwd: string;
  /** Bridge start time; logs written well before it are ignored. */
  readonly sinceMs: number;
  /** Cache-root override (tests). */
  readonly cacheHome?: string;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly cancelled?: () => boolean;
}

/**
 * Poll for our own connection log until it reports the channel
 * verdict, the timeout passes (old CLI / moved path — give up and keep
 * heuristic behavior), or the wait is cancelled.
 */
export async function waitForChannelMcpLog(
  opts: WaitForChannelMcpLogOptions,
): Promise<ChannelSessionInfo | null> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    if (opts.cancelled?.() === true) return null;
    const info = await scanChannelMcpLog(opts.cwd, opts.sinceMs, opts.cacheHome);
    if (info?.channelEnabled !== null && info !== null) return info;
    if (Date.now() >= deadline) return info;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * `orc channel` — share a Claude Code session through the Channels
 * mechanism (research preview) instead of the hook queue.
 *
 * This process is spawned BY claude (it is an MCP server listed in
 * the user's `mcpServers` config and enabled per session with
 * `claude --dangerously-load-development-channels server:orc`), so
 * open-rc's no-spawn rule holds: claude owns this process, not us.
 *
 * Composition — two halves glued back to back:
 *
 *   MCP (stdio, ../channel/mcp.ts)      bridge (WS /agent, attach.ts)
 *   ─ notifications/claude/channel  ←   `prompt` frames from viewers
 *   ─ permission_request notif      →   `permission_request` frames
 *   ─ permission verdict notif      ←   `permission_response` frames
 *   claude session ──────────────── transcript ──→ replay + live tail
 *
 * Versus `/orc` (attach + hooks): browser prompts land INSTANTLY,
 * even while the session is idle — no Stop-hook window, no queue, no
 * terminal capture — and tool-approval dialogs relay to the browser.
 * The price: it must be enabled when the session STARTS; use `/orc`
 * to share a session after the fact.
 *
 * stdout belongs to the MCP transport — every log goes to stderr.
 */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { type ChannelMcp, type ChannelMcpOptions, makeChannelMcp } from '../channel/mcp.ts';
import { type AttachOrcHandle, agentUrlFromBase, runAttachOrc } from './attach.ts';
import { parseFlags } from './flags.ts';

/** Backoff between /agent registration attempts: claude may well be
 *  started before `orc serve` is up, and the channel must simply keep
 *  trying rather than die with the session still running. */
const REGISTER_RETRY_MS = 10_000;

export interface ChannelCliFlags {
  /** `/agent` WebSocket URL of the orc server. */
  server: string;
  /** Sidebar label. */
  label: string;
  /** Project cwd (claude spawns MCP servers in the project dir). */
  cwd: string;
  /** Explicit clientId (defaults to a stable per-host/cwd id). */
  clientId: string;
}

/**
 * Stable clientId for a project's channel: same host + cwd → same id,
 * so browser deep links survive session restarts. (The session id
 * itself can't serve here — it isn't known until the session writes
 * its transcript, long after registration.)
 */
export function stableChannelClientId(host: string, cwd: string): string {
  const digest = createHash('sha256').update(`${host}:${cwd}`).digest('hex');
  return `ch-${digest.slice(0, 12)}`;
}

export function parseChannelFlags(argv: string[]): ChannelCliFlags {
  const flags = parseFlags(argv);
  const explicit = typeof flags.server === 'string' ? flags.server : undefined;
  const server = agentUrlFromBase(explicit ?? process.env.ORC_BASE_URL ?? 'ws://127.0.0.1:7322');
  const cwd = typeof flags.cwd === 'string' ? resolve(flags.cwd) : process.cwd();
  const label =
    typeof flags.label === 'string'
      ? flags.label
      : `${process.env.USER ?? 'user'}@${hostname()} (channel)`;
  const clientId =
    typeof flags.clientId === 'string' ? flags.clientId : stableChannelClientId(hostname(), cwd);
  return { server, label, cwd, clientId };
}

export interface RunChannelOptions {
  /** Log sink (stderr). */
  readonly log?: (line: string) => void;
  /** Called once everything is torn down (claude closed the pipe or
   *  the session ended). */
  readonly onExit?: () => void;
  /** Test injection: build a fake MCP half (receives the same wiring
   *  callbacks the real one gets). */
  readonly mcpFactory?: (mcpOpts: ChannelMcpOptions) => ChannelMcp;
  /** Attach-state base dir override (tests). */
  readonly attachBaseDir?: string;
  /** `~/.claude` override for transcript discovery (tests). */
  readonly claudeHome?: string;
  /** Registration retry backoff override (tests). */
  readonly registerRetryMs?: number;
  /** Transcript-discovery poll cadence override (tests). */
  readonly discoverPollMs?: number;
}

export interface ChannelHandle {
  stop(): Promise<void>;
}

export async function runChannel(
  flags: ChannelCliFlags,
  opts: RunChannelOptions = {},
): Promise<ChannelHandle> {
  const log = opts.log ?? ((line: string) => console.error(line));
  let bridge: AttachOrcHandle | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log(`orc channel: shutting down (${reason})`);
    if (retryTimer) clearTimeout(retryTimer);
    await bridge?.stop().catch(() => {});
    await mcp.close().catch(() => {});
    opts.onExit?.();
  };

  const mcpOpts: ChannelMcpOptions = {
    onPermissionRequest: (req) => {
      // Mirror the dialog to every attached viewer. Dropped silently
      // while the /agent link is down — the terminal dialog stays.
      bridge?.send({
        type: 'permission_request',
        requestId: req.requestId,
        tool: req.tool,
        input: { description: req.description, preview: req.inputPreview },
      });
    },
    onClose: () => {
      // stdio closed: claude exited (or dropped us). Nothing to
      // linger for — the session is gone.
      void stop('mcp transport closed');
    },
  };
  const mcp = (opts.mcpFactory ?? makeChannelMcp)(mcpOpts);

  // Connect stdio FIRST: claude is waiting on the MCP handshake, and
  // it must succeed even when `orc serve` isn't reachable yet.
  await mcp.connect();

  // Register on /agent with endless retry (claude may outlive relay
  // restarts, and may have been started before the relay).
  const startBridge = async (): Promise<void> => {
    if (stopped) return;
    try {
      bridge = await runAttachOrc(
        { server: flags.server, label: flags.label, cwd: flags.cwd, clientId: flags.clientId },
        {
          log,
          ...(opts.attachBaseDir !== undefined ? { attachBaseDir: opts.attachBaseDir } : {}),
          ...(opts.claudeHome !== undefined ? { claudeHome: opts.claudeHome } : {}),
          onExit: () => {
            // SessionEnd marker: the session is over, exit with it.
            void stop('session ended');
          },
          channel: {
            onPrompt: (text) => mcp.notifyPrompt(text),
            onPermissionResponse: (requestId, approved) =>
              mcp.notifyPermissionVerdict(requestId, approved),
            ...(opts.discoverPollMs !== undefined ? { discoverPollMs: opts.discoverPollMs } : {}),
          },
        },
      );
    } catch (err) {
      const wait = opts.registerRetryMs ?? REGISTER_RETRY_MS;
      log(
        `orc channel: registration failed (${err instanceof Error ? err.message : err}) — ` +
          `retrying in ${Math.round(wait / 1000)}s`,
      );
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void startBridge();
      }, wait);
    }
  };
  await startBridge();

  return { stop: () => stop('stopped') };
}

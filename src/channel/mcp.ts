/**
 * The MCP half of `orc channel` — a Claude Code CHANNEL server
 * (research preview, claude v2.1.80+).
 *
 * Claude Code spawns this process itself (it is listed under
 * `mcpServers` and named in `--dangerously-load-development-channels
 * server:orc`) and talks JSON-RPC over stdio. Declaring the
 * `claude/channel` capability turns the MCP connection into a push
 * channel: every `notifications/claude/channel` we emit is injected
 * into the running session as a `<channel source="orc">` event —
 * immediately, even while the session sits idle. That property is
 * what the hook-based delivery path could never have (Issue #11).
 *
 * `claude/channel/permission` additionally opts in to permission
 * relay (v2.1.81+): Claude Code mirrors every tool-approval dialog to
 * us as a `permission_request` notification, and accepts an
 * allow/deny verdict back — first answer (terminal or remote) wins.
 *
 * open-rc still spawns nothing: the spawning is done BY claude's own
 * MCP machinery, exactly like any other MCP server the user installs.
 *
 * IMPORTANT: stdout is the MCP transport. Nothing in the channel
 * process may print to stdout; all logging goes to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

/** The MCP server name claude must know us by: it is the `source`
 *  attribute of injected `<channel>` tags (the transcript-side
 *  delivery confirmation greps for it) and the `server:orc` entry in
 *  `--dangerously-load-development-channels`. */
export const CHANNEL_SERVER_NAME = 'orc';

/** Added to Claude's system prompt so channel events are handled as
 *  what they are: prompts from the shared open-rc view. */
export const CHANNEL_INSTRUCTIONS = [
  `Events from the ${CHANNEL_SERVER_NAME} channel arrive as`,
  `<channel source="${CHANNEL_SERVER_NAME}"> messages. Each one is a prompt from the person`,
  'driving this session remotely through open-rc (a browser or tui view of this very session).',
  'The sender watches your full output stream live, so treat every event exactly as a prompt',
  'typed into this session and respond normally in the conversation. There is no reply tool',
  'and none is needed — your regular response is what the sender sees.',
].join(' ');

/** One mirrored tool-approval dialog (permission relay). */
export interface RelayedPermissionRequest {
  readonly requestId: string;
  readonly tool: string;
  readonly description: string;
  readonly inputPreview: string;
}

/** `notifications/claude/channel/permission_request` — sent by Claude
 *  Code (not Claude) when a permission dialog opens. The zod literal
 *  doubles as the SDK's dispatch key. */
const PermissionRequestNotification = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export interface ChannelMcpOptions {
  /** A permission dialog opened — relay it to the viewers. */
  readonly onPermissionRequest: (req: RelayedPermissionRequest) => void;
  /** stdio transport closed — claude is gone, shut the bridge down. */
  readonly onClose: () => void;
}

export interface ChannelMcp {
  /** Push one viewer prompt into the session (idle or not). */
  readonly notifyPrompt: (text: string) => Promise<void>;
  /** Answer a mirrored permission dialog. */
  readonly notifyPermissionVerdict: (requestId: string, approved: boolean) => Promise<void>;
  /** Connect the transport — stdio by default (claude is the other
   *  end); tests pass an in-memory transport. */
  readonly connect: (transport?: Transport) => Promise<void>;
  /** Close the transport (shutdown path). */
  readonly close: () => Promise<void>;
}

export function makeChannelMcp(opts: ChannelMcpOptions): ChannelMcp {
  const mcp = new Server(
    { name: CHANNEL_SERVER_NAME, version: '0.1.0' },
    {
      capabilities: {
        experimental: {
          // Presence registers the channel listener in Claude Code.
          'claude/channel': {},
          // Opt in to permission relay. Safe here: verdicts only come
          // from viewers the relay already authenticated (/ws), and
          // /agent bridges can only reach their own session.
          'claude/channel/permission': {},
        },
      },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  );

  mcp.setNotificationHandler(PermissionRequestNotification, ({ params }) => {
    opts.onPermissionRequest({
      requestId: params.request_id,
      tool: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    });
  });

  mcp.onclose = () => {
    opts.onClose();
  };

  return {
    async notifyPrompt(text: string): Promise<void> {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: text },
      });
    },
    async notifyPermissionVerdict(requestId: string, approved: boolean): Promise<void> {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: requestId, behavior: approved ? 'allow' : 'deny' },
      });
    },
    async connect(transport?: Transport): Promise<void> {
      await mcp.connect(transport ?? new StdioServerTransport());
    },
    async close(): Promise<void> {
      await mcp.close();
    },
  };
}

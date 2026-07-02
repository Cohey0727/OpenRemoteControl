/**
 * Wire protocol between the browser SPA, the open-rc server, and the
 * user-owned bridge (whatever pipes `claude`'s `stream-json` to a
 * WebSocket).
 *
 * Two WebSocket routes on the server, two protocol surfaces:
 *
 *   - `/ws`     — browsers connect here. See `BrowserClientMessage` /
 *                 `ServerBrowserMessage` below.
 *   - `/agent`  — bridges connect here. See `BridgeToServer` /
 *                 `ServerToBridge` below.
 *
 * The server's only job is to relay between the two. It does not
 * interpret `stream-json` (the bridge does that translation before
 * speaking `/agent`), and it does not own any `claude` process.
 *
 * Browser-perceived client state is described by `ClientInfo`; a client
 * is one connected bridge. The server tags every frame it relays
 * bridge → browser with the source `clientId`.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Client metadata                                                            */
/* -------------------------------------------------------------------------- */

export const ClientStatus = z.enum(['idle', 'busy', 'exited', 'errored']);
export type ClientStatus = z.infer<typeof ClientStatus>;

export const ClientInfo = z.object({
  clientId: z.string().min(1),
  label: z.string(),
  cwd: z.string(),
  status: ClientStatus,
  lastActivity: z.number(),
  connectedAt: z.number(),
});
export type ClientInfo = z.infer<typeof ClientInfo>;

/**
 * Server-side bookkeeping for one connected bridge.
 *
 * Not part of the wire protocol — this lives only on the server. The
 * `ws` field is the live ServerWebSocket for the bridge. `info()`
 * projects this down to the public `ClientInfo` shape that browsers see.
 */
export interface BridgeConn {
  readonly clientId: string;
  label: string;
  cwd: string;
  status: ClientStatus;
  lastActivity: number;
  readonly connectedAt: number;
  readonly ws: unknown;
  /**
   * Bounded in-memory replay buffer of the conversation frames this
   * client has relayed (text / thinking / tool_use / tool_result / done
   * / error) plus echoed `user` prompts — NOT `permission_request`
   * (transient). Replayed to a browser/tui on attach so a reload or a
   * late joiner sees recent history. Ephemeral: dropped when the bridge
   * disconnects and never written to disk.
   */
  history: RelayedMessage[];
  /**
   * The most recent terminal screen (from an `attach-tmux` bridge), or
   * null for a normal conversation bridge. Kept OUTSIDE `history` (only
   * the latest screen matters, and screens are large) but replayed on
   * attach so a late joiner sees the current terminal even when the
   * mirrored pane is momentarily static and sends no new `screen` frame.
   */
  latestScreen: string | null;
  info(): ClientInfo;
}

/* -------------------------------------------------------------------------- */
/*  Browser ↔ Server (`/ws`)                                                   */
/* -------------------------------------------------------------------------- */

export const ListClients = z.object({
  type: z.literal('list_clients'),
});
export type ListClients = z.infer<typeof ListClients>;

export const Attach = z.object({
  type: z.literal('attach'),
  clientId: z.string().min(1),
});
export type Attach = z.infer<typeof Attach>;

export const Detach = z.object({
  type: z.literal('detach'),
  clientId: z.string().min(1),
});
export type Detach = z.infer<typeof Detach>;

export const SendPrompt = z.object({
  type: z.literal('send'),
  clientId: z.string().min(1),
  text: z.string().min(1),
});
export type SendPrompt = z.infer<typeof SendPrompt>;

export const PermissionResponse = z.object({
  type: z.literal('permission_response'),
  clientId: z.string().min(1),
  requestId: z.string().min(1),
  approved: z.boolean(),
});
export type PermissionResponse = z.infer<typeof PermissionResponse>;

export const BrowserClientMessage = z.discriminatedUnion('type', [
  ListClients,
  Attach,
  Detach,
  SendPrompt,
  PermissionResponse,
]);
export type BrowserClientMessage = z.infer<typeof BrowserClientMessage>;

/* ---------- Server → Browser ---------- */

/** Sent in reply to `list_clients` and on every list change. */
export const ClientListMessage = z.object({
  type: z.literal('client_list'),
  clients: z.array(ClientInfo),
});
export type ClientListMessage = z.infer<typeof ClientListMessage>;

/** Broadcast when a new bridge connects and registers. */
export const ClientRegisteredMessage = z.object({
  type: z.literal('client_registered'),
  client: ClientInfo,
});
export type ClientRegisteredMessage = z.infer<typeof ClientRegisteredMessage>;

/** Broadcast when a bridge disconnects. */
export const ClientRemovedMessage = z.object({
  type: z.literal('client_removed'),
  clientId: z.string(),
});
export type ClientRemovedMessage = z.infer<typeof ClientRemovedMessage>;

/**
 * Broadcast when any client's `status` or `lastActivity` changes.
 * UI updates the sidebar from this; no polling.
 */
export const ClientsChangedMessage = z.object({
  type: z.literal('clients_changed'),
  clients: z.array(ClientInfo),
});
export type ClientsChangedMessage = z.infer<typeof ClientsChangedMessage>;

/* Per-client frames relayed from bridge → browser. The server adds
   `clientId`; the bridge never sends it. */

const WithClientId = z.object({ clientId: z.string() });

/**
 * A human prompt, echoed by the server to EVERY client attached to the
 * clientId (not just the sender). This is what keeps a shared session
 * in sync: when the browser or a `tui` client sends `send`, all views
 * render the same "you" turn instead of only the sender's optimistic copy.
 */
export const UserMessage = WithClientId.extend({
  type: z.literal('user'),
  text: z.string(),
});
export type UserMessage = z.infer<typeof UserMessage>;

export const TextMessage = WithClientId.extend({
  type: z.literal('text'),
  text: z.string(),
});
export type TextMessage = z.infer<typeof TextMessage>;

/**
 * A streaming fragment of the assistant's in-progress text (from
 * `claude --include-partial-messages`). Relayed live to attached
 * clients but NEVER recorded to history: the final `text` frame
 * carries the complete content, so replaying deltas would render the
 * reply twice.
 */
export const TextDeltaMessage = WithClientId.extend({
  type: z.literal('text_delta'),
  text: z.string(),
});
export type TextDeltaMessage = z.infer<typeof TextDeltaMessage>;

/**
 * A full snapshot of a terminal screen (from `tmux capture-pane`),
 * used by the `attach-tmux` bridge to mirror an existing interactive
 * `claude` running in a tmux pane. Like `text_delta` it is live-only:
 * only the latest screen matters, so it is relayed to attached clients
 * but never recorded to the replay buffer (a stale screen would flash
 * on attach and then be overwritten by the next poll anyway).
 */
export const ScreenMessage = WithClientId.extend({
  type: z.literal('screen'),
  text: z.string(),
});
export type ScreenMessage = z.infer<typeof ScreenMessage>;

export const ThinkingMessage = WithClientId.extend({
  type: z.literal('thinking'),
  text: z.string(),
});
export type ThinkingMessage = z.infer<typeof ThinkingMessage>;

export const ToolUseMessage = WithClientId.extend({
  type: z.literal('tool_use'),
  tool: z.string(),
  input: z.string(),
});
export type ToolUseMessage = z.infer<typeof ToolUseMessage>;

export const ToolResultMessage = WithClientId.extend({
  type: z.literal('tool_result'),
  output: z.string(),
});
export type ToolResultMessage = z.infer<typeof ToolResultMessage>;

export const PermissionRequestMessage = WithClientId.extend({
  type: z.literal('permission_request'),
  requestId: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type PermissionRequestMessage = z.infer<typeof PermissionRequestMessage>;

export const DoneMessage = WithClientId.extend({
  type: z.literal('done'),
  cost: z.number().optional(),
  duration_ms: z.number().optional(),
  /** Epoch ms when the turn completed. Stamped by the server if the
   *  bridge doesn't provide one, so replayed history keeps the
   *  original completion time. */
  ts: z.number().optional(),
});
export type DoneMessage = z.infer<typeof DoneMessage>;

export const ErrorMessage = WithClientId.extend({
  type: z.literal('error'),
  message: z.string(),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const RelayedMessage = z.discriminatedUnion('type', [
  UserMessage,
  TextMessage,
  TextDeltaMessage,
  ThinkingMessage,
  ToolUseMessage,
  ToolResultMessage,
  PermissionRequestMessage,
  DoneMessage,
  ErrorMessage,
  ScreenMessage,
]);
export type RelayedMessage = z.infer<typeof RelayedMessage>;

/** Server → browser. Anything except `RelayedMessage` is server-originated. */
export const ServerBrowserMessage = z.discriminatedUnion('type', [
  ClientListMessage,
  ClientRegisteredMessage,
  ClientRemovedMessage,
  ClientsChangedMessage,
  UserMessage,
  TextMessage,
  TextDeltaMessage,
  ThinkingMessage,
  ToolUseMessage,
  ToolResultMessage,
  PermissionRequestMessage,
  DoneMessage,
  ErrorMessage,
  ScreenMessage,
]);
export type ServerBrowserMessage = z.infer<typeof ServerBrowserMessage>;

/* -------------------------------------------------------------------------- */
/*  Bridge ↔ Server (`/agent`)                                                 */
/* -------------------------------------------------------------------------- */

/** First frame a bridge sends on connect. */
export const Register = z.object({
  type: z.literal('register'),
  clientId: z.string().optional(),
  label: z.string().min(1),
  cwd: z.string().min(1),
});
export type Register = z.infer<typeof Register>;

/** Optional explicit goodbye. Connection close also removes the client. */
export const Unregister = z.object({
  type: z.literal('unregister'),
});
export type Unregister = z.infer<typeof Unregister>;

/** Update the client's `status` field (idle/busy/etc). */
export const StatusUpdate = z.object({
  type: z.literal('status'),
  status: ClientStatus,
});
export type StatusUpdate = z.infer<typeof StatusUpdate>;

/** Frames forwarded to attached browsers. The server adds `clientId`. */
export const BridgeFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('screen'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    tool: z.string(),
    input: z.string(),
  }),
  z.object({ type: z.literal('tool_result'), output: z.string() }),
  z.object({
    type: z.literal('permission_request'),
    requestId: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('done'),
    cost: z.number().optional(),
    duration_ms: z.number().optional(),
    ts: z.number().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type BridgeFrame = z.infer<typeof BridgeFrame>;

/** Bridge → server. */
export const BridgeToServer = z.discriminatedUnion('type', [
  Register,
  Unregister,
  StatusUpdate,
  BridgeFrame,
]);
export type BridgeToServer = z.infer<typeof BridgeToServer>;

/** Server → bridge (relayed from attached browsers). */
export const PromptMessage = z.object({
  type: z.literal('prompt'),
  text: z.string(),
});
export type PromptMessage = z.infer<typeof PromptMessage>;

export const ServerToBridge = z.discriminatedUnion('type', [
  PromptMessage,
  z.object({
    type: z.literal('permission_response'),
    requestId: z.string(),
    approved: z.boolean(),
  }),
]);
export type ServerToBridge = z.infer<typeof ServerToBridge>;

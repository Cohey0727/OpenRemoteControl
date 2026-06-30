/**
 * WebSocket protocol between the SPA UI and the open-rc server.
 *
 * Adopted shape from `zhdzh12138/pocket-claude`, with one divergence we
 * decided on:
 *   - `permission_request` and `permission_response` are wired through
 *     even though our v0.1 uses `--permission-mode bypassPermissions`.
 *     They are no-ops today; Phase 2 will implement them for real.
 */

import { z } from 'zod';

/* ----------------------------- Client → Server ---------------------------- */

/** UI attaches to a session and starts receiving its events. */
export const Attach = z.object({
  type: z.literal('attach'),
  sessionId: z.string().min(1),
});
export type Attach = z.infer<typeof Attach>;

/** UI stops receiving a session's events (does not kill the session). */
export const Detach = z.object({
  type: z.literal('detach'),
  sessionId: z.string().min(1),
});
export type Detach = z.infer<typeof Detach>;

/** UI sends a prompt to a session. */
export const Send = z.object({
  type: z.literal('send'),
  sessionId: z.string().min(1),
  text: z.string().min(1),
  projectPath: z.string().optional(),
});
export type Send = z.infer<typeof Send>;

/** UI replies to a permission prompt. */
export const PermissionResponse = z.object({
  type: z.literal('permission_response'),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  approved: z.boolean(),
});
export type PermissionResponse = z.infer<typeof PermissionResponse>;

export const WsClientMessage = z.discriminatedUnion('type', [
  Attach,
  Detach,
  Send,
  PermissionResponse,
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

/* ----------------------------- Server → Client ---------------------------- */

const BaseServer = z.object({ sessionId: z.string().min(1) });

export const TextMessage = BaseServer.extend({
  type: z.literal('text'),
  text: z.string(),
});
export type TextMessage = z.infer<typeof TextMessage>;

export const ThinkingMessage = BaseServer.extend({
  type: z.literal('thinking'),
  text: z.string(),
});
export type ThinkingMessage = z.infer<typeof ThinkingMessage>;

export const ToolUseMessage = BaseServer.extend({
  type: z.literal('tool_use'),
  tool: z.string(),
  input: z.string(),
});
export type ToolUseMessage = z.infer<typeof ToolUseMessage>;

export const ToolResultMessage = BaseServer.extend({
  type: z.literal('tool_result'),
  output: z.string(),
});
export type ToolResultMessage = z.infer<typeof ToolResultMessage>;

export const PermissionRequestMessage = BaseServer.extend({
  type: z.literal('permission_request'),
  requestId: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type PermissionRequestMessage = z.infer<typeof PermissionRequestMessage>;

export const DoneMessage = BaseServer.extend({
  type: z.literal('done'),
  cost: z.number().optional(),
  duration_ms: z.number().optional(),
});
export type DoneMessage = z.infer<typeof DoneMessage>;

export const ErrorMessage = BaseServer.extend({
  type: z.literal('error'),
  message: z.string(),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const WsServerMessage = z.discriminatedUnion('type', [
  TextMessage,
  ThinkingMessage,
  ToolUseMessage,
  ToolResultMessage,
  PermissionRequestMessage,
  DoneMessage,
  ErrorMessage,
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

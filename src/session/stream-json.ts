/**
 * Parser for `claude --bare --output-format stream-json` stdout.
 *
 * The CLI emits one JSON object per line on stdout (NDJSON). Each line
 * carries a `type` field with one of: `system`, `assistant`, `user`,
 * `result`. We define a permissive schema — fields we don't use are
 * allowed through so the parser keeps working across CLI versions.
 *
 * Public reference:
 *   https://docs.claude.com/en/docs/agent-sdk/overview
 *   https://docs.claude.com/en/docs/agent-sdk/streaming-input
 */

import { z } from 'zod';

/* --------------------------------- system -------------------------------- */

const SystemInit = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  model: z.string().optional(),
  permission_mode: z.string().optional(),
});
export type SystemInit = z.infer<typeof SystemInit>;

const SystemThinkingTokens = z.object({
  type: z.literal('system'),
  subtype: z.literal('thinking_tokens'),
  session_id: z.string().optional(),
});

/* ------------------------------- assistant -------------------------------- */

const ThinkingBlock = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
});

const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const AssistantContent = z.discriminatedUnion('type', [ThinkingBlock, TextBlock, ToolUseBlock]);

const AssistantMessage = z.object({
  type: z.literal('assistant'),
  message: z.object({
    role: z.literal('assistant'),
    content: z.array(AssistantContent),
  }),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullish(),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

/* ---------------------------------- user --------------------------------- */

const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  is_error: z.boolean().optional(),
});

const UserTextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const UserContent = z.discriminatedUnion('type', [ToolResultBlock, UserTextBlock]);

const UserMessage = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.array(UserContent),
  }),
  session_id: z.string().optional(),
});
export type UserMessage = z.infer<typeof UserMessage>;

/* --------------------------------- result --------------------------------- */

const ResultSuccess = z.object({
  type: z.literal('result'),
  subtype: z.literal('success'),
  is_error: z.literal(false),
  result: z.string().optional(),
  session_id: z.string().optional(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional(),
});

const ResultError = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.literal(true),
  error: z.string().optional(),
  session_id: z.string().optional(),
  duration_ms: z.number().optional(),
});

export const ResultMessage = z.union([ResultSuccess, ResultError]);
export type ResultMessage = z.infer<typeof ResultMessage>;

/* --------------------------------- union --------------------------------- */

export const StreamJsonEvent = z.union([
  SystemInit,
  SystemThinkingTokens,
  AssistantMessage,
  UserMessage,
  ResultMessage,
  z.object({ type: z.string() }).passthrough(),
]);
export type StreamJsonEvent = z.infer<typeof StreamJsonEvent>;

/* ---------------------------------- parse --------------------------------- */

export class StreamJsonParseError extends Error {
  public readonly line: string;
  public override readonly cause?: unknown;

  constructor(message: string, line: string, cause?: unknown) {
    super(message);
    this.name = 'StreamJsonParseError';
    this.line = line;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Parse a single NDJSON line into a stream-json event.
 *
 * Returns `null` for empty lines and for object types we don't model
 * (the trailing `passthrough` schema absorbs them). Throws
 * `StreamJsonParseError` for malformed JSON or schema violations.
 */
export function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (cause) {
    throw new StreamJsonParseError(`malformed JSON: ${trimmed}`, trimmed, cause);
  }

  const result = StreamJsonEvent.safeParse(raw);
  if (!result.success) {
    throw new StreamJsonParseError(
      `schema violation: ${result.error.issues.map((i) => i.message).join('; ')}`,
      trimmed,
    );
  }
  return result.data;
}

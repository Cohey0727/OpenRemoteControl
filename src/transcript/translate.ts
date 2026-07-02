/**
 * Translate Claude Code transcript JSONL entries into the BridgeFrame
 * shapes `open-rc serve` relays to browsers.
 *
 * A transcript is the session's own on-disk record
 * (`~/.claude/projects/<project>/<session>.jsonl`). Each line is one
 * entry; the ones that carry conversation are:
 *
 *   { type: "user",      message: { content: string | Block[] } }
 *   { type: "assistant", message: { content: Block[] } }
 *
 * Everything else (mode, attachment, file-history-snapshot, …) is
 * bookkeeping and is dropped. So are:
 *
 *   - sidechain entries (subagent traffic; not this conversation),
 *   - meta user entries (`isMeta: true` — hook/system injections),
 *   - command wrappers (`<command-name>…`, `<local-command-stdout>…`)
 *     and other `<…>`-framed synthetic prompts,
 *   - `[open-rc]`-tagged prompts: those are browser messages this
 *     bridge itself queued; the server already echoed them to every
 *     attached view when they were sent, so replaying the transcript
 *     copy would render them twice.
 */

import { z } from 'zod';

/** Truncation caps keep single frames light on the wire; the terminal
 *  remains the source of full-fidelity output. */
const MAX_TOOL_INPUT = 2_000;
const MAX_TOOL_OUTPUT = 8_000;

/** Marker the open-rc hook wraps around browser-injected prompts. */
export const OPENRC_MARKER = '[open-rc]';

/* -------------------------------------------------------------------------- */
/*  Entry schema (loose — transcripts are external input)                      */
/* -------------------------------------------------------------------------- */

const ContentBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  content: z.unknown().optional(),
});
type ContentBlock = z.infer<typeof ContentBlock>;

const TranscriptEntry = z.looseObject({
  type: z.string(),
  isMeta: z.boolean().nullish(),
  isSidechain: z.boolean().nullish(),
  timestamp: z.string().nullish(),
  message: z
    .looseObject({
      role: z.string().optional(),
      content: z.union([z.string(), z.array(ContentBlock)]).optional(),
    })
    .nullish(),
});

/* -------------------------------------------------------------------------- */
/*  Output frames                                                              */
/* -------------------------------------------------------------------------- */

export type TranscriptFrame =
  | { type: 'user'; text: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; tool: string; input: string }
  | { type: 'tool_result'; output: string };

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated]`;
}

/** A human prompt worth relaying — not a synthetic `<…>` wrapper, not
 *  a hook injection, not this bridge's own round-tripped message. */
function isRelayablePrompt(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (t.startsWith('<')) return false;
  if (t.startsWith('Caveat:')) return false;
  if (t.startsWith('[Request interrupted')) return false;
  if (t.includes(OPENRC_MARKER)) return false;
  return true;
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (block && typeof block === 'object' && 'text' in block) {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

function fromUserContentBlocks(blocks: readonly ContentBlock[]): TranscriptFrame[] {
  return blocks.flatMap((block): TranscriptFrame[] => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return isRelayablePrompt(block.text) ? [{ type: 'user', text: block.text }] : [];
    }
    if (block.type === 'tool_result') {
      const output = flattenToolResult(block.content);
      return [{ type: 'tool_result', output: truncate(output, MAX_TOOL_OUTPUT) }];
    }
    return [];
  });
}

function fromAssistantContentBlocks(blocks: readonly ContentBlock[]): TranscriptFrame[] {
  return blocks.flatMap((block): TranscriptFrame[] => {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return [{ type: 'text', text: block.text }];
    }
    if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking.trim() !== ''
    ) {
      return [{ type: 'thinking', text: block.thinking }];
    }
    if (block.type === 'tool_use') {
      const input = block.input === undefined ? '' : JSON.stringify(block.input);
      return [
        {
          type: 'tool_use',
          tool: block.name ?? 'unknown',
          input: truncate(input, MAX_TOOL_INPUT),
        },
      ];
    }
    return [];
  });
}

/* -------------------------------------------------------------------------- */
/*  Public surface                                                             */
/* -------------------------------------------------------------------------- */

/** Epoch ms of an entry's `timestamp` field, or null. */
export function entryTimestamp(raw: unknown): number | null {
  const parsed = TranscriptEntry.safeParse(raw);
  if (!parsed.success || !parsed.data.timestamp) return null;
  const ms = Date.parse(parsed.data.timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Translate one parsed transcript entry into zero or more frames.
 * Unknown / bookkeeping / filtered entries yield `[]`.
 */
export function translateEntry(raw: unknown): TranscriptFrame[] {
  const parsed = TranscriptEntry.safeParse(raw);
  if (!parsed.success) return [];
  const entry = parsed.data;

  if (entry.isSidechain === true) return [];
  const content = entry.message?.content;
  if (content === undefined) return [];

  if (entry.type === 'user') {
    if (entry.isMeta === true) return [];
    if (typeof content === 'string') {
      return isRelayablePrompt(content) ? [{ type: 'user', text: content }] : [];
    }
    return fromUserContentBlocks(content);
  }

  if (entry.type === 'assistant') {
    if (typeof content === 'string') {
      return content.trim() === '' ? [] : [{ type: 'text', text: content }];
    }
    return fromAssistantContentBlocks(content);
  }

  return [];
}

/**
 * Translate one raw JSONL line. Garbage lines (partial writes, non-
 * JSON) yield `[]` — a tailer can hand lines over without pre-checks.
 */
export function translateLine(line: string): TranscriptFrame[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];
  try {
    return translateEntry(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

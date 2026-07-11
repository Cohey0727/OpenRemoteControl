import type { UiMessage } from './wire';

/**
 * Fold an incoming `tool_result` into the pending `tool` message it
 * answers, so one tool call renders as one card instead of two.
 *
 * Matching order:
 *   1. by id — the bridge relays the transcript's `tool_use_id`, which
 *      pairs exactly even across parallel tool calls;
 *   2. positionally — for id-less bridges, the OLDEST unresolved tool
 *      call in the current turn (stream-json emits results in call
 *      order, so FIFO is the faithful pairing). The scan stops at the
 *      last turn boundary (`user` / `divider`): a result never answers
 *      a call from an earlier turn, so a stale never-resolved call
 *      can't capture it.
 *
 * Returns a new array with the match resolved in place, or null when
 * nothing pends — the caller then appends an orphan `tool_result`
 * (e.g. the server's replay tail was cut between the pair).
 */
export function resolveToolResult(
  messages: readonly UiMessage[],
  output: string,
  toolUseId?: string,
): UiMessage[] | null {
  const index = toolUseId ? findById(messages, toolUseId) : findOldestPending(messages);
  if (index === null) return null;
  const target = messages[index];
  if (!target || target.kind !== 'tool') return null;
  return messages.map((m, i) => (i === index ? { ...target, output } : m));
}

function findById(messages: readonly UiMessage[], toolUseId: string): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.kind === 'tool' && m.id === toolUseId && m.output === undefined) return i;
  }
  return null;
}

function findOldestPending(messages: readonly UiMessage[]): number | null {
  let oldest: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.kind === 'user' || m.kind === 'divider') break;
    if (m.kind === 'tool' && m.output === undefined) oldest = i;
  }
  return oldest;
}

/**
 * A one-line human hint for a collapsed tool card's summary row —
 * the Bash command line, the file being edited, the pattern being
 * searched — so an autonomous run reads as a scannable log.
 */
export function toolSummaryHint(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object') return '';
    const o = parsed as Record<string, unknown>;
    for (const key of ['description', 'command', 'file_path', 'pattern', 'query', 'url']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim() !== '') return firstLine(v);
    }
    return '';
  } catch {
    return '';
  }
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

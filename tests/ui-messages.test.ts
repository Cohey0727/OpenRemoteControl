/**
 * Tool call / result pairing for the SPA transcript: a `tool_result`
 * frame folds into the pending `tool` card it answers (by id when the
 * bridge relays one, positionally otherwise), so one tool call renders
 * as ONE section instead of alternating tool_use / result rows.
 */

import { describe, expect, test } from 'bun:test';
import { resolveToolResult, toolSummaryHint } from '../ui/src/messages.ts';
import type { UiMessage } from '../ui/src/wire.ts';

const tool = (id: string | undefined, tool = 'Bash', output?: string): UiMessage => ({
  kind: 'tool',
  tool,
  input: '{"command":"ls"}',
  ...(id !== undefined ? { id } : {}),
  ...(output !== undefined ? { output } : {}),
});

describe('resolveToolResult — by id', () => {
  test('resolves the matching pending call, immutably', () => {
    const messages: UiMessage[] = [tool('t1'), tool('t2')];
    const next = resolveToolResult(messages, 'files…', 't1');
    expect(next).toEqual([tool('t1', 'Bash', 'files…'), tool('t2')]);
    // original untouched
    expect(messages[0]).toEqual(tool('t1'));
  });

  test('an already-resolved call is never overwritten', () => {
    const messages: UiMessage[] = [tool('t1', 'Bash', 'first')];
    expect(resolveToolResult(messages, 'second', 't1')).toBeNull();
  });

  test('unknown id yields null (caller appends an orphan result)', () => {
    expect(resolveToolResult([tool('t1')], 'out', 'missing')).toBeNull();
  });
});

describe('resolveToolResult — positional fallback (no id)', () => {
  test('pairs FIFO with the oldest pending call in the turn', () => {
    const messages: UiMessage[] = [tool(undefined, 'Read'), tool(undefined, 'Grep')];
    const next = resolveToolResult(messages, 'read out');
    expect(next?.[0]).toEqual(tool(undefined, 'Read', 'read out'));
    expect(next?.[1]).toEqual(tool(undefined, 'Grep'));
  });

  test('never reaches across a turn boundary for a stale pending call', () => {
    const messages: UiMessage[] = [
      tool(undefined, 'Bash'), // interrupted, never resolved
      { kind: 'user', text: 'next prompt' },
    ];
    expect(resolveToolResult(messages, 'out')).toBeNull();
  });

  test('empty transcript yields null', () => {
    expect(resolveToolResult([], 'out')).toBeNull();
  });
});

describe('toolSummaryHint', () => {
  test('prefers the human description, then the command', () => {
    expect(toolSummaryHint('{"command":"ls -la","description":"List files"}')).toBe('List files');
    expect(toolSummaryHint('{"command":"ls -la"}')).toBe('ls -la');
    expect(toolSummaryHint('{"file_path":"/tmp/a.ts"}')).toBe('/tmp/a.ts');
  });

  test('first line only, capped at 80 chars', () => {
    expect(toolSummaryHint('{"command":"echo a\\necho b"}')).toBe('echo a');
    const long = 'x'.repeat(120);
    expect(toolSummaryHint(JSON.stringify({ command: long }))).toBe(`${'x'.repeat(80)}…`);
  });

  test('non-JSON or hint-less input yields empty string', () => {
    expect(toolSummaryHint('not json')).toBe('');
    expect(toolSummaryHint('{"other":1}')).toBe('');
  });
});

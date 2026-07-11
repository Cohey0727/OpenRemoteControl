/**
 * Transcript → BridgeFrame translation. The fixtures mirror real
 * Claude Code transcript JSONL entries (see src/transcript/translate.ts
 * for the shapes).
 */

import { describe, expect, test } from 'bun:test';
import {
  OPENRC_MARKER,
  entryTimestamp,
  translateEntry,
  translateLine,
} from '../src/transcript/translate.ts';

const userText = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: text },
  timestamp: '2026-07-02T12:00:00.000Z',
  ...extra,
});

describe('translateEntry — user entries', () => {
  test('plain prompt becomes a user frame', () => {
    expect(translateEntry(userText('hello world'))).toEqual([
      { type: 'user', text: 'hello world' },
    ]);
  });

  test('command wrappers, meta, caveats, and interruptions are dropped', () => {
    expect(translateEntry(userText('<command-name>/goal</command-name>'))).toEqual([]);
    expect(translateEntry(userText('<local-command-stdout>ok</local-command-stdout>'))).toEqual([]);
    expect(translateEntry(userText('hi', { isMeta: true }))).toEqual([]);
    expect(translateEntry(userText('Caveat: the messages below…'))).toEqual([]);
    expect(translateEntry(userText('[Request interrupted by user]'))).toEqual([]);
  });

  test('open-rc round-tripped prompts are dropped (server already echoed them)', () => {
    expect(translateEntry(userText(`${OPENRC_MARKER} browser said: do x`))).toEqual([]);
  });

  test('sidechain entries are dropped', () => {
    expect(translateEntry(userText('subagent prompt', { isSidechain: true }))).toEqual([]);
  });

  test('tool_result blocks become tool_result frames (string and block-array content)', () => {
    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ls output' },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: 'block out' }],
          },
        ],
      },
    };
    expect(translateEntry(entry)).toEqual([
      { type: 'tool_result', output: 'ls output', toolUseId: 't1' },
      { type: 'tool_result', output: 'block out', toolUseId: 't2' },
    ]);
  });

  test('long tool output is truncated', () => {
    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x'.repeat(10_000) }],
      },
    };
    const [frame] = translateEntry(entry);
    expect(frame?.type).toBe('tool_result');
    if (frame?.type === 'tool_result') {
      expect(frame.output.length).toBeLessThan(9_000);
      expect(frame.output).toEndWith('[truncated]');
    }
  });
});

describe('translateEntry — assistant entries', () => {
  test('text, thinking, and tool_use blocks translate', () => {
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'the answer' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    expect(translateEntry(entry)).toEqual([
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: 'the answer' },
      { type: 'tool_use', tool: 'Bash', input: '{"command":"ls"}', id: 't1' },
    ]);
  });

  test('empty text/thinking blocks are dropped', () => {
    const entry = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '  ' }] },
    };
    expect(translateEntry(entry)).toEqual([]);
  });
});

describe('translateEntry — bookkeeping entries', () => {
  test('non-conversation entry types yield nothing', () => {
    for (const type of ['mode', 'permission-mode', 'attachment', 'file-history-snapshot']) {
      expect(translateEntry({ type, sessionId: 's' })).toEqual([]);
    }
  });

  test('garbage input yields nothing', () => {
    expect(translateEntry(null)).toEqual([]);
    expect(translateEntry(42)).toEqual([]);
    expect(translateEntry({})).toEqual([]);
  });
});

describe('translateLine / entryTimestamp', () => {
  test('parses a JSONL line and survives partial lines', () => {
    expect(translateLine(JSON.stringify(userText('yo')))).toEqual([{ type: 'user', text: 'yo' }]);
    expect(translateLine('{"type":"user","message"')).toEqual([]);
    expect(translateLine('')).toEqual([]);
  });

  test('entryTimestamp parses ISO timestamps', () => {
    expect(entryTimestamp(userText('x'))).toBe(Date.parse('2026-07-02T12:00:00.000Z'));
    expect(entryTimestamp({ type: 'user' })).toBeNull();
    expect(entryTimestamp('garbage')).toBeNull();
  });
});

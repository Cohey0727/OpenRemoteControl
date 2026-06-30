import { describe, expect, test } from 'bun:test';
import { parseStreamJsonLine } from '../src/session/stream-json.ts';
import { translate } from '../src/session/translate.ts';
import {
  DoneMessage,
  ErrorMessage,
  TextMessage,
  ThinkingMessage,
  ToolResultMessage,
  ToolUseMessage,
} from '../src/session/ws-protocol.ts';

const SID = 'sess-1';

describe('parseStreamJsonLine', () => {
  test('returns null for empty/whitespace lines', () => {
    expect(parseStreamJsonLine('')).toBeNull();
    expect(parseStreamJsonLine('   ')).toBeNull();
    expect(parseStreamJsonLine('\n')).toBeNull();
  });

  test('parses system/init', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/home/x',
      tools: ['Bash', 'Edit'],
      model: 'claude-sonnet-4-5',
    });
    const evt = parseStreamJsonLine(line);
    expect(evt?.type).toBe('system');
    if (evt?.type === 'system') {
      expect(evt.subtype).toBe('init');
    }
  });

  test('parses assistant with text block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    });
    const evt = parseStreamJsonLine(line);
    expect(evt?.type).toBe('assistant');
  });

  test('parses assistant with tool_use block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    });
    const evt = parseStreamJsonLine(line);
    expect(evt?.type).toBe('assistant');
  });

  test('parses user with tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'file1.txt\nfile2.txt',
            is_error: false,
          },
        ],
      },
    });
    const evt = parseStreamJsonLine(line);
    expect(evt?.type).toBe('user');
  });

  test('parses result success', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1234,
      total_cost_usd: 0.0123,
    });
    const evt = parseStreamJsonLine(line);
    expect(evt?.type).toBe('result');
  });

  test('parses result error', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      error: 'too many turns',
      duration_ms: 5000,
    });
    const evt = parseStreamJsonLine(line);
    expect(evt?.type).toBe('result');
  });

  test('throws on malformed JSON', () => {
    expect(() => parseStreamJsonLine('not json')).toThrow();
  });

  test('throws when type is missing', () => {
    const line = JSON.stringify({ message: { content: [] } });
    expect(() => parseStreamJsonLine(line)).toThrow();
  });
});

describe('translate', () => {
  test('system/init → empty', () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] }),
    );
    if (!evt) throw new Error('parse failed');
    expect(translate(evt, SID)).toEqual([]);
  });

  test('assistant text → TextMessage', () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      }),
    );
    if (!evt) throw new Error('parse failed');
    const out = translate(evt, SID);
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(() => TextMessage.parse(m)).not.toThrow();
    if (m.type === 'text') {
      expect(m.text).toBe('Hi');
      expect(m.sessionId).toBe(SID);
    }
  });

  test('assistant thinking → ThinkingMessage', () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'pondering...' }],
        },
      }),
    );
    if (!evt) throw new Error('parse failed');
    const out = translate(evt, SID);
    expect(out[0]?.type).toBe('thinking');
    expect(() => ThinkingMessage.parse(out[0]!)).not.toThrow();
  });

  test('assistant tool_use → ToolUseMessage with stringified input', () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'ls -la' },
            },
          ],
        },
      }),
    );
    if (!evt) throw new Error('parse failed');
    const out = translate(evt, SID);
    expect(out[0]?.type).toBe('tool_use');
    const m = out[0]!;
    expect(() => ToolUseMessage.parse(m)).not.toThrow();
    if (m.type === 'tool_use') {
      expect(m.tool).toBe('Bash');
      expect(JSON.parse(m.input)).toEqual({ command: 'ls -la' });
    }
  });

  test('user tool_result → ToolResultMessage', () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'file.txt\n',
              is_error: false,
            },
          ],
        },
      }),
    );
    if (!evt) throw new Error('parse failed');
    const out = translate(evt, SID);
    expect(out[0]?.type).toBe('tool_result');
    expect(() => ToolResultMessage.parse(out[0]!)).not.toThrow();
  });

  test('user text → empty (echoed prompt, ignored)', () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      }),
    );
    if (!evt) throw new Error('parse failed');
    expect(translate(evt, SID)).toEqual([]);
  });

  test('result success → DoneMessage with metrics', () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 4321,
        total_cost_usd: 0.05,
      }),
    );
    if (!evt) throw new Error('parse failed');
    const out = translate(evt, SID);
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(() => DoneMessage.parse(m)).not.toThrow();
    if (m.type === 'done') {
      expect(m.duration_ms).toBe(4321);
      expect(m.cost).toBe(0.05);
    }
  });

  test('result error → ErrorMessage', () => {
    const evt = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error: 'API timeout',
      }),
    );
    if (!evt) throw new Error('parse failed');
    const out = translate(evt, SID);
    expect(out[0]?.type).toBe('error');
    expect(() => ErrorMessage.parse(out[0]!)).not.toThrow();
  });
});

import { describe, expect, test } from 'bun:test';
import { mergeSettings } from '../scripts/install-hooks.ts';

const BIN = '/Users/kohei/.local/bin/orc';

type Settings = Parameters<typeof mergeSettings>[0];

const ourStopGroup = (bin: string) => ({
  hooks: [{ type: 'command' as const, command: `${bin} hook stop`, timeout: 604_800 }],
});

const userStopGroup = {
  hooks: [{ type: 'command' as const, command: 'echo done' }],
};

describe('mergeSettings', () => {
  test('install is idempotent — re-running never duplicates our hooks', () => {
    const once = mergeSettings({}, BIN, false);
    const twice = mergeSettings(once, BIN, false);
    expect(twice.hooks?.Stop).toHaveLength(1);
    expect(twice.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(twice.hooks?.SessionEnd).toHaveLength(1);
    expect(twice.hooks?.Notification).toHaveLength(1);
    expect(twice.hooks?.PreToolUse).toHaveLength(1);
  });

  test('remove strips our hooks, including accumulated duplicates', () => {
    const settings: Settings = {
      hooks: {
        Stop: [ourStopGroup(BIN), ourStopGroup(BIN), ourStopGroup(BIN)],
      },
    };
    const removed = mergeSettings(settings, BIN, true);
    expect(removed.hooks).toBeUndefined();
  });

  test('remove strips legacy open-rc binary hooks too', () => {
    const settings: Settings = {
      hooks: {
        Stop: [ourStopGroup('/Users/kohei/.local/bin/open-rc')],
      },
    };
    const removed = mergeSettings(settings, BIN, true);
    expect(removed.hooks).toBeUndefined();
  });

  test('remove preserves user hooks verbatim', () => {
    const settings: Settings = {
      hooks: {
        Stop: [ourStopGroup(BIN), userStopGroup],
        PreCompact: [userStopGroup],
      },
    };
    const removed = mergeSettings(settings, BIN, true);
    expect(removed.hooks?.Stop).toEqual([userStopGroup]);
    expect(removed.hooks?.PreCompact).toEqual([userStopGroup]);
  });

  test('remove preserves non-hook settings', () => {
    const settings: Settings = {
      model: 'claude-fable-5',
      hooks: { Stop: [ourStopGroup(BIN)] },
    };
    const removed = mergeSettings(settings, BIN, true);
    expect(removed.model).toBe('claude-fable-5');
  });
});

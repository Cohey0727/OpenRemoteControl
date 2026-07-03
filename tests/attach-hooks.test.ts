/**
 * Hook handlers: the browser → session delivery half of attach-orc.
 * Everything runs in-process — the handlers are pure functions over
 * stdin JSON and the attach state dir.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  appendQueue,
  attachDirFor,
  browserTurnMarkerExists,
  createAttachDir,
  endMarkerExists,
  stopMarkerMtime,
  touchBrowserTurnMarker,
  touchReleaseMarker,
  writeAttachedCount,
  writeBridgeInfo,
} from '../src/attach/state.ts';
import {
  parseHookInput,
  runEndHook,
  runNotifyHook,
  runPromptHook,
  runStopHook,
} from '../src/cli/attach-hooks.ts';
import { OPENRC_MARKER } from '../src/transcript/translate.ts';

const base = join(import.meta.dir, '.tmp-hooks');

async function liveBridgeSession(): Promise<{ sessionId: string; dir: string }> {
  const sessionId = crypto.randomUUID();
  const dir = attachDirFor(sessionId, base);
  await createAttachDir(dir);
  await writeBridgeInfo(dir, {
    clientId: sessionId,
    server: 'ws://t/agent',
    startedAt: Date.now(),
  });
  return { sessionId, dir };
}

describe('parseHookInput', () => {
  test('valid input parses, garbage returns null', () => {
    expect(parseHookInput('{"session_id":"s1","stop_hook_active":false}')?.session_id).toBe('s1');
    expect(parseHookInput('not json')).toBeNull();
    expect(parseHookInput('{"no_session":true}')).toBeNull();
  });
});

describe('runStopHook', () => {
  test('no bridge → no output, no marker', async () => {
    const sessionId = crypto.randomUUID();
    const result = await runStopHook({ session_id: sessionId }, { baseDir: base, lingerMs: 0 });
    expect(result.output).toBeUndefined();
    expect(await stopMarkerMtime(attachDirFor(sessionId, base))).toBeNull();
  });

  test('queued prompts → block decision carrying the prompts, marker touched', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await appendQueue(dir, 'fix the bug');
    await appendQueue(dir, 'then run tests');

    const result = await runStopHook({ session_id: sessionId }, { baseDir: base, lingerMs: 0 });
    expect(result.output?.decision).toBe('block');
    const reason = result.output?.reason as string;
    expect(reason).toContain(OPENRC_MARKER);
    expect(reason).toContain('fix the bug');
    expect(reason).toContain('then run tests');
    expect(await stopMarkerMtime(dir)).toBeNumber();
  });

  test('empty queue + nobody attached → returns immediately even with a long window', async () => {
    const { sessionId } = await liveBridgeSession();
    const started = Date.now();
    const result = await runStopHook(
      { session_id: sessionId },
      { baseDir: base, lingerMs: 60_000 },
    );
    expect(result.output).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('lingers while attached and picks up a prompt that arrives late', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await writeAttachedCount(dir, 1);
    setTimeout(() => {
      void appendQueue(dir, 'late browser message');
    }, 400);

    const result = await runStopHook({ session_id: sessionId }, { baseDir: base, lingerMs: 5_000 });
    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason as string).toContain('late browser message');
  });

  test('linger window expires cleanly with nothing queued', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await writeAttachedCount(dir, 1);
    const result = await runStopHook({ session_id: sessionId }, { baseDir: base, lingerMs: 500 });
    expect(result.output).toBeUndefined();
  });

  test('browser-driven mode: delivery sets the marker and the long window applies', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await writeAttachedCount(dir, 1);
    await appendQueue(dir, 'first from browser');
    const first = await runStopHook({ session_id: sessionId }, { baseDir: base, lingerMs: 0 });
    expect(first.output?.decision).toBe('block');
    expect(await browserTurnMarkerExists(dir)).toBe(true);

    // Next turn end: the LONG window is used (short window would give
    // up long before the late message lands at 800 ms).
    setTimeout(() => {
      void appendQueue(dir, 'follow-up from browser');
    }, 800);
    const second = await runStopHook(
      { session_id: sessionId },
      { baseDir: base, lingerMs: 100, activeLingerMs: 5_000 },
    );
    expect(second.output?.decision).toBe('block');
    expect(second.output?.reason as string).toContain('follow-up from browser');
  });

  test('browser-driven mode survives zero viewers (phone lock drops the WS)', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await touchBrowserTurnMarker(dir);
    await writeAttachedCount(dir, 0); // screen locked — viewer gone
    setTimeout(() => {
      void appendQueue(dir, 'sent after unlocking the phone');
    }, 400);

    const result = await runStopHook(
      { session_id: sessionId },
      { baseDir: base, lingerMs: 100, activeLingerMs: 5_000 },
    );
    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason as string).toContain('sent after unlocking the phone');
  });

  test('browser-driven mode listens without a deadline (default window is unlimited)', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await touchBrowserTurnMarker(dir);
    await writeAttachedCount(dir, 0);
    // lingerMs 100 would give up long before 900 ms — only the
    // unlimited browser-driven default keeps the hook alive.
    setTimeout(() => {
      void appendQueue(dir, 'late but still delivered');
    }, 900);
    const result = await runStopHook({ session_id: sessionId }, { baseDir: base, lingerMs: 100 });
    expect(result.output?.decision).toBe('block');
    expect(result.output?.reason as string).toContain('late but still delivered');
  });

  test('open-rc release ends a lingering window and clears browser-driven mode', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await touchBrowserTurnMarker(dir);
    setTimeout(() => {
      void touchReleaseMarker(dir);
    }, 400);
    const started = Date.now();
    const result = await runStopHook({ session_id: sessionId }, { baseDir: base });
    expect(result.output).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await browserTurnMarkerExists(dir)).toBe(false);
  });

  test('a stale release marker does not kill the next window', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await touchReleaseMarker(dir); // released some time in the past
    await new Promise((r) => setTimeout(r, 50));
    await touchBrowserTurnMarker(dir);
    setTimeout(() => {
      void appendQueue(dir, 'delivered despite old marker');
    }, 400);
    const result = await runStopHook({ session_id: sessionId }, { baseDir: base });
    expect(result.output?.decision).toBe('block');
  });

  test('a CLI prompt clears browser-driven mode', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await touchBrowserTurnMarker(dir);
    await runPromptHook({ session_id: sessionId, prompt: 'typed locally' }, { baseDir: base });
    expect(await browserTurnMarkerExists(dir)).toBe(false);
  });
});

describe('runPromptHook', () => {
  test('queued prompts ride along as additionalContext', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await appendQueue(dir, 'from the browser');
    const result = await runPromptHook(
      { session_id: sessionId, prompt: 'cli says hi' },
      { baseDir: base },
    );
    const specific = result.output?.hookSpecificOutput as Record<string, unknown>;
    expect(specific.hookEventName).toBe('UserPromptSubmit');
    expect(specific.additionalContext as string).toContain('from the browser');
  });

  test('no queue → silent no-op', async () => {
    const { sessionId } = await liveBridgeSession();
    const result = await runPromptHook({ session_id: sessionId }, { baseDir: base });
    expect(result.output).toBeUndefined();
  });
});

describe('runEndHook', () => {
  test('touches the end marker only for live bridges', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    await runEndHook({ session_id: sessionId }, { baseDir: base });
    expect(await endMarkerExists(dir)).toBe(true);

    const stray = crypto.randomUUID();
    await runEndHook({ session_id: stray }, { baseDir: base });
    expect(await endMarkerExists(attachDirFor(stray, base))).toBe(false);
  });
});

describe('runNotifyHook', () => {
  test('says a message is waiting only when one actually is', async () => {
    const { sessionId, dir } = await liveBridgeSession();
    expect(
      (await runNotifyHook({ session_id: sessionId }, { baseDir: base })).output,
    ).toBeUndefined();

    await appendQueue(dir, 'stuck message');
    const result = await runNotifyHook({ session_id: sessionId }, { baseDir: base });
    expect(result.output?.systemMessage as string).toContain('waiting');
  });
});

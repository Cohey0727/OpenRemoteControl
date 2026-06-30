/**
 * Phase 2 unit tests.
 *
 * Covers:
 *   - settings.json generator produces the right hook command shape
 *   - PermissionManager open / resolve lifecycle + timeout
 *   - audit log appends JSONL
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetAuditPathForTests, writeAudit } from '../src/permission/audit.ts';
import { PermissionManager } from '../src/permission/manager.ts';
import {
  buildHookSettings,
  cleanupHookSettings,
  writeHookSettings,
} from '../src/permission/settings.ts';

describe('buildHookSettings', () => {
  test('produces a PreToolUse hook with the right command', () => {
    const out = buildHookSettings({
      sessionId: 'abc-123',
      hookUrl: 'http://127.0.0.1:7322/internal/hook',
      openRcBin: '/usr/local/bin/open-rc',
    });

    expect(out.hooks).toBeDefined();
    const hooks = out.hooks as Record<
      string,
      Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
    >;
    const pre = hooks.PreToolUse;
    expect(pre).toBeArray();
    expect(pre).toHaveLength(1);
    expect(pre?.[0]?.matcher).toBe('.*');
    expect(pre?.[0]?.hooks[0]?.type).toBe('command');
    expect(pre?.[0]?.hooks[0]?.command).toContain('pretool');
    expect(pre?.[0]?.hooks[0]?.command).toContain('--session abc-123');
    expect(pre?.[0]?.hooks[0]?.command).toContain('--url http://127.0.0.1:7322/internal/hook');
  });

  test('quotes paths containing spaces in the command', () => {
    const out = buildHookSettings({
      sessionId: 'sid',
      hookUrl: 'http://x',
      openRcBin: '/path with space/open-rc',
    });
    const hooks = out.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const cmd = hooks.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
    expect(cmd).toContain('"/path with space/open-rc"');
  });
});

describe('writeHookSettings / cleanupHookSettings', () => {
  let dir: string;

  beforeEach(() => {
    dir = `${tmpdir()}/open-rc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes the file and cleans up on demand', async () => {
    const p = await writeHookSettings(join(dir, 'sub', 'settings.json'), {
      sessionId: 'sid',
      hookUrl: 'http://x',
      openRcBin: '/bin/open-rc',
    });
    expect(existsSync(p)).toBe(true);
    const contents = readFileSync(p, 'utf8');
    expect(contents).toContain('"PreToolUse"');
    await cleanupHookSettings(p);
    expect(existsSync(p)).toBe(false);
  });

  test('cleanup is idempotent (ENOENT is swallowed)', async () => {
    const p = join(dir, 'never-existed.json');
    // Should not throw.
    await cleanupHookSettings(p);
  });
});

describe('PermissionManager', () => {
  test('open → resolve allows the request', async () => {
    const pm = new PermissionManager({ timeoutMs: 5_000 });
    const received: unknown[] = [];
    pm.on((r) => received.push(r));

    const decisionPromise = pm.open({
      sessionId: 's1',
      tool: 'Bash',
      input: { command: 'rm -rf /' },
      toolUseId: 'tu-1',
      hookEventName: 'PreToolUse',
      claudeSessionId: 'cs-1',
    });

    expect(pm.size).toBe(1);
    expect(received).toHaveLength(1);

    const req = received[0] as { id: string };
    expect(pm.resolve(req.id, { approved: false })).toBe(true);
    expect(pm.size).toBe(0);

    const d = await decisionPromise;
    expect(d.approved).toBe(false);
  });

  test('resolving an unknown id returns false', () => {
    const pm = new PermissionManager();
    expect(pm.resolve('nope', { approved: true })).toBe(false);
  });

  test('times out after the configured window', async () => {
    const pm = new PermissionManager({ timeoutMs: 50 });
    const p = pm.open({
      sessionId: 's',
      tool: 'Bash',
      input: {},
      toolUseId: 'tu',
      hookEventName: 'PreToolUse',
      claudeSessionId: '',
    });
    await expect(p).rejects.toThrow(/timed out/);
    expect(pm.size).toBe(0);
  });

  test('multiple listeners all receive the request', async () => {
    const pm = new PermissionManager({ timeoutMs: 5_000 });
    let a = 0;
    let b = 0;
    pm.on(() => {
      a++;
    });
    pm.on(() => {
      b++;
    });
    const p = pm.open({
      sessionId: 's',
      tool: 'Bash',
      input: {},
      toolUseId: 'tu',
      hookEventName: 'PreToolUse',
      claudeSessionId: '',
    });
    expect(a).toBe(1);
    expect(b).toBe(1);
    // Resolve so the test cleans up.
    const id = (pm as unknown as { pending: Map<string, { req: { id: string } }> }).pending
      .keys()
      .next().value as string;
    pm.resolve(id, { approved: true });
    await p;
  });
});

describe('audit log', () => {
  beforeEach(() => resetAuditPathForTests());
  afterEach(() => resetAuditPathForTests());

  test('appends a single line of JSONL', async () => {
    const dir = `${tmpdir()}/open-rc-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env.XDG_DATA_HOME = dir;
    resetAuditPathForTests();

    await writeAudit({
      timestamp: 1_700_000_000_000,
      sessionId: 's',
      requestId: 'r',
      tool: 'Bash',
      decision: 'allow',
    });
    // The actual file path is resolved lazily; allow some I/O.
    await new Promise((r) => setTimeout(r, 50));

    const path = join(dir, 'open-rc', 'audit.jsonl');
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0] as string) as {
      tool: string;
      decision: string;
    };
    expect(parsed.tool).toBe('Bash');
    expect(parsed.decision).toBe('allow');
  });
});

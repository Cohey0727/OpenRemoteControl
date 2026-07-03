/**
 * Shell-revision stamp tests — the revision the server appends to
 * /sw.js so the browser's SW update check detects ANY UI change
 * (not just manual CACHE_VERSION bumps in sw.js itself).
 *
 * Contract:
 *   - Same directory state → same revision (stable across calls).
 *   - Any file content/mtime change → different revision.
 *   - Adding or removing a file → different revision.
 *   - Unreadable directory → the fixed 'unknown' fallback, no throw.
 *
 * Run: bun test tests/shell-rev.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeShellRev } from '../src/serve/shell-rev.ts';

function makeUiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'open-rc-shell-rev-'));
  writeFileSync(join(dir, 'index.html'), '<title>x</title>');
  writeFileSync(join(dir, 'app.ts'), 'export {};');
  mkdirSync(join(dir, 'vendor'));
  writeFileSync(join(dir, 'vendor', 'marked.js'), '// vendored');
  return dir;
}

describe('computeShellRev', () => {
  test('is stable while the directory is unchanged', () => {
    const dir = makeUiDir();
    try {
      const a = computeShellRev(dir);
      const b = computeShellRev(dir);
      expect(a).toBe(b);
      expect(a).not.toBe('unknown');
      // Usable inside a JS comment stamp — no comment terminator.
      expect(a).not.toContain('*/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('changes when a file is touched (mtime bump)', () => {
    const dir = makeUiDir();
    try {
      const before = computeShellRev(dir);
      const future = new Date(Date.now() + 5_000);
      utimesSync(join(dir, 'app.ts'), future, future);
      const after = computeShellRev(dir);
      expect(after).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('changes when a nested file is added', () => {
    const dir = makeUiDir();
    try {
      const before = computeShellRev(dir);
      writeFileSync(join(dir, 'vendor', 'extra.js'), '// new dep');
      const after = computeShellRev(dir);
      expect(after).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to "unknown" for a missing directory', () => {
    expect(computeShellRev('/nonexistent/open-rc-shell-rev')).toBe('unknown');
  });
});

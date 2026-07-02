/**
 * Transcript discovery: cwd munging and newest-JSONL selection.
 */

import { describe, expect, test } from 'bun:test';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  mungeCwd,
  newestTranscript,
  projectTranscriptDir,
  resolveTranscript,
  sessionIdOf,
} from '../src/transcript/locate.ts';

const tmp = () => join(import.meta.dir, '.tmp-locate', crypto.randomUUID());

describe('mungeCwd / projectTranscriptDir', () => {
  test('replaces every non-alphanumeric character with a dash', () => {
    expect(mungeCwd('/Users/kohei/Workspace/open-rc')).toBe('-Users-kohei-Workspace-open-rc');
    expect(mungeCwd('/a/b.c_d')).toBe('-a-b-c-d');
  });

  test('claudeHome override anchors the projects dir', () => {
    expect(projectTranscriptDir('/x/y', '/tmp/claude-home')).toBe('/tmp/claude-home/projects/-x-y');
  });

  test('sessionIdOf strips dir and extension', () => {
    expect(sessionIdOf('/p/abc-123.jsonl')).toBe('abc-123');
  });
});

describe('newestTranscript', () => {
  test('picks the most recently modified jsonl', async () => {
    const dir = tmp();
    await mkdir(dir, { recursive: true });
    const old = join(dir, 'old.jsonl');
    const fresh = join(dir, 'fresh.jsonl');
    await writeFile(old, '{}\n');
    await writeFile(fresh, '{}\n');
    const past = new Date(Date.now() - 60_000);
    await utimes(old, past, past);

    const found = await newestTranscript(dir);
    expect(found?.path).toBe(fresh);
    expect(found?.sessionId).toBe('fresh');
  });

  test('returns null for a missing or empty dir', async () => {
    expect(await newestTranscript('/nonexistent/nowhere')).toBeNull();
    const dir = tmp();
    await mkdir(dir, { recursive: true });
    expect(await newestTranscript(dir)).toBeNull();
  });
});

describe('resolveTranscript', () => {
  test('explicit --transcript wins and must exist', async () => {
    const dir = tmp();
    await mkdir(dir, { recursive: true });
    const t = join(dir, 'sess.jsonl');
    await writeFile(t, '{}\n');
    const found = await resolveTranscript({ transcript: t, cwd: '/anywhere' });
    expect(found).toEqual({ path: t, sessionId: 'sess' });

    await expect(
      resolveTranscript({ transcript: join(dir, 'nope.jsonl'), cwd: '/x' }),
    ).rejects.toThrow('transcript not found');
  });

  test('discovers the current session of a project cwd', async () => {
    const home = tmp();
    const cwd = '/my/project';
    const projDir = join(home, 'projects', mungeCwd(cwd));
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'abc.jsonl'), '{}\n');

    const found = await resolveTranscript({ cwd, claudeHome: home });
    expect(found.sessionId).toBe('abc');
  });

  test('clear error when no session exists', async () => {
    const home = tmp();
    await expect(resolveTranscript({ cwd: '/no/session', claudeHome: home })).rejects.toThrow(
      'no Claude Code transcript found',
    );
  });
});

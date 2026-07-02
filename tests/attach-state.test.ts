/**
 * Attach state dir: the filesystem contract between the bridge and
 * the hook handlers (queue, heartbeat, markers).
 */

import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendQueue,
  attachDirFor,
  bridgeAlive,
  createAttachDir,
  drainQueue,
  endMarkerExists,
  queueNonEmpty,
  readAttachedCount,
  removeAttachDir,
  stopMarkerMtime,
  touchEndMarker,
  touchStopMarker,
  writeAttachedCount,
  writeBridgeInfo,
} from '../src/attach/state.ts';

const base = join(import.meta.dir, '.tmp-attach');
const freshDir = async () => {
  const dir = attachDirFor(crypto.randomUUID(), base);
  await createAttachDir(dir);
  return dir;
};

describe('attachDirFor', () => {
  test('sanitizes hostile session ids so they cannot escape the base dir', () => {
    expect(attachDirFor('../../etc/passwd', '/base')).toBe('/base/______etc_passwd');
    expect(attachDirFor('normal-uuid-1234', '/base')).toBe('/base/normal-uuid-1234');
  });
});

describe('queue', () => {
  test('append then drain round-trips in order', async () => {
    const dir = await freshDir();
    await appendQueue(dir, 'first');
    await appendQueue(dir, 'second');
    expect(await queueNonEmpty(dir)).toBe(true);
    expect(await drainQueue(dir)).toEqual(['first', 'second']);
    expect(await queueNonEmpty(dir)).toBe(false);
    expect(await drainQueue(dir)).toEqual([]);
  });

  test('recovers a drain file left by a crashed hook', async () => {
    const dir = await freshDir();
    await writeFile(
      join(dir, 'queue.draining.ndjson'),
      `${JSON.stringify({ text: 'lost', ts: 1 })}\n`,
    );
    await appendQueue(dir, 'new');
    expect(await drainQueue(dir)).toEqual(['lost', 'new']);
  });

  test('garbage queue lines are skipped', async () => {
    const dir = await freshDir();
    await writeFile(join(dir, 'queue.ndjson'), 'not json\n{"text":"ok","ts":1}\n');
    expect(await drainQueue(dir)).toEqual(['ok']);
  });
});

describe('bridge heartbeat', () => {
  test('fresh heartbeat is alive, stale is not, missing is not', async () => {
    const dir = await freshDir();
    expect(await bridgeAlive(dir)).toBe(false);

    await writeBridgeInfo(dir, { clientId: 'c', server: 'ws://x/agent', startedAt: Date.now() });
    expect(await bridgeAlive(dir)).toBe(true);

    const raw = JSON.parse(await readFile(join(dir, 'bridge.json'), 'utf8'));
    await writeFile(
      join(dir, 'bridge.json'),
      JSON.stringify({ ...raw, heartbeatAt: Date.now() - 120_000 }),
    );
    expect(await bridgeAlive(dir)).toBe(false);
  });
});

describe('attached count and markers', () => {
  test('attached count round-trips (default 0)', async () => {
    const dir = await freshDir();
    expect(await readAttachedCount(dir)).toBe(0);
    await writeAttachedCount(dir, 3);
    expect(await readAttachedCount(dir)).toBe(3);
  });

  test('stop/end markers', async () => {
    const dir = await freshDir();
    expect(await stopMarkerMtime(dir)).toBeNull();
    await touchStopMarker(dir);
    expect(await stopMarkerMtime(dir)).toBeNumber();

    expect(await endMarkerExists(dir)).toBe(false);
    await touchEndMarker(dir);
    expect(await endMarkerExists(dir)).toBe(true);
  });

  test('createAttachDir clears leftovers from a dead bridge; removeAttachDir removes all', async () => {
    const dir = await freshDir();
    await appendQueue(dir, 'stale');
    await touchEndMarker(dir);
    await createAttachDir(dir);
    expect(await drainQueue(dir)).toEqual([]);
    expect(await endMarkerExists(dir)).toBe(false);

    await removeAttachDir(dir);
    expect(await bridgeAlive(dir)).toBe(false);
  });
});

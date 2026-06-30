/**
 * Phase 5: Web Push — store + VAPID key lifecycle.
 *
 *   - VAPID key generation persists to disk and re-loads on subsequent calls.
 *   - PushStore CRUD: add, list, removeByEndpoint, count.
 *   - Notifier handles 410-gone endpoints by removing them from the store.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushStore } from '../src/push/store.ts';
import { loadOrCreateVapidKeys } from '../src/push/vapid.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'open-rc-push-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('VAPID keys', () => {
  test('loadOrCreateVapidKeys generates and persists', async () => {
    const path = join(tmp, 'vapid.json');
    const first = await loadOrCreateVapidKeys(path);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.privateKey.length).toBeGreaterThan(20);
    expect(first.source).toBe('generated');
    expect(existsSync(path)).toBe(true);

    const second = await loadOrCreateVapidKeys(path);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.source).toBe('disk');
  });

  test('regenerates when the on-disk file is corrupted', async () => {
    const path = join(tmp, 'vapid.json');
    await Bun.write(path, 'not json at all');
    const keys = await loadOrCreateVapidKeys(path);
    expect(keys.publicKey.length).toBeGreaterThan(20);
    expect(keys.source).toBe('generated');
  });
});

describe('PushStore', () => {
  let store: PushStore;

  beforeEach(() => {
    store = new PushStore({ path: join(tmp, 'push.db') });
  });

  afterEach(() => {
    store.close();
  });

  test('addSubscription then listSubscriptions returns it', () => {
    const rec = store.addSubscription({
      endpoint: 'https://push.example.com/1',
      keys: { p256dh: 'p1', auth: 'a1' },
    });
    expect(rec.id).toBeTruthy();
    const list = store.listSubscriptions();
    expect(list).toHaveLength(1);
    expect(list[0]?.endpoint).toBe('https://push.example.com/1');
    expect(list[0]?.p256dh).toBe('p1');
    expect(list[0]?.auth).toBe('a1');
    expect(list[0]?.sessionId).toBeNull();
  });

  test('session-scoped filter returns only matching subs', () => {
    store.addSubscription({
      endpoint: 'https://push.example.com/global',
      keys: { p256dh: 'g', auth: 'g' },
    });
    store.addSubscription({
      endpoint: 'https://push.example.com/s1',
      keys: { p256dh: 's', auth: 's' },
      sessionId: 'session-1',
    });
    const onlyS1 = store.listSubscriptions({ sessionId: 'session-1' });
    expect(onlyS1.map((s) => s.endpoint).sort()).toEqual([
      'https://push.example.com/global',
      'https://push.example.com/s1',
    ]);
    const noMatch = store.listSubscriptions({ sessionId: 'session-2' });
    expect(noMatch.map((s) => s.endpoint)).toEqual(['https://push.example.com/global']);
  });

  test('removeSubscriptionByEndpoint removes and returns true', () => {
    store.addSubscription({
      endpoint: 'https://push.example.com/x',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(store.count()).toBe(1);
    const removed = store.removeSubscriptionByEndpoint('https://push.example.com/x');
    expect(removed).toBe(true);
    expect(store.count()).toBe(0);
    // Removing again returns false.
    expect(store.removeSubscriptionByEndpoint('https://push.example.com/x')).toBe(false);
  });

  test('adding the same endpoint twice replaces the prior record', () => {
    store.addSubscription({
      endpoint: 'https://push.example.com/dup',
      keys: { p256dh: 'old', auth: 'old' },
    });
    store.addSubscription({
      endpoint: 'https://push.example.com/dup',
      keys: { p256dh: 'new', auth: 'new' },
    });
    expect(store.count()).toBe(1);
    const list = store.listSubscriptions();
    expect(list[0]?.p256dh).toBe('new');
  });
});

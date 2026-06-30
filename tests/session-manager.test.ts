/**
 * Regression tests for SessionManager — issue #6: when attach() is called
 * twice on the same session with different listeners, the first listener
 * must be unsubscribed (and no longer called) and the second listener
 * must be the sole receiver of subsequent events.
 */

import { describe, expect, test } from 'bun:test';
import { SessionManager } from '../src/session/manager.ts';
import type { SubprocessEvent } from '../src/session/subprocess.ts';

describe('session/manager', () => {
  test('attach() with a new listener unsubscribes the previous one (issue #6)', async () => {
    // Use a binary that exits immediately so the subprocess emits an `exit`
    // event without needing a real `claude`. `/usr/bin/false` exits 1 on
    // every platform with a minimal delay; this lets us check which
    // listener receives the post-attach emit.
    const manager = new SessionManager({ binary: '/usr/bin/false' });
    const sessionId = 'listener-swap-test';

    let firstCalls = 0;
    let secondCalls = 0;
    const firstListener = (_e: SubprocessEvent) => {
      firstCalls++;
    };
    const secondListener = (_e: SubprocessEvent) => {
      secondCalls++;
    };

    // First attach — should subscribe `firstListener`.
    manager.attach(sessionId, firstListener);
    // Second attach on the same session — must drop `firstListener` and
    // subscribe `secondListener` in its place.
    manager.attach(sessionId, secondListener);

    // Wait for the subprocess to exit and the exit event to flush to the
    // (only remaining) listener. If the unsub of the first listener is
    // broken, firstCalls would be 1 and secondCalls would still be 1.
    await new Promise((r) => setTimeout(r, 500));

    expect(firstCalls).toBe(0);
    expect(secondCalls).toBeGreaterThan(0);
  });
});

/**
 * Push subscription store — backed by bun:sqlite.
 *
 * Subscriptions are browser-issued; we never mint them server-side.
 * We persist only the minimum needed to deliver notifications.
 */

import { Database } from 'bun:sqlite';

export interface PushSubscriptionRecord {
  /** Stable internal id (UUID). */
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Optional session scope — null means "any session". */
  sessionId: string | null;
  createdAt: number;
}

interface RawRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  session_id: string | null;
  created_at: number;
}

function rowToRecord(r: RawRow): PushSubscriptionRecord {
  return {
    id: r.id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

export interface PushStoreOptions {
  path: string;
}

export class PushStore {
  private db: Database;

  constructor(opts: PushStoreOptions) {
    this.db = new Database(opts.path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_session
        ON push_subscriptions(session_id);
    `);
  }

  addSubscription(input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    sessionId?: string | null;
  }): PushSubscriptionRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO push_subscriptions
          (id, endpoint, p256dh, auth, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.endpoint, input.keys.p256dh, input.keys.auth, input.sessionId ?? null, now);
    return {
      id,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      sessionId: input.sessionId ?? null,
      createdAt: now,
    };
  }

  removeSubscriptionByEndpoint(endpoint: string): boolean {
    const r = this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    return r.changes > 0;
  }

  listSubscriptions(filter?: { sessionId?: string }): PushSubscriptionRecord[] {
    let sql = `SELECT id, endpoint, p256dh, auth, session_id, created_at
               FROM push_subscriptions`;
    const params: (string | number | null)[] = [];
    if (filter?.sessionId !== undefined) {
      sql += ' WHERE session_id = ? OR session_id IS NULL';
      params.push(filter.sessionId);
    }
    const rows = this.db.prepare(sql).all(...params) as RawRow[];
    return rows.map(rowToRecord);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get() as {
      c: number;
    };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}

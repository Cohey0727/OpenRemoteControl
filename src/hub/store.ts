/**
 * bun:sqlite schema + queries for the hub.
 *
 * Tables:
 *   devices     — every device that has dialed in (pending or approved)
 *   pairings    — short-lived enrollment tokens; consumed once
 *   sessions    — known remote sessions (one per device per logical session)
 *   audit_log   — every hub action for forensics
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HubStoreOptions {
  readonly path: string;
}

export class HubStore {
  private db: Database;

  constructor(opts: HubStoreOptions) {
    mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new Database(opts.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id           TEXT PRIMARY KEY,
        public_key   TEXT NOT NULL UNIQUE,
        label        TEXT,
        approved     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        approved_at  INTEGER
      );
      CREATE TABLE IF NOT EXISTS pairings (
        token        TEXT PRIMARY KEY,
        device_id    TEXT NOT NULL REFERENCES devices(id),
        expires_at   INTEGER NOT NULL,
        consumed     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        device_id    TEXT NOT NULL REFERENCES devices(id),
        label        TEXT,
        cwd          TEXT,
        last_seen    INTEGER NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp    INTEGER NOT NULL,
        device_id    TEXT,
        action       TEXT NOT NULL,
        detail       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);
      CREATE INDEX IF NOT EXISTS idx_pairings_device ON pairings(device_id);
    `);
  }

  /* ----------------------------- devices ----------------------------- */

  insertDevice(id: string, publicKey: string): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, public_key, created_at) VALUES (?, ?, ?)
         ON CONFLICT(public_key) DO NOTHING`,
      )
      .run(id, publicKey, Date.now());
  }

  approveDevice(publicKey: string, label: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE devices SET approved = 1, approved_at = ?, label = COALESCE(?, label)
         WHERE public_key = ? AND approved = 0`,
      )
      .run(Date.now(), label, publicKey);
    return res.changes > 0;
  }

  getDevice(publicKey: string): { id: string; approved: boolean; label: string | null } | null {
    const row = this.db
      .prepare('SELECT id, approved, label FROM devices WHERE public_key = ?')
      .get(publicKey) as { id: string; approved: number; label: string | null } | null;
    if (!row) return null;
    return { id: row.id, approved: row.approved === 1, label: row.label };
  }

  listDevices(): Array<{
    id: string;
    publicKey: string;
    label: string | null;
    approved: boolean;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(
        'SELECT id, public_key, label, approved, created_at FROM devices ORDER BY created_at DESC',
      )
      .all() as Array<{
      id: string;
      public_key: string;
      label: string | null;
      approved: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      publicKey: r.public_key,
      label: r.label,
      approved: r.approved === 1,
      createdAt: r.created_at,
    }));
  }

  /* ---------------------------- pairings ----------------------------- */

  createPairing(token: string, deviceId: string, ttlMs: number): void {
    this.db
      .prepare('INSERT INTO pairings (token, device_id, expires_at) VALUES (?, ?, ?)')
      .run(token, deviceId, Date.now() + ttlMs);
  }

  consumePairing(token: string): { deviceId: string } | null {
    const row = this.db
      .prepare('SELECT device_id, expires_at, consumed FROM pairings WHERE token = ?')
      .get(token) as { device_id: string; expires_at: number; consumed: number } | null;
    if (!row) return null;
    if (row.consumed === 1 || row.expires_at < Date.now()) return null;
    this.db.prepare('UPDATE pairings SET consumed = 1 WHERE token = ?').run(token);
    return { deviceId: row.device_id };
  }

  /* ----------------------------- sessions ---------------------------- */

  upsertSession(id: string, deviceId: string, cwd: string | null, label: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, device_id, cwd, label, last_seen, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen = excluded.last_seen,
           cwd = COALESCE(excluded.cwd, sessions.cwd),
           label = COALESCE(excluded.label, sessions.label)`,
      )
      .run(id, deviceId, cwd, label, Date.now(), Date.now());
  }

  removeSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  listSessions(): Array<{
    id: string;
    deviceId: string;
    cwd: string | null;
    label: string | null;
    lastSeen: number;
  }> {
    const rows = this.db
      .prepare('SELECT id, device_id, cwd, label, last_seen FROM sessions ORDER BY last_seen DESC')
      .all() as Array<{
      id: string;
      device_id: string;
      cwd: string | null;
      label: string | null;
      last_seen: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      cwd: r.cwd,
      label: r.label,
      lastSeen: r.last_seen,
    }));
  }

  /* ------------------------------ audit ----------------------------- */

  audit(deviceId: string | null, action: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO audit_log (timestamp, device_id, action, detail) VALUES (?, ?, ?, ?)')
      .run(Date.now(), deviceId, action, detail ?? null);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * SessionManager — owns the set of running Subprocess instances, one per
 * session. Each session is identified by a sessionId string and lazily
 * spawned on first attach.
 *
 * For v0.1: at most one client can be attached to a session at a time.
 * Multi-subscriber is a hub-mode concern.
 */

import { type PermissionMode, Subprocess, type SubprocessListener } from './subprocess.ts';

export interface ManagedSession {
  readonly id: string;
  readonly subprocess: Subprocess;
  /** The client currently attached, if any. */
  attached: SubprocessListener | null;
  /** The unsub function returned by `subprocess.on(listener)`. */
  unsubscribe: (() => void) | null;
  /** Timestamp of last event emitted from the subprocess (ms since epoch). */
  lastActivity: number;
}

export interface SessionManagerOptions {
  /** Path or name of the `claude` binary. */
  readonly binary?: string;
  /** Working directory for spawned subprocesses. */
  readonly cwd?: string;
  /** Permission mode forwarded to subprocesses. */
  readonly permissionMode?: PermissionMode;
}

export class SessionManager {
  private sessions: Map<string, ManagedSession> = new Map();

  constructor(private readonly opts: SessionManagerOptions = {}) {}

  /**
   * Attach a client listener to a session. Spawns the subprocess on first
   * attach. Returns a `detach` callback that removes the listener (the
   * subprocess keeps running).
   */
  attach(sessionId: string, listener: SubprocessListener): () => void {
    const session = this.getOrCreate(sessionId);

    // If someone else is already attached, drop them first.
    if (session.attached && session.unsubscribe) {
      session.unsubscribe();
    }

    const unsubscribe = session.subprocess.on(listener);
    session.attached = listener;
    session.unsubscribe = unsubscribe;
    session.lastActivity = Date.now();
    session.subprocess.start();
    return () => this.detach(sessionId, listener);
  }

  /**
   * Send a prompt to a session's subprocess. Throws if the session is not
   * running.
   */
  send(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    session.lastActivity = Date.now();
    session.subprocess.send(text);
  }

  /**
   * Interrupt the current turn of a session.
   */
  interrupt(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.subprocess.interrupt();
  }

  /**
   * Stop and remove a session. Idempotent.
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.unsubscribe) session.unsubscribe();
    await session.subprocess.stop();
  }

  /**
   * Stop every running session. Called on server shutdown.
   */
  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /** Test helper: count of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** List session summaries (Phase 3 sidebar). */
  list(): Array<{ id: string; lastActivity: number }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      lastActivity: s.lastActivity,
    }));
  }

  private getOrCreate(sessionId: string): ManagedSession {
    let session = this.sessions.get(sessionId);
    if (session) return session;

    const subprocess = new Subprocess({
      binary: this.opts.binary ?? process.env.CLAUDE_BIN ?? 'claude',
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.permissionMode ? { permissionMode: this.opts.permissionMode } : {}),
    });
    session = {
      id: sessionId,
      subprocess,
      attached: null,
      unsubscribe: null,
      lastActivity: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private detach(sessionId: string, listener: SubprocessListener): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.attached === listener) {
      if (session.unsubscribe) session.unsubscribe();
      session.attached = null;
      session.unsubscribe = null;
    }
  }
}

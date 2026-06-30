/**
 * PermissionManager — bridges the PreToolUse hook (HTTP) to the WS
 * permission_request/permission_response protocol.
 *
 * Flow:
 *   1. Server receives POST /internal/hook/{sessionId} from the hook
 *      command. The POST body carries tool info.
 *   2. Manager creates a PendingRequest (id, sessionId, tool, input,
 *      resolve callback) and emits a `permission_request` WS frame to
 *      the attached UI(s) via the listener API.
 *   3. UI sends `permission_response` back over WS. Manager resolves
 *      the matching PendingRequest, which unblocks the HTTP POST.
 *
 * The PendingRequest map is per-session so concurrent prompts for
 * different sessions don't interfere. Requests for the same session
 * are queued (FIFO) — the hook waits for the user to decide the
 * earlier one before being asked about the next.
 */

import { randomUUID } from 'node:crypto';
import { writeAudit } from './audit.ts';

export interface PermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly toolUseId: string;
  readonly hookEventName: string;
  readonly claudeSessionId: string;
  readonly createdAt: number;
}

export interface PermissionDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

/** Listener invoked once per inbound permission request. */
export type PermissionListener = (req: PermissionRequest) => void;

interface Pending {
  readonly req: PermissionRequest;
  readonly resolve: (decision: PermissionDecision) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface PermissionManagerOptions {
  /** How long a permission request waits before timing out (default 5 min). */
  readonly timeoutMs?: number;
}

export class PermissionManager {
  private pending = new Map<string, Pending>();
  private listeners = new Set<PermissionListener>();
  private readonly timeoutMs: number;

  constructor(opts: PermissionManagerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  /**
   * Open a new permission request. Returns a promise that resolves with
   * the user's decision (or rejects on timeout / unknown request).
   */
  open(args: {
    sessionId: string;
    tool: string;
    input: Record<string, unknown>;
    toolUseId: string;
    hookEventName: string;
    claudeSessionId: string;
  }): Promise<PermissionDecision> {
    const req: PermissionRequest = {
      id: randomUUID(),
      sessionId: args.sessionId,
      tool: args.tool,
      input: args.input,
      toolUseId: args.toolUseId,
      hookEventName: args.hookEventName,
      claudeSessionId: args.claudeSessionId,
      createdAt: Date.now(),
    };

    return new Promise<PermissionDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req.id)) {
          reject(new Error('permission request timed out'));
        }
      }, this.timeoutMs);
      timer.unref?.();

      this.pending.set(req.id, { req, resolve, reject, timer });

      // Audit the request opening (with input). Resolution is audited by
      // the WS handler (which has the user-facing reason).
      void writeAudit({
        timestamp: req.createdAt,
        sessionId: req.sessionId,
        requestId: req.id,
        tool: req.tool,
        input: req.input,
        decision: 'allow', // provisional; updated on resolution
        reason: 'requested',
      });

      for (const l of this.listeners) {
        try {
          l(req);
        } catch {
          // listener errors must not block other listeners
        }
      }
    });
  }

  /**
   * Resolve a pending request by id. Returns true if the request was
   * found and resolved, false otherwise.
   */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(decision);
    return true;
  }

  /** Test helper: number of in-flight requests across all sessions. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Register a listener for newly opened requests. Returns an
   * unsubscribe function.
   */
  on(listener: PermissionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Audit log — append-only JSONL of every permission decision.
 *
 * Writes go to:
 *   $XDG_DATA_HOME/open-rc/audit.jsonl   (preferred)
 *   ~/.local/share/open-rc/audit.jsonl   (XDG fallback)
 *   ./audit.jsonl                         (last resort, only if both fail)
 *
 * One line per decision. Errors are swallowed — audit must never
 * crash a permission flow.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AuditEntry {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly requestId: string;
  readonly tool: string;
  readonly input?: Record<string, unknown>;
  readonly decision: 'allow' | 'deny' | 'timeout';
  readonly reason?: string;
}

let resolvedPath: string | null = null;

async function resolveAuditPath(): Promise<string> {
  if (resolvedPath) return resolvedPath;

  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const candidates = [join(xdg, 'open-rc', 'audit.jsonl'), join(process.cwd(), 'audit.jsonl')];

  for (const p of candidates) {
    try {
      await mkdir(dirname(p), { recursive: true });
      resolvedPath = p;
      return p;
    } catch {
      // try next
    }
  }
  throw new Error('no writable audit path');
}

/**
 * Append one entry. Best-effort: any error is swallowed after writing
 * to stderr so it doesn't crash the calling code path.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const path = await resolveAuditPath();
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    process.stderr.write(`audit append failed: ${err}\n`);
  }
}

/** Test helper: reset cached path so a new env var is honored. */
export function resetAuditPathForTests(): void {
  resolvedPath = null;
}

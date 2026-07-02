/**
 * Locate the transcript JSONL of an already-running Claude Code
 * session on disk.
 *
 * Claude Code writes every session to
 * `~/.claude/projects/<munged cwd>/<session-uuid>.jsonl`, where the
 * munged cwd replaces every non-alphanumeric character with `-`
 * (`/Users/me/Workspace/open-rc` → `-Users-me-Workspace-open-rc`).
 *
 * The bridge shares the CURRENT session of a project, which is the
 * most recently modified transcript in that directory — the session
 * that just executed `/attach-orc` has, by definition, written its
 * own invocation to its transcript moments ago.
 *
 * Read-only: this module never writes into `~/.claude`.
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface LocatedTranscript {
  /** Absolute path to the session's JSONL transcript. */
  readonly path: string;
  /** Session id — the transcript's basename without `.jsonl`. */
  readonly sessionId: string;
}

/** Replace every non-alphanumeric character with `-` (Claude Code's
 *  project-directory naming scheme). */
export function mungeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** `~/.claude/projects/<munged cwd>` for a given project cwd. */
export function projectTranscriptDir(cwd: string, claudeHome?: string): string {
  const base = claudeHome ?? join(homedir(), '.claude');
  return join(base, 'projects', mungeCwd(cwd));
}

/** Session id encoded in a transcript path. */
export function sessionIdOf(transcriptPath: string): string {
  return basename(transcriptPath).replace(/\.jsonl$/, '');
}

/**
 * The most recently modified `*.jsonl` in a project transcript dir —
 * the project's current session. Returns null when the directory does
 * not exist or holds no transcripts.
 */
export async function newestTranscript(projectDir: string): Promise<LocatedTranscript | null> {
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch {
    return null;
  }

  let newest: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(projectDir, name);
    try {
      const s = await stat(path);
      if (!s.isFile()) continue;
      if (!newest || s.mtimeMs > newest.mtime) {
        newest = { path, mtime: s.mtimeMs };
      }
    } catch {
      // raced with deletion; skip
    }
  }

  if (!newest) return null;
  return { path: newest.path, sessionId: sessionIdOf(newest.path) };
}

/**
 * Resolve the transcript to bridge: an explicit `--transcript` wins,
 * otherwise the newest transcript of the project at `cwd`.
 */
export async function resolveTranscript(input: {
  readonly transcript?: string;
  readonly cwd: string;
  readonly claudeHome?: string;
}): Promise<LocatedTranscript> {
  if (input.transcript) {
    const s = await stat(input.transcript).catch(() => null);
    if (!s?.isFile()) {
      throw new Error(`transcript not found: ${input.transcript}`);
    }
    return { path: input.transcript, sessionId: sessionIdOf(input.transcript) };
  }

  const dir = projectTranscriptDir(input.cwd, input.claudeHome);
  const found = await newestTranscript(dir);
  if (!found) {
    throw new Error(
      `no Claude Code transcript found under ${dir} — is a claude session running in this directory? (pass --transcript to point at one explicitly)`,
    );
  }
  return found;
}

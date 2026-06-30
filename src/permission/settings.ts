/**
 * Settings.json generator — produces a Claude Code settings file that
 * defines our PreToolUse hook.
 *
 * Why this exists: `--bare` skips hooks, so for sessions with
 * `--permission-mode default`, we have to drop `--bare` and inject a
 * settings file that registers the hook. The hook command is
 * `open-rc hook pretool --session <sessionId> --url <hookUrl>`.
 *
 * The Claude Code PreToolUse hook protocol:
 *   - stdin:  JSON `{"hook_event_name":"PreToolUse","tool_name":"Bash", ...}`
 *   - stdout: JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *                                         "permissionDecision":"allow|deny|ask",
 *                                         "permissionDecisionReason":"..."}}`
 *   - exit 0 on success; non-zero on error.
 *
 * Reference: https://docs.claude.com/en/docs/claude-code/hooks
 */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface HookSettingsOpts {
  /** Session id (UUID) — included in the hook command so it can route back. */
  readonly sessionId: string;
  /** URL the hook command will POST tool info to. */
  readonly hookUrl: string;
  /** Path to the `open-rc` binary the hook command runs. */
  readonly openRcBin: string;
}

/**
 * Build the settings.json payload. Pure function so we can unit-test the
 * shape without touching the filesystem.
 */
export function buildHookSettings(opts: HookSettingsOpts): Record<string, unknown> {
  const hookCmd = [
    opts.openRcBin,
    'hook',
    'pretool',
    '--session',
    opts.sessionId,
    '--url',
    opts.hookUrl,
  ];
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [
            {
              type: 'command',
              command: hookCmd.map((s) => (s.includes(' ') ? JSON.stringify(s) : s)).join(' '),
            },
          ],
        },
      ],
    },
  };
}

/**
 * Write a settings.json file to `path` and return the path. Caller is
 * responsible for cleanup; `cleanupHookSettings` deletes it.
 */
export async function writeHookSettings(path: string, opts: HookSettingsOpts): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const payload = buildHookSettings(opts);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Best-effort cleanup. Swallows ENOENT — the file may have been removed.
 */
export async function cleanupHookSettings(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

#!/usr/bin/env bun
/**
 * Install (or remove) the open-rc Claude Code integration:
 *
 *   1. Hook entries in `~/.claude/settings.json` —
 *      Stop / UserPromptSubmit / SessionEnd → `open-rc hook <event>`.
 *      These are the browser→session delivery half of `attach-orc`;
 *      they are instant no-ops on sessions that never ran
 *      `/attach-orc` (see src/cli/attach-hooks.ts).
 *   2. The `/attach-orc` slash command — a symlink from
 *      `~/.claude/commands/attach-orc.md` to this repo's
 *      `commands/attach-orc.md`, so `git pull` updates it in place.
 *
 * Idempotent: existing open-rc entries (recognized by their command
 * containing "open-rc hook") are replaced, never duplicated, and all
 * other user hooks are preserved verbatim.
 *
 * Usage:
 *   bun run scripts/install-hooks.ts --bin ~/.local/bin/open-rc
 *   bun run scripts/install-hooks.ts --remove
 */

import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseFlags } from '../src/cli/flags.ts';

/** Marker every open-rc-managed hook command contains. */
const HOOK_MARKER = 'open-rc hook';

/** Stop hook needs headroom over the LONG (browser-driven) listening
 *  window — 300 s by default (ORC_STOP_LINGER_ACTIVE_MS). */
const STOP_TIMEOUT_S = 630;

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>;
};

const isOurs = (h: HookCommand): boolean =>
  typeof h.command === 'string' && h.command.includes(HOOK_MARKER);

/** Drop open-rc commands from a group list; drop groups left empty. */
function withoutOurs(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
}

function addedHooks(bin: string): Record<string, HookGroup[]> {
  return {
    Stop: [
      {
        hooks: [{ type: 'command', command: `${bin} hook stop`, timeout: STOP_TIMEOUT_S }],
      },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${bin} hook prompt` }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: `${bin} hook end` }] }],
  };
}

export function mergeSettings(settings: Settings, bin: string, remove: boolean): Settings {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  const ours = addedHooks(bin);

  for (const event of Object.keys(ours)) {
    const kept = withoutOurs(hooks[event] ?? []);
    const next = remove ? kept : [...kept, ...(ours[event] ?? [])];
    if (next.length > 0) hooks[event] = next;
    else hooks[event] = undefined as unknown as HookGroup[];
  }
  const prunedHooks = Object.fromEntries(
    Object.entries(hooks).filter(([, v]) => v !== undefined),
  ) as Record<string, HookGroup[]>;

  const { hooks: _ignored, ...rest } = settings;
  return Object.keys(prunedHooks).length > 0 ? { ...rest, hooks: prunedHooks } : rest;
}

async function readSettings(path: string): Promise<Settings> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Settings;
    }
    throw new Error(`${path} is not a JSON object`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function installCommandLink(commandsDir: string, repoCommand: string): Promise<void> {
  await mkdir(commandsDir, { recursive: true });
  const link = join(commandsDir, 'attach-orc.md');
  await unlink(link).catch(() => {});
  await symlink(repoCommand, link);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const remove = flags.remove === true;
  const home = homedir();
  const bin = typeof flags.bin === 'string' ? flags.bin : join(home, '.local', 'bin', 'open-rc');
  const settingsPath =
    typeof flags.settings === 'string' ? flags.settings : join(home, '.claude', 'settings.json');
  const commandsDir =
    typeof flags.commandsDir === 'string' ? flags.commandsDir : join(home, '.claude', 'commands');
  const repoCommand = new URL('../commands/attach-orc.md', import.meta.url).pathname;

  const settings = await readSettings(settingsPath);
  const merged = mergeSettings(settings, bin, remove);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);

  if (remove) {
    await unlink(join(commandsDir, 'attach-orc.md')).catch(() => {});
    console.log(`open-rc hooks removed from ${settingsPath}`);
    console.log(`removed ${join(commandsDir, 'attach-orc.md')}`);
  } else {
    await installCommandLink(commandsDir, repoCommand);
    console.log(
      `open-rc hooks installed in ${settingsPath} (Stop / UserPromptSubmit / SessionEnd)`,
    );
    console.log(`/attach-orc command linked at ${join(commandsDir, 'attach-orc.md')}`);
    console.log('restart running claude sessions to pick the hooks up');
  }
}

if (import.meta.main) {
  await main();
}

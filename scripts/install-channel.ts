#!/usr/bin/env bun
/**
 * Install (or remove) the `orc` MCP CHANNEL server entry in the
 * user-scope Claude Code MCP config (`~/.claude.json`):
 *
 *   "mcpServers": { "orc": { "type": "stdio",
 *                            "command": "<BIN_DIR>/orc",
 *                            "args": ["channel"] } }
 *
 * With the entry in place, any project can opt a session into
 * channel-based sharing:
 *
 *   claude --dangerously-load-development-channels server:orc
 *
 * (the development flag is required while Channels are a research
 * preview — custom channels aren't on the Anthropic allowlist).
 *
 * The entry name MUST be `orc`: it is the `source` attribute of the
 * injected `<channel>` tags and the `server:orc` reference above.
 *
 * Idempotent: an existing `orc` entry is replaced only when it is
 * recognizably ours (args start with "channel"); anything else in the
 * file is preserved verbatim. `~/.claude.json` is claude's own
 * mutable config — run this while no claude session is writing it.
 *
 * Usage:
 *   bun run scripts/install-channel.ts --bin ~/.local/bin/orc
 *   bun run scripts/install-channel.ts --remove
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFlags } from '../src/cli/flags.ts';

/** The mcpServers key — also the channel's `source` name. */
const SERVER_KEY = 'orc';

interface McpServerEntry {
  type?: string;
  command?: string;
  args?: unknown[];
}
type ClaudeJson = Record<string, unknown> & {
  mcpServers?: Record<string, McpServerEntry>;
};

const isOurs = (entry: McpServerEntry | undefined): boolean =>
  entry !== undefined && Array.isArray(entry.args) && entry.args[0] === 'channel';

/** Pure merge: add or remove our entry, touch nothing else. */
export function mergeClaudeJson(config: ClaudeJson, bin: string, remove: boolean): ClaudeJson {
  const servers = { ...(config.mcpServers ?? {}) };
  const existing = servers[SERVER_KEY];

  if (remove) {
    if (!isOurs(existing)) return config; // not ours (or absent) — leave it
    const { [SERVER_KEY]: _dropped, ...rest } = servers;
    if (Object.keys(rest).length > 0) return { ...config, mcpServers: rest };
    const { mcpServers: _emptied, ...restConfig } = config;
    return restConfig;
  }

  if (existing !== undefined && !isOurs(existing)) {
    throw new Error(
      `mcpServers.${SERVER_KEY} already exists in the config and is not an open-rc channel entry — refusing to overwrite it`,
    );
  }
  return {
    ...config,
    mcpServers: {
      ...servers,
      [SERVER_KEY]: { type: 'stdio', command: bin, args: ['channel'] },
    },
  };
}

async function readConfig(path: string): Promise<ClaudeJson> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ClaudeJson;
    }
    throw new Error(`${path} is not a JSON object`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const remove = flags.remove === true;
  const home = homedir();
  const bin = typeof flags.bin === 'string' ? flags.bin : join(home, '.local', 'bin', 'orc');
  const configPath =
    typeof flags.claudeJson === 'string' ? flags.claudeJson : join(home, '.claude.json');

  const config = await readConfig(configPath);
  const merged = mergeClaudeJson(config, bin, remove);
  if (merged !== config) {
    await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  }

  if (remove) {
    console.log(`channel MCP entry removed from ${configPath}`);
  } else {
    console.log(`channel MCP server "${SERVER_KEY}" registered in ${configPath}`);
    console.log('enable it per session with:');
    console.log('  claude --dangerously-load-development-channels server:orc');
  }
}

if (import.meta.main) {
  await main();
}

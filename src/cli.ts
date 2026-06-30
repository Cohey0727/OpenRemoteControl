#!/usr/bin/env bun
/**
 * `open-rc` CLI entry point.
 *
 * Commands:
 *   serve       Start the local server (default if no command given).
 *   hub         Run as a public relay (Phase 4).
 *   hook pretool  Internal: invoked by Claude Code as a PreToolUse hook.
 */

import { HubServer } from './hub/server.ts';
import { serve } from './serve.ts';

function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const [command = 'serve', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
}

const uiDir = new URL('../ui/', import.meta.url).pathname;

const { command, flags } = parseArgs(process.argv.slice(2));

if (command === 'serve' || command === '') {
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  const port = typeof flags.port === 'string' ? Number.parseInt(flags.port, 10) : 7322;
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : undefined;
  const claudeBin = typeof flags.claudeBin === 'string' ? flags.claudeBin : undefined;
  const permissionMode =
    typeof flags.permissionMode === 'string' ? flags.permissionMode : undefined;

  if (Number.isNaN(port)) {
    console.error(`invalid port: ${flags.port}`);
    process.exit(2);
  }

  const handle = await serve({
    host,
    port,
    uiDir,
    ...(cwd ? { cwd } : {}),
    ...(claudeBin ? { claudeBin } : {}),
    ...(permissionMode ? { permissionMode: permissionMode as 'default' } : {}),
  });

  console.log(`open-rc serve listening on http://${host}:${port}`);
  console.log(`UI:   http://${host}:${port}/`);
  console.log(`WS:   ws://${host}:${port}/ws`);

  const shutdown = async () => {
    console.log('\nshutting down...');
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (command === 'hub') {
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  const port = typeof flags.port === 'string' ? Number.parseInt(flags.port, 10) : 7443;
  const dbPath = typeof flags.dbPath === 'string' ? flags.dbPath : undefined;
  const autoApprove = flags.autoApprove === true;

  const hub = new HubServer({ ...(dbPath ? { dbPath } : {}), autoApprove });
  await hub.start({ host, port });
  console.log(`open-rc hub listening on http://${host}:${port}`);
  console.log(`Device WS: ws://${host}:${port}/device`);
  console.log(`Browser WS: ws://${host}:${port}/browser`);
  console.log(`Health: http://${host}:${port}/health`);

  const shutdown = async () => {
    console.log('\nshutting down...');
    await hub.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (command === 'hook' && flags.type === 'pretool') {
  // Internal entrypoint invoked by the PreToolUse hook defined in
  // src/permission/settings.ts. Forwards to the hook command.
  await import('./hook/pretool.ts');
} else {
  console.error(`unknown command: ${command}`);
  console.error('available commands: serve, hub, hook pretool');
  process.exit(2);
}

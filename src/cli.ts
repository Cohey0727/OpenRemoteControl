#!/usr/bin/env bun
/**
 * `open-rc` CLI entry point.
 *
 * Commands:
 *   serve   Local WebSocket relay + SPA (default if no command given).
 *   hub     Public relay that brokers many `serve` instances to many
 *           browsers.
 *   tui     Terminal front-end for a relayed session. A plain `/ws`
 *           client (like the browser) — attaches to a clientId and
 *           renders/sends frames.
 *
 * All three run no processes of their own. `serve`/`hub` are
 * byte-pass-through relays; `tui` is a WebSocket client. The user runs
 * `claude` themselves and brings their own bridge that pipes its
 * stream-json to the `/agent` WebSocket; open-rc only relays.
 */

import { parseFlags } from './cli/flags.ts';
import { parseTuiFlags, runTui } from './cli/tui.ts';
import { HubServer } from './hub/server.ts';
import { serve } from './serve.ts';

function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const [command = 'serve', ...rest] = argv;
  return { command, flags: parseFlags(rest) };
}

const uiDir = new URL('../ui/', import.meta.url).pathname;

const { command, flags } = parseArgs(process.argv.slice(2));

if (command === 'serve' || command === '') {
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  const port = typeof flags.port === 'string' ? Number.parseInt(flags.port, 10) : 7322;
  const pushDisabled = flags.pushDisabled === true;

  if (Number.isNaN(port)) {
    console.error(`invalid port: ${flags.port}`);
    process.exit(2);
  }

  const handle = await serve({
    host,
    port,
    uiDir,
    ...(pushDisabled ? { pushDisabled } : {}),
  });

  console.log(`open-rc serve listening on http://${host}:${port}`);
  console.log(`UI:    http://${host}:${port}/`);
  console.log(`WS:    ws://${host}:${port}/ws     (browsers)`);
  console.log(`Agent: ws://${host}:${port}/agent  (user-owned bridges)`);

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
} else if (command === 'tui') {
  const tuiFlags = parseTuiFlags(process.argv.slice(3));
  await runTui(tuiFlags);
} else {
  console.error(`unknown command: ${command}`);
  console.error('available commands: serve, hub, tui');
  process.exit(2);
}

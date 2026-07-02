#!/usr/bin/env bun
/**
 * `open-rc` CLI entry point.
 *
 * Commands:
 *   serve         Local WebSocket relay + SPA (default if no command given).
 *   hub           Public relay that brokers many `serve` instances to many
 *                 browsers.
 *   attach-orc    Spawn a local `claude` and bridge it to the running
 *                 `serve` via `/agent`, so the session shows up in the
 *                 browser and can be driven from there. Point it at a
 *                 remote serve with `ORC_BASE_URL`. `orc` = "open remote
 *                 control".
 *   tui           Terminal front-end for a relayed session. A plain
 *                 `/ws` client (like the browser) — attaches to a
 *                 clientId and shares that ONE `claude` with the
 *                 browser: prompts and stream flow both ways.
 *
 * Spawn discipline:
 *   - `serve`, `hub`, and `tui` NEVER spawn anything. `serve`/`hub` are
 *     byte-pass-through relays; `tui` is a WebSocket client. Their
 *     process trees contain only themselves.
 *   - `attach-orc` is the ONE place in the project that calls `Bun.spawn`
 *     for `claude`. It runs as a separate process under the user's
 *     terminal, owns the subprocess, and translates its stream-json
 *     stdio into /agent frames. The server remains spawn-free.
 */

import { parseAttachFlags, runAttach } from './cli/attach-orc.ts';
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
} else if (command === 'attach-orc') {
  const attachFlags = parseAttachFlags(process.argv.slice(3));
  console.log(`[attach-orc] server:   ${attachFlags.server}`);
  console.log(`[attach-orc] label:    ${attachFlags.label}`);
  console.log(`[attach-orc] cwd:      ${attachFlags.cwd}`);
  if (attachFlags.clientId) {
    console.log(`[attach-orc] clientId: ${attachFlags.clientId}`);
  }
  await runAttach(attachFlags);
} else if (command === 'tui') {
  const tuiFlags = parseTuiFlags(process.argv.slice(3));
  await runTui(tuiFlags);
} else {
  console.error(`unknown command: ${command}`);
  console.error('available commands: serve, hub, attach-orc, tui');
  process.exit(2);
}

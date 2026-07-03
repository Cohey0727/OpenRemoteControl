#!/usr/bin/env bun
/**
 * `open-rc` CLI entry point.
 *
 * Commands:
 *   serve       Local WebSocket relay + SPA (default if no command
 *               given).
 *   hub         Public relay that brokers many `serve` instances to
 *               many browsers.
 *   tui         Terminal front-end for a relayed session. A plain
 *               `/ws` client (like the browser) — attaches to a
 *               clientId and renders/sends frames.
 *   attach      Share the ALREADY-RUNNING Claude Code session of the
 *               current directory: replays + tails its transcript to
 *               `/agent` and queues browser prompts for the Claude
 *               Code hooks to deliver. Started in the background by
 *               the `/orc` slash command.
 *   hook        Claude Code hook handlers (stop|prompt|notify|ask|end) —
 *               the queue-delivery half of attach-orc. Wired into
 *               `~/.claude/settings.json` by `make setup`.
 *
 * None of these launch a process. `serve`/`hub` are byte-pass-through
 * relays; `tui` is a WebSocket client; `attach-orc` reads the session
 * transcript the user's own `claude` writes; `hook` handlers exchange
 * files with the bridge. There is no child_process, PTY, or tmux
 * anywhere in open-rc.
 */

import { runHookCommand } from './cli/attach-hooks.ts';
import { parseAttachOrcFlags, runAttachOrc } from './cli/attach.ts';
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

  // Styled only on a TTY so piped/logged output stays grep-friendly.
  const tty = process.stdout.isTTY === true;
  const amber = tty ? '\x1b[38;5;208m' : '';
  const cyan = tty ? '\x1b[36m' : '';
  const dim = tty ? '\x1b[90m' : '';
  const bold = tty ? '\x1b[1m' : '';
  const off = tty ? '\x1b[0m' : '';
  console.log(`${amber}${bold}orc serve${off} ${dim}·${off} relay is up`);
  console.log(` ${amber}◉${off} ${dim}UI${off}      ${cyan}http://${host}:${port}/${off}`);
  console.log(
    ` ${amber}◉${off} ${dim}ws${off}      ${cyan}ws://${host}:${port}/ws${off}     ${dim}browsers / tui${off}`,
  );
  console.log(
    ` ${amber}◉${off} ${dim}agent${off}   ${cyan}ws://${host}:${port}/agent${off}  ${dim}bridges — /orc lands here${off}`,
  );

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
  console.log(`orc hub listening on http://${host}:${port}`);
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
} else if (command === 'attach') {
  const attachFlags = parseAttachOrcFlags(process.argv.slice(3));
  let handle: Awaited<ReturnType<typeof runAttachOrc>>;
  try {
    handle = await runAttachOrc(attachFlags, {
      onExit: () => process.exit(0),
    });
  } catch (err) {
    console.error(`orc attach: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (command === 'hook') {
  const event = process.argv[3] ?? '';
  const stdinText = await Bun.stdin.text();
  process.exit(await runHookCommand(event, stdinText));
} else {
  console.error(`unknown command: ${command}`);
  console.error('available commands: serve, hub, tui, attach, hook');
  process.exit(2);
}

/**
 * `open-rc tui` — a terminal front-end for a session that open-rc serve
 * is relaying.
 *
 * It is a plain `/ws` client, exactly like the browser SPA: it does NOT
 * spawn or own `claude`. `attach-orc` owns the one `claude`; the browser
 * and this `tui` are both clients of `open-rc serve`, attached to the
 * same clientId — so they share ONE live session. A prompt typed here
 * shows up in the browser and vice-versa, and both see the same stream.
 *
 * Flags: --server (ws URL of serve's /ws, default from ORC_BASE_URL),
 * --client-id (which session to attach to; auto-picks the only/most
 * recent one when omitted).
 */

import { type Interface, createInterface } from 'node:readline';
import { parseFlags } from './flags.ts';

/* -------------------------------------------------------------------------- */
/*  Flags                                                                      */
/* -------------------------------------------------------------------------- */

export interface TuiFlags {
  /** WebSocket URL of the serve /ws (browser) endpoint. */
  server: string;
  /** Explicit clientId to attach to. Auto-picked when omitted. */
  clientId?: string;
}

/** Derive the browser `/ws` URL from a base like ORC_BASE_URL. */
export function wsUrlFromBase(base: string): string {
  let u = base
    .trim()
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
  if (!/^wss?:\/\//i.test(u)) u = `ws://${u}`;
  u = u.replace(/\/+$/, '');
  return /\/ws$/.test(u) ? u : `${u}/ws`;
}

export function parseTuiFlags(argv: string[]): TuiFlags {
  const flags = parseFlags(argv);
  const base = process.env.ORC_BASE_URL ?? process.env.ORC__BASE_URL;
  const server = wsUrlFromBase(
    typeof flags.server === 'string' ? flags.server : (base ?? 'ws://127.0.0.1:7322'),
  );
  const clientId = typeof flags.clientId === 'string' ? flags.clientId : undefined;
  return { server, ...(clientId !== undefined ? { clientId } : {}) };
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const C = {
  amber: '\x1b[38;5;208m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
  off: '\x1b[0m',
};

interface ClientInfo {
  clientId: string;
  label: string;
  cwd: string;
  status: string;
  lastActivity: number;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/* -------------------------------------------------------------------------- */
/*  Run                                                                        */
/* -------------------------------------------------------------------------- */

export async function runTui(flags: TuiFlags): Promise<void> {
  let ws: WebSocket | undefined;
  let attached: string | null = flags.clientId ?? null;
  let clients: ClientInfo[] = [];
  let pendingRequestId: string | null = null;
  let stop = false;
  const reconnectDelays = [500, 1000, 2000, 3000, 5000];
  let reconnectAttempt = 0;

  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`${C.amber}› ${C.off}`);

  /** Print a line above the input prompt without eating what's being typed. */
  function render(line: string): void {
    process.stdout.write(`\r\x1b[2K${line}\n`);
    rl.prompt(true);
  }

  function sendJson(obj: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function pickClient(): void {
    const live = clients.filter((c) => c.status !== 'exited');
    const pool = live.length > 0 ? live : clients;
    if (attached && clients.some((c) => c.clientId === attached)) {
      doAttach(attached);
      return;
    }
    if (pool.length === 0) {
      render(
        `${C.dim}no sessions connected yet — run \`attach-orc\` somewhere, then /clients${C.off}`,
      );
      return;
    }
    const only = pool.length === 1 ? pool[0] : undefined;
    if (only) {
      doAttach(only.clientId);
      return;
    }
    render(`${C.bold}multiple sessions — /attach <clientId>:${C.off}`);
    for (const c of pool)
      render(`  ${C.cyan}${c.clientId}${C.off}  ${c.label} ${C.dim}(${c.cwd})${C.off}`);
  }

  function doAttach(clientId: string): void {
    const c = clients.find((x) => x.clientId === clientId);
    attached = clientId;
    pendingRequestId = null;
    sendJson({ type: 'attach', clientId });
    render(
      `${C.green}◉${C.off} attached to ${C.bold}${c?.label ?? clientId}${C.off} ` +
        `${C.dim}${c?.cwd ?? ''} · shared with the browser · type to send, /help for commands${C.off}`,
    );
  }

  function handle(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'client_list':
      case 'clients_changed':
        clients = (msg.clients as ClientInfo[]) ?? [];
        if (!attached || !clients.some((c) => c.clientId === attached)) pickClient();
        return;
      case 'client_registered': {
        const c = msg.client as ClientInfo;
        if (!clients.some((x) => x.clientId === c.clientId)) clients = [...clients, c];
        if (!attached) pickClient();
        return;
      }
      case 'client_removed':
        clients = clients.filter((c) => c.clientId !== (msg.clientId as string));
        if (attached === msg.clientId) {
          render(`${C.red}◉${C.off} ${C.dim}session ${msg.clientId} disconnected${C.off}`);
          attached = null;
          pickClient();
        }
        return;
    }

    // Per-session frames only matter for the attached client.
    if (msg.clientId !== attached) return;
    switch (msg.type) {
      case 'user':
        render(`${C.amber}you${C.off} ${msg.text as string}`);
        return;
      case 'text':
        render(`${C.bold}claude${C.off} ${msg.text as string}`);
        return;
      case 'thinking':
        render(`${C.dim}  thinking · ${truncate(msg.text as string, 120)}${C.off}`);
        return;
      case 'tool_use':
        render(
          `${C.dim}  ⏵ ${C.off}${C.cyan}${msg.tool as string}${C.off} ${C.dim}${truncate(msg.input as string, 100)}${C.off}`,
        );
        return;
      case 'tool_result':
        render(`${C.dim}  ⏴ ${truncate(msg.output as string, 120)}${C.off}`);
        return;
      case 'permission_request': {
        pendingRequestId = msg.requestId as string;
        render(
          `${C.amber}${C.bold}⚠ permission${C.off} ${C.bold}${msg.tool as string}${C.off} ` +
            `${C.dim}${truncate(JSON.stringify(msg.input), 160)}${C.off}\n` +
            `  ${C.dim}reply${C.off} ${C.green}/allow${C.off} ${C.dim}or${C.off} ${C.red}/deny${C.off}`,
        );
        return;
      }
      case 'done': {
        const bits = ['turn complete'];
        if (typeof msg.duration_ms === 'number')
          bits.push(`${((msg.duration_ms as number) / 1000).toFixed(1)}s`);
        if (typeof msg.cost === 'number') bits.push(`$${(msg.cost as number).toFixed(4)}`);
        if (typeof msg.ts === 'number') {
          bits.push(new Date(msg.ts as number).toLocaleTimeString());
        }
        render(`${C.dim}── ${bits.join(' · ')} ──${C.off}`);
        return;
      }
      case 'error':
        render(`${C.red}error${C.off} ${msg.message as string}`);
        return;
    }
  }

  function connect(): void {
    if (stop) return;
    const sock = new WebSocket(flags.server);
    ws = sock;
    sock.addEventListener('open', () => {
      reconnectAttempt = 0;
      render(`${C.green}◉${C.off} ${C.dim}connected ${flags.server}${C.off}`);
      sendJson({ type: 'list_clients' });
      if (attached) sendJson({ type: 'attach', clientId: attached });
    });
    sock.addEventListener('message', (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data !== 'string') return;
      try {
        handle(JSON.parse(data));
      } catch {
        // ignore malformed
      }
    });
    sock.addEventListener('close', () => {
      ws = undefined;
      if (stop) return;
      const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 5000;
      reconnectAttempt++;
      render(`${C.dim}disconnected — reconnecting…${C.off}`);
      setTimeout(connect, delay);
    });
    sock.addEventListener('error', () => {
      try {
        sock.close();
      } catch {
        // ignore
      }
    });
  }

  function shutdown(): void {
    stop = true;
    try {
      ws?.close();
    } catch {
      // ignore
    }
    rl.close();
    process.stdout.write('\n');
    process.exit(0);
  }

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      switch (cmd) {
        case 'help':
          render(
            `${C.dim}commands:${C.off} /allow  /deny  /clients  /attach <clientId>  /quit${C.off}\n` +
              `${C.dim}anything else is sent as a prompt to the shared session.${C.off}`,
          );
          break;
        case 'allow':
        case 'deny':
          if (!pendingRequestId) {
            render(`${C.dim}nothing to ${cmd}${C.off}`);
          } else {
            sendJson({
              type: 'permission_response',
              clientId: attached,
              requestId: pendingRequestId,
              approved: cmd === 'allow',
            });
            render(
              `${cmd === 'allow' ? C.green : C.red}${cmd === 'allow' ? 'allowed' : 'denied'}${C.off}`,
            );
            pendingRequestId = null;
          }
          break;
        case 'clients':
          if (clients.length === 0) render(`${C.dim}no sessions${C.off}`);
          for (const c of clients) {
            const mark = c.clientId === attached ? `${C.amber}●${C.off}` : ' ';
            render(
              `${mark} ${C.cyan}${c.clientId}${C.off}  ${c.label} ${C.dim}${c.status} · ${c.cwd}${C.off}`,
            );
          }
          break;
        case 'attach':
          if (!arg) render(`${C.dim}usage: /attach <clientId>${C.off}`);
          else doAttach(arg);
          break;
        case 'quit':
        case 'exit':
          shutdown();
          return;
        default:
          render(`${C.dim}unknown command /${cmd} — /help${C.off}`);
      }
      rl.prompt();
      return;
    }
    if (!attached) {
      render(`${C.dim}not attached to a session — /clients then /attach <clientId>${C.off}`);
      rl.prompt();
      return;
    }
    sendJson({ type: 'send', clientId: attached, text: line });
    rl.prompt();
  });

  rl.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  render(`${C.bold}open·rc tui${C.off} ${C.dim}— connecting to ${flags.server}${C.off}`);
  connect();
  rl.prompt();

  // Keep the process alive on the readline stream.
  await new Promise<void>(() => {});
}

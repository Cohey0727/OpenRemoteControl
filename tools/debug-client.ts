/**
 * Bun-based WS client for debug. Usage: bun run tools/debug-client.ts
 */

const PORT = 7396;
const PROMPT = process.argv[2] ?? 'Reply with exactly: pong';
const SID = process.argv[3] ?? 'dbg';

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

ws.addEventListener('open', () => {
  console.log('[client] open');
  ws.send(JSON.stringify({ type: 'attach', sessionId: SID }));
  setTimeout(() => {
    console.log(`[client] send: ${PROMPT}`);
    ws.send(JSON.stringify({ type: 'send', sessionId: SID, text: PROMPT }));
  }, 300);
});

ws.addEventListener('message', (ev) => {
  const frame = JSON.parse(ev.data as string);
  console.log(`[client] ← ${frame.type}`, JSON.stringify(frame).slice(0, 250));
});

ws.addEventListener('close', () => console.log('[client] close'));
ws.addEventListener('error', (ev) => console.error('[client] error', ev));

setTimeout(() => {
  ws.close();
  process.exit(0);
}, 30_000);

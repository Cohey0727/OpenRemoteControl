/**
 * Manual smoke test — start serve, attach a WS, send a prompt, dump frames.
 * Not part of the unit suite; run via `bun run tools/smoke.ts`.
 */

import { serve } from '../src/serve.ts';

const PORT = 7397;
const UI_DIR = `${import.meta.dir}/../ui`;

const handle = await serve({ host: '127.0.0.1', port: PORT, uiDir: UI_DIR });
console.log(`[smoke] serve on http://127.0.0.1:${PORT}`);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const frames: unknown[] = [];

ws.addEventListener('open', () => {
  console.log('[smoke] ws open');
  ws.send(JSON.stringify({ type: 'attach', sessionId: 'smoke' }));
});

ws.addEventListener('message', (ev) => {
  const frame = JSON.parse(ev.data as string);
  frames.push(frame);
  console.log(
    `[smoke] ← ${frame.type}${frame.type === 'text' || frame.type === 'thinking' || frame.type === 'error' ? `: ${(frame.text ?? frame.message ?? '').slice(0, 200)}` : ''}`,
  );
  if (frame.type === 'tool_use') console.log(`  tool: ${frame.tool}`);
  if (frame.type === 'tool_result') console.log(`  output: ${frame.output.slice(0, 200)}`);
  if (frame.type === 'done') {
    if (typeof frame.duration_ms === 'number') console.log(`  duration_ms: ${frame.duration_ms}`);
    if (typeof frame.cost === 'number') console.log(`  cost: $${frame.cost}`);
  }
});

ws.addEventListener('error', (ev) => {
  console.error('[smoke] ws error', ev);
});

await new Promise((r) => setTimeout(r, 500));

const PROMPT = process.argv[2] ?? 'Reply with exactly: pong';
console.log(`[smoke] send: ${PROMPT}`);
ws.send(JSON.stringify({ type: 'send', sessionId: 'smoke', text: PROMPT }));

// wait up to 60s for done/error
await new Promise<void>((resolve) => {
  const t = setTimeout(resolve, 60_000);
  const check = setInterval(() => {
    if (
      frames.some(
        (f) => (f as { type: string }).type === 'done' || (f as { type: string }).type === 'error',
      )
    ) {
      clearTimeout(t);
      clearInterval(check);
      resolve();
    }
  }, 200);
});

ws.close();
await handle.stop();
console.log(`[smoke] total frames: ${frames.length}`);
process.exit(0);

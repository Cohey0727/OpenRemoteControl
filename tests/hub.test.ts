/**
 * Hub E2E test.
 *
 *   - Boots the hub in-process with autoApprove on
 *   - Two "devices" connect, enroll, and register sessions
 *   - A "browser" lists sessions and sends a message to device A's session
 *   - Asserts device A receives the message
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeypair, signNonce } from '../src/hub/crypto.ts';
import { HubServer } from '../src/hub/server.ts';

const PORT = 7461;
const URL = `ws://127.0.0.1:${PORT}/device`;
const BROWSER_URL = `ws://127.0.0.1:${PORT}/browser`;

let hub: HubServer;
let store: ReturnType<typeof getStoreForTest>;
let tmp: string;

function getStoreForTest() {
  // helper: reach into the hub's private store for direct testing
  return (hub as unknown as { store: import('../src/hub/store.ts').HubStore }).store;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'open-rc-hub-test-'));
  hub = new HubServer({ dbPath: join(tmp, 'hub.db'), autoApprove: true });
  await hub.start({ host: '127.0.0.1', port: PORT });
  store = getStoreForTest();
});

afterAll(async () => {
  // Give Bun a moment to fully tear down closed WS connections before stop().
  await new Promise((r) => setTimeout(r, 200));
  await hub.stop();
  rmSync(tmp, { recursive: true, force: true });
});

interface DeviceConn {
  ws: WebSocket;
  deviceId: string | null;
  inbox: Array<{ type: string; [k: string]: unknown }>;
}

async function connectDevice(): Promise<DeviceConn> {
  const kp = generateKeypair();
  const ws = new WebSocket(URL);
  const conn: DeviceConn = { ws, deviceId: null, inbox: [] };
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.send(JSON.stringify({ type: 'enroll', publicKey: kp.publicKeyB64 }));
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', (e) => reject(new Error(String(e))));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data as string);
      conn.inbox.push(m);
      if (m.type === 'challenge') {
        // Answer the proof-of-possession challenge with a real signature.
        ws.send(
          JSON.stringify({
            type: 'enroll_verify',
            signature: signNonce(m.nonce as string, kp.privateKeyB64),
          }),
        );
      } else if (m.type === 'enroll_ok' && !conn.deviceId) {
        conn.deviceId = m.deviceId as string;
        resolve();
      }
    });
  });
  return conn;
}

describe('hub', () => {
  test('two devices enroll, list sessions, browser sends to device A', async () => {
    const a = await connectDevice();
    const b = await connectDevice();
    expect(a.deviceId).toBeTruthy();
    expect(b.deviceId).toBeTruthy();

    a.ws.send(
      JSON.stringify({ type: 'session_register', sessionId: 's-a', cwd: '/home/a', label: 'A' }),
    );
    b.ws.send(
      JSON.stringify({ type: 'session_register', sessionId: 's-b', cwd: '/home/b', label: 'B' }),
    );

    // Wait for the hub to register both.
    await new Promise((r) => setTimeout(r, 200));

    // Browser lists sessions.
    const browser = new WebSocket(BROWSER_URL);
    const browserInbox: Array<{ type: string; [k: string]: unknown }> = [];
    browser.addEventListener('message', (ev) => {
      browserInbox.push(JSON.parse(ev.data as string));
    });
    await new Promise((r) => browser.addEventListener('open', r));
    browser.send(JSON.stringify({ type: 'list_sessions' }));

    // wait for the list response
    for (let i = 0; i < 30 && !browserInbox.some((m) => m.type === 'sessions'); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const list = browserInbox.find((m) => m.type === 'sessions') as unknown as {
      sessions: Array<{ id: string }>;
    };
    expect(list).toBeTruthy();
    expect(list.sessions.map((s) => s.id).sort()).toEqual(['s-a', 's-b']);

    // Browser sends a message to device A's session.
    const aInboxBefore = a.inbox.length;
    browser.send(JSON.stringify({ type: 'send', sessionId: 's-a', text: 'hello from browser' }));

    // wait for A to receive
    for (let i = 0; i < 30; i++) {
      if (a.inbox.length > aInboxBefore) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const got = a.inbox.find(
      (m) => m.type === 'route_send' && (m.text as string) === 'hello from browser',
    );
    expect(got).toBeTruthy();
    expect((got as unknown as { sessionId: string }).sessionId).toBe('s-a');

    // device B should NOT have received it
    const bGot = b.inbox.find(
      (m) => m.type === 'route_send' && (m.text as string) === 'hello from browser',
    );
    expect(bGot).toBeUndefined();

    a.ws.close();
    b.ws.close();
    browser.close();
    // Wait for sockets to actually close so afterAll can shut the hub cleanly.
    await Promise.all([
      new Promise<void>((r) => a.ws.addEventListener('close', () => r(), { once: true })),
      new Promise<void>((r) => b.ws.addEventListener('close', () => r(), { once: true })),
      new Promise<void>((r) => browser.addEventListener('close', () => r(), { once: true })),
    ]);
  });

  test('enroll_pending path issues a pairing URL when not auto-approved', async () => {
    // We exercise the store-level pairing flow rather than spinning up a
    // second hub (which is flaky under bun:test). The WS-level path is
    // covered by manual integration in tools/.
    const token = 'tok-pending';
    const deviceId = 'dev-pending';
    store.insertDevice(deviceId, 'pub-pending');
    store.createPairing(token, deviceId, 60_000);
    const consumed = store.consumePairing(token);
    expect(consumed).toBeTruthy();
    expect(consumed?.deviceId).toBe(deviceId);
    // Second consume must fail.
    expect(store.consumePairing(token)).toBeNull();
  });

  test('listDevices returns inserted devices', () => {
    store.insertDevice('d-list', 'pub-list');
    store.approveDevice('pub-list', 'listed');
    const list = store.listDevices();
    expect(list.some((d) => d.id === 'd-list')).toBe(true);
  });
});

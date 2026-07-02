/**
 * Hub client — `open-rc serve --hub <url>` uses this to dial the hub
 * and relay sessions + events between local WS clients and the hub.
 */

import { fingerprint, generateKeypair, signNonce } from './crypto.ts';

export interface HubClientOptions {
  readonly hubUrl: string;
  /** Path where the device keypair is persisted. */
  readonly keyPath: string;
  /** Local serve port (for display in the enrollment UI). */
  readonly localPort: number;
  /** Called when a `route_send` arrives from the hub. */
  readonly onSend: (sessionId: string, text: string) => void;
  /** Called when a `route_permission_response` arrives. */
  readonly onPermissionResponse: (sessionId: string, requestId: string, approved: boolean) => void;
}

export interface HubClientHandle {
  stop(): Promise<void>;
  /** Tell the hub about a session we host locally. */
  registerSession(sessionId: string, cwd: string | null, label: string | null): void;
  /** Tell the hub the session is gone. */
  unregisterSession(sessionId: string): void;
  /** Push a stream-json frame to the hub. */
  pushSessionEvent(sessionId: string, frame: unknown): void;
}

interface StoredKey {
  privateKeyB64: string;
  publicKeyB64: string;
}

export async function startHubClient(opts: HubClientOptions): Promise<HubClientHandle> {
  const key = await loadOrCreateKey(opts.keyPath);
  const wsUrl = `${opts.hubUrl.replace(/^http/, 'ws')}/device`;

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopRequested = false;

  function connect(): void {
    if (stopRequested) return;
    ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      ws?.send(JSON.stringify({ type: 'enroll', publicKey: key.publicKeyB64 }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          [k: string]: unknown;
        };
        if (msg.type === 'challenge') {
          // Prove possession of the private key by signing the hub's nonce.
          const signature = signNonce(msg.nonce as string, key.privateKeyB64);
          ws?.send(JSON.stringify({ type: 'enroll_verify', signature }));
        } else if (msg.type === 'enroll_pending') {
          // eslint-disable-next-line no-console
          console.error(
            `[hub] new device — approve at ${opts.hubUrl}${msg.pairUrl}\n` +
              `[hub] fingerprint: ${fingerprint(key.publicKeyB64)}`,
          );
        } else if (msg.type === 'enroll_ok') {
          // eslint-disable-next-line no-console
          console.error(`[hub] enrolled as ${msg.deviceId}`);
          // Re-register any sessions we know about.
        } else if (msg.type === 'route_send') {
          opts.onSend(msg.sessionId as string, msg.text as string);
        } else if (msg.type === 'route_permission_response') {
          opts.onPermissionResponse(
            msg.sessionId as string,
            msg.requestId as string,
            Boolean(msg.approved),
          );
        }
      } catch {
        // ignore malformed
      }
    });
    ws.addEventListener('close', () => {
      ws = null;
      if (!stopRequested) {
        reconnectTimer = setTimeout(connect, 2_000);
      }
    });
    ws.addEventListener('error', () => {
      ws?.close();
    });
  }
  connect();

  return {
    stop: async () => {
      stopRequested = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
    registerSession(sessionId, cwd, label) {
      ws?.send(JSON.stringify({ type: 'session_register', sessionId, cwd, label }));
    },
    unregisterSession(sessionId) {
      ws?.send(JSON.stringify({ type: 'session_unregister', sessionId }));
    },
    pushSessionEvent(sessionId, frame) {
      ws?.send(JSON.stringify({ type: 'session_event', sessionId, frame }));
    },
  };
}

async function loadOrCreateKey(path: string): Promise<StoredKey> {
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const parsed = JSON.parse(await file.text()) as StoredKey;
      if (typeof parsed.privateKeyB64 === 'string' && typeof parsed.publicKeyB64 === 'string') {
        return parsed;
      }
    } catch {
      // fall through and regenerate
    }
  }
  const kp = generateKeypair();
  const stored: StoredKey = { privateKeyB64: kp.privateKeyB64, publicKeyB64: kp.publicKeyB64 };
  await Bun.write(path, JSON.stringify(stored));
  return stored;
}

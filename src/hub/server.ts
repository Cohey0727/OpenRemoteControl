/**
 * Hub mode — central relay that many `open-rc serve` instances dial into.
 *
 * Protocol:
 *   - Devices connect over WS at `/device`. First message is a JSON
 *     `enroll` with the device's publicKey. If the device is unknown,
 *     hub returns a `pair_url` for browser-side approval. If approved,
 *     hub returns `ok` and the device sends `session_register` +
 *     stream-json relay frames (`session_event`, `permission_request`).
 *   - Browsers connect over WS at `/browser`. They can list sessions
 *     and forward `send` / `permission_response` to the owning device.
 *
 * This is intentionally a thin pass-through — the actual stream-json
 * protocol stays the same; the hub just routes frames by sessionId.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import { fingerprint, generateKeypair, signNonce, verifyNonce } from './crypto.ts';
import { HubStore } from './store.ts';

export interface HubServerOptions {
  readonly host?: string;
  readonly port?: number;
  /** Path to sqlite file. Default $XDG_DATA_HOME/open-rc/hub.db. */
  readonly dbPath?: string;
  /** Auto-approve any new device (insecure; for testing only). */
  readonly autoApprove?: boolean;
}

interface DeviceWsData {
  kind: 'device';
  deviceId: string | null;
  authenticated: boolean;
  /** Nonce issued for the current proof-of-possession challenge. */
  pendingNonce: string | null;
  /** Public key being proven in the current challenge. */
  pendingPublicKey: string | null;
}

interface BrowserWsData {
  kind: 'browser';
}

type WsData = DeviceWsData | BrowserWsData;

interface DeviceState {
  ws: ServerWebSocket<WsData>;
  sessions: Set<string>;
}

/** In-memory map of sessionId → deviceId. */
const sessionToDevice = new Map<string, string>();

export class HubServer {
  private readonly store: HubStore;
  private readonly autoApprove: boolean;
  private readonly devices = new Map<string, DeviceState>(); // deviceId → state
  private readonly browsers = new Set<ServerWebSocket<WsData>>();
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(opts: HubServerOptions = {}) {
    this.store = new HubStore({
      path:
        opts.dbPath ??
        `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/open-rc/hub.db`,
    });
    this.autoApprove = opts.autoApprove ?? false;
  }

  async start(opts: HubServerOptions = {}): Promise<{ port: number }> {
    const host = opts.host ?? '127.0.0.1';
    const port = opts.port ?? 7443;
    this.server = Bun.serve<WsData>({
      hostname: host,
      port,
      websocket: {
        open: (ws) => {
          // data is initialized on upgrade via /device or /browser path
          if (!ws.data)
            ws.data = {
              kind: 'device',
              deviceId: null,
              authenticated: false,
              pendingNonce: null,
              pendingPublicKey: null,
            };
          if (ws.data.kind === 'browser') {
            this.browsers.add(ws);
            ws.send(JSON.stringify({ type: 'hello', role: 'browser' }));
          }
        },
        message: (ws, raw) => this.onMessage(ws, raw),
        close: (ws) => this.onClose(ws),
      },
      fetch: (req, srv) => this.fetch(req, srv),
    });
    return { port: this.server.port ?? port };
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    this.store.close();
  }

  private async fetch(
    req: Request,
    srv: { upgrade: (r: Request, opts: { data: WsData }) => boolean },
  ): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/device') {
      const ok = srv.upgrade(req, {
        data: {
          kind: 'device',
          deviceId: null,
          authenticated: false,
          pendingNonce: null,
          pendingPublicKey: null,
        },
      });
      if (ok) return new Response(null, { status: 101 });
      return new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/browser') {
      const ok = srv.upgrade(req, { data: { kind: 'browser' } });
      if (ok) return new Response(null, { status: 101 });
      return new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        devices: this.devices.size,
        browsers: this.browsers.size,
        sessions: sessionToDevice.size,
      });
    }
    if (url.pathname === '/api/devices' && req.method === 'GET') {
      return Response.json({ devices: this.store.listDevices() });
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const sessions = this.store.listSessions().map((s) => ({
        ...s,
        online: sessionToDevice.has(s.id),
      }));
      return Response.json({ sessions });
    }
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      // Browser POSTs { token, label } to approve a pairing.
      let body: { token?: string; label?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response('invalid JSON', { status: 400 });
      }
      if (!body.token) return new Response('missing token', { status: 400 });
      const pairing = this.store.consumePairing(body.token);
      if (!pairing) return new Response('invalid or expired token', { status: 404 });
      const device = this.store.listDevices().find((d) => d.id === pairing.deviceId);
      if (!device) return new Response('device gone', { status: 404 });
      this.store.approveDevice(device.publicKey, body.label ?? 'browser-paired');
      this.store.audit(device.id, 'pair', `label=${body.label ?? ''}`);
      // Notify the waiting device (if connected).
      const state = this.devices.get(device.id);
      if (state) {
        state.ws.send(JSON.stringify({ type: 'enroll_ok', deviceId: device.id }));
      }
      return Response.json({ ok: true, deviceId: device.id });
    }
    return new Response('not found', { status: 404 });
  }

  private async onMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): Promise<void> {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'malformed JSON' }));
      return;
    }

    if (ws.data.kind === 'device') {
      await this.onDeviceMessage(ws as ServerWebSocket<DeviceWsData>, msg);
    } else {
      this.onBrowserMessage(ws as ServerWebSocket<BrowserWsData>, msg);
    }
  }

  private async onDeviceMessage(
    ws: ServerWebSocket<DeviceWsData>,
    msg: { type: string; [k: string]: unknown },
  ): Promise<void> {
    switch (msg.type) {
      case 'enroll': {
        const publicKey = msg.publicKey as string | undefined;
        if (!publicKey) {
          ws.send(JSON.stringify({ type: 'error', message: 'missing publicKey' }));
          return;
        }
        let device = this.store.getDevice(publicKey);
        if (!device) {
          const id = randomUUID();
          this.store.insertDevice(id, publicKey);
          device = { id, approved: this.autoApprove, label: null };
          if (this.autoApprove) {
            this.store.approveDevice(publicKey, 'auto-approved');
          }
          this.store.audit(id, 'enroll', `fp=${fingerprint(publicKey)}`);
        }
        ws.data.deviceId = device.id;
        if (device.approved) {
          // Proof-of-possession: the public key alone is not a secret
          // (it is even served from /api/devices), so challenge the
          // device to sign a fresh nonce before trusting it. Only a
          // holder of the matching private key can complete enroll_verify.
          const nonce = randomBytes(32).toString('base64');
          ws.data.pendingNonce = nonce;
          ws.data.pendingPublicKey = publicKey;
          ws.send(JSON.stringify({ type: 'challenge', nonce }));
        } else {
          // Issue a pairing token; browser POSTs to /api/pair to approve.
          const token = randomBytes(16).toString('hex');
          this.store.createPairing(token, device.id, 10 * 60 * 1000);
          const pairUrl = `/pair?token=${token}`;
          ws.send(
            JSON.stringify({
              type: 'enroll_pending',
              deviceId: device.id,
              pairUrl,
              token,
            }),
          );
        }
        return;
      }
      case 'enroll_verify': {
        const signature = msg.signature as string | undefined;
        const nonce = ws.data.pendingNonce;
        const publicKey = ws.data.pendingPublicKey;
        const deviceId = ws.data.deviceId;
        if (!signature || !nonce || !publicKey || !deviceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'no pending challenge' }));
          return;
        }
        // Consume the nonce regardless of outcome (single-use).
        ws.data.pendingNonce = null;
        ws.data.pendingPublicKey = null;
        if (!verifyNonce(nonce, signature, publicKey)) {
          this.store.audit(deviceId, 'enroll_verify_failed', `fp=${fingerprint(publicKey)}`);
          ws.send(JSON.stringify({ type: 'error', message: 'signature verification failed' }));
          return;
        }
        ws.data.authenticated = true;
        this.devices.set(deviceId, { ws, sessions: new Set() });
        this.store.audit(deviceId, 'connect');
        ws.send(JSON.stringify({ type: 'enroll_ok', deviceId }));
        return;
      }
      case 'session_register': {
        if (!ws.data.authenticated || !ws.data.deviceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'not enrolled' }));
          return;
        }
        const sessionId = msg.sessionId as string | undefined;
        const cwd = (msg.cwd as string | undefined) ?? null;
        const label = (msg.label as string | undefined) ?? null;
        if (!sessionId) {
          ws.send(JSON.stringify({ type: 'error', message: 'missing sessionId' }));
          return;
        }
        // Ownership guard: don't let one device hijack a sessionId that
        // another device already owns.
        const existingOwner = sessionToDevice.get(sessionId);
        if (existingOwner && existingOwner !== ws.data.deviceId) {
          this.store.audit(
            ws.data.deviceId,
            'session_register_rejected',
            `sid=${sessionId} owner=${existingOwner}`,
          );
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'session owned by another device',
              sessionId,
            }),
          );
          return;
        }
        this.store.upsertSession(sessionId, ws.data.deviceId, cwd, label);
        sessionToDevice.set(sessionId, ws.data.deviceId);
        const state = this.devices.get(ws.data.deviceId);
        if (state) state.sessions.add(sessionId);
        this.broadcast({ type: 'session_added', sessionId, deviceId: ws.data.deviceId });
        return;
      }
      case 'session_event': {
        if (!ws.data.authenticated || !ws.data.deviceId) return;
        const sessionId = msg.sessionId as string | undefined;
        const frame = msg.frame;
        if (!sessionId || typeof frame !== 'object' || frame === null) return;
        // Only the owning device may stream frames for a session. Without
        // this check, any enrolled device could spoof events into another
        // device's session as displayed in browsers.
        const owner = sessionToDevice.get(sessionId);
        if (owner !== ws.data.deviceId) {
          // Audit the rejection too: an enrolled device probing sessions it
          // doesn't own is a strong signal of an attack and should leave a
          // trail even when the request itself is dropped.
          this.store.audit(
            ws.data.deviceId ?? 'unknown',
            'session_event_rejected',
            `sid=${sessionId} owner=${owner ?? 'none'}`,
          );
          ws.send(JSON.stringify({ type: 'error', message: 'not owner of session', sessionId }));
          return;
        }
        this.broadcast({ type: 'session_event', sessionId, frame });
        this.store.audit(ws.data.deviceId, 'session_event', `sid=${sessionId}`);
        return;
      }
      case 'session_unregister': {
        if (!ws.data.authenticated || !ws.data.deviceId) return;
        const sessionId = msg.sessionId as string | undefined;
        if (!sessionId) return;
        // Only the owning device may unregister a session.
        const owner = sessionToDevice.get(sessionId);
        if (owner && owner !== ws.data.deviceId) {
          this.store.audit(
            ws.data.deviceId,
            'session_unregister_rejected',
            `sid=${sessionId} owner=${owner}`,
          );
          return;
        }
        sessionToDevice.delete(sessionId);
        this.store.removeSession(sessionId);
        const state = this.devices.get(ws.data.deviceId);
        if (state) state.sessions.delete(sessionId);
        this.broadcast({ type: 'session_removed', sessionId });
        return;
      }
      case 'send_to_session': {
        if (!ws.data.authenticated || !ws.data.deviceId) return;
        const sessionId = msg.sessionId as string | undefined;
        const text = msg.text as string | undefined;
        if (!sessionId || text === undefined) return;
        const ownerDeviceId = sessionToDevice.get(sessionId);
        if (!ownerDeviceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'no such session' }));
          return;
        }
        const target = this.devices.get(ownerDeviceId);
        if (!target) {
          ws.send(JSON.stringify({ type: 'error', message: 'device offline' }));
          return;
        }
        target.ws.send(JSON.stringify({ type: 'route_send', sessionId, text }));
        return;
      }
      case 'permission_response': {
        if (!ws.data.authenticated || !ws.data.deviceId) return;
        const sessionId = msg.sessionId as string | undefined;
        const requestId = msg.requestId as string | undefined;
        const approved = msg.approved as boolean | undefined;
        if (!sessionId || !requestId || typeof approved !== 'boolean') return;
        const ownerDeviceId = sessionToDevice.get(sessionId);
        if (!ownerDeviceId) return;
        const target = this.devices.get(ownerDeviceId);
        if (!target) return;
        target.ws.send(
          JSON.stringify({
            type: 'route_permission_response',
            sessionId,
            requestId,
            approved,
          }),
        );
        return;
      }
      default:
        ws.send(JSON.stringify({ type: 'error', message: `unknown device message: ${msg.type}` }));
    }
  }

  private onBrowserMessage(
    ws: ServerWebSocket<BrowserWsData>,
    msg: { type: string; [k: string]: unknown },
  ): void {
    switch (msg.type) {
      case 'list_sessions':
        ws.send(
          JSON.stringify({
            type: 'sessions',
            sessions: this.store.listSessions().map((s) => ({
              ...s,
              online: sessionToDevice.has(s.id),
            })),
          }),
        );
        return;
      case 'send': {
        const sessionId = msg.sessionId as string | undefined;
        const text = msg.text as string | undefined;
        if (!sessionId || !text) return;
        const ownerDeviceId = sessionToDevice.get(sessionId);
        if (!ownerDeviceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'session offline' }));
          return;
        }
        const target = this.devices.get(ownerDeviceId);
        target?.ws.send(JSON.stringify({ type: 'route_send', sessionId, text }));
        return;
      }
      default:
        ws.send(JSON.stringify({ type: 'error', message: `unknown browser message: ${msg.type}` }));
    }
  }

  private onClose(ws: ServerWebSocket<WsData>): void {
    if (ws.data.kind === 'device') {
      const deviceId = ws.data.deviceId;
      if (deviceId) {
        const state = this.devices.get(deviceId);
        // Only tear down if THIS socket is the current one for the device.
        // A benign reconnect can register a new socket before the old
        // one's close fires; without this check that stale close would
        // evict the live connection and its sessions from routing.
        if (state && state.ws === ws) {
          for (const sid of state.sessions) sessionToDevice.delete(sid);
          this.devices.delete(deviceId);
          this.store.audit(deviceId, 'disconnect');
        }
      }
    } else {
      this.browsers.delete(ws);
    }
  }

  private broadcast(frame: object): void {
    const json = JSON.stringify(frame);
    for (const b of this.browsers) {
      try {
        b.send(json);
      } catch {
        // skip dead clients
      }
    }
  }
}

// Re-export crypto + store helpers for testing.
export { generateKeypair, signNonce, verifyNonce, fingerprint };
export { HubStore };

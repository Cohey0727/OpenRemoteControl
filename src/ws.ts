/**
 * WebSocket relay — the heart of `open-rc serve`.
 *
 * The server holds exactly one piece of mutable state:
 *   `clients: Map<clientId, BridgeConn>`
 *
 * A `BridgeConn` is one user-owned bridge connected on `/agent`. Each
 * bridge registers itself (label, cwd) on connect. The server fans out
 * the bridge's frames to every browser attached to that client, and
 * forwards browser `send` / `permission_response` frames back to the
 * bridge.
 *
 * The server never touches `claude`, never signals it, never walks
 * `ps` / `lsof` / `/proc`. It is byte-pass-through for bridge →
 * browser and for browser → bridge.
 *
 * Lifecycle:
 *   - Bridge WS opens → buffer messages until `register` arrives →
 *     assign `clientId`, broadcast `client_registered`.
 *   - Browser WS opens → state in `WsData` only.
 *   - Browser sends `attach { clientId }` → track in `attachedBrowsers`.
 *   - Bridge WS closes → broadcast `client_removed`, drop the client
 *     from the map, detach its browsers (their `clientId` is cleared).
 */

import type { ServerWebSocket } from 'bun';
import type { z } from 'zod';
import { writeAudit } from './permission/audit.ts';
import type {
  BridgeConn,
  BridgeToServer,
  BrowserClientMessage,
  ClientInfo,
  ServerBrowserMessage,
  ServerToBridge,
} from './session/ws-protocol.ts';
import {
  BridgeToServer as BridgeToServerSchema,
  BrowserClientMessage as BrowserClientMessageSchema,
  type RelayedMessage,
} from './session/ws-protocol.ts';

/** Max frames buffered from a bridge before it sends `register`. */
const MAX_PREREGISTER_FRAMES = 64;

export interface WsData {
  /** kind discriminator so the same handlers can serve two routes. */
  readonly kind: 'browser' | 'bridge';
  /** Currently-attached client id (browser side). null when detached. */
  clientId: string | null;
  /** Detach callback returned by attach(). */
  detach: (() => void) | null;
  /** Bridge-side: clientId assigned at register time. null until then. */
  registeredClientId: string | null;
  /** Bridge-side: buffer of frames received before `register` completed. */
  preRegisterBuffer: string[] | null;
}

export interface WsHandlerDeps {
  /** Read-only view of the live client list. */
  readonly listClients: () => ClientInfo[];
  /** Add a browser to the connected-browser set (server-originated
   *  broadcasts target this set). */
  readonly registerBrowser: (browser: ServerWebSocket<WsData>) => void;
  /** Remove a browser from the connected-browser set on close. */
  readonly unregisterBrowser: (browser: ServerWebSocket<WsData>) => void;
  /**
   * Register a bridge. Returns the assigned `BridgeConn` (with clientId),
   * or throws if the requested id is already taken.
   */
  readonly registerBridge: (input: {
    requestedClientId?: string;
    label: string;
    cwd: string;
    ws: ServerWebSocket<WsData>;
  }) => BridgeConn;
  /** Remove a bridge by clientId. Idempotent. */
  readonly removeBridge: (clientId: string) => void;
  /** Update a bridge's status. */
  readonly setBridgeStatus: (clientId: string, status: BridgeConn['status']) => void;
  /** Touch lastActivity; returns true if the status transitioned to busy. */
  readonly touchBridge: (clientId: string) => boolean;
  /** Send a frame to a specific bridge. */
  readonly sendToBridge: (clientId: string, frame: ServerToBridge) => boolean;
  /**
   * Subscribe a browser to a client. Returns a detach fn. The fn is
   * called once on `detach` or when the bridge disconnects.
   */
  readonly attachBrowser: (
    clientId: string,
    browser: ServerWebSocket<WsData>,
  ) => (() => void) | null;
  /**
   * Forward a per-client frame from bridge to every attached browser.
   * The server adds the `clientId` field on its way out.
   */
  readonly broadcastToBrowsers: (clientId: string, frame: z.infer<typeof RelayedMessage>) => void;
  /**
   * Broadcast a server-originated frame (e.g. `client_registered`) to
   * every connected browser.
   */
  readonly broadcastServerMessage: (frame: ServerBrowserMessage) => void;
  /** Append a frame to the client's bounded in-memory replay buffer. */
  readonly recordHistory: (clientId: string, frame: z.infer<typeof RelayedMessage>) => void;
  /** Replay the client's buffered history to one just-attached browser. */
  readonly replayHistory: (clientId: string, browser: ServerWebSocket<WsData>) => void;
  /**
   * Optional: fired when a bridge sends `done` — used to schedule web
   * push. Errors are swallowed (push is best-effort).
   */
  readonly onClientDone?: (clientId: string, summary: string) => void;
}

/* -------------------------------------------------------------------------- */
/*  Browser handlers (`/ws`)                                                   */
/* -------------------------------------------------------------------------- */

function makeBrowserHandlers(deps: WsHandlerDeps) {
  const {
    listClients,
    sendToBridge,
    attachBrowser,
    broadcastToBrowsers,
    recordHistory,
    replayHistory,
    registerBrowser,
    unregisterBrowser,
  } = deps;

  function sendToBrowser(ws: ServerWebSocket<WsData>, frame: ServerBrowserMessage): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // socket probably closed; drop silently
    }
  }

  function handleAttach(ws: ServerWebSocket<WsData>, clientId: string): void {
    if (!clientId) {
      sendToBrowser(ws, {
        type: 'error',
        clientId: '',
        message: 'attach requires a non-empty clientId',
      });
      return;
    }

    // Detach previous attachment.
    if (ws.data.detach) {
      ws.data.detach();
      ws.data.detach = null;
      ws.data.clientId = null;
    }

    const detach = attachBrowser(clientId, ws);
    if (!detach) {
      sendToBrowser(ws, {
        type: 'error',
        clientId,
        message: `unknown client: ${clientId}`,
      });
      return;
    }

    ws.data.clientId = clientId;
    ws.data.detach = detach;
    // Replay recent history so a reload or a late joiner sees the
    // conversation so far, not a blank pane.
    replayHistory(clientId, ws);
  }

  function handleDetach(ws: ServerWebSocket<WsData>, clientId: string): void {
    if (ws.data.clientId === clientId && ws.data.detach) {
      ws.data.detach();
      ws.data.detach = null;
      ws.data.clientId = null;
    }
  }

  function handleSend(ws: ServerWebSocket<WsData>, clientId: string, text: string): void {
    const ok = sendToBridge(clientId, { type: 'prompt', text });
    if (!ok) {
      sendToBrowser(ws, {
        type: 'error',
        clientId,
        message: `unknown client: ${clientId}`,
      });
      return;
    }
    // Echo the prompt to every client attached to this session (the sender
    // included) so all shared views — browser and `tui` — render the same
    // "you" turn from one source of truth, not just an optimistic local copy.
    const echo = { type: 'user' as const, clientId, text };
    broadcastToBrowsers(clientId, echo);
    recordHistory(clientId, echo);
  }

  function handlePermissionResponse(
    ws: ServerWebSocket<WsData>,
    clientId: string,
    requestId: string,
    approved: boolean,
  ): void {
    const ok = sendToBridge(clientId, { type: 'permission_response', requestId, approved });
    if (!ok) {
      sendToBrowser(ws, {
        type: 'error',
        clientId,
        message: `unknown client: ${clientId}`,
      });
      return;
    }
    void writeAudit({
      timestamp: Date.now(),
      sessionId: clientId,
      requestId,
      tool: '(resolved)',
      decision: approved ? 'allow' : 'deny',
      reason: approved ? 'user allowed' : 'user denied',
    });
  }

  function handleListClients(ws: ServerWebSocket<WsData>): void {
    sendToBrowser(ws, { type: 'client_list', clients: listClients() });
  }

  return {
    open(ws: ServerWebSocket<WsData>): void {
      ws.data = {
        kind: 'browser',
        clientId: null,
        detach: null,
        registeredClientId: null,
        preRegisterBuffer: null,
      };
      registerBrowser(ws);
      // Immediately hand the new browser the current client list so it
      // can render the sidebar without waiting for the next event.
      sendToBrowser(ws, { type: 'client_list', clients: listClients() });
    },
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        sendToBrowser(ws, {
          type: 'error',
          clientId: ws.data.clientId ?? '',
          message: 'malformed JSON',
        });
        return;
      }

      const result = BrowserClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        sendToBrowser(ws, {
          type: 'error',
          clientId: ws.data.clientId ?? '',
          message: `invalid message: ${result.error.issues[0]?.message ?? 'unknown'}`,
        });
        return;
      }

      const msg: BrowserClientMessage = result.data;
      switch (msg.type) {
        case 'attach':
          handleAttach(ws, msg.clientId);
          break;
        case 'detach':
          handleDetach(ws, msg.clientId);
          break;
        case 'send':
          handleSend(ws, msg.clientId, msg.text);
          break;
        case 'permission_response':
          handlePermissionResponse(ws, msg.clientId, msg.requestId, msg.approved);
          break;
        case 'list_clients':
          handleListClients(ws);
          break;
      }
    },
    close(ws: ServerWebSocket<WsData>): void {
      if (ws.data.detach) {
        try {
          ws.data.detach();
        } catch {
          // ignore
        }
        ws.data.detach = null;
      }
      ws.data.clientId = null;
      unregisterBrowser(ws);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Bridge handlers (`/agent`)                                                 */
/* -------------------------------------------------------------------------- */

function makeBridgeHandlers(deps: WsHandlerDeps) {
  const {
    registerBridge,
    removeBridge,
    setBridgeStatus,
    touchBridge,
    broadcastToBrowsers,
    broadcastServerMessage,
    recordHistory,
    onClientDone,
  } = deps;

  function handleRegister(
    ws: ServerWebSocket<WsData>,
    msg: Extract<BridgeToServer, { type: 'register' }>,
  ): void {
    let conn: BridgeConn;
    try {
      conn = registerBridge({
        ...(msg.clientId !== undefined ? { requestedClientId: msg.clientId } : {}),
        label: msg.label,
        cwd: msg.cwd,
        ws,
      });
    } catch (err) {
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      } catch {
        // ignore
      }
      return;
    }

    ws.data.registeredClientId = conn.clientId;

    // Flush any buffered pre-register frames.
    const buf = ws.data.preRegisterBuffer ?? [];
    ws.data.preRegisterBuffer = null;
    for (const raw of buf) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        processFrame(ws, conn.clientId, parsed);
      } catch {
        // drop garbage
      }
    }

    // Tell the bridge its assigned id so it can use it for diagnostics.
    try {
      ws.send(JSON.stringify({ type: 'registered', clientId: conn.clientId }));
    } catch {
      // ignore
    }

    // Broadcast the new client to all browsers.
    broadcastServerMessage({ type: 'client_registered', client: conn.info() });
    broadcastServerMessage({ type: 'clients_changed', clients: deps.listClients() });
  }

  function processFrame(ws: ServerWebSocket<WsData>, clientId: string, parsed: unknown): void {
    const result = BridgeToServerSchema.safeParse(parsed);
    if (!result.success) {
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `invalid frame: ${result.error.issues[0]?.message ?? 'unknown'}`,
          }),
        );
      } catch {
        // ignore
      }
      return;
    }

    const msg: BridgeToServer = result.data;
    switch (msg.type) {
      case 'register':
        // Re-register is treated as a no-op (idempotent).
        return;
      case 'unregister': {
        // Explicit goodbye. Clear the registered id first so the close
        // handler (which fires from ws.close below) doesn't broadcast a
        // second client_removed/clients_changed for the same client.
        ws.data.registeredClientId = null;
        broadcastServerMessage({ type: 'client_removed', clientId });
        removeBridge(clientId);
        broadcastServerMessage({ type: 'clients_changed', clients: deps.listClients() });
        try {
          ws.close(1000, 'unregister');
        } catch {
          // ignore
        }
        return;
      }
      case 'status':
        setBridgeStatus(clientId, msg.status);
        broadcastServerMessage({ type: 'clients_changed', clients: deps.listClients() });
        return;
      case 'user':
      case 'text':
      case 'text_delta':
      case 'thinking':
      case 'tool_use':
      case 'tool_result':
      case 'permission_request':
      case 'error': {
        // Tag with clientId and forward to attached browsers.
        const tagged = { ...msg, clientId } as z.infer<typeof RelayedMessage>;
        // Broadcast the list only when the status flips idle→busy, so the
        // sidebar dot updates without a broadcast on every single frame.
        const becameBusy = touchBridge(clientId);
        broadcastToBrowsers(clientId, tagged);
        // Buffer conversation frames for replay-on-attach, but NOT:
        //  - permission_request (a stale replayed prompt would pop a
        //    modal for an already-answered request),
        //  - text_delta (the final `text` frame carries the same
        //    content; replaying both would render the reply twice).
        // Bridge-observed `user` prompts (e.g. typed into the shared
        // terminal) ARE recorded, like the server's own send echoes.
        if (msg.type !== 'permission_request' && msg.type !== 'text_delta') {
          recordHistory(clientId, tagged);
        }
        if (becameBusy) {
          broadcastServerMessage({ type: 'clients_changed', clients: deps.listClients() });
        }
        return;
      }
      case 'done': {
        // Stamp the completion time (unless the bridge already did) so
        // browsers can show a wall-clock timestamp on the turn divider —
        // including on history replay, where render time would be wrong.
        const tagged = {
          ...msg,
          ts: msg.ts ?? Date.now(),
          clientId,
        } as z.infer<typeof RelayedMessage>;
        // A finished turn returns the client to idle; refresh the sidebar.
        setBridgeStatus(clientId, 'idle');
        broadcastToBrowsers(clientId, tagged);
        recordHistory(clientId, tagged);
        broadcastServerMessage({ type: 'clients_changed', clients: deps.listClients() });
        if (onClientDone) {
          try {
            const summary =
              typeof msg.cost === 'number' ? `done · $${msg.cost.toFixed(4)}` : 'Task complete';
            onClientDone(clientId, summary);
          } catch {
            // push errors must never break the WS stream
          }
        }
        return;
      }
    }
  }

  return {
    open(ws: ServerWebSocket<WsData>): void {
      ws.data = {
        kind: 'bridge',
        clientId: null,
        detach: null,
        registeredClientId: null,
        preRegisterBuffer: [],
      };
    },
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      const registered = ws.data.registeredClientId;

      // Buffer until register completes.
      if (registered === null) {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (
            parsed &&
            typeof parsed === 'object' &&
            (parsed as { type?: unknown }).type === 'register'
          ) {
            const result = BridgeToServerSchema.safeParse(parsed);
            if (!result.success || result.data.type !== 'register') {
              try {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: `invalid frame: ${
                      result.success ? 'expected register' : result.error.issues[0]?.message
                    }`,
                  }),
                );
              } catch {
                // ignore
              }
              return;
            }
            handleRegister(ws, result.data);
            return;
          }
          // Pre-register frame: stash it, but cap the buffer so a bridge
          // that streams frames yet never sends `register` can't grow
          // server memory without bound.
          if (
            ws.data.preRegisterBuffer &&
            ws.data.preRegisterBuffer.length < MAX_PREREGISTER_FRAMES
          ) {
            ws.data.preRegisterBuffer.push(text);
          }
        } catch {
          // drop garbage
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'malformed JSON' }));
        } catch {
          // ignore
        }
        return;
      }
      processFrame(ws, registered, parsed);
    },
    close(ws: ServerWebSocket<WsData>): void {
      const clientId = ws.data.registeredClientId;
      if (clientId !== null) {
        broadcastServerMessage({ type: 'client_removed', clientId });
        removeBridge(clientId);
        broadcastServerMessage({ type: 'clients_changed', clients: deps.listClients() });
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Public surface                                                              */
/* -------------------------------------------------------------------------- */

export interface WsHandlers {
  browser: {
    open(ws: ServerWebSocket<WsData>): void;
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void;
    close(ws: ServerWebSocket<WsData>): void;
  };
  bridge: {
    open(ws: ServerWebSocket<WsData>): void;
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void;
    close(ws: ServerWebSocket<WsData>): void;
  };
}

export function makeWsHandlers(deps: WsHandlerDeps): WsHandlers {
  return {
    browser: makeBrowserHandlers(deps),
    bridge: makeBridgeHandlers(deps),
  };
}

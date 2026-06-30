/**
 * WebSocket handler — bridges `WsClientMessage` (UI) ↔ `WsServerMessage`
 * (UI) via the `SessionManager` and the stream-json translator.
 *
 * Wire flow:
 *   UI ── send ───────────▶ manager.send(sid, text)
 *                         ▶ subprocess stdin (NDJSON user message)
 *   subprocess stdout ──▶ translate(event) ──▶ UI ws.send(frames)
 *   UI ── attach ─────────▶ manager.attach(sid, listener)
 *   UI ── detach ─────────▶ unsubscribe
 *
 * Phase 2: also bridges permission_request/permission_response via the
 * PermissionManager.
 */

import type { ServerWebSocket } from 'bun';
import { writeAudit } from './permission/audit.ts';
import type { PermissionManager } from './permission/manager.ts';
import type { SessionManager } from './session/manager.ts';
import type {
  AssistantMessage,
  ResultMessage,
  StreamJsonEvent,
  UserMessage,
} from './session/stream-json.ts';
import { translate } from './session/translate.ts';
import { WsClientMessage, type WsServerMessage } from './session/ws-protocol.ts';

export interface WsHandlerDeps {
  readonly manager: SessionManager;
  readonly permissions: PermissionManager;
  /**
   * Called when a stream-json `result` frame arrives for a session. Used to
   * fire web-push notifications. Errors thrown from this callback are
   * swallowed (push is best-effort and must not break the WS stream).
   */
  readonly onSessionDone?: (sessionId: string, summary: string) => void;
}

export interface WsData {
  /** sessionId of the currently attached session, if any. */
  sessionId: string | null;
  /** Detach callback returned by manager.attach. */
  detach: (() => void) | null;
}

export interface WsHandlers {
  open(ws: ServerWebSocket<WsData>): void;
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void;
  close(ws: ServerWebSocket<WsData>): void;
}

export function makeWsHandlers(deps: WsHandlerDeps): WsHandlers {
  const { manager, permissions, onSessionDone } = deps;

  function sendError(ws: ServerWebSocket<WsData>, message: string, sessionId: string): void {
    ws.send(
      JSON.stringify({
        type: 'error',
        sessionId,
        message,
      } satisfies WsServerMessage),
    );
  }

  function translateEvent(event: StreamJsonEvent, sessionId: string): WsServerMessage[] {
    if (event.type === 'assistant') {
      return translate(event as AssistantMessage, sessionId);
    }
    if (event.type === 'user') {
      return translate(event as UserMessage, sessionId);
    }
    if (event.type === 'result') {
      const r = event as ResultMessage;
      if (onSessionDone) {
        try {
          // Only success results carry a `result` string; errors have `error`.
          const summary =
            'is_error' in r && r.is_error === false && typeof r.result === 'string'
              ? r.result.slice(0, 240)
              : 'is_error' in r && r.is_error === true
                ? `Error: ${typeof r.error === 'string' ? r.error : 'unknown'}`
                : 'Task complete';
          onSessionDone(sessionId, summary);
        } catch {
          // never let push errors break the WS stream
        }
      }
      return translate(r, sessionId);
    }
    return [];
  }

  function handleAttach(ws: ServerWebSocket<WsData>, sessionId: string): void {
    if (ws.data.sessionId && ws.data.sessionId !== sessionId && ws.data.detach) {
      ws.data.detach();
      ws.data.sessionId = null;
      ws.data.detach = null;
    }

    const detach = manager.attach(sessionId, (e) => {
      if (e.kind === 'event') {
        const frames = translateEvent(e.event, sessionId);
        for (const frame of frames) {
          ws.send(JSON.stringify(frame));
        }
      } else if (e.kind === 'parse_error') {
        sendError(ws, `parse error: ${e.error.message}`, sessionId);
      } else if (e.kind === 'spawn_error') {
        sendError(ws, `spawn error: ${e.error.message}`, sessionId);
      } else if (e.kind === 'exit') {
        ws.send(
          JSON.stringify({
            type: 'done',
            sessionId,
          } satisfies WsServerMessage),
        );
      }
    });

    // Bridge permission requests targeted at this session to the WS.
    const permUnsub = permissions.on((req) => {
      if (req.sessionId !== sessionId) return;
      ws.send(
        JSON.stringify({
          type: 'permission_request',
          sessionId,
          requestId: req.id,
          tool: req.tool,
          input: req.input,
        } satisfies WsServerMessage),
      );
    });

    // Wrap the original detach so we also unsubscribe from permissions.
    const wrappedDetach = () => {
      detach();
      permUnsub();
    };
    ws.data.sessionId = sessionId;
    ws.data.detach = wrappedDetach;
  }

  function handleDetach(ws: ServerWebSocket<WsData>, sessionId: string): void {
    if (ws.data.sessionId === sessionId && ws.data.detach) {
      ws.data.detach();
      ws.data.sessionId = null;
      ws.data.detach = null;
    }
  }

  function handleSend(ws: ServerWebSocket<WsData>, sessionId: string, text: string): void {
    try {
      manager.send(sessionId, text);
    } catch (err) {
      sendError(ws, err instanceof Error ? err.message : String(err), sessionId);
    }
  }

  function handlePermissionResponse(
    ws: ServerWebSocket<WsData>,
    requestId: string,
    sessionId: string,
    approved: boolean,
  ): void {
    const ok = permissions.resolve(requestId, {
      approved,
      reason: approved ? 'user allowed' : 'user denied',
    });
    if (!ok) {
      sendError(ws, `unknown permission request: ${requestId}`, sessionId);
      return;
    }
    void writeAudit({
      sessionId,
      requestId,
      tool: '(resolved)',
      decision: approved ? 'allow' : 'deny',
      timestamp: Date.now(),
    });
  }

  // (Permission forwarding is done per-attach via `permissions.on` in
  // `handleAttach` above — keeps the model single-subscriber for v0.2.)

  return {
    open(ws) {
      ws.data = { sessionId: null, detach: null };
    },
    message(ws, raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        sendError(ws, 'malformed JSON', ws.data.sessionId ?? '');
        return;
      }

      const result = WsClientMessage.safeParse(parsed);
      if (!result.success) {
        sendError(
          ws,
          `invalid message: ${result.error.issues[0]?.message ?? 'unknown'}`,
          ws.data.sessionId ?? '',
        );
        return;
      }

      const msg = result.data;
      switch (msg.type) {
        case 'attach':
          handleAttach(ws, msg.sessionId);
          break;
        case 'detach':
          handleDetach(ws, msg.sessionId);
          break;
        case 'send':
          handleSend(ws, msg.sessionId, msg.text);
          break;
        case 'permission_response':
          handlePermissionResponse(ws, msg.requestId, msg.sessionId, msg.approved);
          break;
      }
    },
    close(ws) {
      if (ws.data.detach) {
        ws.data.detach();
        ws.data.detach = null;
        ws.data.sessionId = null;
      }
    },
  };
}

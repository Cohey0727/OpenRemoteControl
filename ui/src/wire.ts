/**
 * Wire types shared between the SPA and `orc serve`. These mirror the
 * zod schemas in `src/session/ws-protocol.ts`; the server is a relay and
 * never interprets `stream-json`, so the browser owns rendering.
 */

export type ClientStatus = 'idle' | 'busy' | 'exited' | 'errored';

export interface ClientInfo {
  clientId: string;
  label: string;
  cwd: string;
  status: ClientStatus;
  lastActivity: number;
  connectedAt: number;
}

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** A viewer's answer to one relayed AskUserQuestion sub-question. */
export interface QuestionAnswer {
  question: string;
  header?: string;
  labels: string[];
}

export type BrowserClientMessage =
  | { type: 'list_clients' }
  | { type: 'attach'; clientId: string }
  | { type: 'detach'; clientId: string }
  | { type: 'send'; clientId: string; text: string }
  | { type: 'permission_response'; clientId: string; requestId: string; approved: boolean }
  | { type: 'question_response'; clientId: string; requestId: string; answers: QuestionAnswer[] }
  | { type: 'rename'; clientId: string; label: string };

export type ServerBrowserMessage =
  | { type: 'client_list'; clients: ClientInfo[] }
  | { type: 'client_registered'; client: ClientInfo }
  | { type: 'client_removed'; clientId: string }
  | { type: 'clients_changed'; clients: ClientInfo[] }
  | { type: 'client_rekeyed'; from: string; to: string; client: ClientInfo }
  | { type: 'user'; clientId: string; text: string }
  | { type: 'text'; clientId: string; text: string }
  | { type: 'text_delta'; clientId: string; text: string }
  | { type: 'thinking'; clientId: string; text: string }
  | { type: 'tool_use'; clientId: string; tool: string; input: string }
  | { type: 'tool_result'; clientId: string; output: string }
  | {
      type: 'permission_request';
      clientId: string;
      requestId: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | { type: 'question'; clientId: string; requestId: string; questions: QuestionItem[] }
  | { type: 'done'; clientId: string; cost?: number; duration_ms?: number; ts?: number }
  | { type: 'error'; clientId: string; message: string };

export interface PermissionPrompt {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

/** A rendered transcript entry. `text_delta` streaming fragments are held
 *  separately in the store (live-only) and never become UiMessages. */
export type UiMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; tool: string; input: string }
  | { kind: 'tool_result'; output: string }
  | { kind: 'system'; text: string }
  | { kind: 'divider'; text: string }
  | { kind: 'question'; requestId: string; questions: QuestionItem[] }
  | { kind: 'error'; text: string };

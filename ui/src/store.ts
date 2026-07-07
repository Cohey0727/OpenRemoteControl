import { useSyncExternalStore } from 'react';
import type {
  BrowserClientMessage,
  ClientInfo,
  PermissionPrompt,
  QuestionAnswer,
  ServerBrowserMessage,
  UiMessage,
} from './wire';

/**
 * The single source of truth for the SPA: the `/ws` connection plus all
 * relayed state. It is framework-agnostic (a plain observable object) and
 * exposed to React via `useStore` / `useSyncExternalStore`. Routing is
 * owned by wouter in `App.tsx`; the store only mirrors the active session
 * id (`setRoute`) to reconcile attach/detach.
 */

export interface StoreState {
  clients: ClientInfo[];
  connected: boolean;
  messagesByClient: Record<string, UiMessage[]>;
  promptsByClient: Record<string, PermissionPrompt>;
  /** Live-only streaming partial reply (text_delta); never persisted. */
  streamByClient: Record<string, string>;
  busy: Record<string, boolean>;
  /** requestId → answer summary, for questions answered from THIS view. */
  answeredQuestions: Record<string, string>;
  draft: string;
  /** Ticks every 15 s so relative timestamps advance without a rebuild. */
  tick: number;
  /** Captured beforeinstallprompt event (PWA install affordance). */
  installEvent: unknown | null;
  iosHintVisible: boolean;
  /** Bumped when the attached client vanishes; App navigates home on it. */
  orphanSignal: number;
  /** Last server-side id change (`client_rekeyed`); App rewrites the URL
   *  from `from` to `to` on it. `seq` distinguishes repeat rekeys. */
  rekey: { seq: number; from: string; to: string } | null;
}

const RECONNECT_DELAYS = [500, 1000, 2000, 3000, 5000];

function dropKey<T>(m: Record<string, T>, key: string): Record<string, T> {
  if (!(key in m)) return m;
  const next = { ...m };
  delete next[key];
  return next;
}

function retainKeys<T>(m: Record<string, T>, live: Set<string>): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const k of Object.keys(m)) {
    if (live.has(k)) next[k] = m[k] as T;
    else changed = true;
  }
  return changed ? next : m;
}

function moveKey<T>(m: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!(from in m)) return m;
  const next = { ...m, [to]: m[from] as T };
  delete next[from];
  return next;
}

class Store {
  private state: StoreState = {
    clients: [],
    connected: false,
    messagesByClient: {},
    promptsByClient: {},
    streamByClient: {},
    busy: {},
    answeredQuestions: {},
    draft: '',
    tick: 0,
    installEvent: null,
    iosHintVisible: false,
    orphanSignal: 0,
    rekey: null,
  };
  private listeners = new Set<() => void>();
  private ws: WebSocket | undefined;
  private reconnectAttempt = 0;
  /** The session id the URL points at (desired active session). */
  private desiredId: string | null = null;
  /** The session id we currently hold a server-side attach for. */
  private attachedId: string | null = null;

  getState = (): StoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /* --------------------------- WS lifecycle --------------------------- */

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.set({ connected: true });
      this.raw({ type: 'list_clients' });
      // Re-subscribe to whatever we were watching before the drop. Clear
      // the local transcript first so the server's replay repopulates it
      // without duplicating what we already had.
      if (this.attachedId) {
        this.clearMessages(this.attachedId);
        this.raw({ type: 'attach', clientId: this.attachedId });
      }
    });
    this.ws.addEventListener('close', () => {
      this.set({ connected: false });
      this.scheduleReconnect();
    });
    // 'close' always follows 'error'; reconnect is scheduled there.
    this.ws.addEventListener('error', () => {});
    this.ws.addEventListener('message', (ev) => {
      let msg: ServerBrowserMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.handleServer(msg);
    });
  }

  private scheduleReconnect(): void {
    const delay =
      RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)] ?? 5000;
    this.reconnectAttempt++;
    setTimeout(() => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect();
    }, delay);
  }

  private raw(msg: BrowserClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /* --------------------------- route sync ----------------------------- */

  private hasClient(id: string): boolean {
    return this.state.clients.some((c) => c.clientId === id);
  }

  private clearMessages(id: string): void {
    this.set({ messagesByClient: { ...this.state.messagesByClient, [id]: [] } });
  }

  /** Called by App whenever the URL's session id changes. */
  setRoute(id: string | null): void {
    if (this.desiredId === id) return;
    this.desiredId = id;
    this.reconcile();
  }

  /**
   * Reconcile the server-side attachment with the desired (URL) session
   * and the live client list. Idempotent; safe to call on every route or
   * client-list change.
   */
  private reconcile(): void {
    const want = this.desiredId;
    // The client we were attached to disappeared entirely → orphaned.
    if (this.attachedId && !this.hasClient(this.attachedId)) {
      this.attachedId = null;
      this.set({ orphanSignal: this.state.orphanSignal + 1 });
    }
    // Switched away from (or cleared) the attached session → detach it.
    if (this.attachedId && this.attachedId !== want) {
      this.raw({ type: 'detach', clientId: this.attachedId });
      this.attachedId = null;
    }
    // Attach the desired session once it is present in the list.
    if (want && this.hasClient(want) && this.attachedId !== want) {
      this.clearMessages(want);
      this.raw({ type: 'attach', clientId: want });
      this.attachedId = want;
    }
  }

  /* --------------------------- frame handling ------------------------- */

  private appendFor(clientId: string, m: UiMessage): void {
    const prev = this.state.messagesByClient[clientId] ?? [];
    this.set({
      messagesByClient: { ...this.state.messagesByClient, [clientId]: [...prev, m] },
    });
  }

  private setBusyFor(clientId: string, value: boolean): void {
    this.set({ busy: { ...this.state.busy, [clientId]: value } });
  }

  private clearStreamFor(clientId: string): void {
    if (clientId in this.state.streamByClient) {
      this.set({ streamByClient: dropKey(this.state.streamByClient, clientId) });
    }
  }

  private forgetClient(clientId: string): void {
    this.set({
      messagesByClient: dropKey(this.state.messagesByClient, clientId),
      promptsByClient: dropKey(this.state.promptsByClient, clientId),
      busy: dropKey(this.state.busy, clientId),
      streamByClient: dropKey(this.state.streamByClient, clientId),
    });
  }

  private retainClients(live: Set<string>): void {
    this.set({
      messagesByClient: retainKeys(this.state.messagesByClient, live),
      promptsByClient: retainKeys(this.state.promptsByClient, live),
      busy: retainKeys(this.state.busy, live),
      streamByClient: retainKeys(this.state.streamByClient, live),
    });
  }

  private handleServer(msg: ServerBrowserMessage): void {
    switch (msg.type) {
      case 'client_list':
      case 'clients_changed': {
        this.set({ clients: msg.clients });
        this.retainClients(new Set(msg.clients.map((c) => c.clientId)));
        this.reconcile();
        break;
      }
      case 'client_registered': {
        const prev = this.state.clients;
        const idx = prev.findIndex((c) => c.clientId === msg.client.clientId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = msg.client;
          this.set({ clients: next });
        } else {
          this.set({ clients: [...prev, msg.client] });
        }
        this.reconcile();
        break;
      }
      case 'client_removed':
        this.set({ clients: this.state.clients.filter((c) => c.clientId !== msg.clientId) });
        this.forgetClient(msg.clientId);
        this.reconcile();
        break;
      case 'client_rekeyed': {
        // Same session, new id (e.g. `orc channel` traded its provisional
        // id for the discovered session id). The server already migrated
        // our attachment; follow it locally — swap the sidebar row, move
        // the buffers, and let App rewrite the URL — WITHOUT a detach.
        const { from, to } = msg;
        const idx = this.state.clients.findIndex((c) => c.clientId === from);
        const clients =
          idx >= 0
            ? this.state.clients.map((c) => (c.clientId === from ? msg.client : c))
            : [...this.state.clients, msg.client];
        this.set({
          clients,
          messagesByClient: moveKey(this.state.messagesByClient, from, to),
          promptsByClient: moveKey(this.state.promptsByClient, from, to),
          busy: moveKey(this.state.busy, from, to),
          streamByClient: moveKey(this.state.streamByClient, from, to),
          rekey: { seq: (this.state.rekey?.seq ?? 0) + 1, from, to },
        });
        if (this.attachedId === from) this.attachedId = to;
        if (this.desiredId === from) this.desiredId = to;
        this.reconcile();
        break;
      }
      case 'user':
        this.appendFor(msg.clientId, { kind: 'user', text: msg.text });
        break;
      case 'text':
        this.clearStreamFor(msg.clientId);
        this.appendFor(msg.clientId, { kind: 'assistant_text', text: msg.text });
        break;
      case 'text_delta':
        this.set({
          streamByClient: {
            ...this.state.streamByClient,
            [msg.clientId]: (this.state.streamByClient[msg.clientId] ?? '') + msg.text,
          },
        });
        break;
      case 'thinking':
        this.appendFor(msg.clientId, { kind: 'thinking', text: msg.text });
        break;
      case 'tool_use':
        this.appendFor(msg.clientId, { kind: 'tool_use', tool: msg.tool, input: msg.input });
        break;
      case 'tool_result':
        this.appendFor(msg.clientId, { kind: 'tool_result', output: msg.output });
        break;
      case 'question': {
        // The bridge re-relays a still-pending question on every attach
        // (transient, never replayed); dedupe by requestId.
        const already = (this.state.messagesByClient[msg.clientId] ?? []).some(
          (m) => m.kind === 'question' && m.requestId === msg.requestId,
        );
        if (!already) {
          this.appendFor(msg.clientId, {
            kind: 'question',
            requestId: msg.requestId,
            questions: msg.questions,
          });
        }
        break;
      }
      case 'permission_request':
        this.set({
          promptsByClient: {
            ...this.state.promptsByClient,
            [msg.clientId]: { requestId: msg.requestId, tool: msg.tool, input: msg.input },
          },
        });
        break;
      case 'done': {
        this.setBusyFor(msg.clientId, false);
        this.clearStreamFor(msg.clientId);
        const meta: string[] = ['turn complete'];
        if (typeof msg.duration_ms === 'number')
          meta.push(`${(msg.duration_ms / 1000).toFixed(1)}s`);
        if (typeof msg.cost === 'number') meta.push(`$${msg.cost.toFixed(4)}`);
        if (typeof msg.ts === 'number') meta.push(formatClockLocal(msg.ts));
        this.appendFor(msg.clientId, { kind: 'divider', text: meta.join('  ·  ') });
        break;
      }
      case 'error':
        this.setBusyFor(msg.clientId, false);
        this.clearStreamFor(msg.clientId);
        this.appendFor(msg.clientId, { kind: 'error', text: msg.message });
        break;
    }
  }

  /* --------------------------- actions -------------------------------- */

  setDraft(v: string): void {
    if (this.state.draft !== v) this.set({ draft: v });
  }

  submit(clientId: string): void {
    const text = this.state.draft.trim();
    if (!text || !this.state.connected) return;
    // No optimistic append — the server echoes a `user` frame to every
    // attached client, so the message renders once, identically.
    this.raw({ type: 'send', clientId, text });
    this.set({ draft: '' });
    this.setBusyFor(clientId, true);
  }

  decide(clientId: string, approved: boolean): void {
    const p = this.state.promptsByClient[clientId];
    if (!p) return;
    this.raw({ type: 'permission_response', clientId, requestId: p.requestId, approved });
    this.appendFor(clientId, {
      kind: 'system',
      text: approved ? `allowed: ${p.tool}` : `denied: ${p.tool}`,
    });
    this.set({ promptsByClient: dropKey(this.state.promptsByClient, clientId) });
  }

  answerQuestion(clientId: string, requestId: string, answers: QuestionAnswer[]): void {
    if (answers.every((a) => a.labels.length === 0)) return;
    this.raw({ type: 'question_response', clientId, requestId, answers });
    this.setBusyFor(clientId, true);
    this.set({
      answeredQuestions: {
        ...this.state.answeredQuestions,
        [requestId]: answers
          .map((a) => a.labels.join(', '))
          .filter((t) => t !== '')
          .join(' · '),
      },
    });
  }

  rename(clientId: string, label: string): void {
    this.raw({ type: 'rename', clientId, label });
  }

  setInstallEvent(ev: unknown | null): void {
    this.set({ installEvent: ev });
  }
  setIosHintVisible(v: boolean): void {
    this.set({ iosHintVisible: v });
  }
  bumpTick(): void {
    this.set({ tick: this.state.tick + 1 });
  }
}

/** Local copy to avoid importing format.ts into the store's hot path. */
function formatClockLocal(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const store = new Store();

if (typeof window !== 'undefined') {
  setInterval(() => store.bumpTick(), 15_000);
}

/** Subscribe a component to a slice of the store. The selector must
 *  return a referentially stable value when its slice is unchanged (the
 *  store keeps slices immutable, so `s => s.clients` is stable). */
export function useStore<T>(selector: (s: StoreState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

/**
 * open-rc SPA — vanilla TypeScript, no framework.
 *
 * The relay is `open-rc serve`; this file is the browser side that talks
 * to it. We use a tiny signal implementation (~30 lines) for reactivity
 * and DOM is built with the native `document` API. No build step —
 * `Bun.Transpiler` compiles this on the fly.
 *
 * Layout: 300 px sidebar on the left listing currently-connected
 * bridges, chat pane on the right with the active bridge's transcript.
 * A permission modal sits on top when a `permission_request` is open.
 *
 * On mobile (< 720 px) the panes slide; sidebar by default, chat when
 * a client is selected, back button returns to the sidebar.
 */

import { marked } from 'marked';

/* ============================================================
 * Tiny reactivity: signals + effects
 * ============================================================ */

type Cleanup = () => void;
type Disposer = () => void;

/**
 * A reactive computation. It tracks the signal subscriber-sets it reads
 * (`deps`) so it can unsubscribe on re-run, and the effects created
 * during its run (`children`) so those are disposed when it re-runs or
 * is disposed — without this, rebuilding the sidebar/chat would leak an
 * ever-growing pile of orphaned effects still subscribed to `activeId`.
 */
interface Reaction {
  // biome-ignore lint/suspicious/noConfusingVoidType: effect callbacks may return nothing or a Cleanup
  fn: () => void | Cleanup;
  deps: Set<Set<Reaction>>;
  children: Reaction[];
  cleanup: Cleanup | null;
  disposed: boolean;
}

let currentObserver: Reaction | null = null;

function unsubscribe(r: Reaction): void {
  for (const dep of r.deps) dep.delete(r);
  r.deps.clear();
}

function disposeReaction(r: Reaction): void {
  r.disposed = true;
  for (const c of r.children) disposeReaction(c);
  r.children = [];
  r.cleanup?.();
  r.cleanup = null;
  unsubscribe(r);
}

function runReaction(r: Reaction): void {
  if (r.disposed) return;
  // Tear down the previous run: dispose owned children, run user
  // cleanup, drop old subscriptions (they are re-established below).
  for (const c of r.children) disposeReaction(c);
  r.children = [];
  r.cleanup?.();
  r.cleanup = null;
  unsubscribe(r);

  const prev = currentObserver;
  currentObserver = r;
  if (prev) prev.children.push(r);
  try {
    const maybeCleanup = r.fn();
    r.cleanup = typeof maybeCleanup === 'function' ? maybeCleanup : null;
  } finally {
    // Restore (not null) so a parent effect keeps tracking signals it
    // reads after creating a nested effect.
    currentObserver = prev;
  }
}

function signal<T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => void] {
  let value = initial;
  const subs = new Set<Reaction>();
  const get = (): T => {
    if (currentObserver) {
      subs.add(currentObserver);
      currentObserver.deps.add(subs);
    }
    return value;
  };
  const set = (next: T | ((prev: T) => T)): void => {
    const v = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
    if (Object.is(v, value)) return;
    value = v;
    // Snapshot to avoid mutation-during-iteration; skip effects disposed
    // mid-flush (e.g. a parent re-run disposed one of its children).
    for (const r of [...subs]) if (!r.disposed) runReaction(r);
  };
  return [get, set];
}

// biome-ignore lint/suspicious/noConfusingVoidType: effect callbacks may return nothing or a Cleanup
function effect(fn: () => void | Cleanup): Disposer {
  const r: Reaction = { fn, deps: new Set(), children: [], cleanup: null, disposed: false };
  runReaction(r);
  return () => disposeReaction(r);
}

function mount(node: Node, replaceId: string): void {
  const root = document.getElementById(replaceId);
  if (!root) throw new Error(`#${replaceId} not found`);
  root.replaceWith(node);
}

/* ============================================================
 * DOM helpers
 * ============================================================ */

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | null | undefined | false | Child[];

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') {
      el.setAttribute('class', String(v));
    } else if (k === 'style' && typeof v === 'string') {
      el.setAttribute('style', v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'value' && el instanceof HTMLInputElement) {
      (el as HTMLInputElement).value = String(v);
    } else if (k === 'value' && el instanceof HTMLTextAreaElement) {
      (el as HTMLTextAreaElement).value = String(v);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else if (v === false) {
      // skip
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

function appendChildren(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Replace the children of `el` with `next` (which may be nodes or strings). */
function setChildren(el: Node, next: Child[]): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  appendChildren(el, next);
}

/** Reactive text node — auto-updates when read signals change. */
function bindText(get: () => string): Text {
  const t = document.createTextNode(get());
  effect(() => {
    t.nodeValue = get();
  });
  return t;
}

/** Reactive attribute — auto-updates when read signals change. */
function bindAttr(el: Element, name: string, get: () => string | null | undefined): void {
  effect(() => {
    const v = get();
    if (v == null) el.removeAttribute(name);
    else el.setAttribute(name, v);
  });
}

/**
 * querySelector for elements the caller just built with `h()`. A miss is
 * a template bug, not a runtime state — fail loudly instead of silently
 * skipping the binding.
 */
function mustQuery(root: Element, selector: string): Element {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`template bug: missing ${selector}`);
  return el;
}

/* ============================================================
 * Markdown rendering
 * ============================================================ */

marked.setOptions({ gfm: true, breaks: true });

/**
 * Tags that must never survive into the DOM, and the attribute patterns
 * that carry script. Model output (assistant / thinking text) is
 * attacker-influenced — it can echo file/tool/web content — so its
 * rendered HTML is sanitized before it touches innerHTML. Without this,
 * a `<img src=x onerror=…>` in a reply would run script on the relay's
 * own origin and could open its own /ws to drive the agent and
 * auto-approve permissions. No external dependency: we reuse the
 * browser's own parser.
 */
const UNSAFE_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'BASE',
  'FORM',
]);

function sanitizeHtml(dirty: string): string {
  const doc = new DOMParser().parseFromString(dirty, 'text/html');
  const els: Element[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) els.push(walker.currentNode as Element);
  for (const el of els) {
    if (UNSAFE_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*(javascript|data|vbscript):/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name);
      } else if (name === 'srcdoc' || name === 'style') {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

function renderMarkdown(text: string): string {
  return sanitizeHtml(marked.parse(text, { async: false }) as string);
}

/** Wall-clock HH:MM:SS for turn-complete dividers. */
function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return 'now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function basename(p: string): string {
  const m = p.split('/').filter(Boolean);
  return m[m.length - 1] ?? p;
}

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
}

function formatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/* ============================================================
 * Wire types
 * ============================================================ */

type ClientStatus = 'idle' | 'busy' | 'exited' | 'errored';

interface ClientInfo {
  clientId: string;
  label: string;
  cwd: string;
  status: ClientStatus;
  lastActivity: number;
  connectedAt: number;
}

type BrowserClientMessage =
  | { type: 'list_clients' }
  | { type: 'attach'; clientId: string }
  | { type: 'detach'; clientId: string }
  | { type: 'send'; clientId: string; text: string }
  | {
      type: 'permission_response';
      clientId: string;
      requestId: string;
      approved: boolean;
    };

type ServerBrowserMessage =
  | { type: 'client_list'; clients: ClientInfo[] }
  | { type: 'client_registered'; client: ClientInfo }
  | { type: 'client_removed'; clientId: string }
  | { type: 'clients_changed'; clients: ClientInfo[] }
  | { type: 'user'; clientId: string; text: string }
  | { type: 'text'; clientId: string; text: string }
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
  | { type: 'done'; clientId: string; cost?: number; duration_ms?: number }
  | { type: 'error'; clientId: string; message: string };

interface PermissionPrompt {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

type UiMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; tool: string; input: string }
  | { kind: 'tool_result'; output: string }
  | { kind: 'system'; text: string }
  | { kind: 'divider'; text: string }
  | { kind: 'error'; text: string };

/* ============================================================
 * State
 * ============================================================ */

const [clients, setClients] = signal<ClientInfo[]>([]);
const [activeId, setActiveId] = signal<string | null>(null);
const [connected, setConnected] = signal(false);
const [busy, setBusy] = signal<Record<string, boolean>>({});
const [draft, setDraft] = signal('');
const [messagesByClient, setMessagesByClient] = signal<Record<string, UiMessage[]>>({});
const [promptsByClient, setPromptsByClient] = signal<Record<string, PermissionPrompt>>({});
// Streaming partial reply per client (text_delta frames). Live-only:
// cleared when the final `text` frame (or done/error) arrives; never
// part of messagesByClient, never replayed.
const [streamByClient, setStreamByClient] = signal<Record<string, string>>({});
const [mobileView, setMobileView] = signal<'sidebar' | 'chat'>('sidebar');
const [mobile, setMobile] = signal(isMobile());
// Ticks every 15 s so relative "last activity" timestamps advance on
// their own; rows read it to re-render without a full list rebuild.
const [nowTick, setNowTick] = signal(0);
if (typeof window !== 'undefined') {
  setInterval(() => setNowTick((n) => n + 1), 15_000);
}

// PWA: the captured beforeinstallprompt event, if any. Non-null means
// we can show a custom "Install" affordance. Null on iOS Safari (the
// event never fires there) and on any browser that has already
// installed us or has dismissed the prompt.
const [installPromptEvent, setInstallPromptEvent] = signal<unknown | null>(null);
// PWA: iOS-Safari users get a one-time hint to use the share sheet
// (beforeinstallprompt never fires on iOS). Latch in localStorage so
// we only nag once per device.
const [iosHintVisible, setIosHintVisible] = signal(false);
const IOS_HINT_LS_KEY = 'open-rc.ios-hint-dismissed';

let ws: WebSocket | undefined;

/* ============================================================
 * WS plumbing
 * ============================================================ */

function appendFor(clientId: string, m: UiMessage): void {
  setMessagesByClient((prev) => ({
    ...prev,
    [clientId]: [...(prev[clientId] ?? []), m],
  }));
  scrollChatToBottom();
}

function setBusyFor(clientId: string, value: boolean): void {
  setBusy((prev) => ({ ...prev, [clientId]: value }));
}

function scrollChatToBottom(): void {
  queueMicrotask(() => {
    const main = document.querySelector('.chat-scroll');
    if (main) (main as HTMLElement).scrollTop = (main as HTMLElement).scrollHeight;
  });
}

function appendStreamFor(clientId: string, chunk: string): void {
  setStreamByClient((prev) => ({ ...prev, [clientId]: (prev[clientId] ?? '') + chunk }));
  scrollChatToBottom();
}

function clearStreamFor(clientId: string): void {
  setStreamByClient((prev) => (clientId in prev ? dropKey(prev, clientId) : prev));
}

function send(msg: BrowserClientMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function activeClient(): ClientInfo | undefined {
  return clients().find((c) => c.clientId === activeId());
}

/* ---- URL routing: the active session lives in the path /sessions/:id ---- */

/** A session id we want to attach to as soon as it appears — seeded from
 *  the URL at load so a reload or a shared /sessions/:id deep-links back. */
let pendingSession: string | null = sessionFromPath();

function sessionFromPath(): string | null {
  const m = location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function syncUrl(clientId: string, replace: boolean): void {
  const path = `/sessions/${encodeURIComponent(clientId)}`;
  if (location.pathname === path) return;
  const state = { clientId };
  if (replace) history.replaceState(state, '', path);
  else history.pushState(state, '', path);
}

function clearUrl(): void {
  if (location.pathname !== '/') history.replaceState({}, '', '/');
}

/** Clear this client's local transcript, then attach — the server replays
 *  its buffered history on attach, so clearing first avoids duplicates
 *  (on first select, on reconnect, and on back/forward). */
function sendAttach(clientId: string): void {
  setMessagesByClient((prev) => ({ ...prev, [clientId]: [] }));
  send({ type: 'attach', clientId });
}

function selectClient(clientId: string, opts: { replace?: boolean } = {}): void {
  const cur = activeId();
  if (cur === clientId) {
    syncUrl(clientId, opts.replace ?? false);
    if (mobile()) setMobileView('chat');
    return;
  }
  if (cur) send({ type: 'detach', clientId: cur });
  setActiveId(clientId);
  sendAttach(clientId);
  syncUrl(clientId, opts.replace ?? false);
  if (mobile()) setMobileView('chat');
}

function backToSidebar(): void {
  setMobileView('sidebar');
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const id = sessionFromPath();
    if (id) {
      if (clients().some((c) => c.clientId === id)) selectClient(id, { replace: true });
      else pendingSession = id;
    } else {
      const cur = activeId();
      if (cur) send({ type: 'detach', clientId: cur });
      setActiveId(null);
      pendingSession = null;
    }
  });
}

let reconnectAttempt = 0;
const RECONNECT_DELAYS = [500, 1000, 2000, 3000, 5000];

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    setConnected(true);
    send({ type: 'list_clients' });
    // Re-subscribe to whatever client we were watching before the drop.
    // sendAttach clears the local transcript first so the server's replay
    // repopulates it without duplicating what we already had.
    const cur = activeId();
    if (cur) sendAttach(cur);
  });

  ws.addEventListener('close', () => {
    setConnected(false);
    scheduleReconnect();
  });

  // 'close' always follows 'error'; reconnect is scheduled there. Avoid
  // spamming the transcript with an error line on every transient drop.
  ws.addEventListener('error', () => {});

  ws.addEventListener('message', (ev) => {
    let msg: ServerBrowserMessage;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    handleServer(msg);
  });
}

function scheduleReconnect(): void {
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)] ?? 5000;
  reconnectAttempt++;
  setTimeout(() => {
    if (!ws || ws.readyState === WebSocket.CLOSED) connect();
  }, delay);
}

/** Drop one client's per-client state (transcript, prompt, busy flag). */
function dropKey<T>(m: Record<string, T>, key: string): Record<string, T> {
  if (!(key in m)) return m;
  const next = { ...m };
  delete next[key];
  return next;
}

/** Keep only per-client state whose clientId is still live. */
function retainKeys<T>(m: Record<string, T>, live: Set<string>): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const k of Object.keys(m)) {
    if (live.has(k)) next[k] = m[k] as T;
    else changed = true;
  }
  return changed ? next : m;
}

function forgetClient(clientId: string): void {
  setMessagesByClient((prev) => dropKey(prev, clientId));
  setPromptsByClient((prev) => dropKey(prev, clientId));
  setBusy((prev) => dropKey(prev, clientId));
  setStreamByClient((prev) => dropKey(prev, clientId));
}

function retainClients(live: Set<string>): void {
  setMessagesByClient((prev) => retainKeys(prev, live));
  setPromptsByClient((prev) => retainKeys(prev, live));
  setBusy((prev) => retainKeys(prev, live));
  setStreamByClient((prev) => retainKeys(prev, live));
}

function handleServer(msg: ServerBrowserMessage): void {
  switch (msg.type) {
    case 'client_list':
    case 'clients_changed': {
      setClients(msg.clients);
      // Prune transcripts/prompts/busy for clients that are gone, so the
      // state maps can't grow without bound and a reused clientId can't
      // resurrect a stale transcript.
      retainClients(new Set(msg.clients.map((c) => c.clientId)));
      const has = (id: string): boolean => msg.clients.some((c) => c.clientId === id);
      if (pendingSession && has(pendingSession)) {
        // The session named in the URL just appeared — attach to it.
        selectClient(pendingSession, { replace: true });
        pendingSession = null;
      } else if (!activeId() && msg.clients.length > 0) {
        // No URL session (or it's absent from a non-empty list): auto-pick.
        const first = msg.clients.find((c) => c.status !== 'exited') ?? msg.clients[0];
        if (first) selectClient(first.clientId, { replace: true });
        pendingSession = null;
      }
      if (activeId() && !has(activeId() as string)) {
        setActiveId(null);
        clearUrl();
      }
      break;
    }
    case 'client_registered':
      setClients((prev) => {
        const idx = prev.findIndex((c) => c.clientId === msg.client.clientId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = msg.client;
          return next;
        }
        return [...prev, msg.client];
      });
      if (pendingSession === msg.client.clientId) {
        selectClient(msg.client.clientId, { replace: true });
        pendingSession = null;
      } else if (!activeId() && !pendingSession) {
        selectClient(msg.client.clientId, { replace: true });
      }
      break;
    case 'client_removed':
      setClients((prev) => prev.filter((c) => c.clientId !== msg.clientId));
      if (activeId() === msg.clientId) {
        setActiveId(null);
        clearUrl();
      }
      forgetClient(msg.clientId);
      break;
    case 'user':
      appendFor(msg.clientId, { kind: 'user', text: msg.text });
      break;
    case 'text':
      // The final complete text supersedes any streamed partial.
      clearStreamFor(msg.clientId);
      appendFor(msg.clientId, { kind: 'assistant_text', text: msg.text });
      break;
    case 'text_delta':
      appendStreamFor(msg.clientId, msg.text);
      break;
    case 'thinking':
      appendFor(msg.clientId, { kind: 'thinking', text: msg.text });
      break;
    case 'tool_use':
      appendFor(msg.clientId, { kind: 'tool_use', tool: msg.tool, input: msg.input });
      break;
    case 'tool_result':
      appendFor(msg.clientId, { kind: 'tool_result', output: msg.output });
      break;
    case 'permission_request':
      setPromptsByClient((prev) => ({
        ...prev,
        [msg.clientId]: {
          requestId: msg.requestId,
          tool: msg.tool,
          input: msg.input,
        },
      }));
      break;
    case 'done': {
      setBusyFor(msg.clientId, false);
      clearStreamFor(msg.clientId);
      const meta: string[] = ['turn complete'];
      if (typeof msg.duration_ms === 'number') {
        meta.push(`${(msg.duration_ms / 1000).toFixed(1)}s`);
      }
      if (typeof msg.cost === 'number') {
        meta.push(`$${msg.cost.toFixed(4)}`);
      }
      if (typeof msg.ts === 'number') {
        meta.push(formatClock(msg.ts));
      }
      appendFor(msg.clientId, { kind: 'divider', text: meta.join('  ·  ') });
      break;
    }
    case 'error':
      setBusyFor(msg.clientId, false);
      clearStreamFor(msg.clientId);
      appendFor(msg.clientId, { kind: 'error', text: msg.message });
      break;
  }
}

/* ============================================================
 * Composer
 * ============================================================ */

function submit(): void {
  const text = draft().trim();
  const cid = activeId();
  if (!text || !connected() || !cid) return;
  // No optimistic append — the server echoes a `user` frame to every
  // attached client (this one included), so the message renders once,
  // identically, in the browser and any `tui` sharing the session.
  send({ type: 'send', clientId: cid, text });
  setDraft('');
  setBusyFor(cid, true);
}

function decide(approved: boolean): void {
  const cid = activeId();
  if (!cid) return;
  const p = promptsByClient()[cid];
  if (!p) return;
  send({
    type: 'permission_response',
    clientId: cid,
    requestId: p.requestId,
    approved,
  });
  appendFor(cid, {
    kind: 'system',
    text: approved ? `allowed: ${p.tool}` : `denied: ${p.tool}`,
  });
  setPromptsByClient((prev) => {
    const next = { ...prev };
    delete next[cid];
    return next;
  });
}

function onComposerKey(e: KeyboardEvent): void {
  // The Enter that confirms an IME composition (kanji conversion etc.)
  // must not send the message. `isComposing` covers modern engines;
  // keyCode 229 is the legacy signal some browsers (notably Safari)
  // report on the composition-commit keydown after isComposing has
  // already flipped false.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.target instanceof HTMLTextAreaElement && !e.target.disabled) {
      e.preventDefault();
      submit();
    }
  }
}

function onInput(e: Event): void {
  setDraft((e.currentTarget as HTMLTextAreaElement).value);
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const was = mobile();
    const now = isMobile();
    if (was !== now) setMobile(now);
  });
}

/* ============================================================
 * View helpers
 * ============================================================ */

function clientRow(c: ClientInfo): HTMLElement {
  const isActive = (): boolean => activeId() === c.clientId;
  const row = h(
    'button',
    {
      type: 'button',
      class: 'client-row',
      onClick: () => selectClient(c.clientId),
      'aria-pressed': 'false',
      title: c.cwd,
    },
    h('span', { class: 'client-status' }),
    h(
      'span',
      { class: 'client-meta' },
      h('span', { class: 'client-label' }, c.label),
      h(
        'span',
        { class: 'client-sub' },
        h('span', { class: 'status-label' }, c.status),
        h('span', { class: 'sep' }, '·'),
        h('span', { class: 'client-cwd' }, basename(c.cwd)),
        h('span', { class: 'sep' }, '·'),
        h('span', { class: 'client-time' }),
      ),
    ),
  );
  // Reactive bindings
  bindAttr(row, 'class', () => `client-row${isActive() ? ' active' : ''}`);
  bindAttr(row, 'aria-pressed', () => (isActive() ? 'true' : 'false'));
  const statusDot = mustQuery(row, '.client-status');
  bindAttr(statusDot, 'class', () => `client-status ${c.status}`);
  const timeEl = mustQuery(row, '.client-time');
  // Read nowTick() so the relative time re-renders on the 15 s tick.
  setChildren(timeEl, [
    bindText(() => {
      nowTick();
      return formatRelative(c.lastActivity);
    }),
  ]);
  return row;
}

function messageView(_cid: string, m: UiMessage): HTMLElement {
  switch (m.kind) {
    case 'user':
      return h(
        'div',
        { class: 'msg user' },
        h('div', { class: 'role' }, 'You'),
        h('div', { class: 'body' }, m.text),
      );
    case 'assistant_text': {
      const el = h(
        'div',
        { class: 'msg text' },
        h('div', { class: 'role' }, 'Assistant'),
        h('div', { class: 'markdown' }),
      );
      const md = mustQuery(el, '.markdown');
      md.innerHTML = renderMarkdown(m.text);
      return el;
    }
    case 'thinking': {
      const el = h(
        'details',
        { class: 'msg thinking' },
        h('summary', {}, h('span', { class: 'role' }, 'Thinking')),
        h('div', { class: 'markdown' }),
      );
      const md = mustQuery(el, '.markdown');
      md.innerHTML = renderMarkdown(m.text);
      return el;
    }
    case 'tool_use': {
      const el = h(
        'details',
        { class: 'msg tool_use' },
        h('summary', {}, h('span', { class: 'name' }, m.tool)),
        h('pre', { class: 'body' }),
      );
      const pre = mustQuery(el, 'pre');
      pre.textContent = formatJson(m.input);
      return el;
    }
    case 'tool_result':
      return h(
        'details',
        { class: 'msg tool_result', open: 'open' },
        h('summary', {}, h('span', { class: 'name' }, 'result')),
        h('pre', { class: 'body' }, m.output),
      );
    case 'system':
      return h('div', { class: 'msg system' }, h('div', { class: 'body' }, m.text));
    case 'divider':
      return h('div', { class: 'msg divider' }, m.text);
    case 'error':
      return h(
        'div',
        { class: 'msg error' },
        h('div', { class: 'role' }, 'Error'),
        h('div', { class: 'body' }, m.text),
      );
  }
}

function activeBusy(): boolean {
  const cid = activeId();
  if (!cid) return false;
  return !!busy()[cid];
}

function activePrompt(): PermissionPrompt | null {
  const cid = activeId();
  if (!cid) return null;
  return promptsByClient()[cid] ?? null;
}

function orderedClients(): ClientInfo[] {
  // Stable arrival order: rows must never reshuffle on click or on
  // activity. (Pinning the active row first / sorting by recency made
  // the list jump around mid-use; recency is already visible as each
  // row's timestamp.) clientId tiebreak keeps equal timestamps stable.
  const arr = [...clients()];
  arr.sort((a, b) => a.connectedAt - b.connectedAt || a.clientId.localeCompare(b.clientId));
  return arr;
}

/* ============================================================
 * Top-level layout
 * ============================================================ */

function buildApp(): HTMLElement {
  // ----- Sidebar -----
  const clientListEl = h('div', { class: 'client-list' });
  effect(() => {
    const list = orderedClients();
    if (list.length === 0) {
      // Keep the sidebar terse when empty; the how-to lives in the
      // chat pane's onboarding state so the two never contradict.
      setChildren(clientListEl, [h('div', { class: 'client-empty' }, 'No sessions.')]);
    } else {
      setChildren(clientListEl, list.map(clientRow));
    }
  });

  const connEl = h(
    'span',
    { class: 'conn' },
    h('span', { class: 'dot' }),
    h('span', { class: 'conn-label' }),
  );
  bindAttr(connEl, 'class', () => `conn ${connected() ? 'online' : 'offline'}`);
  setChildren(mustQuery(connEl, '.conn-label'), [
    bindText(() => (connected() ? 'online' : 'offline')),
  ]);

  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h(
      'header',
      { class: 'sidebar-head' },
      h('div', { class: 'wordmark' }, 'Open Remote Control'),
      // Custom install affordance. Renders only while we have a
      // captured beforeinstallprompt event. Click triggers the
      // browser's own install dialog; the button hides itself
      // afterwards because the event is single-use.
      h(
        'button',
        {
          class: 'install-btn',
          title: 'Install open-rc',
          'aria-label': 'Install open-rc',
          onClick: triggerInstallPrompt,
        },
        'Install',
      ),
      connEl,
    ),
    clientListEl,
  );

  // ----- Chat pane -----
  // The live wrapper carries BOTH classes: `chat` gives it the exact
  // same column as the transcript (max-width, centring, responsive
  // padding) so its cards can never span the full pane; `chat-live`
  // scopes the vertical-padding trims in the stylesheet.
  const chatScroll = h(
    'div',
    { class: 'chat-scroll' },
    h('div', { class: 'chat' }),
    h('div', { class: 'chat chat-live' }),
  );
  const chatInner = mustQuery(chatScroll, '.chat:not(.chat-live)');
  const liveEl = mustQuery(chatScroll, '.chat-live');

  // Live region below the transcript: the streaming partial reply
  // (text_delta) while it's generating, or a typing indicator when the
  // client is busy with nothing streamed yet. Kept separate from the
  // transcript so its per-delta re-render can't disturb the
  // incremental append logic or expand/collapse state above.
  effect(() => {
    const cid = activeId();
    const streamText = cid ? (streamByClient()[cid] ?? '') : '';
    const isBusy = cid ? !!busy()[cid] : false;
    if (!cid || (!isBusy && streamText.length === 0)) {
      setChildren(liveEl, []);
      return;
    }
    if (streamText.length > 0) {
      const el = h(
        'div',
        { class: 'msg text streaming' },
        h('div', { class: 'role' }, 'Assistant'),
        h('div', { class: 'markdown' }),
      );
      mustQuery(el, '.markdown').innerHTML = renderMarkdown(streamText);
      setChildren(liveEl, [el]);
    } else {
      setChildren(liveEl, [
        h(
          'div',
          { class: 'msg typing' },
          h('div', { class: 'role' }, 'Assistant'),
          h('div', { class: 'typing-dots' }, h('span'), h('span'), h('span')),
        ),
      ]);
    }
  });

  // Transcript rendering. Keyed off activeId() (NOT activeClient(), which
  // changes object identity on every status tick and would rebuild the
  // whole transcript, resetting scroll and re-parsing markdown). New
  // messages for the current client are appended incrementally so we
  // don't re-render — and lose the expand/collapse state of — every
  // prior message on each frame.
  let renderedCid: string | null = null;
  let renderedCount = 0;
  const placeholder = (): HTMLElement =>
    h(
      'div',
      { class: 'msg system' },
      h('div', { class: 'body' }, connected() ? 'send a message to begin' : 'connecting…'),
    );
  effect(() => {
    const cid = activeId();
    const byClient = messagesByClient();
    if (!cid) {
      setChildren(chatInner, []);
      renderedCid = null;
      renderedCount = 0;
      return;
    }
    const items = byClient[cid] ?? [];
    const clientChanged = cid !== renderedCid;
    if (clientChanged || items.length === 0) {
      setChildren(
        chatInner,
        items.length === 0 ? [placeholder()] : items.map((m) => messageView(cid, m)),
      );
      renderedCid = cid;
      renderedCount = items.length;
      return;
    }
    if (renderedCount === 0) setChildren(chatInner, []); // clear placeholder
    for (let i = renderedCount; i < items.length; i++) {
      const m = items[i];
      if (m) chatInner.appendChild(messageView(cid, m));
    }
    renderedCount = items.length;
  });

  // Topbar (changes per active client)
  const topbar = h(
    'header',
    { class: 'chat-topbar' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn-back',
        onClick: () => backToSidebar(),
        'aria-label': 'Back to sidebar',
      },
      '‹',
    ),
    h(
      'div',
      { class: 'chat-cwd' },
      h('span', { class: 'label' }),
      h('span', { class: 'sep' }, '·'),
      h('span', { class: 'cwd-text' }),
    ),
    h('span', { class: 'chat-status' }),
  );
  const backBtn = mustQuery(topbar, '.btn-back') as HTMLElement;
  effect(() => {
    backBtn.style.display = mobile() ? '' : 'none';
  });
  effect(() => {
    const c = activeClient();
    if (!c) return;
    const labelEl = mustQuery(topbar, '.label');
    const cwdEl = mustQuery(topbar, '.cwd-text');
    const statusEl = mustQuery(topbar, '.chat-status');
    mustQuery(topbar, '.chat-cwd').setAttribute('title', c.cwd);
    setChildren(labelEl, [bindText(() => c.label)]);
    setChildren(cwdEl, [bindText(() => c.cwd)]);
    bindAttr(statusEl, 'class', () => `chat-status ${c.status}`);
    setChildren(statusEl, [bindText(() => c.status)]);
  });

  // Composer
  const ta = h('textarea', {
    rows: '1',
    placeholder: 'Send a message…',
    onInput: (e: Event) => onInput(e),
    onKeyDown: (e: KeyboardEvent) => onComposerKey(e),
  }) as HTMLTextAreaElement;
  // Reactive placeholder + value
  effect(() => {
    ta.placeholder = connected() ? 'Send a message…' : 'Connecting…';
  });
  effect(() => {
    ta.value = draft();
  });

  const sendBtn = h(
    'button',
    {
      type: 'button',
      class: 'send',
      onClick: () => submit(),
    },
    'Send',
  );
  effect(() => {
    sendBtn.disabled = !connected() || !activeId() || draft().trim() === '';
    setChildren(sendBtn, [activeBusy() ? 'Send (busy)' : 'Send']);
  });

  const composer = h(
    'footer',
    { class: 'composer' },
    h('div', { class: 'composer-inner' }, ta, sendBtn),
  );

  // Onboarding shown when nothing is connected — an invitation to act,
  // written in the interface's voice, carrying the how-to that the
  // sidebar used to duplicate.
  const onboarding = (): HTMLElement =>
    h(
      'div',
      { class: 'empty-state' },
      h('div', { class: 'empty-badge' }, h('span', { class: 'dot' }), 'waiting for a session'),
      h('h2', {}, 'Nothing connected yet'),
      h(
        'p',
        {},
        'Bridge a running claude to this relay and it appears in the sidebar, ready to drive.',
      ),
      h(
        'div',
        { class: 'empty-cmds' },
        h('div', { class: 'empty-cmd' }, h('code', {}, 'attach-orc'), 'in any terminal'),
        h('div', { class: 'empty-cmd' }, h('code', {}, '/attach-orc'), 'inside Claude Code'),
      ),
    );

  // Shown only in the unusual case where sessions exist but none is active.
  const selectPrompt = (): HTMLElement =>
    h(
      'div',
      { class: 'empty-state' },
      h('h2', {}, 'Select a session'),
      h('p', {}, 'Pick a session from the sidebar to watch its stream.'),
    );

  const chatBody = h('div', { class: 'chat-body' });
  // Keyed off activeId() so the pane swaps only on client switch, not on
  // every status tick (which would recreate the scroll container).
  effect(() => {
    if (activeId()) {
      setChildren(chatBody, [topbar, chatScroll, composer]);
    } else {
      setChildren(chatBody, [clients().length > 0 ? selectPrompt() : onboarding()]);
    }
  });

  const chatPane = h(
    'main',
    { class: 'chat-pane', onKeyDown: (e: KeyboardEvent) => onComposerKey(e) },
    chatBody,
  );

  // ----- Modal -----
  // `display: contents` so this wrapper never becomes a grid item of
  // `#app` (an extra grid item would spawn a phantom row and steal
  // height from the sidebar). Its only child, the fixed-position
  // backdrop, is positioned out of flow anyway.
  const modalRoot = h('div', { style: 'display: contents' });
  effect(() => {
    const p = activePrompt();
    if (!p) {
      setChildren(modalRoot, []);
      return;
    }
    const where = activeClient()?.label;
    setChildren(modalRoot, [
      h(
        'div',
        { class: 'modal-backdrop' },
        h(
          'div',
          { class: 'modal' },
          h('div', { class: 'modal-eyebrow' }, 'Permission required'),
          h('h3', {}, 'Run ', p.tool, '?'),
          h(
            'p',
            { class: 'lede' },
            where
              ? `This runs on ${where}. Review the input before you allow it.`
              : 'Review the input before you allow it.',
          ),
          h('pre', { class: 'target' }, JSON.stringify(p.input, null, 2)),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn', onClick: () => decide(false) }, 'Deny'),
            h('button', { class: 'btn primary', onClick: () => decide(true) }, 'Allow'),
          ),
        ),
      ),
    ]);
  });

  // The shell's grid layout is keyed off `#app` in index.html; mount()
  // replaces the placeholder node, so we must carry the id forward or
  // the sidebar column collapses.
  // The install button and the iOS hint are visibility-toggled by
  // effect() below — they always exist in the DOM, we only flip
  // their display, so the install affordance is reachable from the
  // very first paint without a re-mount flash.
  const installBtn = mustQuery(sidebar, '.install-btn');
  effect(() => {
    installBtn.style.display = installPromptEvent() ? '' : 'none';
  });
  const iOSHint = h(
    'div',
    { class: 'ios-hint', role: 'status' },
    h(
      'div',
      { class: 'ios-hint-text' },
      'To install: tap ',
      h('span', { class: 'ios-share' }, 'Share'),
      ', then "Add to Home Screen".',
    ),
    h('button', { class: 'ios-hint-close', 'aria-label': 'Dismiss', onClick: dismissIosHint }, '×'),
  );
  iOSHint.style.display = 'none';
  effect(() => {
    iOSHint.style.display = iosHintVisible() ? '' : 'none';
  });
  document.body.appendChild(iOSHint);

  return h('div', { id: 'app', class: 'app' }, sidebar, chatPane, modalRoot);
}

/* ============================================================
 * Mobile shell classes (applied to <body>)
 * ============================================================ */

if (typeof document !== 'undefined') {
  effect(() => {
    const cls = document.body.classList;
    if (!mobile()) {
      cls.remove('app-mobile-chat', 'app-mobile-sidebar');
    } else {
      cls.toggle('app-mobile-chat', mobileView() === 'chat');
      cls.toggle('app-mobile-sidebar', mobileView() === 'sidebar');
    }
  });
}

/* ============================================================
 * PWA — service-worker registration, install prompt, iOS hint
 * ============================================================ */

/** `BeforeInstallPromptEvent` is non-standard and not in lib.dom, so
 *  we type the surface we actually use. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** Heuristic: is this an iOS Safari that won't fire beforeinstallprompt?
 *  Mac Safari 13.1+ advertises itself as Safari with a desktop
 *  user-agent that contains "Macintosh" but not "Mobile" — exclude it. */
function isIosWebkit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  if (!isIos) return false;
  // WebKit only — other iOS browsers (Chrome for iOS) are actually
  // WebKit under the hood, but `Install via Share` is the same flow.
  return /WebKit/.test(ua);
}

function triggerInstallPrompt(): void {
  const ev = installPromptEvent() as BeforeInstallPromptEvent | null;
  if (!ev) return;
  // The event is single-use. Clear it first so a second click while
  // the dialog is open doesn't try to re-prompt.
  setInstallPromptEvent(null);
  void (async () => {
    try {
      await ev.prompt();
      await ev.userChoice;
      // Whether the user accepted or dismissed, the event is gone;
      // the appinstalled listener will refresh state if relevant.
    } catch {
      // Browser refused (e.g. user closed the parent tab) — nothing
      // to do; the next beforeinstallprompt will re-show the button.
    }
  })();
}

function dismissIosHint(): void {
  setIosHintVisible(false);
  try {
    localStorage.setItem(IOS_HINT_LS_KEY, '1');
  } catch {
    // localStorage can be disabled (private mode) — fine, the hint
    // will just reappear on next launch, no harm done.
  }
}

function initPwa(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Register the SW. We do NOT pass a scope: /sw.js is served with
  // `Service-Worker-Allowed: /`, so it can claim the whole origin
  // regardless of where it's listed.
  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      // When a new SW takes over (reg.update() finishes, or a new
      // install completes after a previous activation), reload so
      // the page is running the new shell. The SW itself does NOT
      // call skipWaiting on install, so this branch is the main
      // path for picking up updates.
      if (reg.waiting) {
        // A new SW is already installed and waiting. Reload to
        // activate it (the SW will skip-wait on this signal).
        try {
          reg.waiting.postMessage({ type: 'skipWaiting' });
        } catch {}
      }
    })
    .catch(() => {
      // SW registration failed (e.g. file:// or no HTTPS in some
      // non-localhost context). The SPA still works as a plain
      // page; we just lose offline + push.
    });

  // Pick up SW activations triggered while the page is open.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  // Capture the install prompt event. Browsers fire it shortly after
  // first load when the page is install-eligible; we stash it and
  // surface a custom button.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // suppress the browser's mini-infobar
    setInstallPromptEvent(event);
  });
  // When the user accepts the install, the appinstalled event fires;
  // clear the captured event so the button disappears.
  window.addEventListener('appinstalled', () => {
    setInstallPromptEvent(null);
  });

  // iOS Safari: no beforeinstallprompt. Surface a one-time banner
  // pointing the user at the share-sheet install flow. The check
  // is structural (UA), so it runs even when the user navigates
  // between /sessions/<id> paths within the same SPA.
  if (isIosWebkit() && !window.matchMedia('(display-mode: standalone)').matches) {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(IOS_HINT_LS_KEY) === '1';
    } catch {
      // localStorage may be blocked — fall through and show.
    }
    if (!dismissed) setIosHintVisible(true);
  }
}

/* ============================================================
 * Boot
 * ============================================================ */

mount(buildApp(), 'app');
queueMicrotask(connect);
initPwa();

/**
 * Solid.js SPA for open-rc.
 *
 * Single-session v0.1. Loads Solid from esm.sh. Uses `solid-js/html`
 * (tagged template literals) so no JSX build step is required.
 *
 * Wire protocol mirrors `src/session/ws-protocol.ts`. Kept inline as
 * plain types so the UI has zero build step. Future phases may move to
 * Vite + a generated client to share types properly.
 */

import hljs from 'highlight.js';
import { marked } from 'marked';
import { createSignal } from 'solid-js';
import html from 'solid-js/html';
import { render } from 'solid-js/web';

// ----- Wire types (mirror of src/session/ws-protocol.ts) -----

type WsClientMessage =
  | { type: 'send'; sessionId: string; text: string; projectPath?: string }
  | {
      type: 'permission_response';
      sessionId: string;
      requestId: string;
      approved: boolean;
    }
  | { type: 'attach'; sessionId: string }
  | { type: 'detach'; sessionId: string };

type WsServerMessage =
  | { type: 'text'; sessionId: string; text: string }
  | { type: 'thinking'; sessionId: string; text: string }
  | {
      type: 'tool_use';
      sessionId: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | { type: 'tool_result'; sessionId: string; output: string }
  | {
      type: 'permission_request';
      sessionId: string;
      requestId: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | { type: 'done'; sessionId: string; cost?: number; duration_ms?: number }
  | { type: 'error'; sessionId: string; message: string };

interface PermissionPrompt {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

type UiMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; tool: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; output: string }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string };

const SESSION_ID = 'main';

// ----- Markdown rendering -----
marked.setOptions({
  gfm: true,
  breaks: true,
});
const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  let highlighted = text;
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang }).value;
    } catch {
      /* fall back to raw */
    }
  } else {
    try {
      highlighted = hljs.highlightAuto(text).value;
    } catch {
      /* fall back to raw */
    }
  }
  const langClass = lang ? ` class="language-${escapeAttr(lang)}"` : '';
  return `<pre><code${langClass}>${highlighted}</code></pre>`;
};

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

// ----- App -----

function App() {
  const [messages, setMessages] = createSignal<UiMessage[]>([]);
  const [connected, setConnected] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [sessions, setSessions] = createSignal<Array<{ id: string }>>([]);
  const [pushSubscribed, setPushSubscribed] = createSignal(false);

  let ws: WebSocket | undefined;
  let currentPrompt: PermissionPrompt | null = null;

  function append(m: UiMessage): void {
    setMessages((prev) => [...prev, m]);
    // scroll to bottom on next tick
    queueMicrotask(() => {
      const main = document.querySelector('main');
      if (main) main.scrollTop = main.scrollHeight;
    });
  }

  function send(msg: WsClientMessage): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  function connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      setConnected(true);
      send({ type: 'attach', sessionId: SESSION_ID });
      append({ kind: 'system', text: 'connected' });
      refreshSessions();
    });

    ws.addEventListener('close', () => {
      setConnected(false);
      setBusy(false);
      append({ kind: 'system', text: 'disconnected' });
    });

    ws.addEventListener('error', () => {
      append({ kind: 'error', text: 'websocket error' });
    });

    ws.addEventListener('message', (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        append({ kind: 'error', text: `bad frame: ${ev.data}` });
        return;
      }
      handleServer(msg);
    });
  }

  function handleServer(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'text':
        append({ kind: 'assistant_text', text: msg.text });
        break;
      case 'thinking':
        append({ kind: 'thinking', text: msg.text });
        break;
      case 'tool_use':
        append({ kind: 'tool_use', tool: msg.tool, input: msg.input });
        break;
      case 'tool_result':
        append({ kind: 'tool_result', output: msg.output });
        break;
      case 'permission_request':
        currentPrompt = {
          requestId: msg.requestId,
          tool: msg.tool,
          input: msg.input,
        };
        break;
      case 'done': {
        setBusy(false);
        const meta: string[] = [];
        if (typeof msg.duration_ms === 'number') {
          meta.push(`${(msg.duration_ms / 1000).toFixed(1)}s`);
        }
        if (typeof msg.cost === 'number') {
          meta.push(`$${msg.cost.toFixed(4)}`);
        }
        append({ kind: 'system', text: meta.length ? `done (${meta.join(', ')})` : 'done' });
        break;
      }
      case 'error':
        setBusy(false);
        append({ kind: 'error', text: msg.message });
        break;
    }
  }

  function submit(): void {
    const text = draft().trim();
    if (!text || !connected()) return;
    append({ kind: 'user', text });
    send({ type: 'send', sessionId: SESSION_ID, text });
    setDraft('');
    setBusy(true);
  }

  function decide(approved: boolean): void {
    if (!currentPrompt) return;
    send({
      type: 'permission_response',
      sessionId: SESSION_ID,
      requestId: currentPrompt.requestId,
      approved,
    });
    append({
      kind: 'system',
      text: approved ? `allowed: ${currentPrompt.tool}` : `denied: ${currentPrompt.tool}`,
    });
    currentPrompt = null;
  }

  async function refreshSessions(): Promise<void> {
    try {
      const r = await fetch('/api/sessions');
      if (!r.ok) return;
      const data = (await r.json()) as { sessions: Array<{ id: string }> };
      setSessions(data.sessions);
    } catch {
      // ignore — sidebar just stays stale
    }
  }

  function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!('serviceWorker' in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      });
      return reg;
    } catch (err) {
      console.error('service worker registration failed', err);
      return null;
    }
  }

  async function subscribePush(): Promise<void> {
    if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
      alert('Push notifications are not supported in this browser.');
      return;
    }
    if (Notification.permission === 'denied') {
      alert('Notifications are blocked. Enable them in your browser settings.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;

    const reg = await ensureServiceWorker();
    if (!reg) return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Fetch the VAPID public key from the server.
      let keyRes: Response;
      try {
        keyRes = await fetch('/api/push/vapid-public-key');
      } catch {
        alert('Push is not enabled on this server.');
        return;
      }
      if (!keyRes.ok) {
        alert('Push is not enabled on this server.');
        return;
      }
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    const json = sub.toJSON();
    const endpoint = json.endpoint;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      alert('Subscription missing required keys.');
      return;
    }
    try {
      const r = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, keys: { p256dh, auth }, sessionId: SESSION_ID }),
      });
      if (r.ok) {
        setPushSubscribed(true);
      } else {
        alert('Failed to register subscription with server.');
      }
    } catch (err) {
      console.error('subscribe failed', err);
      alert('Failed to register subscription.');
    }
  }

  function interrupt(): void {
    send({ type: 'send', sessionId: SESSION_ID, text: '/interrupt' });
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function onInput(e: Event): void {
    setDraft((e.currentTarget as HTMLTextAreaElement).value);
  }

  function messageView(m: UiMessage): unknown {
    switch (m.kind) {
      case 'user':
        return html`<div class="msg user text">
          <div class="role">You</div>
          ${m.text}
        </div>`;
      case 'assistant_text':
        return html`<div class="msg text">
          <div class="role">Assistant</div>
          <div class="markdown" innerHTML=${() => renderMarkdown(m.text)}></div>
        </div>`;
      case 'thinking':
        return html`<details class="msg thinking">
          <summary><span class="role">Thinking</span></summary>
          <div class="markdown" innerHTML=${() => renderMarkdown(m.text)}></div>
        </details>`;
      case 'tool_use':
        return html`<details class="msg tool_use">
          <summary><span class="name">${m.tool}</span></summary>
          <pre>${JSON.stringify(m.input, null, 2)}</pre>
        </details>`;
      case 'tool_result':
        return html`<details class="msg tool_result" open>
          <summary><span class="name">result</span></summary>
          <pre>${m.output}</pre>
        </details>`;
      case 'system':
        return html`<div class="msg system">${m.text}</div>`;
      case 'error':
        return html`<div class="msg error">${m.text}</div>`;
    }
  }

  // Connect on first render
  queueMicrotask(connect);

  return html`
    <header>
      <h1>open-rc</h1>
      <div class="header-actions">
        <button
          class="btn-push"
          title=${() => (pushSubscribed() ? 'Notifications enabled' : 'Enable notifications')}
          onClick=${() => void subscribePush()}
        >
          ${() => (pushSubscribed() ? '🔔' : '🔕')}
        </button>
        <div class=${() => `status ${connected() ? 'connected' : 'disconnected'}`}>
          <span class="dot"></span>
          <span>${() => (connected() ? 'connected' : 'disconnected')}</span>
        </div>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <h2>Sessions</h2>
        ${() => {
          const list = sessions();
          if (list.length === 0) {
            return html`<div class="empty">No active sessions</div>`;
          }
          return html`<ul>
            ${list.map(
              (s) => html`<li class=${() => (s.id === SESSION_ID ? 'active' : '')}>${s.id}</li>`,
            )}
          </ul>`;
        }}
      </aside>

      <div class="content">
        <main>
          <div class="messages">
            ${() => {
              const list = messages();
              if (list.length === 0) {
                return html`<div class="empty">Send a message to start.</div>`;
              }
              return list.map(messageView);
            }}
          </div>
        </main>

        <footer>
          <div class="composer">
            <textarea
              value=${draft}
              onInput=${onInput}
              onKeyDown=${onKeyDown}
              placeholder=${() => (connected() ? 'Send a message…' : 'Connecting…')}
              rows="2"
            ></textarea>
            ${() =>
              busy()
                ? html`<button class="interrupt" onClick=${interrupt}>Stop</button>`
                : html`<button
                    onClick=${submit}
                    disabled=${() => !connected() || draft().trim() === ''}
                  >
                    Send
                  </button>`}
          </div>
        </footer>
      </div>
    </div>

    ${() => {
      const p = currentPrompt;
      if (!p) return null;
      return html`
        <div class="modal-backdrop">
          <div class="modal">
            <div class="modal-title">Permission required</div>
            <div class="modal-tool">${p.tool}</div>
            <pre class="modal-input">${JSON.stringify(p.input, null, 2)}</pre>
            <div class="modal-actions">
              <button class="deny" onClick=${() => decide(false)}>Deny</button>
              <button class="allow" onClick=${() => decide(true)}>Allow</button>
            </div>
          </div>
        </div>
      `;
    }}
  `;
}

const root = document.getElementById('app');
if (root) {
  render(App, root);
}

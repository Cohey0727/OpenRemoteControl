import { store } from './store';

/**
 * PWA plumbing: service-worker registration + aggressive background
 * update, install-prompt capture, the iOS install hint, and the composer
 * draft parked across the self-reload that applies a SW update. Plus the
 * VisualViewport → --app-vh mirror that keeps the bottom composer on
 * screen through iOS toolbar/keyboard states.
 */

const IOS_HINT_LS_KEY = 'open-rc.ios-hint-dismissed';
const DRAFT_RESTORE_SS_KEY = 'open-rc.draft-restore';
const SW_UPDATE_INTERVAL_MS = 5 * 60_000;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** Trigger the browser's own install dialog from our captured event. */
export function triggerInstallPrompt(): void {
  const ev = store.getState().installEvent as BeforeInstallPromptEvent | null;
  if (!ev) return;
  // Single-use: clear first so a second click can't re-prompt.
  store.setInstallEvent(null);
  void (async () => {
    try {
      await ev.prompt();
      await ev.userChoice;
    } catch {
      // Browser refused — the next beforeinstallprompt re-shows the button.
    }
  })();
}

export function dismissIosHint(): void {
  store.setIosHintVisible(false);
  try {
    localStorage.setItem(IOS_HINT_LS_KEY, '1');
  } catch {
    // localStorage disabled (private mode) — hint just reappears next launch.
  }
}

/** iOS Safari won't fire beforeinstallprompt; detect it to show the hint. */
function isIosWebkit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  return isIos && /WebKit/.test(ua);
}

function restoreParkedDraft(): void {
  try {
    const parked = sessionStorage.getItem(DRAFT_RESTORE_SS_KEY);
    if (parked !== null) {
      sessionStorage.removeItem(DRAFT_RESTORE_SS_KEY);
      if (parked !== '') store.setDraft(parked);
    }
  } catch {
    // sessionStorage blocked — nothing was parked either.
  }
}

/** Mirror the visible viewport height into --app-vh (see styles.css). */
export function initViewportHeight(): void {
  if (typeof window === 'undefined' || !window.visualViewport) return;
  const vv = window.visualViewport;
  const sync = (): void => {
    document.documentElement.style.setProperty('--app-vh', `${vv.height}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  window.addEventListener('orientationchange', sync);
  sync();
}

export function initPwa(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    initInstallHints();
    return;
  }
  restoreParkedDraft();
  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      const nudge = (worker: ServiceWorker | null): void => {
        try {
          worker?.postMessage({ type: 'skipWaiting' });
        } catch {}
      };
      nudge(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        next?.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) nudge(next);
        });
      });
      const check = (): void => {
        reg.update().catch(() => {});
      };
      setInterval(check, SW_UPDATE_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('online', check);
    })
    .catch(() => {
      // SW registration failed — the SPA still works as a plain page.
    });

  // Apply SW activations by reloading into the new shell. Park the typed
  // draft first so the background update is invisible beyond the reload.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    try {
      const pending = store.getState().draft;
      if (pending !== '') sessionStorage.setItem(DRAFT_RESTORE_SS_KEY, pending);
    } catch {
      // best-effort
    }
    location.reload();
  });

  // The SW may ask the page to navigate (notification click).
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const data = ev.data as { type?: string; url?: string } | null;
    if (data?.type === 'navigate' && typeof data.url === 'string') {
      try {
        history.pushState({}, '', data.url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch {}
    }
  });

  initInstallHints();
}

function initInstallHints(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    store.setInstallEvent(event);
  });
  window.addEventListener('appinstalled', () => {
    store.setInstallEvent(null);
  });
  if (isIosWebkit() && !window.matchMedia('(display-mode: standalone)').matches) {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(IOS_HINT_LS_KEY) === '1';
    } catch {}
    if (!dismissed) store.setIosHintVisible(true);
  }
}

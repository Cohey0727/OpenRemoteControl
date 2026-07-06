import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initPwa, initViewportHeight } from './pwa';
import { store } from './store';
import './styles.css';

/**
 * Seed a `/` history entry beneath a deep-linked /sessions/:id so the back
 * button — in-app or the browser's — returns to the sidebar instead of
 * exiting the app. Runs once, before React (and wouter) read the location.
 */
function seedDeepLinkHistory(): void {
  const m = location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (!m) return;
  const deep = location.pathname;
  history.replaceState({}, '', '/');
  history.pushState({}, '', deep);
}

seedDeepLinkHistory();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Kick the WS connection and PWA after the first paint is scheduled.
store.connect();
initViewportHeight();
initPwa();

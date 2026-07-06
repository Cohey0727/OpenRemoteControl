import { useEffect } from 'react';
import { useLocation, useRoute } from 'wouter';
import { ChatPane } from './components/ChatPane';
import { IosHint } from './components/IosHint';
import { PermissionModal } from './components/PermissionModal';
import { Sidebar } from './components/Sidebar';
import { triggerInstallPrompt } from './pwa';
import { store, useStore } from './store';

/**
 * Root component. wouter owns the URL: `/` is the sidebar/home view,
 * `/sessions/:id` is a session. The active session id is derived from the
 * route — never a separate signal — so the URL, the store's attachment,
 * and the visible mobile pane can never diverge (the class of router bug
 * the vanilla build kept hitting).
 */
export function App() {
  const [, navigate] = useLocation();
  const [match, params] = useRoute('/sessions/:id');
  const routeId = match && params?.id ? decodeURIComponent(params.id) : null;

  const clients = useStore((s) => s.clients);
  const orphanSignal = useStore((s) => s.orphanSignal);
  const client = routeId ? (clients.find((c) => c.clientId === routeId) ?? null) : null;

  // URL → store: reconcile the server-side attachment with the route.
  useEffect(() => {
    store.setRoute(routeId);
  }, [routeId]);

  // The attached session vanished → return to the list.
  useEffect(() => {
    if (orphanSignal > 0) navigate('/', { replace: true });
  }, [orphanSignal, navigate]);

  // Mobile: the visible pane is derived from the route. The rules only
  // bite inside the max-width media query, so setting them on desktop is
  // inert — no separate `mobile` state needed.
  useEffect(() => {
    document.body.classList.toggle('app-mobile-chat', routeId != null);
    document.body.classList.toggle('app-mobile-sidebar', routeId == null);
  }, [routeId]);

  const onSelect = (id: string): void => {
    navigate(`/sessions/${encodeURIComponent(id)}`);
  };
  // Mobile in-app back mirrors the browser back button exactly (a `/`
  // entry is seeded beneath a deep-linked session in main.tsx, so there is
  // always somewhere to return to). The popstate clears the selection.
  const onBack = (): void => {
    if (routeId) history.back();
  };

  return (
    <div id="app" className="app">
      <Sidebar activeId={routeId} onSelect={onSelect} onInstall={triggerInstallPrompt} />
      <ChatPane routeId={routeId} client={client} hasClients={clients.length > 0} onBack={onBack} />
      {client ? <PermissionModal client={client} /> : null}
      <IosHint />
    </div>
  );
}

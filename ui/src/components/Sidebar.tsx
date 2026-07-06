import { useStore } from '../store';
import type { ClientInfo } from '../wire';
import { ClientRow } from './ClientRow';

interface Props {
  activeId: string | null;
  onSelect: (clientId: string) => void;
  onInstall: () => void;
}

/** Stable arrival order: rows must never reshuffle on click or activity.
 *  clientId tiebreak keeps equal timestamps stable. */
function ordered(clients: ClientInfo[]): ClientInfo[] {
  return [...clients].sort(
    (a, b) => a.connectedAt - b.connectedAt || a.clientId.localeCompare(b.clientId),
  );
}

export function Sidebar({ activeId, onSelect, onInstall }: Props) {
  const clients = useStore((s) => s.clients);
  const connected = useStore((s) => s.connected);
  const installEvent = useStore((s) => s.installEvent);
  const list = ordered(clients);

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <div className="wordmark">Open Remote Control</div>
        {installEvent ? (
          <button
            type="button"
            className="install-btn"
            title="Install ORC"
            aria-label="Install ORC"
            onClick={onInstall}
          >
            Install
          </button>
        ) : null}
        <span className={`conn ${connected ? 'online' : 'offline'}`}>
          <span className="dot" />
          <span className="conn-label">{connected ? 'online' : 'offline'}</span>
        </span>
      </header>
      <div className="client-list">
        {list.length === 0 ? (
          <div className="client-empty">No sessions.</div>
        ) : (
          list.map((c) => (
            <ClientRow
              key={c.clientId}
              client={c}
              active={activeId === c.clientId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </aside>
  );
}

import { basename, formatModel, formatRelative } from '../format';
import { useStore } from '../store';
import type { ClientInfo } from '../wire';

interface Props {
  client: ClientInfo;
  active: boolean;
  onSelect: (clientId: string) => void;
}

export function ClientRow({ client, active, onSelect }: Props) {
  // Re-render on the 15 s tick so the relative timestamp advances.
  useStore((s) => s.tick);
  return (
    <button
      type="button"
      className={`client-row${active ? ' active' : ''}`}
      onClick={() => onSelect(client.clientId)}
      aria-pressed={active ? 'true' : 'false'}
      title={client.cwd}
    >
      <span className={`client-status ${client.status}`} />
      <span className="client-meta">
        <span className="client-label">{client.label}</span>
        <span className="client-sub">
          <span className="status-label">{client.status}</span>
          {client.model ? (
            <>
              <span className="sep">·</span>
              <span className="client-model" title={client.model}>
                {formatModel(client.model)}
              </span>
            </>
          ) : null}
          <span className="sep">·</span>
          <span className="client-cwd">{basename(client.cwd)}</span>
          <span className="sep">·</span>
          <span className="client-time">{formatRelative(client.lastActivity)}</span>
        </span>
      </span>
    </button>
  );
}

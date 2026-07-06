import { store, useStore } from '../store';
import type { ClientInfo } from '../wire';

/** Permission dialog shown when the active session has an open
 *  `permission_request`. First answer — terminal or browser — wins. */
export function PermissionModal({ client }: { client: ClientInfo }) {
  const prompt = useStore((s) => s.promptsByClient[client.clientId]);
  if (!prompt) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-eyebrow">Permission required</div>
        <h3>Run {prompt.tool}?</h3>
        <p className="lede">This runs on {client.label}. Review the input before you allow it.</p>
        <pre className="target">{JSON.stringify(prompt.input, null, 2)}</pre>
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => store.decide(client.clientId, false)}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => store.decide(client.clientId, true)}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

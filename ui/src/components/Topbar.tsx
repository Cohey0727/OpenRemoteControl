import { useEffect, useRef, useState } from 'react';
import { store } from '../store';
import type { ClientInfo } from '../wire';

interface Props {
  client: ClientInfo;
  onBack: () => void;
}

/**
 * Chat header: back button (mobile, shown via CSS), the session label with
 * inline rename, cwd, and the status pill. Rename commits on Enter or blur,
 * cancels on Esc; an empty value clears the alias back to the bridge name.
 */
export function Topbar({ client, onBack }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const start = (): void => {
    setValue(client.label);
    setRenaming(true);
  };
  const commit = (): void => {
    store.rename(client.clientId, value.trim());
    setRenaming(false);
  };

  return (
    <header className="chat-topbar">
      <button type="button" className="btn-back" onClick={onBack} aria-label="Back to sidebar">
        ‹
      </button>
      <div className="chat-cwd" title={client.cwd}>
        {renaming ? (
          <input
            ref={inputRef}
            className="rename-input"
            type="text"
            maxLength={80}
            aria-label="Session name"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              // The Enter/Escape that confirms or cancels an IME
              // composition (kanji conversion etc.) belongs to the IME,
              // not to us — same guard as the composer. keyCode 229 is
              // the legacy signal some browsers (notably Safari) report.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenaming(false);
              }
            }}
          />
        ) : (
          <>
            <span className="label">{client.label}</span>
            <button
              type="button"
              className="btn-rename"
              title="Rename this session"
              aria-label="Rename this session"
              onClick={start}
            >
              ✎
            </button>
          </>
        )}
        <span className="sep">·</span>
        <span className="cwd-text">{client.cwd}</span>
      </div>
      <span className={`chat-status ${client.status}`}>{client.status}</span>
    </header>
  );
}

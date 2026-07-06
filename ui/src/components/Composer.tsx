import { useEffect, useRef } from 'react';
import { store, useStore } from '../store';

/** Message composer pinned to the bottom of the chat pane. */
export function Composer({ clientId }: { clientId: string }) {
  const draft = useStore((s) => s.draft);
  const connected = useStore((s) => s.connected);
  const busy = useStore((s) => !!s.busy[clientId]);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow with content up to the CSS max-height, then scroll
  // internally. Runs on every draft change, so sending (draft → '')
  // snaps back to one line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize keyed on draft value
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }, [draft]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // The Enter that confirms an IME composition (kanji conversion etc.)
    // must not send. `isComposing` covers modern engines; keyCode 229 is
    // the legacy signal some browsers (notably Safari) report.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.currentTarget.disabled) {
      e.preventDefault();
      store.submit(clientId);
    }
  };

  const canSend = connected && draft.trim() !== '';

  return (
    <footer className="composer">
      <div className="composer-inner">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={connected ? 'Send a message…' : 'Connecting…'}
          value={draft}
          onChange={(e) => store.setDraft(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="send"
          disabled={!canSend}
          onClick={() => store.submit(clientId)}
        >
          {busy ? 'Send (busy)' : 'Send'}
        </button>
      </div>
    </footer>
  );
}

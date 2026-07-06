import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { Markdown } from './Markdown';
import { MessageView } from './MessageView';

/**
 * The scrollable transcript plus the live region (streaming partial reply
 * or a typing indicator). Messages are append-only per client and keyed by
 * index, so React preserves each card's DOM — and the native
 * expand/collapse state of `<details>` — as new frames arrive.
 */
export function Transcript({ clientId }: { clientId: string }) {
  const messages = useStore((s) => s.messagesByClient[clientId] ?? EMPTY);
  const stream = useStore((s) => s.streamByClient[clientId] ?? '');
  const busy = useStore((s) => !!s.busy[clientId]);
  const connected = useStore((s) => s.connected);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep pinned to the bottom as content grows (new messages or stream).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll on content change, not on ref
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, stream, busy]);

  const showLive = stream.length > 0 || busy;

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat">
        {messages.length === 0 ? (
          <div className="msg system">
            <div className="body">{connected ? 'send a message to begin' : 'connecting…'}</div>
          </div>
        ) : (
          messages.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only, never reordered
            <MessageView key={i} clientId={clientId} message={m} />
          ))
        )}
      </div>
      <div className="chat chat-live">
        {showLive ? (
          stream.length > 0 ? (
            <div className="msg text streaming">
              <div className="role">Assistant</div>
              <Markdown text={stream} />
            </div>
          ) : (
            <div className="msg typing">
              <div className="role">Assistant</div>
              <div className="typing-dots">
                <span />
                <span />
                <span />
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

const EMPTY: never[] = [];

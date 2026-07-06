/** Shown when nothing is connected — an invitation to point a bridge at
 *  the relay, carrying the how-to in the interface's voice. */
export function Onboarding() {
  return (
    <div className="empty-state">
      <div className="empty-badge">
        <span className="dot" />
        waiting for a session
      </div>
      <h2>Nothing connected yet</h2>
      <p>
        Point a bridge at this relay — pipe a running claude’s stream-json to the /agent WebSocket —
        and the session appears in the sidebar, ready to drive.
      </p>
      <div className="empty-cmds">
        <div className="empty-cmd">
          <code>/ws</code>browsers connect here
        </div>
        <div className="empty-cmd">
          <code>/agent</code>your bridge connects here
        </div>
      </div>
    </div>
  );
}

/** Shown when sessions exist but none is active (desktop, or a cleared
 *  selection). */
export function SelectPrompt() {
  return (
    <div className="empty-state">
      <h2>Select a session</h2>
      <p>Pick a session from the sidebar to watch its stream.</p>
    </div>
  );
}

/** Shown while a deep-linked /sessions/:id has not appeared in the list. */
export function Connecting() {
  return (
    <div className="empty-state">
      <h2>Connecting…</h2>
      <p>Waiting for this session to appear.</p>
    </div>
  );
}

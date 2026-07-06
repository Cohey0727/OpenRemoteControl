import { dismissIosHint } from '../pwa';
import { useStore } from '../store';

/** One-time iOS-Safari install hint (no beforeinstallprompt there). */
export function IosHint() {
  const visible = useStore((s) => s.iosHintVisible);
  if (!visible) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a dismissible toast, not an <output> for a form
    <div className="ios-hint" role="status">
      <div className="ios-hint-text">
        To install: tap <span className="ios-share">Share</span>, then "Add to Home Screen".
      </div>
      <button
        type="button"
        className="ios-hint-close"
        aria-label="Dismiss"
        onClick={dismissIosHint}
      >
        ×
      </button>
    </div>
  );
}

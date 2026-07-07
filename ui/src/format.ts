/** Formatting helpers shared across components. */

/** Wall-clock HH:MM:SS for turn-complete dividers. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return 'now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function basename(p: string): string {
  const m = p.split('/').filter(Boolean);
  return m[m.length - 1] ?? p;
}

/** Compact model name for the sidebar: strip the `claude-` prefix and
 *  a trailing release date (`claude-haiku-4-5-20251001` → `haiku-4-5`).
 *  Unknown shapes pass through untouched. */
export function formatModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
}

export function formatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/**
 * Shell revision — a fingerprint of the UI directory that the server
 * appends to `/sw.js` as a trailing comment.
 *
 * Why: the browser only treats a service worker as "updated" when the
 * fetched sw.js bytes differ from the registered one. Without this
 * stamp, editing app.ts (or any other shell asset) ships a new shell
 * to online users but never triggers the SW update → skipWaiting →
 * reload pipeline that long-lived installed PWAs rely on. With it,
 * ANY change under ui/ (a `git pull` on the host is enough) changes
 * the served sw.js bytes, so the SPA's background update checks pick
 * the new shell up without a manual CACHE_VERSION bump.
 *
 * The fingerprint hashes file paths + mtime + size (not contents):
 * cheap enough to run per request, and a spurious mtime-only bump
 * merely costs one silent SW reinstall. It must be deterministic
 * between requests while the directory is unchanged — otherwise every
 * update check would look like a new deploy and reload-loop the page.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Fingerprint the UI directory. Returns `'unknown'` (a valid, fixed
 *  stamp) if the directory can't be read — serving the SW unstamped
 *  beats failing the request. */
export function computeShellRev(uiDir: string): string {
  try {
    const entries = readdirSync(uiDir, { recursive: true, encoding: 'utf8' });
    const lines = entries
      .map((rel) => {
        try {
          const st = statSync(join(uiDir, rel));
          if (!st.isFile()) return null;
          return `${rel}\n${st.mtimeMs}\n${st.size}`;
        } catch {
          return null; // raced deletion — skip, the next check re-stamps
        }
      })
      .filter((line): line is string => line !== null)
      .sort();
    return Bun.hash(lines.join('\n')).toString(16);
  } catch {
    return 'unknown';
  }
}

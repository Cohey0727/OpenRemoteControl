import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The SPA is a Vite build (`ui/dist`); the server-serving tests point
 * `uiDir` there. Build it once per test process if it isn't present, so
 * `bun test` works standalone without a separate build step. Structural
 * assertions (manifest link, SW handlers, hashed bundle) don't depend on
 * a fresh build, so an existing dist is reused as-is.
 */
let built = false;

export async function ensureUiDist(): Promise<string> {
  const root = join(import.meta.dir, '..', '..');
  const dist = join(root, 'ui', 'dist');
  if (!built && !existsSync(join(dist, 'index.html'))) {
    const proc = await Bun.$`bun run build:ui`.cwd(root).nothrow();
    if (proc.exitCode !== 0) throw new Error('vite build failed while preparing tests');
  }
  built = true;
  return dist;
}

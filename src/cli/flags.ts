/**
 * One shared CLI flag parser for every `open-rc` command.
 *
 * Accepts all three conventional spellings and normalizes kebab-case
 * keys to camelCase so callers read `flags.pushDisabled`, not
 * `flags['push-disabled']`:
 *
 *   --port 7322        → { port: '7322' }
 *   --port=7322        → { port: '7322' }   (the `=` form documented in
 *                        README / SECURITY for `--autoApprove=false`)
 *   --push-disabled    → { pushDisabled: true }
 *   --client-id work   → { clientId: 'work' }
 *
 * A value that itself starts with `--` is only consumed via the `=`
 * form; `--label --x` leaves `label` a bare boolean (use `--label=--x`).
 */
export function parseFlags(tokens: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok || !tok.startsWith('--')) continue;
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[kebabToCamel(body.slice(0, eq))] = body.slice(eq + 1);
      continue;
    }
    const key = kebabToCamel(body);
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

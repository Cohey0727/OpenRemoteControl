/**
 * Basic-auth support for orc's WebSocket CLIENTS. Needed only by
 * `orc tui` (a `/ws` viewer) when the relay runs with ORC_USER /
 * ORC_PASSWORD set — `/agent` is deliberately ungated, so `orc
 * attach` works without credentials. Browsers authenticate through
 * the /login cookie; `tui` carries the same credentials as an
 * `Authorization: Basic …` header, sourced from
 * `ORC_AUTH=user:password` (bake it into the launcher via
 * `make setup ORC_AUTH=…`, or export it in the shell).
 * Unset, the handshake is exactly what it always was.
 */

export function orcAuthHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> | null {
  const raw = env.ORC_AUTH;
  if (!raw || !raw.includes(':')) return null;
  return { Authorization: `Basic ${Buffer.from(raw).toString('base64')}` };
}

/** `new WebSocket(url)`, plus the ORC_AUTH header when configured.
 *  (The `headers` option is a Bun extension to the WebSocket ctor.) */
export function openWebSocket(url: string): WebSocket {
  const headers = orcAuthHeaders();
  if (!headers) return new WebSocket(url);
  return new WebSocket(url, { headers } as unknown as string[]);
}

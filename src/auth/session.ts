/**
 * Optional single-user authentication for `orc serve`.
 *
 * Enabled by setting BOTH `ORC_USER` and `ORC_PASSWORD` (prefixed —
 * a bare `USER` is always present in every shell and would arm auth
 * by accident). Unset, the relay behaves exactly as before: open on
 * loopback, protect it yourself elsewhere.
 *
 * Model: one credential pair, one stateless session token.
 *
 *   token = HMAC-SHA256( key = SHA-256(user ":" password ":" salt),
 *                        msg = "orc-session-v1" )
 *
 * The token is deterministic for a given credential pair, carried in
 * an HttpOnly cookie with a 10-year Max-Age ("infinite session" by
 * request — 2026-07-04). No server-side session store: restarts and
 * redeploys keep everyone logged in, and changing the password
 * invalidates every existing cookie at once. Bridges and `tui`
 * authenticate the same credentials via `Authorization: Basic …`
 * (env `ORC_AUTH=user:password` on the client side).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthConfig {
  readonly user: string;
  readonly password: string;
}

export const SESSION_COOKIE = 'orc_session';
/** "Infinite" session: 10 years. */
const COOKIE_MAX_AGE_S = 315_360_000;

/** Auth settings from the environment; null = auth disabled. */
export function authConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AuthConfig | null {
  const user = env.ORC_USER;
  const password = env.ORC_PASSWORD;
  if (!user || !password) return null;
  return { user, password };
}

function sessionToken(cfg: AuthConfig): string {
  const key = createHash('sha256').update(`${cfg.user}:${cfg.password}:orc-auth-v1`).digest();
  return createHmac('sha256', key).update('orc-session-v1').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Check a submitted login. */
export function credentialsValid(cfg: AuthConfig, user: string, password: string): boolean {
  // Compare both fields unconditionally so timing doesn't reveal
  // which one was wrong.
  const userOk = safeEqual(user, cfg.user);
  const passOk = safeEqual(password, cfg.password);
  return userOk && passOk;
}

/** `Set-Cookie` value for a fresh login. */
export function sessionCookie(cfg: AuthConfig): string {
  return `${SESSION_COOKIE}=${sessionToken(cfg)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
}

/** Does the request carry a valid session cookie? */
export function cookieValid(req: Request, cfg: AuthConfig): boolean {
  const header = req.headers.get('cookie');
  if (!header) return false;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      return safeEqual(rest.join('='), sessionToken(cfg));
    }
  }
  return false;
}

/** Does the request carry valid `Authorization: Basic …` credentials
 *  (bridges / tui, which have no cookie jar)? */
export function basicValid(req: Request, cfg: AuthConfig): boolean {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  return credentialsValid(cfg, decoded.slice(0, idx), decoded.slice(idx + 1));
}

/** Any accepted proof: browser cookie or client Basic header. */
export function requestAuthed(req: Request, cfg: AuthConfig): boolean {
  return cookieValid(req, cfg) || basicValid(req, cfg);
}

/** Only same-origin path redirects after login — never off-site. */
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

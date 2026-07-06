/**
 * Login gate: enabled only when credentials are configured; browsers
 * go through /login and get an everlasting cookie; WebSockets accept
 * the cookie (browser) or Basic auth (bridge/tui); everything is
 * exactly as open as before when auth is off.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  authConfigFromEnv,
  basicValid,
  cookieValid,
  credentialsValid,
  safeNextPath,
  sessionCookie,
} from '../src/auth/session.ts';
import { serve } from '../src/serve.ts';
import { ensureUiDist } from './helpers/build-ui.ts';

const PORT = 7488;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { user: 'kohei', password: 'correct horse battery staple' };

let handle: { stop: () => Promise<void> } | undefined;

beforeAll(async () => {
  const uiDir = await ensureUiDist();
  handle = await serve({
    host: '127.0.0.1',
    port: PORT,
    uiDir,
    pushDisabled: true,
    auth: AUTH,
  });
});

afterAll(async () => {
  if (handle) await handle.stop();
});

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('session primitives', () => {
  test('authConfigFromEnv arms only when both vars are set', () => {
    expect(authConfigFromEnv({})).toBeNull();
    expect(authConfigFromEnv({ ORC_USER: 'a' })).toBeNull();
    expect(authConfigFromEnv({ ORC_PASSWORD: 'b' })).toBeNull();
    expect(authConfigFromEnv({ ORC_USER: 'a', ORC_PASSWORD: 'b' })).toEqual({
      user: 'a',
      password: 'b',
    });
  });

  test('credential and cookie verification', () => {
    expect(credentialsValid(AUTH, AUTH.user, AUTH.password)).toBe(true);
    expect(credentialsValid(AUTH, AUTH.user, 'nope')).toBe(false);

    const cookie = sessionCookie(AUTH);
    const req = new Request('http://x/', { headers: { cookie: cookie.split(';')[0] ?? '' } });
    expect(cookieValid(req, AUTH)).toBe(true);
    const bad = new Request('http://x/', { headers: { cookie: 'orc_session=forged' } });
    expect(cookieValid(bad, AUTH)).toBe(false);

    const breq = new Request('http://x/', {
      headers: { authorization: basic(AUTH.user, AUTH.password) },
    });
    expect(basicValid(breq, AUTH)).toBe(true);
  });

  test('safeNextPath never leaves the origin', () => {
    expect(safeNextPath('/sessions/abc')).toBe('/sessions/abc');
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('https://evil.com')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
  });
});

describe('gated serve', () => {
  test('pages redirect to /login; health and PWA identity stay open', async () => {
    const root = await fetch(`${BASE}/`, { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toContain('/login');

    expect((await fetch(`${BASE}/health`)).status).toBe(200);
    expect((await fetch(`${BASE}/manifest.webmanifest`)).status).toBe(200);
    expect((await fetch(`${BASE}/login`)).status).toBe(200);
    expect((await fetch(`${BASE}/app.ts`, { redirect: 'manual' })).status).toBe(302);
  });

  test('login: wrong creds 401, right creds set the everlasting cookie', async () => {
    const bad = await fetch(`${BASE}/login`, {
      method: 'POST',
      body: new URLSearchParams({ user: 'kohei', password: 'wrong', next: '/' }),
    });
    expect(bad.status).toBe(401);

    const good = await fetch(`${BASE}/login`, {
      method: 'POST',
      body: new URLSearchParams({ user: AUTH.user, password: AUTH.password, next: '/sessions/x' }),
      redirect: 'manual',
    });
    expect(good.status).toBe(303);
    expect(good.headers.get('location')).toBe('/sessions/x');
    const setCookie = good.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('orc_session=');
    expect(setCookie).toContain('Max-Age=315360000');

    const cookie = setCookie.split(';')[0] ?? '';
    const authed = await fetch(`${BASE}/`, { headers: { cookie } });
    expect(authed.status).toBe(200);
    expect(await authed.text()).toContain('<!doctype html>');
  });

  test('websockets: /ws gated (cookie or basic), /agent open for bridges', async () => {
    const tryWs = (url: string, headers?: Record<string, string>) =>
      new Promise<boolean>((resolve) => {
        const ws = headers
          ? new WebSocket(url, { headers } as unknown as string[])
          : new WebSocket(url);
        const timer = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 3_000);
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          ws.close();
          resolve(true);
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
      });

    expect(await tryWs(`ws://127.0.0.1:${PORT}/ws`)).toBe(false);

    const cookie = sessionCookie(AUTH).split(';')[0] ?? '';
    expect(await tryWs(`ws://127.0.0.1:${PORT}/ws`, { cookie })).toBe(true);
    // Basic credentials also work on /ws (that is how `tui` signs in).
    expect(
      await tryWs(`ws://127.0.0.1:${PORT}/ws`, {
        authorization: basic(AUTH.user, AUTH.password),
      }),
    ).toBe(true);
    // /agent (bridge registration) is deliberately ungated even with
    // auth armed — bridges connect with zero ceremony.
    expect(await tryWs(`ws://127.0.0.1:${PORT}/agent`)).toBe(true);
  });
});

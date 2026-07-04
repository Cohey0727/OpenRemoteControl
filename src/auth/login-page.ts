/**
 * The `/login` page — a single self-contained HTML document in the
 * relay's visual language (dark, hairlines, amber = your control
 * point). No SPA involvement: plain form POST, so it works before any
 * script loads and never depends on the service worker.
 */

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function loginPage(input: { next: string; error?: string }): string {
  const next = escapeHtml(input.next);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>Open Remote Control — sign in</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<style>
  :root {
    --bg: #0e0f12; --surface: #16181d; --hairline: #232730;
    --hairline-strong: #313641; --fg: #e8e9ec; --fg-subtle: #5d6068;
    --accent: #f97316; --error: #ef4444;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: grid; place-items: center;
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  form {
    width: min(320px, calc(100vw - 2rem));
    background: var(--surface); border: 1px solid var(--hairline);
    border-radius: 6px; padding: 1.6rem 1.4rem 1.4rem;
  }
  h1 {
    margin: 0 0 0.2rem; font-size: 0.95rem; letter-spacing: -0.01em;
  }
  .sub {
    margin: 0 0 1.1rem; color: var(--fg-subtle);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.68rem;
  }
  label {
    display: block; margin: 0.7rem 0 0.25rem; color: var(--fg-subtle);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.1em;
  }
  input {
    width: 100%; padding: 0.5rem 0.6rem; border-radius: 4px;
    border: 1px solid var(--hairline-strong); background: var(--bg);
    color: var(--fg); font: inherit; outline: none;
  }
  input:focus { border-color: var(--accent); }
  button {
    margin-top: 1.1rem; width: 100%; padding: 0.55rem;
    background: var(--accent); border: none; border-radius: 4px;
    color: #0e0f12; font: inherit; font-weight: 600; cursor: pointer;
  }
  .err {
    margin: 0.9rem 0 0; color: var(--error); font-size: 0.8rem;
  }
</style>
</head>
<body>
<form method="POST" action="/login">
  <h1>Open Remote Control</h1>
  <p class="sub">sign in to drive shared sessions</p>
  <input type="hidden" name="next" value="${next}" />
  <label for="user">user</label>
  <input id="user" name="user" autocomplete="username" autofocus required />
  <label for="password">password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required />
  ${input.error ? `<p class="err">${escapeHtml(input.error)}</p>` : ''}
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

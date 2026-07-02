---
description: Spawn a claude session in THIS project and bridge it to open-rc serve, in the background
argument-hint: [flags...]
allowed-tools: Bash(attach-orc:*)
---

Start the open-rc bridge for THIS project WITHOUT taking over this session. Run this command in the BACKGROUND — use the Bash tool's background mode and do NOT wait for it to finish:

    attach-orc $ARGUMENTS

`attach-orc` (installed on your PATH by `make setup`) spawns a local `claude` in the current working directory — the project this session is open in — and bridges it to the running `open-rc serve`, so it appears in the browser and is driven from there. It is a long-lived bridge: run in the foreground it would block this session until the spawned claude exits, which is why it must go to the background — that keeps your original session free to keep working.

`--cwd` defaults to the directory you invoke it from, so no `--cwd` flag is needed. Point it at a remote serve by exporting `ORC_BASE_URL` first (e.g. `ORC_BASE_URL=https://serve.example:7322`).

After launching, tell the user, in one or two lines:
- the bridge is running in the background and this session stays interactive,
- drive that claude from the browser,
- stop it by ending the background task (or `pkill -f 'cli.ts attach-orc'`).

If it exits within ~10 seconds, it couldn't register with `open-rc serve` (the bridge fails fast when the first registration times out) — surface the background task's output so the user can see why (commonly: `serve` isn't running, `ORC_BASE_URL` points nowhere, or the clientId is already in use).

> Requires `attach-orc` on PATH (default `~/.local/bin`, added by `make setup`). If you get "command not found: attach-orc", re-run `make setup` in the open-rc repo and follow its PATH hint, then restart this session.

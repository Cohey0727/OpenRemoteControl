---
description: Share THIS already-running Claude Code session with open-rc (browser + tui), without spawning anything
argument-hint: [--server ws://host:7322/agent] [--label name]
allowed-tools: Bash(open-rc:*)
---

Share the CURRENT session — this very conversation — with a running `open-rc serve`, so it appears in the browser sidebar and can be read and driven from the browser and `open-rc tui` as well as from this terminal.

Run the bridge in the BACKGROUND — use the Bash tool's background mode and do NOT wait for it to finish:

    open-rc attach-orc $ARGUMENTS

The bridge does not spawn or control any process. It finds this session's own transcript (the JSONL Claude Code is writing for this conversation), replays it to the server as history, then tails it live; messages typed here appear in the browser, and messages sent from the browser are queued and delivered into this session by the open-rc Stop/UserPromptSubmit hooks at turn boundaries. `--cwd` defaults to the directory this session runs in, so no flag is needed. Point it at a remote serve by exporting `ORC_BASE_URL` (e.g. `ORC_BASE_URL=https://serve.example:7322`) or passing `--server`.

After launching, wait ~2 seconds, check the background task's output, and tell the user, in a few short lines:

- the session URL the bridge printed (`open http://…/sessions/<id>`) — that link opens THIS conversation in the browser,
- messages from the browser arrive at turn ends: as soon as a viewer attaches, the session listens with NO time limit (remote mode), so even the first browser message never misses a window; typing here returns the terminal to normal 45 s windows (`ORC_STOP_LINGER_MS`), and Esc instantly reclaims the prompt from a listening hook; multiple-choice questions (AskUserQuestion) render as buttons in the browser and are answered from there,
- stop sharing by ending the background task; the session itself is never touched.

If the bridge exits within ~10 seconds, it could not register with `open-rc serve` (it fails fast when the first registration times out) — surface its output so the user sees why (commonly: `serve` isn't running, `ORC_BASE_URL` points nowhere, or another bridge already shares this session).

> Requires `open-rc` on PATH and the open-rc hooks in `~/.claude/settings.json` — both installed by `make setup` in the open-rc repo. If `open-rc` is missing or browser→CLI delivery doesn't work, re-run `make setup` and restart this session.

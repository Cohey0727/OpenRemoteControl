---
description: Share THIS already-running Claude Code session with open-rc (browser + tui), without spawning anything
argument-hint: [--server ws://host:7322/agent] [--label name]
allowed-tools: Bash(open-rc:*)
---

Share the CURRENT session — this very conversation — with a running `orc serve`, so it appears in the browser sidebar and can be read and driven from the browser and `orc tui` as well as from this terminal.

Run the bridge in the BACKGROUND — use the Bash tool's background mode and do NOT wait for it to finish:

    orc attach $ARGUMENTS

The bridge does not spawn or control any process. It finds this session's own transcript (the JSONL Claude Code is writing for this conversation), replays it to the server as history, then tails it live; messages typed here appear in the browser, and messages sent from the browser are queued and delivered into this session by the open-rc Stop/UserPromptSubmit hooks at turn boundaries. `--cwd` defaults to the directory this session runs in, so no flag is needed. Point it at a remote serve by exporting `ORC_BASE_URL` (e.g. `ORC_BASE_URL=https://serve.example:7322`) or passing `--server`.

After launching, wait ~2 seconds, check the background task's output, and tell the user, in a few short lines:

- the session URL the bridge printed (`open http://…/sessions/<id>`) — that link opens THIS conversation in the browser,
- messages from the browser arrive at turn ends: after each turn the session listens for 45 s (`ORC_STOP_LINGER_MS`), and a viewer opening the page re-arms that window; once a browser message is actually delivered the session switches to remote mode and listens with NO time limit until someone types here again (typing restores the normal windows, Esc instantly reclaims the prompt from a listening hook); a message sent while no window is open is queued, the sender sees a notice, and it is delivered on the session's next activity; multiple-choice questions (AskUserQuestion) render as buttons in the browser and are answered from there,
- stop sharing by ending the background task; the session itself is never touched.

If the bridge exits within ~10 seconds, it could not register with `orc serve` (it fails fast when the first registration times out) — surface its output so the user sees why (commonly: `serve` isn't running, `ORC_BASE_URL` points nowhere, or another bridge already shares this session).

> Requires `orc` on PATH and the open-rc hooks in `~/.claude/settings.json` — both installed by `make setup` in the open-rc repo. If `orc` is missing or browser→CLI delivery doesn't work, re-run `make setup` and restart this session.

> Alternative — instant delivery via Channels (research preview): instead of `/orc` on an already-running session, START the session with `claude --dangerously-load-development-channels server:orc` (the `orc` channel MCP server is registered by `make setup`). Browser messages then land in the session the moment they are sent — even while it is idle — and tool-permission dialogs relay to the browser. Trade-off: it must be enabled at session start, so `/orc` remains the way to share a session after the fact.

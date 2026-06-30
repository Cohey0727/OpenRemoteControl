#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook for open-rc.
 *
 * Claude Code invokes us on stdin with tool info; we POST it to the
 * open-rc server and print its decision to stdout.
 *
 * Wire flow:
 *   claude ──(stdin JSON)──▶ this hook ──(HTTP POST)──▶ server /internal/hook/{sid}
 *                          ◀──(HTTP response)── server ──(hookSpecificOutput JSON)──▶ stdout ──▶ claude
 *
 * Invoked as: `open-rc hook pretool --session <sid> --url <hookUrl>`
 */

import { z } from 'zod';

/* --------------------------------- I/O ----------------------------------- */

const HookInputSchema = z.object({
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(),
});

const HookOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('PreToolUse'),
    permissionDecision: z.enum(['allow', 'deny', 'ask']),
    permissionDecisionReason: z.string().optional(),
  }),
});

/* ----------------------------- arg parsing ------------------------------- */

function parseArgs(argv: string[]): { session: string; url: string } {
  let session = '';
  let url = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') session = argv[++i] ?? '';
    else if (a === '--url') url = argv[++i] ?? '';
  }
  if (!session || !url) {
    process.stderr.write('open-rc hook pretool: --session and --url are required\n');
    process.exit(2);
  }
  return { session, url };
}

/* ------------------------------- main ------------------------------------ */

async function main(): Promise<void> {
  const { session, url } = parseArgs(process.argv.slice(2));

  const raw = await Bun.stdin.text();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`hook pretool: malformed JSON from claude: ${err}\n`);
    process.exit(1);
  }

  const parsed = HookInputSchema.safeParse(payload);
  if (!parsed.success) {
    process.stderr.write(
      `hook pretool: unexpected input shape: ${parsed.error.issues[0]?.message}\n`,
    );
    // Soft-fail: tell claude to ask the human via its own UI, so we
    // don't block the session on a malformed payload.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'open-rc hook received malformed input',
        },
      }),
    );
    return;
  }

  const input = parsed.data;
  const toolName = input.tool_name ?? 'unknown';
  const toolInput = input.tool_input ?? {};
  const toolUseId = input.tool_use_id ?? '';

  let response: Response;
  try {
    response = await fetch(`${url}/${encodeURIComponent(session)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: toolName,
        input: toolInput,
        toolUseId,
        hookEventName: input.hook_event_name ?? 'PreToolUse',
        claudeSessionId: input.session_id ?? '',
      }),
      // 5 minutes — generous; the UI modal won't time out faster than this.
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    process.stderr.write(`hook pretool: server unreachable: ${err}\n`);
    // Fall back to "ask" so claude surfaces its own prompt.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `open-rc server unreachable: ${err instanceof Error ? err.message : String(err)}`,
        },
      }),
    );
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    process.stderr.write(`hook pretool: server ${response.status}: ${text}\n`);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `open-rc server error ${response.status}`,
        },
      }),
    );
    return;
  }

  const decision = (await response.json()) as {
    approved: boolean;
    reason?: string;
  };

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: (decision.approved ? 'allow' : 'deny') as 'allow' | 'deny',
      ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
    },
  };

  // Validate before writing to stdout — Claude Code will reject malformed output.
  const validated = HookOutputSchema.parse(output);
  process.stdout.write(`${JSON.stringify(validated)}\n`);
}

await main();

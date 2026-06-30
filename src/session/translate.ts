/**
 * Translates stream-json events emitted by `claude --bare --output-format
 * stream-json` into the simpler WsServerMessage shapes the SPA consumes.
 *
 * The server is the only thing that knows about stream-json. The UI sees
 * only the seven discriminated-union shapes defined in `ws-protocol.ts`.
 */

import type {
  AssistantMessage,
  ResultMessage,
  StreamJsonEvent,
  UserMessage,
} from './stream-json.ts';
import type { WsServerMessage } from './ws-protocol.ts';

type Translator = (event: StreamJsonEvent, sessionId: string) => WsServerMessage[];

const translateAssistant: Translator = (event, sessionId) => {
  if (event.type !== 'assistant') return [];
  const msg = event as AssistantMessage;
  return msg.message.content.map((block): WsServerMessage => {
    switch (block.type) {
      case 'text':
        return { type: 'text', sessionId, text: block.text };
      case 'thinking':
        return { type: 'thinking', sessionId, text: block.thinking };
      case 'tool_use':
        return {
          type: 'tool_use',
          sessionId,
          tool: block.name,
          input: JSON.stringify(block.input),
        };
    }
  });
};

const translateUser: Translator = (event, sessionId) => {
  if (event.type !== 'user') return [];
  const msg = event as UserMessage;
  const out: WsServerMessage[] = [];
  for (const block of msg.message.content) {
    if (block.type === 'tool_result') {
      const content =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      out.push({ type: 'tool_result', sessionId, output: content });
    }
    // `text` blocks in user messages are echoes of the prompt — we ignore
    // them, the UI already rendered the prompt on send.
  }
  return out;
};

const translateResult: Translator = (event, sessionId) => {
  if (event.type !== 'result') return [];
  const r = event as ResultMessage;
  if (r.is_error) {
    return [
      {
        type: 'error',
        sessionId,
        message: 'error' in r && typeof r.error === 'string' ? r.error : r.subtype,
      },
    ];
  }
  const done: WsServerMessage = { type: 'done', sessionId };
  if ('duration_ms' in r && typeof r.duration_ms === 'number') {
    done.duration_ms = r.duration_ms;
  }
  if ('total_cost_usd' in r && typeof r.total_cost_usd === 'number') {
    done.cost = r.total_cost_usd;
  }
  return [done];
};

/**
 * Translate a single stream-json event into zero or more WsServerMessages.
 *
 * Returns an empty array for events we ignore (system init, thinking_tokens,
 * and any passthrough types).
 */
export function translate(event: StreamJsonEvent, sessionId: string): WsServerMessage[] {
  switch (event.type) {
    case 'assistant':
      return translateAssistant(event, sessionId);
    case 'user':
      return translateUser(event, sessionId);
    case 'result':
      return translateResult(event, sessionId);
    default:
      // system init, thinking_tokens, and unknown passthrough types
      return [];
  }
}

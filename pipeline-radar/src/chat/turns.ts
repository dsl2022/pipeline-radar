import { boundHistory, type ChatTurn } from '@pipeline-radar/shared/chat';
import type { SseEvent } from './sse';

// The panel's message model, kept as plain data with pure transitions so the
// streaming behaviour is testable without a DOM. ChatPanel owns only the
// fetch loop and the rendering.

export interface UserMsg {
  role: 'user';
  text: string;
}

/** A prepared brief: preview + the commit token the model never saw. */
export interface BriefCard {
  filename: string;
  markdown: string;
  token: string;
}

export interface AssistantMsg {
  role: 'assistant';
  text: string;
  thinking: string;
  tools: string[];
  notice?: string;
  error?: string;
  brief?: BriefCard;
  streaming: boolean;
}

export type Msg = UserMsg | AssistantMsg;

export function emptyAssistant(): AssistantMsg {
  return { role: 'assistant', text: '', thinking: '', tools: [], streaming: true };
}

/** Fold one SSE event into the streaming assistant message. */
export function applyEvent(msg: AssistantMsg, ev: SseEvent): AssistantMsg {
  const d = (ev.data ?? {}) as { text?: string; name?: string; message?: string };
  switch (ev.event) {
    case 'delta':
      return { ...msg, text: msg.text + (d.text ?? '') };
    case 'thinking':
      return { ...msg, thinking: msg.thinking + (d.text ?? '') };
    case 'tool':
      return d.name ? { ...msg, tools: [...msg.tools, d.name] } : msg;
    case 'notice':
      return { ...msg, notice: d.text };
    case 'brief': {
      const b = ev.data as { filename?: string; markdown?: string; token?: string };
      if (typeof b?.markdown !== 'string' || typeof b?.token !== 'string') return msg;
      return { ...msg, brief: { filename: b.filename ?? 'brief.md', markdown: b.markdown, token: b.token } };
    }
    case 'error':
      return { ...msg, error: d.message ?? 'the assistant could not finish this turn' };
    case 'done':
      return { ...msg, streaming: false };
    default:
      // open, heartbeats, anything future - carry no message content.
      return msg;
  }
}

/**
 * The history to send with the next question: completed exchanges only,
 * bounded to the shared caps. A turn that errored or streamed nothing is
 * dropped as a pair — sending its user half alone would break the alternating
 * shape the server enforces, and the model has nothing to remember from it.
 */
export function historyFrom(msgs: Msg[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let i = 0; i + 1 < msgs.length; i += 1) {
    const u = msgs[i];
    const a = msgs[i + 1];
    if (
      u.role === 'user' &&
      a.role === 'assistant' &&
      !a.streaming &&
      !a.error &&
      a.text.trim().length > 0
    ) {
      turns.push({ role: 'user', text: u.text }, { role: 'assistant', text: a.text });
    }
  }
  return boundHistory(turns);
}

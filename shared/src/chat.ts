// The chat wire protocol, shared by the web panel and the API gates.
//
// One module owns the shape and the bounds of a multi-turn request so the two
// sides cannot drift: the panel trims history with the same constants the
// server rejects on. The server still validates — the client's trimming is a
// courtesy, not a contract, because anyone can POST without the panel.

/** MILESTONE-6-PLAN.md 6.1: the per-question cap, enforced on both sides. */
export const MAX_MESSAGE_CHARS = 4000;

/** Prior turns sent back with a question. 10 exchanges is a long session. */
export const MAX_HISTORY_TURNS = 20;

/**
 * Per-item cap, above the message cap because assistant answers run long.
 * Truncation keeps the head: the lead carries the answer, the tail the caveats.
 */
export const MAX_HISTORY_ITEM_CHARS = 8000;

/**
 * Total history budget. Roughly 6k tokens — enough to follow "and in
 * children?" without re-buying the whole session's context every turn.
 */
export const MAX_HISTORY_TOTAL_CHARS = 24_000;

export type ChatRole = 'user' | 'assistant';

export interface ChatTurn {
  role: ChatRole;
  text: string;
}

// Tab, newline and carriage return are legitimate in a pasted question. The
// rest of C0, DEL, and the C1 range are not, and are a cheap way to smuggle
// terminal escapes or confuse whatever parses the transcript later.
// eslint-disable-next-line no-control-regex -- rejecting these is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

/**
 * Client-side trimming before send. Keeps the newest turns, truncates
 * over-long items, and drops from the front until the totals fit — then
 * re-trims so what remains still starts with a user turn, because dropping an
 * odd number of items would otherwise leave an assistant turn leading and the
 * server (rightly) refuses that shape.
 */
export function boundHistory(turns: ChatTurn[]): ChatTurn[] {
  let out = turns.slice(-MAX_HISTORY_TURNS).map((t) =>
    t.text.length > MAX_HISTORY_ITEM_CHARS ? { ...t, text: t.text.slice(0, MAX_HISTORY_ITEM_CHARS) } : t,
  );

  let total = out.reduce((n, t) => n + t.text.length, 0);
  while (out.length > 0 && total > MAX_HISTORY_TOTAL_CHARS) {
    total -= out[0].text.length;
    out = out.slice(1);
  }
  while (out.length > 0 && out[0].role === 'assistant') out = out.slice(1);
  return out;
}

export type HistoryResult = { ok: true; value: ChatTurn[] } | { ok: false; reason: string };

/**
 * Server-side check. Strict where boundHistory is forgiving: anything out of
 * bounds is rejected, never silently trimmed — a server that quietly rewrites
 * the request would hide a broken client behind working answers.
 *
 * The pair shape (starts with user, alternates, ends with assistant) is
 * enforced because the question is appended after the history: any other
 * shape puts two same-role messages in a row.
 */
export function validateHistory(value: unknown): HistoryResult {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, reason: 'history must be an array' };
  if (value.length > MAX_HISTORY_TURNS) {
    return { ok: false, reason: `history exceeds ${MAX_HISTORY_TURNS} turns` };
  }
  if (value.length % 2 !== 0) {
    return { ok: false, reason: 'history must be whole exchanges' };
  }

  let total = 0;
  const out: ChatTurn[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i] as { role?: unknown; text?: unknown } | null;
    const expected: ChatRole = i % 2 === 0 ? 'user' : 'assistant';
    if (typeof item !== 'object' || item === null) {
      return { ok: false, reason: 'history items must be objects' };
    }
    if (item.role !== expected) {
      return { ok: false, reason: 'history must alternate user and assistant' };
    }
    if (typeof item.text !== 'string' || item.text.trim().length === 0) {
      return { ok: false, reason: 'history items must have text' };
    }
    if (item.text.length > MAX_HISTORY_ITEM_CHARS) {
      return { ok: false, reason: `history item exceeds ${MAX_HISTORY_ITEM_CHARS} characters` };
    }
    if (hasControlChars(item.text)) {
      return { ok: false, reason: 'history contains control characters' };
    }
    total += item.text.length;
    out.push({ role: expected, text: item.text });
  }
  if (total > MAX_HISTORY_TOTAL_CHARS) {
    return { ok: false, reason: `history exceeds ${MAX_HISTORY_TOTAL_CHARS} characters` };
  }
  return { ok: true, value: out };
}

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

/**
 * What the panel tells the agent about the app around it (PR 9, the copilot
 * layer). All optional: a request with no context is a plain question. The
 * watchlist diff is client-computed — the server holds no snapshots — and the
 * model only narrates it, so it crosses the wire as bounded, validated data.
 */
export interface ChatContext {
  disease?: string;
  view?: 'trials' | 'drugs';
  phases?: string[];
  statuses?: string[];
  /** Serialized LandscapeDiff for the current disease, if a watchlist exists. */
  watchlistDiff?: unknown;
}

/** Ceiling on the serialized context, dominated by the watchlist diff. */
export const MAX_CONTEXT_CHARS = 16_000;

const MAX_FILTER_ITEMS = 12;
const MAX_FIELD_CHARS = 120;

export type ContextResult = { ok: true; value: ChatContext | undefined } | { ok: false; reason: string };

function badField(name: string): ContextResult {
  return { ok: false, reason: `context ${name} is invalid` };
}

function validStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_FILTER_ITEMS &&
    value.every((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_FIELD_CHARS && !hasControlChars(s))
  );
}

export function validateContext(value: unknown): ContextResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'context must be an object' };
  }
  const c = value as Record<string, unknown>;

  const out: ChatContext = {};
  if (c.disease !== undefined) {
    if (typeof c.disease !== 'string' || c.disease.length === 0 || c.disease.length > MAX_FIELD_CHARS || hasControlChars(c.disease)) {
      return badField('disease');
    }
    out.disease = c.disease;
  }
  if (c.view !== undefined) {
    if (c.view !== 'trials' && c.view !== 'drugs') return badField('view');
    out.view = c.view;
  }
  if (c.phases !== undefined) {
    if (!validStrings(c.phases)) return badField('phases');
    out.phases = c.phases;
  }
  if (c.statuses !== undefined) {
    if (!validStrings(c.statuses)) return badField('statuses');
    out.statuses = c.statuses;
  }
  if (c.watchlistDiff !== undefined) {
    let text: string;
    try {
      text = JSON.stringify(c.watchlistDiff);
    } catch {
      return badField('watchlistDiff');
    }
    if (typeof text !== 'string' || hasControlChars(text)) return badField('watchlistDiff');
    if (text.length > MAX_CONTEXT_CHARS) {
      return { ok: false, reason: `context exceeds ${MAX_CONTEXT_CHARS} characters` };
    }
    out.watchlistDiff = c.watchlistDiff;
  }

  // The whole thing must fit, not just the diff: twelve 120-char filters
  // should not smuggle past the ceiling the diff respects.
  if (JSON.stringify(out).length > MAX_CONTEXT_CHARS) {
    return { ok: false, reason: `context exceeds ${MAX_CONTEXT_CHARS} characters` };
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
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

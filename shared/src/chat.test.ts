import {
  MAX_CONTEXT_CHARS,
  MAX_HISTORY_ITEM_CHARS,
  MAX_HISTORY_TOTAL_CHARS,
  MAX_HISTORY_TURNS,
  boundHistory,
  hasControlChars,
  validateContext,
  validateHistory,
  type ChatTurn,
} from './chat';

const pair = (n: number, size = 10): ChatTurn[] => {
  const out: ChatTurn[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: 'user', text: `q${i}`.padEnd(size, 'x') });
    out.push({ role: 'assistant', text: `a${i}`.padEnd(size, 'y') });
  }
  return out;
};

describe('boundHistory', () => {
  it('passes a small history through untouched', () => {
    const h = pair(3);
    expect(boundHistory(h)).toEqual(h);
  });

  it('keeps the newest turns when over the turn cap', () => {
    const h = pair(15); // 30 items
    const out = boundHistory(h);
    expect(out.length).toBe(MAX_HISTORY_TURNS);
    expect(out[out.length - 1]).toEqual(h[h.length - 1]);
  });

  it('truncates an over-long item keeping the head', () => {
    const long = 'lead sentence. '.repeat(2000);
    const out = boundHistory([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: long },
    ]);
    expect(out[1].text.length).toBe(MAX_HISTORY_ITEM_CHARS);
    expect(out[1].text.startsWith('lead sentence.')).toBe(true);
  });

  it('drops oldest turns until the total fits', () => {
    const h = pair(4, 7000); // 8 items × 7000 chars, way over the total cap
    const out = boundHistory(h);
    const total = out.reduce((n, t) => n + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_HISTORY_TOTAL_CHARS);
    expect(out[out.length - 1]).toEqual(h[h.length - 1]);
  });

  // The server refuses a history led by an assistant turn, so trimming must
  // never produce one.
  it('never leaves an assistant turn leading after a drop', () => {
    const h = pair(4, 7000);
    const out = boundHistory(h);
    expect(out.length === 0 || out[0].role === 'user').toBe(true);
    // What survives must be a shape the server accepts.
    expect(validateHistory(out).ok).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(boundHistory([])).toEqual([]);
  });
});

describe('validateHistory', () => {
  it('treats absence as an empty history', () => {
    expect(validateHistory(undefined)).toEqual({ ok: true, value: [] });
  });

  it('accepts a well-formed exchange', () => {
    const res = validateHistory(pair(2));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.length).toBe(4);
  });

  it.each([
    ['a string', 'not an array'],
    ['an object', { role: 'user', text: 'hi' }],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(validateHistory(value).ok).toBe(false);
  });

  it('rejects more than the turn cap', () => {
    expect(validateHistory(pair(MAX_HISTORY_TURNS / 2 + 1)).ok).toBe(false);
  });

  it('rejects an odd number of items', () => {
    expect(validateHistory(pair(1).slice(0, 1)).ok).toBe(false);
  });

  it('rejects a history led by the assistant', () => {
    const [u, a] = pair(1);
    expect(validateHistory([a, u]).ok).toBe(false);
  });

  it('rejects consecutive same-role turns', () => {
    const [u, a] = pair(1);
    expect(validateHistory([u, { ...a, role: 'user' }]).ok).toBe(false);
  });

  it('rejects a non-string or empty text', () => {
    expect(validateHistory([{ role: 'user', text: 42 }, pair(1)[1]]).ok).toBe(false);
    expect(validateHistory([{ role: 'user', text: '   ' }, pair(1)[1]]).ok).toBe(false);
  });

  it('rejects an item over the per-item cap', () => {
    const h = pair(1);
    h[1].text = 'a'.repeat(MAX_HISTORY_ITEM_CHARS + 1);
    expect(validateHistory(h).ok).toBe(false);
  });

  it('rejects when the total exceeds the budget even though each item fits', () => {
    expect(validateHistory(pair(4, 7000)).ok).toBe(false);
  });

  it('rejects control characters in history text', () => {
    const h = pair(1);
    h[0].text = 'hello\u0000world';
    expect(validateHistory(h).ok).toBe(false);
  });
});

describe('hasControlChars', () => {
  it('allows tab, newline and carriage return', () => {
    expect(hasControlChars('a\tb\nc\r\n')).toBe(false);
  });

  it('rejects C0, DEL and C1', () => {
    expect(hasControlChars('a\u0000b')).toBe(true);
    expect(hasControlChars('a\u007Fb')).toBe(true);
    expect(hasControlChars('a\u009Bb')).toBe(true);
  });
});

describe('validateContext', () => {
  it('treats absence as no context', () => {
    expect(validateContext(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('accepts a well-formed context', () => {
    const res = validateContext({ disease: 'melanoma', view: 'drugs', phases: ['PHASE3'], statuses: [] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ disease: 'melanoma', view: 'drugs', phases: ['PHASE3'], statuses: [] });
  });

  it('collapses an empty object to no context', () => {
    expect(validateContext({})).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['a non-object', 'melanoma'],
    ['an array', []],
    ['an unknown view', { view: 'dashboard' }],
    ['an over-long disease', { disease: 'x'.repeat(121) }],
    ['control characters in the disease', { disease: 'mel\u0007anoma' }],
    ['a non-string filter entry', { phases: [42] }],
    ['too many filter entries', { phases: Array.from({ length: 13 }, (_, i) => `P${i}`) }],
  ])('rejects %s', (_name, value) => {
    expect(validateContext(value).ok).toBe(false);
  });

  it('rejects a watchlist diff over the budget and accepts one inside it', () => {
    const big = { rows: 'x'.repeat(MAX_CONTEXT_CHARS) };
    expect(validateContext({ watchlistDiff: big }).ok).toBe(false);
    const small = { hasChanges: true, added: [{ drug: 'examplemab' }] };
    const res = validateContext({ watchlistDiff: small });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value?.watchlistDiff).toEqual(small);
  });
});

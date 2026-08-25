import { checkCitations, extractNctIds, seedKnownIds } from './citations';

// The accept criterion for this layer (MILESTONE-6-PR-PLAN.md PR 10): a
// fabricated NCT ID is flagged; an ID a tool vouched for is not.

describe('extractNctIds', () => {
  it('finds every distinct ID and ignores near-misses', () => {
    const ids = extractNctIds('See NCT01234567 and NCT01234567 again, also NCT9999 and NCTXXXXXXXX.');
    expect([...ids]).toEqual(['NCT01234567']);
  });

  it('finds IDs inside JSON as easily as prose', () => {
    const ids = extractNctIds('{"rows":[{"nct_id":"NCT00000001"},{"example_nct_ids":["NCT00000002"]}]}');
    expect(ids.size).toBe(2);
  });
});

describe('seedKnownIds', () => {
  it('collects IDs from prior turns and the watchlist diff', () => {
    const known = seedKnownIds(
      [
        { role: 'user', text: 'tell me about NCT01111111' },
        { role: 'assistant', text: 'NCT01111111 is a phase 3 study.' },
      ],
      { disease: 'melanoma', watchlistDiff: { new_trials: [{ nct_ids: ['NCT02222222'] }] } },
    );
    expect(known.has('NCT01111111')).toBe(true);
    expect(known.has('NCT02222222')).toBe(true);
    expect(known.size).toBe(2);
  });

  it('is empty for a first turn with no context', () => {
    expect(seedKnownIds(undefined, undefined).size).toBe(0);
  });
});

describe('checkCitations', () => {
  const known = new Set(['NCT01234567']);

  it('passes a reply whose every ID a tool vouched for', () => {
    expect(checkCitations('The largest is NCT01234567.', known)).toEqual({ cited: 1, unverified: [] });
  });

  it('flags a fabricated ID', () => {
    const out = checkCitations('See NCT01234567 and NCT09999999.', known);
    expect(out).toEqual({ cited: 2, unverified: ['NCT09999999'] });
  });

  it('flags a fabricated ID only once however often it repeats', () => {
    const out = checkCitations('NCT09999999, again NCT09999999.', known);
    expect(out.unverified).toEqual(['NCT09999999']);
  });

  it('reports a reply with no IDs as clean', () => {
    expect(checkCitations('There are 409 distinct drugs.', known)).toEqual({ cited: 0, unverified: [] });
  });
});

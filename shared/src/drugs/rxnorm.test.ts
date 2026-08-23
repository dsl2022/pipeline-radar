import { brandishAliases, clearRxnormCache, enrichTopRows, resolveDrugRow, resolveRxcui } from './rxnorm';
import type { DrugRow } from './cluster';

function mockFetch(bodyByUrl: (url: string) => unknown) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    return { ok: true, status: 200, json: async () => bodyByUrl(url) } as Response;
  });
}

function drugRow(displayName: string, aliases: string[] = []): DrugRow {
  return {
    key: displayName.toLowerCase(),
    displayName,
    trialCount: 1,
    maxPhase: 3,
    phaseLabel: 'Phase 2',
    sponsors: [],
    aliases,
    nctIds: [],
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  clearRxnormCache();
});

describe('resolveRxcui', () => {
  it('queries with allsrc=1 and returns the first RxCUI', async () => {
    const spy = mockFetch(() => ({ idGroup: { rxnormId: ['1547545'] } }));
    await expect(resolveRxcui('pembrolizumab')).resolves.toBe('1547545');
    expect(spy.mock.calls[0][0]).toContain('allsrc=1');
    expect(spy.mock.calls[0][0]).toContain('name=pembrolizumab');
  });

  it('treats an empty idGroup as a definitive miss (null), and caches it', async () => {
    const spy = mockFetch(() => ({ idGroup: {} }));
    await expect(resolveRxcui('mk 3475')).resolves.toBeNull();
    await expect(resolveRxcui('mk 3475')).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1); // second hit served from cache
  });

  it('throws on HTTP errors instead of faking a miss', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    await expect(resolveRxcui('osimertinib')).rejects.toThrow('RxNorm returned 500');
  });
});

describe('brandishAliases', () => {
  it('selects brand-shaped aliases on the canon form (KEYTRUDA® style)', () => {
    expect(brandishAliases(['MK-3475', 'KEYTRUDA®', 'Chemotherapy', 'SCH 900475'])).toEqual([
      'keytruda',
    ]);
  });

  it('caps at two candidates', () => {
    expect(brandishAliases(['Opdivo', 'NIVO®', 'Tecentriq'])).toHaveLength(2);
  });
});

describe('resolveDrugRow', () => {
  it('falls back from a missed display name to a brand alias', async () => {
    mockFetch((url) =>
      url.includes('name=keytruda') ? { idGroup: { rxnormId: ['1547550'] } } : { idGroup: {} },
    );
    const row = drugRow('Pembrolizumab', ['MK-3475', 'KEYTRUDA®']);
    await expect(resolveDrugRow(row)).resolves.toBe('1547550');
  });

  it('returns null when every candidate definitively misses', async () => {
    mockFetch(() => ({ idGroup: {} }));
    await expect(resolveDrugRow(drugRow('BMS-986340'))).resolves.toBeNull();
  });
});

// enrichTopRows runs four workers in parallel and two rows routinely resolve to
// the same alias, so concurrent same-name misses happen on an ordinary page
// load - not only under the agent. The cache never covered this, because it is
// written after the fetch resolves.
describe('concurrent resolution collapses into one request', () => {
  it('queries once for concurrent callers asking the same name', async () => {
    const spy = mockFetch(() => ({ idGroup: { rxnormId: ['1547545'] } }));

    const results = await Promise.all([
      resolveRxcui('pembrolizumab'),
      resolveRxcui('pembrolizumab'),
      resolveRxcui('pembrolizumab'),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['1547545', '1547545', '1547545']);
  });

  it('still queries separately for different names', async () => {
    const spy = mockFetch(() => ({ idGroup: { rxnormId: ['1'] } }));
    await Promise.all([resolveRxcui('pembrolizumab'), resolveRxcui('osimertinib')]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // The real path: four workers, rows sharing a name.
  it('queries once per distinct name across enrichTopRows workers', async () => {
    const spy = mockFetch(() => ({ idGroup: { rxnormId: ['1547545'] } }));
    const rows = Array.from({ length: 8 }, (_, i) => drugRow(`Pembrolizumab`, [`alias${i}`]));

    const seen = new Map<string, string | null>();
    await enrichTopRows(rows, (key, cui) => seen.set(key, cui));

    // Eight rows, one distinct canon name, one request.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen.get('pembrolizumab')).toBe('1547545');
  });

  it('fails every concurrent caller, then retries cleanly', async () => {
    let call = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const failing = call++ === 0;
      return {
        ok: !failing,
        status: failing ? 500 : 200,
        json: async () => ({ idGroup: { rxnormId: ['1547545'] } }),
      } as Response;
    });

    const settled = await Promise.allSettled([resolveRxcui('pembrolizumab'), resolveRxcui('pembrolizumab')]);
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
    expect(await resolveRxcui('pembrolizumab')).toBe('1547545');
  });
});

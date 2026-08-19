import { fetchTrials, clearTrialsCache } from './api';

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({ ok, status, json: async () => body } as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
  clearTrialsCache();
});

describe('fetchTrials', () => {
  it('builds the documented query URL', async () => {
    const spy = mockFetchOnce({ studies: [], totalCount: 0 });
    await fetchTrials('lung cancer');

    // Relative /api URL — resolved against the page origin in the browser.
    const url = new URL(spy.mock.calls[0][0] as string, 'http://localhost');
    expect(url.pathname).toBe('/api/ctgov/v2/studies');
    expect(url.searchParams.get('query.cond')).toBe('lung cancer');
    // Widened in M2 (issue #8): superset of the client-side status filter, per ARCHITECTURE §5.
    expect(url.searchParams.get('filter.overallStatus')).toBe(
      'RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION',
    );
    // Bumped 100 → 500 for M3's drug rollup (MILESTONE-3-PLAN step 4).
    expect(url.searchParams.get('pageSize')).toBe('500');
    expect(url.searchParams.get('countTotal')).toBe('true');
    expect(url.searchParams.get('fields')).toContain('InterventionOtherName');
    expect(url.searchParams.get('pageToken')).toBeNull();
  });

  it('passes pageToken through for pagination', async () => {
    const spy = mockFetchOnce({ studies: [], totalCount: 0 });
    await fetchTrials('lung cancer', 'abc123');

    const url = new URL(spy.mock.calls[0][0] as string, 'http://localhost');
    expect(url.searchParams.get('pageToken')).toBe('abc123');
  });

  it('maps studies and surfaces total + nextPageToken', async () => {
    mockFetchOnce({
      studies: [{ protocolSection: { identificationModule: { nctId: 'NCT00000001' } } }],
      totalCount: 42,
      nextPageToken: 'tok',
    });

    const result = await fetchTrials('als');
    expect(result.total).toBe(42);
    expect(result.nextPageToken).toBe('tok');
    expect(result.trials).toHaveLength(1);
    expect(result.trials[0].nctId).toBe('NCT00000001');
  });

  it('returns empty results without crashing when the API omits fields', async () => {
    mockFetchOnce({});
    const result = await fetchTrials('asdfgh');
    expect(result).toEqual({ trials: [], total: 0, nextPageToken: undefined });
  });

  it('throws a readable error on a non-OK response', async () => {
    mockFetchOnce({}, false, 500);
    await expect(fetchTrials('lung cancer')).rejects.toThrow('ClinicalTrials.gov returned 500');
  });

  it('serves repeat queries from cache without refetching', async () => {
    const spy = mockFetchOnce({ studies: [], totalCount: 7 });
    await fetchTrials('lung cancer');
    const second = await fetchTrials('lung cancer');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.total).toBe(7);
  });

  it('does not cache failed responses', async () => {
    mockFetchOnce({}, false, 500);
    await expect(fetchTrials('als')).rejects.toThrow();
    jest.restoreAllMocks();

    const spy = mockFetchOnce({ studies: [], totalCount: 3 });
    const result = await fetchTrials('als');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(3);
  });
});

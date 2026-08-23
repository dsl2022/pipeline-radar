import { setApiBase } from '@pipeline-radar/shared/net';
import { createTrialData, DATA_TTL_MS } from './data';

// Injected clock, injected fetch: no network, no sleeps. What matters here is
// that a turn asking three tools about one disease costs one upstream call,
// and that a failure is a failure rather than an empty result set.

const study = (nctId: string) => ({
  protocolSection: {
    identificationModule: { nctId, briefTitle: `Study ${nctId}` },
    statusModule: { overallStatus: 'RECRUITING' },
    designModule: { phases: ['PHASE2'], enrollmentInfo: { count: 40 } },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Acme Onc' } },
    armsInterventionsModule: { interventions: [{ type: 'DRUG', name: 'examplemab' }] },
  },
});

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('createTrialData', () => {
  it('maps the registry payload into trials', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse({ studies: [study('NCT01')], totalCount: 1 }),
    );
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const set = await data.search('lung cancer');
    expect(set.trials).toHaveLength(1);
    expect(set.trials[0].nctId).toBe('NCT01');
    expect(set.sampled).toBe(false);
  });

  it('flags a result as sampled when the registry holds more than one page', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(okResponse({ studies: [study('NCT01')], totalCount: 4200 }));
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const set = await data.search('lung cancer');
    expect(set.total).toBe(4200);
    expect(set.sampled).toBe(true);
  });

  it('sends the condition to the registry, url-encoded', async () => {
    setApiBase('http://127.0.0.1:3001/api');
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ studies: [], totalCount: 0 }));
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await data.search('non-small cell lung cancer');
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain('http://127.0.0.1:3001/api/ctgov/v2/studies');
    expect(url).toContain('query.cond=non-small+cell+lung+cancer');
    expect(url).toContain('countTotal=true');
  });

  // Three tools asking about one disease in one turn must not be three calls.
  it('serves a repeat search from cache', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ studies: [study('NCT01')], totalCount: 1 }));
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });

    await data.search('lung cancer');
    await data.search('Lung Cancer');
    await data.search('  lung cancer  ');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // The case the sequential test above misses, and the one that actually
  // happens: the tool runner executes every tool_use block in one assistant
  // message concurrently, so two tools asking about the same disease reach
  // this at the same instant, before either has anything to cache.
  it('collapses concurrent searches for the same condition into one call', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchImpl = jest.fn(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const all = Promise.all([
      data.search('lung cancer'),
      data.search('Lung Cancer'),
      data.search('lung cancer'),
    ]);
    // Let all three reach the cache check before anything resolves.
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveFetch(okResponse({ studies: [study('NCT01')], totalCount: 1 }));
    const results = await all;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const set of results) expect(set.trials[0].nctId).toBe('NCT01');
  });

  it('still separates concurrent searches for different conditions', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ studies: [], totalCount: 0 }));
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await Promise.all([data.search('lung cancer'), data.search('melanoma')]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // A failure shared by every concurrent caller must not become a cached
  // failure, or one blip would poison the condition for the whole TTL.
  it('lets every concurrent caller fail, then retries cleanly', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse({ studies: [study('NCT01')], totalCount: 1 }));
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const results = await Promise.allSettled([data.search('lung cancer'), data.search('lung cancer')]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The slot is free again rather than holding a rejected promise.
    expect((await data.search('lung cancer')).trials).toHaveLength(1);
  });

  it('refetches once the entry has expired', async () => {
    let clock = 1_000;
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ studies: [], totalCount: 0 }));
    const data = createTrialData({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    await data.search('lung cancer');
    clock += DATA_TTL_MS + 1;
    await data.search('lung cancer');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps different conditions apart', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ studies: [], totalCount: 0 }));
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await data.search('lung cancer');
    await data.search('melanoma');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // An empty result set and a failed lookup mean different things, and a tool
  // that returned [] on a 500 would have the agent report "no trials found".
  it('throws on an upstream error rather than reporting no trials', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 502 } as unknown as Response);
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(data.search('lung cancer')).rejects.toThrow(/502/);
  });

  it('does not cache a failure', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 } as unknown as Response)
      .mockResolvedValueOnce(okResponse({ studies: [study('NCT01')], totalCount: 1 }));
    const data = createTrialData({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(data.search('lung cancer')).rejects.toThrow();
    expect((await data.search('lung cancer')).trials).toHaveLength(1);
  });

  it('bounds an upstream that never answers', async () => {
    const fetchImpl = jest.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')));
      }),
    );
    const data = createTrialData({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });

    await expect(data.search('lung cancer')).rejects.toThrow();
  });
});

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

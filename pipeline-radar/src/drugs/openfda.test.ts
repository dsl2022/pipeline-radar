import { badgeDrugs, clearFdaCache, fetchTopReactions, type FdaBadge } from './openfda';
import type { DrugRow } from './cluster';
import pembroFixture from '../samples/openfda-approved-pembrolizumab.json';

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

interface AppOpts {
  generic?: string[];
  brand?: string[];
  origAP?: string;
  sponsor?: string;
  pharm?: string[];
}

function app(number: string, { generic, brand, origAP, sponsor, pharm }: AppOpts = {}) {
  return {
    application_number: number,
    sponsor_name: sponsor ?? 'ACME PHARMA',
    submissions: origAP
      ? [{ submission_type: 'ORIG', submission_status: 'AP', submission_status_date: origAP }]
      : [],
    openfda: { generic_name: generic, brand_name: brand, pharm_class_epc: pharm },
  };
}

function page(results: unknown[], total = results.length) {
  return { meta: { results: { skip: 0, limit: 100, total } }, results };
}

const MISS_404 = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No matches found!' } } };

/** Mock fetch dispatching on the decoded URL; responses may vary per call index. */
function mockFetch(respond: (url: string, call: number) => { status: number; body: unknown }) {
  let call = 0;
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const { status, body } = respond(decodeURIComponent(String(input)), call++);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  });
}

async function collect(rows: DrugRow[]): Promise<Map<string, FdaBadge | null>> {
  const out = new Map<string, FdaBadge | null>();
  await badgeDrugs(rows, (key, badge) => out.set(key, badge));
  return out;
}

afterEach(() => {
  jest.restoreAllMocks();
  clearFdaCache();
});

describe('batch URL shape', () => {
  it('sends one generic_name OR-batch with limit=100 for ≤15 rows', async () => {
    const spy = mockFetch(() =>
      ({ status: 200, body: page([
        app('BLA125514', { generic: ['PEMBROLIZUMAB'], origAP: '20140904' }),
        app('NDA208065', { generic: ['OSIMERTINIB'], origAP: '20151113' }),
        app('BLA761069', { generic: ['DURVALUMAB'], origAP: '20170501' }),
      ]) }),
    );
    const out = await collect([drugRow('Pembrolizumab'), drugRow('Osimertinib'), drugRow('Durvalumab')]);
    expect(spy).toHaveBeenCalledTimes(1);
    const url = decodeURIComponent(String(spy.mock.calls[0][0]));
    expect(url).toContain('openfda.generic_name:("pembrolizumab" "osimertinib" "durvalumab")');
    expect(url).toContain('limit=100');
    expect(out.get('osimertinib')).toMatchObject({ status: 'approved', approvalYear: '2015', via: 'generic' });
  });
});

describe('truncation guard', () => {
  it('paginates with skip before judging absences, and only the union is evaluated', async () => {
    // Page 1 says total=3 but carries 2 results — a truncated response. The
    // second paclitaxel application (the ANDA with the EARLIER date) only
    // arrives on the skip page; judging page 1 alone would mis-badge it.
    const spy = mockFetch((url) => {
      if (url.includes('skip=2'))
        return { status: 200, body: page([app('ANDA076000', { generic: ['PACLITAXEL'], origAP: '19930101' })], 3) };
      return { status: 200, body: page([
        app('NDA020000', { generic: ['PACLITAXEL'], origAP: '19981201' }),
        app('ANDA075000', { generic: ['CARBOPLATIN'], origAP: '20041014' }),
      ], 3) };
    });
    const out = await collect([drugRow('Paclitaxel'), drugRow('Carboplatin'), drugRow('Nosuchdrug')]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(String(spy.mock.calls[1][0]))).toContain('skip=2');
    // Union-level selection: both paclitaxel apps counted, earliest ORIG/AP wins.
    expect(out.get('paclitaxel')).toMatchObject({ approvalYear: '1993', appCount: 2, approvalApprox: true });
    // Absent name gets its verdict only from the complete union: a real miss.
    expect(out.get('nosuchdrug')).toBeNull();
  });

  it('records NOTHING when pagination fails midway — a partial union is never judged', async () => {
    const respond = (url: string) =>
      url.includes('skip=')
        ? { status: 500, body: {} }
        : { status: 200, body: page([app('NDA020000', { generic: ['PACLITAXEL'], origAP: '19981201' })], 3) };
    const spy = mockFetch(respond);
    const out = await collect([drugRow('Paclitaxel'), drugRow('Nosuchdrug')]);
    expect(out.size).toBe(0); // not even the name page 1 DID contain — and no cached miss
    spy.mockRestore();
    const retry = mockFetch(respond);
    await collect([drugRow('Paclitaxel')]);
    expect(retry).toHaveBeenCalled(); // nothing was cached by the failed run
  });
});

describe('correlation', () => {
  it('matches by case-insensitive equality — KEYTRUDA QLEX never badges a pembrolizumab row', async () => {
    // Real capture: the pembrolizumab batch also returns the combination
    // product (generic "PEMBROLIZUMAB AND BERAHYALURONIDASE ALFA-PMPH").
    mockFetch(() => ({ status: 200, body: pembroFixture }));
    const out = await collect([drugRow('Pembrolizumab')]);
    expect(out.get('pembrolizumab')).toMatchObject({
      status: 'approved',
      approvalYear: '2014',
      appNumber: 'BLA125514',
      appCount: 1, // the QLEX combo product is excluded by equality matching
      sponsor: 'MERCK SHARP DOHME',
      via: 'generic',
      brands: ['KEYTRUDA'],
    });
    expect(out.get('pembrolizumab')?.approvalApprox).toBeUndefined();
  });

  it('brand round badges via exact brand match only, tagged via:brand', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('brand_name'))
        return { status: 200, body: page([
          app('BLA125514', { generic: ['PEMBROLIZUMAB'], brand: ['KEYTRUDA'], origAP: '20140904' }),
          app('BLA761467', { generic: ['PEMBROLIZUMAB AND BERAHYALURONIDASE ALFA-PMPH'], brand: ['KEYTRUDA QLEX'], origAP: '20250919' }),
        ]) };
      return MISS_404;
    });
    const out = await collect([drugRow('MK-3475', ['KEYTRUDA®'])]);
    expect(decodeURIComponent(String(spy.mock.calls[1][0]))).toContain('openfda.brand_name:("keytruda")');
    expect(out.get('mk-3475')).toMatchObject({
      approvalYear: '2014',
      appNumber: 'BLA125514',
      appCount: 1, // KEYTRUDA QLEX is not an equality match for "keytruda"
      via: 'brand',
    });
  });
});

describe('selection', () => {
  it('earliest ORIG/AP wins; ANY ANDA in the matched set forces approvalApprox — even when the NDA is earliest', async () => {
    mockFetch(() => ({ status: 200, body: page([
      app('ANDA077059', { generic: ['CARBOPLATIN'], origAP: '20041123', sponsor: 'HOSPIRA' }),
      app('NDA020452', { generic: ['CARBOPLATIN'], origAP: '19990101', sponsor: 'BRISTOL' }),
    ]) }));
    const out = await collect([drugRow('Carboplatin')]);
    expect(out.get('carboplatin')).toMatchObject({
      approvalYear: '1999', // NDA carries the earliest date…
      appNumber: 'NDA020452',
      appCount: 2,
      approvalApprox: true, // …but the ANDA's presence still means truncated history
    });
  });
});

describe('miss semantics', () => {
  it('whole-batch 404 is data: every aliasless row resolves to null (Investigational)', async () => {
    mockFetch(() => MISS_404);
    const out = await collect([drugRow('Ivonescimab'), drugRow('AB-106')]);
    expect(out.get('ivonescimab')).toBeNull();
    expect(out.get('ab-106')).toBeNull();
  });

  it('partial batch: only the absent rows resolve to null', async () => {
    mockFetch(() => ({ status: 200, body: page([
      app('NDA208065', { generic: ['OSIMERTINIB'], origAP: '20151113' }),
    ]) }));
    const out = await collect([drugRow('Osimertinib'), drugRow('Ivonescimab')]);
    expect(out.get('osimertinib')).toMatchObject({ status: 'approved' });
    expect(out.get('ivonescimab')).toBeNull();
  });
});

describe('error semantics', () => {
  it('500 records nothing and caches nothing — unknown is not investigational', async () => {
    mockFetch(() => ({ status: 500, body: {} }));
    const out = await collect([drugRow('Osimertinib')]);
    expect(out.size).toBe(0);
    jest.restoreAllMocks();
    const retry = mockFetch(() => ({ status: 200, body: page([
      app('NDA208065', { generic: ['OSIMERTINIB'], origAP: '20151113' }),
    ]) }));
    const out2 = await collect([drugRow('Osimertinib')]);
    expect(retry).toHaveBeenCalledTimes(1); // the error was not cached as a miss
    expect(out2.get('osimertinib')).toMatchObject({ status: 'approved' });
  });
});

describe('cache', () => {
  it('serves a known name without fetching — hits and misses both', async () => {
    const spy = mockFetch((url) =>
      url.includes('ivonescimab') && !url.includes('osimertinib')
        ? MISS_404
        : { status: 200, body: page([app('NDA208065', { generic: ['OSIMERTINIB'], origAP: '20151113' })]) },
    );
    await collect([drugRow('Osimertinib'), drugRow('Ivonescimab')]);
    const calls = spy.mock.calls.length;
    const out = await collect([drugRow('Osimertinib'), drugRow('Ivonescimab')]);
    expect(spy.mock.calls.length).toBe(calls); // no new fetches
    expect(out.get('osimertinib')).toMatchObject({ status: 'approved' });
    expect(out.get('ivonescimab')).toBeNull();
  });
});

describe('fetchTopReactions (AE drill-in)', () => {
  it('takes top 5 from the count endpoint and caches', async () => {
    const results = [
      { term: 'DEATH', count: 11462 },
      { term: 'MALIGNANT NEOPLASM PROGRESSION', count: 3354 },
      { term: 'DIARRHOEA', count: 1677 },
      { term: 'DRUG RESISTANCE', count: 1096 },
      { term: 'FATIGUE', count: 1037 },
      { term: 'NAUSEA', count: 900 },
    ];
    const spy = mockFetch(() => ({ status: 200, body: { results } }));
    const top = await fetchTopReactions('osimertinib');
    expect(top).toHaveLength(5);
    expect(top[0]).toEqual({ term: 'DEATH', count: 11462 });
    const url = decodeURIComponent(String(spy.mock.calls[0][0]));
    expect(url).toContain('patient.drug.openfda.generic_name:"osimertinib"');
    expect(url).toContain('count=patient.reaction.reactionmeddrapt.exact');
    await fetchTopReactions('osimertinib');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('404 means no reports: empty list, not an error', async () => {
    mockFetch(() => MISS_404);
    await expect(fetchTopReactions('ivonescimab')).resolves.toEqual([]);
  });
});

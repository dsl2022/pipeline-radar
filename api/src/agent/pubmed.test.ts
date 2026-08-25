import { setApiBase } from '@pipeline-radar/shared/net';
import { PUBMED_MIN_INTERVAL_MS, createPubmed } from './pubmed';

// What matters here is the courtesy limit: eutils allows 3 req/s per IP and
// both production tasks share one NAT address. The throttle test asserts on
// the SCHEDULE, not on wall clock - no sleeps.

const response = (count: number) =>
  new Response(JSON.stringify({ esearchresult: { count: String(count) } }), { status: 200 });

describe('createPubmed', () => {
  beforeAll(() => setApiBase('http://upstream.test/api'));

  const harness = () => {
    // Frozen clock: what the test asserts is the SCHEDULE the throttle
    // computes, so the waits themselves are the observable, not elapsed time.
    const clock = 1_000_000;
    const calls: { url: string; at: number }[] = [];
    const waits: number[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push({ url: String(url), at: clock });
      return response(42);
    }) as typeof fetch;
    const pubmed = createPubmed({
      fetchImpl,
      now: () => clock,
      delay: async (ms) => {
        waits.push(ms);
      },
    });
    return { pubmed, calls, waits };
  };

  it('fetches a count through the service proxy', async () => {
    const { pubmed, calls } = harness();
    expect(await pubmed.count('examplemab AND melanoma')).toBe(42);
    expect(calls[0].url).toContain('http://upstream.test/api/pubmed/esearch.fcgi');
    expect(calls[0].url).toContain('retmax=0');
    // The ORIGINAL casing: PubMed's boolean operators are uppercase-only, so
    // the lowercased cache key must never be what goes on the wire.
    expect(calls[0].url).toContain(encodeURIComponent('examplemab AND melanoma'));
  });

  it('assigns concurrent requests slots the minimum interval apart', async () => {
    const { pubmed, calls, waits } = harness();
    await Promise.all([pubmed.count('term one'), pubmed.count('term two'), pubmed.count('term three')]);
    expect(calls.length).toBe(3);
    // First goes immediately; the others are pushed one interval further each.
    expect(waits).toEqual([PUBMED_MIN_INTERVAL_MS, 2 * PUBMED_MIN_INTERVAL_MS]);
  });

  it('serves repeats from cache and coalesces concurrent identical queries', async () => {
    const { pubmed, calls } = harness();
    await Promise.all([pubmed.count('same term'), pubmed.count('Same Term')]);
    await pubmed.count('same term');
    expect(calls.length).toBe(1);
  });

  it('does not cache a failure', async () => {
    let clock = 0;
    let fail = true;
    let attempts = 0;
    const pubmed = createPubmed({
      fetchImpl: (async () => {
        attempts += 1;
        if (fail) return new Response('', { status: 500 });
        return response(7);
      }) as typeof fetch,
      now: () => clock,
      delay: async (ms) => {
        clock += ms;
      },
    });
    await expect(pubmed.count('flaky')).rejects.toThrow('PubMed returned 500');
    fail = false;
    expect(await pubmed.count('flaky')).toBe(7);
    expect(attempts).toBe(2);
  });

  it('treats a response with no count as an error, never as zero', async () => {
    const pubmed = createPubmed({
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      now: () => 0,
      delay: async () => {},
    });
    await expect(pubmed.count('odd')).rejects.toThrow('no count');
  });
});

import { apiBase } from '@pipeline-radar/shared/net';
import { createInFlight } from '@pipeline-radar/shared/single-flight';

// PubMed article counts via NCBI esearch (AI-AGENT-PLAN.md tool table).
//
// eutils allows 3 requests/second per IP without an API key, and both Fargate
// tasks sit behind one NAT address — so the per-process floor is set to keep
// the WORST case (both tasks bursting simultaneously) under the shared limit,
// not just this process. The 24h cache absorbs repeats: publication counts do
// not move meaningfully inside a day.

export const PUBMED_TTL_MS = 24 * 60 * 60_000;
/** Two processes at one request per 700ms ≈ 2.9/s combined — under the 3/s cap. */
export const PUBMED_MIN_INTERVAL_MS = 700;

export interface PubmedDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test seam: resolves after ms. Production sleeps. */
  delay?: (ms: number) => Promise<void>;
  ttlMs?: number;
  minIntervalMs?: number;
}

export interface Pubmed {
  count(term: string): Promise<number>;
}

interface EsearchResponse {
  esearchresult?: { count?: string };
}

export function createPubmed(deps: PubmedDeps = {}): Pubmed {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ttlMs = deps.ttlMs ?? PUBMED_TTL_MS;
  const minIntervalMs = deps.minIntervalMs ?? PUBMED_MIN_INTERVAL_MS;

  const cache = new Map<string, { value: number; expiresAt: number }>();
  const flight = createInFlight<number>();

  // The last SCHEDULED slot, not the last completed request: concurrent
  // callers each claim the next free slot, so a burst spaces itself out
  // instead of all sleeping the same interval and firing together.
  let nextSlotAt = 0;

  async function throttled(term: string, key: string): Promise<number> {
    const wait = Math.max(0, nextSlotAt - now());
    nextSlotAt = now() + wait + minIntervalMs;
    if (wait > 0) await delay(wait);

    // The original term goes on the wire: PubMed's boolean operators are
    // uppercase-only, so the lowercased cache key must never be the query.
    const url = `${apiBase()}/pubmed/esearch.fcgi?db=pubmed&retmode=json&retmax=0&term=${encodeURIComponent(term)}`;
    const res = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`PubMed returned ${res.status}`);
    const body = (await res.json()) as EsearchResponse;
    const count = Number(body.esearchresult?.count);
    if (!Number.isFinite(count)) throw new Error('PubMed response had no count');

    cache.set(key, { value: count, expiresAt: now() + ttlMs });
    return count;
  }

  return {
    async count(term: string): Promise<number> {
      const key = term.trim().toLowerCase();
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;
      return flight.join(key, () => throttled(term.trim(), key));
    },
  };
}

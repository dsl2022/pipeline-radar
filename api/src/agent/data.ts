import { ctgovStudiesUrl, CTGOV_PAGE_SIZE, type CtgovResponse } from '@pipeline-radar/shared/ctgov';
import { mapStudy } from '@pipeline-radar/shared/mapStudy';
import type { Trial } from '@pipeline-radar/shared/types';

// The one place the agent's tools get trial data.
//
// Every tool takes a condition and comes here, rather than accepting a list of
// trials as a tool argument. That is the load-bearing choice in this file: if
// summarize_trials took trials as input, the model would have to reproduce
// several hundred rows to call it, which is both enormous and an invitation to
// invent a row that was never in the registry. Passing a condition string
// means the numbers in an answer can only have come from tested code.
//
// One page, deliberately. 500 active trials is more than any real question
// needs, and an unbounded pagination loop inside a tool call is a wall-clock
// risk the 120s turn budget cannot absorb.

export interface TrialSet {
  trials: Trial[];
  /** What the registry says exists, which may exceed what we fetched. */
  total: number;
  /** True when total > trials.length: every derived figure is a sample. */
  sampled: boolean;
}

export interface TrialData {
  search(condition: string): Promise<TrialSet>;
}

export interface TrialDataDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Matches the proxy's own registry TTL. */
  ttlMs?: number;
  timeoutMs?: number;
}

export const DATA_TTL_MS = 10 * 60_000;
export const DATA_TIMEOUT_MS = 20_000;

export function createTrialData(deps: TrialDataDeps = {}): TrialData {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DATA_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? DATA_TIMEOUT_MS;

  // Per-process, so two tools in the same turn asking about the same disease
  // cost one upstream call. The proxy caches too; this saves the loopback hop.
  const cache = new Map<string, { value: TrialSet; expiresAt: number }>();

  // Requests that have been issued but have not answered yet.
  //
  // Without this the cache only helps callers that arrive after a fetch has
  // COMPLETED, and the tool runner does not work that way: it executes every
  // tool_use block in one assistant message concurrently
  // (BetaToolRunner -> Promise.all), and parallel tool use is the default. So
  // a turn that calls summarize_trials and build_drug_landscape on the same
  // disease has both miss an empty cache in the same tick and start their own
  // registry request - doubling upstream traffic and tool latency while
  // appearing to be cached.
  //
  // Joining the in-flight promise collapses them into one call. A rejected
  // request is removed rather than remembered, so a failure is still not
  // cached and the next caller retries.
  const inFlight = new Map<string, Promise<TrialSet>>();

  async function fetchSet(condition: string, key: string): Promise<TrialSet> {
    const res = await doFetch(ctgovStudiesUrl({ condition }), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`ClinicalTrials.gov returned ${res.status}`);
    }
    const body = (await res.json()) as CtgovResponse;
    const trials = (body.studies ?? []).map(mapStudy);
    const total = body.totalCount ?? trials.length;

    const value: TrialSet = {
      trials,
      total,
      sampled: total > trials.length,
    };
    cache.set(key, { value, expiresAt: now() + ttlMs });
    return value;
  }

  return {
    async search(condition: string): Promise<TrialSet> {
      const key = condition.trim().toLowerCase();
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;

      const pending = inFlight.get(key);
      if (pending) return pending;

      const request = fetchSet(condition, key);
      inFlight.set(key, request);
      try {
        return await request;
      } finally {
        // On success the value is in `cache` before this runs, so a later
        // caller hits the cache rather than re-fetching. On failure nothing
        // was cached and the slot is simply free again.
        inFlight.delete(key);
      }
    },
  };
}

export { CTGOV_PAGE_SIZE };

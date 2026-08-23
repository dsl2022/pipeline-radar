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

  return {
    async search(condition: string): Promise<TrialSet> {
      const key = condition.trim().toLowerCase();
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;

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
    },
  };
}

export { CTGOV_PAGE_SIZE };

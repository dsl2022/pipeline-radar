import { mapStudy } from '@pipeline-radar/shared/mapStudy';
import { ctgovStudiesUrl, type CtgovResponse } from '@pipeline-radar/shared/ctgov';
import type { SearchResult } from '@pipeline-radar/shared/types';
import sampleLungCancer from '@pipeline-radar/shared/samples/lung-cancer.json';

// The request shape (base, fields, status filter, page size) lives in
// shared/ctgov.ts, because the agent issues the same search server-side and
// two field lists drift silently. The relative /api base resolves through
// Vite's dev proxy locally and CloudFront in prod (CICD-PLAN.md).

// Offline parachute: flip to true to serve the saved sample instead of the live API.
const USE_SAMPLES = false;

type RawResponse = CtgovResponse;

// Repeat searches are instant and rate-limit-safe; same pattern reused for openFDA (M4).
const cache = new Map<string, RawResponse>();

export function clearTrialsCache() {
  cache.clear();
}

export async function fetchTrials(disease: string, pageToken?: string): Promise<SearchResult> {
  let data: RawResponse;

  if (USE_SAMPLES) {
    data = sampleLungCancer as RawResponse;
  } else {
    const url = ctgovStudiesUrl({ condition: disease, pageToken });
    const cached = cache.get(url);
    if (cached) {
      data = cached;
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ClinicalTrials.gov returned ${res.status}`);
      data = await res.json();
      cache.set(url, data);
    }
  }

  return {
    trials: (data.studies ?? []).map(mapStudy),
    total: data.totalCount ?? 0,
    nextPageToken: data.nextPageToken,
  };
}

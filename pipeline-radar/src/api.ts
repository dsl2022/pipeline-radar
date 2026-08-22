import { mapStudy, type RawStudy } from '@pipeline-radar/shared/mapStudy';
import type { SearchResult } from '@pipeline-radar/shared/types';
import sampleLungCancer from '@pipeline-radar/shared/samples/lung-cancer.json';

// Relative /api base: the proxy service (api/) forwards to clinicaltrials.gov.
// Locally Vite's dev proxy does the same forwarding (vite.config.ts); in prod
// it's one CloudFront distribution routing /api/* to the ALB (CICD-PLAN.md).
const BASE = '/api/ctgov/v2/studies';

// Offline parachute: flip to true to serve the saved sample instead of the live API.
const USE_SAMPLES = false;

const FIELDS = [
  'NCTId',
  'BriefTitle',
  'OverallStatus',
  'Phase',
  'EnrollmentCount',
  'LeadSponsorName',
  'InterventionType',
  'InterventionName',
  'InterventionOtherName',
].join(',');

// "Active" = anything a consultant would count as in-play today; completed/terminated
// are excluded by design. Must stay a superset of the client-side status filter (§5/§10).
const ACTIVE_STATUSES =
  'RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION';

interface RawResponse {
  studies?: RawStudy[];
  totalCount?: number;
  nextPageToken?: string;
}

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
    const params = new URLSearchParams({
      'query.cond': disease,
      'filter.overallStatus': ACTIVE_STATUSES,
      pageSize: '500', // M3: drug rollup needs volume; research pulled 1000-size pages in seconds
      countTotal: 'true',
      fields: FIELDS,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `${BASE}?${params}`;
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

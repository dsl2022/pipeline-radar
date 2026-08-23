import { apiBase } from './net';
import type { RawStudy } from './mapStudy';

// The ClinicalTrials.gov query, in one place.
//
// This used to live in the frontend's api.ts alone. The agent now issues the
// same search server-side, and two copies of a field list is the kind of
// difference nobody notices until the agent quotes an enrollment number the
// table does not show. The request shape is the contract - it belongs with
// the mapping code that depends on it.

export const CTGOV_FIELDS = [
  'NCTId',
  'BriefTitle',
  'OverallStatus',
  'Phase',
  'EnrollmentCount',
  'LeadSponsorName',
  'InterventionType',
  'InterventionName',
  'InterventionOtherName',
] as const;

// "Active" = anything a consultant would count as in-play today;
// completed/terminated are excluded by design. Must stay a superset of the
// client-side status filter (PIPELINE-RADAR.md 5/10).
export const ACTIVE_STATUSES = [
  'RECRUITING',
  'ACTIVE_NOT_RECRUITING',
  'NOT_YET_RECRUITING',
  'ENROLLING_BY_INVITATION',
] as const;

/** The drug rollup needs volume; the registry serves pages this size in seconds. */
export const CTGOV_PAGE_SIZE = 500;

export interface CtgovResponse {
  studies?: RawStudy[];
  totalCount?: number;
  nextPageToken?: string;
}

export interface CtgovQuery {
  condition: string;
  pageToken?: string;
  pageSize?: number;
}

/** Path + query only; the base decides whether it is browser-relative or absolute. */
export function ctgovStudiesUrl(q: CtgovQuery): string {
  const params = new URLSearchParams({
    'query.cond': q.condition,
    'filter.overallStatus': ACTIVE_STATUSES.join(','),
    pageSize: String(q.pageSize ?? CTGOV_PAGE_SIZE),
    countTotal: 'true',
    fields: CTGOV_FIELDS.join(','),
  });
  if (q.pageToken) params.set('pageToken', q.pageToken);
  return `${apiBase()}/ctgov/v2/studies?${params}`;
}

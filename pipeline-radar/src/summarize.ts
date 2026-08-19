import type { Trial } from './types';

// Pure derived-data layer for milestone 2 (ARCHITECTURE §10-B). No React, no fetch —
// everything here is testable against the saved fixture. phaseRank is also the
// single source of "most advanced phase" for milestone 3's drug rollup (§7).

export const PHASE_RANK: Record<string, number> = {
  NA: 0,
  EARLY_PHASE1: 1,
  PHASE1: 2,
  PHASE2: 3,
  PHASE3: 4,
  PHASE4: 5,
};

export const PHASE_LABELS: Record<string, string> = {
  NA: 'N/A',
  EARLY_PHASE1: 'Early Phase 1',
  PHASE1: 'Phase 1',
  PHASE2: 'Phase 2',
  PHASE3: 'Phase 3',
  PHASE4: 'Phase 4',
};

// A trial ranks by its HIGHEST phase — ["PHASE2","PHASE3"] counts once, as Phase 3 (§10-B).
export function phaseRank(phases: string[]): number {
  return phases.reduce((max, p) => Math.max(max, PHASE_RANK[p] ?? 0), 0);
}

// Canonical bucket key for a trial; unknown/empty phases collapse into NA.
export function highestPhase(phases: string[]): string {
  let best = 'NA';
  for (const p of phases) {
    if (p in PHASE_RANK && PHASE_RANK[p] > PHASE_RANK[best]) best = p;
  }
  return best;
}

export interface PhaseBucket {
  key: string;
  label: string;
  count: number;
}

// Most advanced first (consultant reading order), N/A always last; zero-count buckets omitted.
export function trialsByPhase(trials: Trial[]): PhaseBucket[] {
  const counts = new Map<string, number>();
  for (const t of trials) {
    const key = highestPhase(t.phases);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.keys(PHASE_RANK)
    .sort((a, b) => PHASE_RANK[b] - PHASE_RANK[a])
    .filter((key) => key !== 'NA')
    .concat('NA')
    .filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => ({ key, label: PHASE_LABELS[key], count: counts.get(key)! }));
}

export interface SponsorCount {
  name: string;
  count: number;
}

// Exact-string grouping; known to undercount near-duplicate sponsor names (§7).
export function topSponsors(trials: Trial[], n = 8): SponsorCount[] {
  const counts = new Map<string, number>();
  for (const t of trials) counts.set(t.sponsor, (counts.get(t.sponsor) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

export interface TrialFilters {
  phases?: string[]; // highest-phase bucket keys ("PHASE3", "NA"); empty/undefined = all
  statuses?: string[]; // exact status enums; empty/undefined = all
}

export function filterTrials(trials: Trial[], filters: TrialFilters): Trial[] {
  const phases = filters.phases?.length ? new Set(filters.phases) : null;
  const statuses = filters.statuses?.length ? new Set(filters.statuses) : null;
  // No active filters ⇒ return the INPUT array, not a copy: callers rely on
  // reference equality to skip re-deriving (App reuses the filtered landscape
  // as the unfiltered one in the common no-filter case).
  if (!phases && !statuses) return trials;
  return trials.filter(
    (t) => (!phases || phases.has(highestPhase(t.phases))) && (!statuses || statuses.has(t.status)),
  );
}

export type SortKey = 'phase' | 'enrollment' | 'sponsor' | 'status';
export type SortDir = 'asc' | 'desc';

// Returns a sorted copy. Null enrollment sorts last in BOTH directions; phase sorts by rank.
export function sortTrials(trials: Trial[], key: SortKey, dir: SortDir): Trial[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...trials].sort((a, b) => {
    if (key === 'enrollment') {
      if (a.enrollment === null && b.enrollment === null) return 0;
      if (a.enrollment === null) return 1;
      if (b.enrollment === null) return -1;
      return sign * (a.enrollment - b.enrollment);
    }
    if (key === 'phase') return sign * (phaseRank(a.phases) - phaseRank(b.phases));
    return sign * a[key].localeCompare(b[key]);
  });
}

// "Load more" append with dedupe by nctId — safety net against page drift between requests.
export function mergeTrials(existing: Trial[], incoming: Trial[]): Trial[] {
  const seen = new Set(existing.map((t) => t.nctId));
  return existing.concat(incoming.filter((t) => !seen.has(t.nctId)));
}

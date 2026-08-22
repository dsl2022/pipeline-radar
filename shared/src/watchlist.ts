import type { Landscape } from './drugs/cluster';
import { fdaStatusOf, type FdaBadge, type FdaStatus } from './drugs/openfda';

// Milestone 5: watchlist snapshot + diff. One snapshot per disease, stored in
// localStorage; the differ is pure so it can be driven entirely by fixtures.
//
// Snapshots are ALWAYS taken from the UNFILTERED landscape: a watchlist tracks
// the disease, filters are a viewing lens — diffing the filtered view would
// report every filter click as pipeline churn (MILESTONE-5-PLAN.md step 3).
//
// fdaStatus keeps the codebase's three-way invariant: 'unknown' means the badge
// had not resolved at save time — unknown is never a verdict and never a flip.

export type { FdaStatus } from './drugs/openfda';

export interface DrugSnap {
  key: string;
  displayName: string;
  maxPhase: number;
  phaseLabel: string;
  trialCount: number;
  nctIds: string[];
  fdaStatus: FdaStatus;
}

export interface Snapshot {
  disease: string; // normalized — also the storage key
  savedAt: number;
  fetchedTrials: number;
  totalTrials: number;
  drugs: DrugSnap[];
}

export interface RenamePair {
  prev: DrugSnap;
  cur: DrugSnap;
}

export interface PhaseChange {
  key: string;
  displayName: string;
  from: string;
  to: string;
}

export interface NewTrials {
  key: string;
  displayName: string;
  nctIds: string[];
}

export interface LandscapeDiff {
  added: DrugSnap[];
  removed: DrugSnap[];
  renamed: RenamePair[];
  phaseAdvanced: PhaseChange[];
  phaseRegressed: PhaseChange[];
  fdaFlipped: { key: string; displayName: string }[];
  // approved → investigational: the FDA record is no longer found. Usually a
  // name-match shift rather than a real withdrawal, but the report's FDA column
  // changed either way — never silently swallowed.
  fdaReversed: { key: string; displayName: string }[];
  newlyResolved: { key: string; displayName: string; status: FdaStatus }[];
  newTrials: NewTrials[];
  caveats: string[];
  hasChanges: boolean;
}

export function diseaseKey(disease: string): string {
  return disease.trim().toLowerCase();
}

export function makeSnapshot(
  landscape: Landscape,
  fdaMap: ReadonlyMap<string, FdaBadge | null>,
  meta: { disease: string; savedAt: number; fetchedTrials: number; totalTrials: number },
): Snapshot {
  return {
    disease: diseaseKey(meta.disease),
    savedAt: meta.savedAt,
    fetchedTrials: meta.fetchedTrials,
    totalTrials: meta.totalTrials,
    drugs: landscape.drugs.map((d) => ({
      key: d.key,
      displayName: d.displayName,
      maxPhase: d.maxPhase,
      phaseLabel: d.phaseLabel,
      trialCount: d.trialCount,
      nctIds: [...d.nctIds],
      fdaStatus: fdaStatusOf(d.key, fdaMap),
    })),
  };
}

export function saveSnapshot(s: Snapshot): void {
  try {
    localStorage.setItem(`watchlist:${s.disease}`, JSON.stringify(s));
  } catch {
    /* best-effort — quota or no localStorage */
  }
}

const FDA_STATUSES = new Set<string>(['approved', 'investigational', 'unknown']);

// Full-shape validation, not just "parses": the differ and the panel dereference
// every one of these fields, so a partial write or schema drift that slipped
// through would crash render on every future search of the disease. A snapshot
// that fails ANY check is treated exactly like no watchlist.
function isValidSnapshot(s: unknown): s is Snapshot {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.disease === 'string' &&
    typeof o.savedAt === 'number' &&
    typeof o.fetchedTrials === 'number' &&
    typeof o.totalTrials === 'number' &&
    Array.isArray(o.drugs) &&
    o.drugs.every((d: unknown) => {
      if (typeof d !== 'object' || d === null) return false;
      const r = d as Record<string, unknown>;
      return (
        typeof r.key === 'string' &&
        typeof r.displayName === 'string' &&
        typeof r.maxPhase === 'number' &&
        typeof r.phaseLabel === 'string' &&
        typeof r.trialCount === 'number' &&
        Array.isArray(r.nctIds) &&
        r.nctIds.every((id: unknown) => typeof id === 'string') &&
        typeof r.fdaStatus === 'string' &&
        FDA_STATUSES.has(r.fdaStatus)
      );
    })
  );
}

export function loadSnapshot(disease: string): Snapshot | null {
  try {
    const raw = localStorage.getItem(`watchlist:${diseaseKey(disease)}`);
    if (raw === null) return null;
    const s: unknown = JSON.parse(raw);
    return isValidSnapshot(s) ? s : null;
  } catch {
    return null; // corrupted entry or no localStorage — same as no watchlist
  }
}

// Greedy one-to-one pairing of removed↔added rows by descending NCT overlap.
// Alias-vote shifts rename clusters but also merge and split them, so one added
// row can overlap several removed rows — each row may pair at most once; the
// leftover partner stays genuinely added/removed.
function pairRenames(removed: DrugSnap[], added: DrugSnap[]): RenamePair[] {
  const candidates: { overlap: number; prev: DrugSnap; cur: DrugSnap }[] = [];
  for (const prev of removed) {
    const prevIds = new Set(prev.nctIds);
    for (const cur of added) {
      const overlap = cur.nctIds.filter((id) => prevIds.has(id)).length;
      if (overlap > 0) candidates.push({ overlap, prev, cur });
    }
  }
  candidates.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      a.prev.key.localeCompare(b.prev.key) ||
      a.cur.key.localeCompare(b.cur.key),
  );
  const usedPrev = new Set<string>();
  const usedCur = new Set<string>();
  const pairs: RenamePair[] = [];
  for (const c of candidates) {
    if (usedPrev.has(c.prev.key) || usedCur.has(c.cur.key)) continue;
    usedPrev.add(c.prev.key);
    usedCur.add(c.cur.key);
    pairs.push({ prev: c.prev, cur: c.cur });
  }
  return pairs;
}

export function diffSnapshots(prev: Snapshot, cur: Snapshot): LandscapeDiff {
  const prevByKey = new Map(prev.drugs.map((d) => [d.key, d]));
  const curByKey = new Map(cur.drugs.map((d) => [d.key, d]));

  let removed = prev.drugs.filter((d) => !curByKey.has(d.key));
  let added = cur.drugs.filter((d) => !prevByKey.has(d.key));

  const renamed = pairRenames(removed, added);
  const renamedPrev = new Set(renamed.map((r) => r.prev.key));
  const renamedCur = new Set(renamed.map((r) => r.cur.key));
  removed = removed.filter((d) => !renamedPrev.has(d.key));
  added = added.filter((d) => !renamedCur.has(d.key));

  // Survivors (same key) + renamed pairs are field-diffed identically.
  const pairs: RenamePair[] = [
    ...prev.drugs.flatMap((p) => {
      const c = curByKey.get(p.key);
      return c ? [{ prev: p, cur: c }] : [];
    }),
    ...renamed,
  ];

  const phaseAdvanced: PhaseChange[] = [];
  const phaseRegressed: PhaseChange[] = [];
  const fdaFlipped: LandscapeDiff['fdaFlipped'] = [];
  const fdaReversed: LandscapeDiff['fdaReversed'] = [];
  const newlyResolved: LandscapeDiff['newlyResolved'] = [];
  const newTrials: NewTrials[] = [];

  for (const { prev: p, cur: c } of pairs) {
    if (c.maxPhase > p.maxPhase) {
      phaseAdvanced.push({ key: c.key, displayName: c.displayName, from: p.phaseLabel, to: c.phaseLabel });
    } else if (c.maxPhase < p.maxPhase) {
      phaseRegressed.push({ key: c.key, displayName: c.displayName, from: p.phaseLabel, to: c.phaseLabel });
    }
    // FDA transitions: 'unknown' on either side is never a change (an unresolved
    // badge is not a verdict), but BOTH resolved→resolved directions report —
    // approved→investigational silently vanishing would let the deliverable's
    // FDA column change under a "No changes" banner.
    if (p.fdaStatus === 'investigational' && c.fdaStatus === 'approved') {
      fdaFlipped.push({ key: c.key, displayName: c.displayName });
    } else if (p.fdaStatus === 'approved' && c.fdaStatus === 'investigational') {
      fdaReversed.push({ key: c.key, displayName: c.displayName });
    } else if (p.fdaStatus === 'unknown' && c.fdaStatus !== 'unknown') {
      newlyResolved.push({ key: c.key, displayName: c.displayName, status: c.fdaStatus });
    }
    const prevIds = new Set(p.nctIds);
    const fresh = c.nctIds.filter((id) => !prevIds.has(id));
    if (fresh.length > 0) newTrials.push({ key: c.key, displayName: c.displayName, nctIds: fresh });
  }

  const caveats: string[] = [];
  if (prev.fetchedTrials !== cur.fetchedTrials) {
    caveats.push(
      `Snapshots cover different trial depths (${prev.fetchedTrials.toLocaleString()} vs ${cur.fetchedTrials.toLocaleString()} loaded) — added/dropped drugs may reflect load depth, not the pipeline.`,
    );
  }

  // hasChanges is DERIVED from the category lists — a new category added above
  // counts toward it by construction, never via a hand-maintained OR-chain.
  const categories = {
    added,
    removed,
    renamed,
    phaseAdvanced,
    phaseRegressed,
    fdaFlipped,
    fdaReversed,
    newlyResolved,
    newTrials,
  };
  const hasChanges = Object.values(categories).some((list) => list.length > 0);

  return { ...categories, caveats, hasChanges };
}

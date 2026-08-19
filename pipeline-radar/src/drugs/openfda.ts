import { canon } from './canon';
import { brandishAliases } from './rxnorm';
import type { DrugRow } from './cluster';

// openFDA drugs@fda badge layer (milestone 4). Every rule here is measured —
// research/DATA-RESEARCH.md §6:
// - Name-based join only; the rxcui join was tested and rejected (§6.1).
// - Batched OR queries (~15 names/call), never per-row calls (§6.2).
// - TRUNCATION GUARD: absence only means MISS when the response is complete.
//   The real top-15 lung-cancer chunk returns 115 applications against
//   limit=100 (measured 2026-08-13, §6.2) — openFDA truncates silently, and an
//   un-paginated response would falsely badge approved chemo generics as
//   Investigational. Paginate with skip until total is collected; misses from
//   an incomplete union are never evaluated and never cached.
// - Correlation is case-insensitive EQUALITY against the openfda name arrays,
//   never prefix-match: a "keytruda" batch also returns KEYTRUDA QLEX, a
//   different combination product (§6.2).
// - approvalApprox: ANY ANDA in the matched set ⇒ history untrustworthy (§6.3).

export interface FdaBadge {
  status: 'approved' | 'investigational';
  approvalYear?: string; // from earliest ORIG/AP submission
  approvalApprox?: boolean; // true ⇒ render "records since <year>" (§6.3 old-generic caveat)
  sponsor?: string;
  appNumber?: string; // e.g. "BLA125514"
  appCount?: number; // "9 applications" for multi-ANDA generics
  pharmClass?: string; // openfda.pharm_class_epc[0], free bonus field
  brands?: string[];
  via: 'generic' | 'brand';
}

export interface Reaction {
  term: string;
  count: number;
}

// The three-way invariant in ONE place: key absent = pending/transport error
// (never a verdict), null = definitive miss, badge = approved. Every consumer
// (report cells, headline stats, watchlist snapshots, pending counters) must
// classify through this helper so the states can't drift apart.
export type FdaStatus = 'approved' | 'investigational' | 'unknown';

export function fdaStatusOf(key: string, fdaMap: ReadonlyMap<string, FdaBadge | null>): FdaStatus {
  if (!fdaMap.has(key)) return 'unknown';
  return fdaMap.get(key) ? 'approved' : 'investigational';
}

// Relative /api base — see api.ts; the proxy also pools openFDA's 1k/day
// per-IP quota behind a shared server-side cache.
const BASE = '/api/openfda/drug';
const TTL_MS = 24 * 60 * 60 * 1000;

const mem = new Map<string, FdaBadge | null>();
const aeMem = new Map<string, Reaction[]>();

function readStore<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    const entry = JSON.parse(raw) as { value: T; ts: number };
    if (Date.now() - entry.ts > TTL_MS) return undefined;
    return entry.value;
  } catch {
    return undefined; // no localStorage (tests, SSR) — mem cache still applies
  }
}

function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify({ value, ts: Date.now() }));
  } catch {
    /* best-effort */
  }
}

export function clearFdaCache() {
  mem.clear();
  aeMem.clear();
}

interface FdaApp {
  application_number?: string;
  sponsor_name?: string;
  submissions?: {
    submission_type?: string;
    submission_status?: string;
    submission_status_date?: string;
  }[];
  openfda?: { generic_name?: string[]; brand_name?: string[]; pharm_class_epc?: string[] };
}

interface FdaResponse {
  meta?: { results?: { total?: number } };
  results?: FdaApp[];
}

/**
 * One batched OR query, paginated to completion. Returns every application for
 * the name list, or null on a whole-query 404 (definitive: no name matched).
 * Throws on transport/5xx — including mid-pagination — so a partial union can
 * never be mistaken for a complete one (the truncation invariant).
 */
async function fetchAllApps(field: 'generic_name' | 'brand_name', names: string[]): Promise<FdaApp[] | null> {
  const search = `openfda.${field}:(${names.map((n) => `"${n}"`).join(' ')})`;
  const apps: FdaApp[] = [];
  for (;;) {
    const skip = apps.length;
    const res = await fetch(
      `${BASE}/drugsfda.json?search=${encodeURIComponent(search)}&limit=100${skip > 0 ? `&skip=${skip}` : ''}`,
    );
    if (res.status === 404) {
      if (skip === 0) return null; // miss is DATA: {"error":{"code":"NOT_FOUND"}} (§6.5)
      throw new Error('openFDA 404 mid-pagination');
    }
    if (!res.ok) throw new Error(`openFDA returned ${res.status}`);
    const data = (await res.json()) as FdaResponse;
    const page = data.results ?? [];
    apps.push(...page);
    if (apps.length >= (data.meta?.results?.total ?? apps.length)) return apps;
    if (page.length === 0) throw new Error('openFDA pagination stalled');
  }
}

function matchApps(apps: FdaApp[], field: 'generic_name' | 'brand_name', name: string): FdaApp[] {
  const target = name.toUpperCase();
  return apps.filter((a) => (a.openfda?.[field] ?? []).some((v) => v.toUpperCase() === target));
}

function buildBadge(matched: FdaApp[], via: FdaBadge['via']): FdaBadge {
  let winner = matched[0];
  let earliest: string | undefined;
  for (const app of matched) {
    for (const s of app.submissions ?? []) {
      if (s.submission_type !== 'ORIG' || s.submission_status !== 'AP' || !s.submission_status_date) continue;
      if (!earliest || s.submission_status_date < earliest) {
        earliest = s.submission_status_date;
        winner = app;
      }
    }
  }
  // ANY ANDA present ⇒ approximate. A winner-based rule would show a firm year
  // whenever the truncated history happens to land on an NDA instead (§6.3).
  const anyAnda = matched.some((a) => a.application_number?.startsWith('ANDA'));
  const brands = [...new Set(matched.flatMap((a) => a.openfda?.brand_name ?? []))];
  return {
    status: 'approved',
    approvalYear: earliest?.slice(0, 4),
    approvalApprox: anyAnda ? true : undefined,
    sponsor: winner.sponsor_name,
    appNumber: winner.application_number,
    appCount: matched.length,
    pharmClass: winner.openfda?.pharm_class_epc?.[0],
    brands: brands.length > 0 ? brands : undefined,
    via,
  };
}

/**
 * Badge every row: round 1 batches canon display names against generic_name;
 * round 2 batches brand-shaped aliases of the round-1 misses against
 * brand_name. onResult(key, badge) streams per row; null = definitive miss on
 * both rounds ⇒ Investigational. Transport errors produce NO call for the
 * affected rows — unknown ≠ investigational, and errors are never cached.
 */
export async function badgeDrugs(
  rows: DrugRow[],
  onResult: (key: string, badge: FdaBadge | null) => void,
  opts: { chunkSize?: number; isCancelled?: () => boolean } = {},
): Promise<void> {
  const { chunkSize = 15, isCancelled = () => false } = opts;

  const resolve = (key: string, name: string, badge: FdaBadge | null) => {
    mem.set(name, badge);
    writeStore(`fda:${name}`, badge);
    if (!isCancelled()) onResult(key, badge);
  };

  const pending: { row: DrugRow; name: string }[] = [];
  for (const row of rows) {
    const name = canon(row.displayName);
    if (!name) {
      if (!isCancelled()) onResult(row.key, null);
      continue;
    }
    if (mem.has(name)) {
      if (!isCancelled()) onResult(row.key, mem.get(name)!);
      continue;
    }
    const stored = readStore<FdaBadge | null>(`fda:${name}`);
    if (stored !== undefined) {
      mem.set(name, stored);
      if (!isCancelled()) onResult(row.key, stored);
      continue;
    }
    pending.push({ row, name });
  }

  // Round 1 — generic_name batches of canon display names.
  const missed: { row: DrugRow; name: string }[] = [];
  for (let i = 0; i < pending.length; i += chunkSize) {
    if (isCancelled()) return;
    const chunk = pending.slice(i, i + chunkSize);
    let apps: FdaApp[] | null;
    try {
      apps = await fetchAllApps('generic_name', chunk.map((p) => p.name));
    } catch {
      continue; // transport error: rows stay unbadged, nothing cached
    }
    for (const p of chunk) {
      const matched = apps ? matchApps(apps, 'generic_name', p.name) : [];
      if (matched.length > 0) resolve(p.row.key, p.name, buildBadge(matched, 'generic'));
      else missed.push(p);
    }
  }

  // Round 2 — brand_name batches over the misses' brand-shaped aliases.
  const rowCandidates = missed.map((p) => ({ p, candidates: brandishAliases(p.row.aliases) }));
  const brandNames = [...new Set(rowCandidates.flatMap((rc) => rc.candidates))];
  const brandStates = new Map<string, { apps: FdaApp[] | null; failed: boolean }>();

  for (let i = 0; i < brandNames.length; i += chunkSize) {
    if (isCancelled()) return;
    const chunk = brandNames.slice(i, i + chunkSize);
    try {
      const apps = await fetchAllApps('brand_name', chunk);
      for (const name of chunk) brandStates.set(name, { apps, failed: false });
    } catch {
      for (const name of chunk) brandStates.set(name, { apps: null, failed: true });
    }
  }

  for (const { p, candidates } of rowCandidates) {
    if (isCancelled()) return;
    // Default: definitive miss on both rounds. A failed brand chunk downgrades
    // the verdict to unknown (no call) unless another candidate still hits.
    let verdict: FdaBadge | null | undefined = null;
    for (const name of candidates) {
      const st = brandStates.get(name);
      if (!st || st.failed) {
        verdict = undefined;
        continue;
      }
      const matched = st.apps ? matchApps(st.apps, 'brand_name', name) : [];
      if (matched.length > 0) {
        verdict = buildBadge(matched, 'brand');
        break;
      }
    }
    if (verdict !== undefined) resolve(p.row.key, p.name, verdict);
  }
}

/**
 * FAERS drill-in (step 4): top-5 reported reactions for one canon generic name.
 * On-demand per expanded row, cached like badges. Returns [] on 404 (no
 * reports); throws on transport errors. NOTE for future edits: openFDA boolean
 * glue like +AND+ must stay LITERAL in the query string — encoding the + turns
 * it into a search term and silently returns 0 results (§6.4). This query has
 * no glue, so encoding the whole search value is safe.
 */
export async function fetchTopReactions(canonName: string): Promise<Reaction[]> {
  if (aeMem.has(canonName)) return aeMem.get(canonName)!;
  const stored = readStore<Reaction[]>(`fdaae:${canonName}`);
  if (stored !== undefined) {
    aeMem.set(canonName, stored);
    return stored;
  }
  const res = await fetch(
    `${BASE}/event.json?search=${encodeURIComponent(
      `patient.drug.openfda.generic_name:"${canonName}"`,
    )}&count=patient.reaction.reactionmeddrapt.exact`,
  );
  let top: Reaction[];
  if (res.status === 404) {
    top = [];
  } else if (!res.ok) {
    throw new Error(`openFDA returned ${res.status}`);
  } else {
    const data = (await res.json()) as { results?: Reaction[] };
    top = (data.results ?? []).slice(0, 5);
  }
  aeMem.set(canonName, top);
  writeStore(`fdaae:${canonName}`, top);
  return top;
}

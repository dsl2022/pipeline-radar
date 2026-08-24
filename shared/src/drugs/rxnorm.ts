import { apiBase } from '../net';
import { createInFlight } from '../single-flight';
import { canon, isCategoryTerm, isResearchCode } from './canon';
import type { DrugRow } from './cluster';

// RxNorm enrichment (milestone 3, cuttable layer). Rules are measured — DATA-RESEARCH §3:
// - allsrc=1 is mandatory (investigational INNs: clean-name hits 52% → 77%).
// - The exact endpoint is case-insensitive; search=2 adds nothing; both skipped.
// - NO approximateTerm/fuzzy: scores can't separate a correct typo-fix from a
//   wrong-drug neighbor code (BMS-986340 → BMS-830216).
// - A miss (HTTP 200, empty idGroup) is SIGNAL: likely investigational. null means
//   exactly that; errors are never cached and never become null.

// Resolved per call, not captured at module load - see net.ts.
const base = () => `${apiBase()}/rxnorm/rxcui.json`;

const mem = new Map<string, string | null>();

function readStore(key: string): string | null | undefined {
  try {
    const v = localStorage.getItem(`rxnorm:${key}`);
    if (v === null) return undefined;
    return v === 'MISS' ? null : v;
  } catch {
    return undefined; // no localStorage (tests, SSR) — mem cache still applies
  }
}

function writeStore(key: string, cui: string | null) {
  try {
    localStorage.setItem(`rxnorm:${key}`, cui ?? 'MISS');
  } catch {
    /* best-effort */
  }
}

// enrichTopRows runs four workers in parallel and two rows can resolve to the
// same alias, so same-name concurrent misses happen on an ordinary page load.
const inFlight = createInFlight<string | null>();

export function clearRxnormCache() {
  mem.clear();
  inFlight.clear();
}

/** Resolve one canon'd name → RxCUI, or null on a definitive miss. Throws on HTTP/network errors. */
export async function resolveRxcui(canonName: string): Promise<string | null> {
  if (!canonName) return null;
  if (mem.has(canonName)) return mem.get(canonName)!;
  const stored = readStore(canonName);
  if (stored !== undefined) {
    mem.set(canonName, stored);
    return stored;
  }
  return inFlight.join(canonName, async () => {
    const res = await fetch(`${base()}?name=${encodeURIComponent(canonName)}&allsrc=1`);
    if (!res.ok) throw new Error(`RxNorm returned ${res.status}`);
    const data = (await res.json()) as { idGroup?: { rxnormId?: string[] } };
    const cui = data.idGroup?.rxnormId?.[0] ?? null;
    mem.set(canonName, cui);
    writeStore(canonName, cui);
    return cui;
  });
}

// Brand-name fallback candidates, selected on the CANON form — raw brands arrive as
// "KEYTRUDA®"/"LORBRENA" (all-caps + glyphs), so raw-form matching would be dead code.
export function brandishAliases(aliases: string[], max = 2): string[] {
  const out: string[] = [];
  for (const alias of aliases) {
    const c = canon(alias);
    if (!/^[a-z]{4,13}$/.test(c)) continue;
    if (isResearchCode(alias) || isCategoryTerm(c)) continue;
    if (!out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** Display name first, then up to two brand-ish aliases. null = all candidates definitively missed. */
export async function resolveDrugRow(row: DrugRow): Promise<string | null> {
  const candidates = [canon(row.displayName), ...brandishAliases(row.aliases)];
  for (const name of candidates) {
    const cui = await resolveRxcui(name);
    if (cui) return cui;
  }
  return null;
}

/** Enrich the top rows with bounded concurrency; results stream via onResult. */
export async function enrichTopRows(
  rows: DrugRow[],
  onResult: (key: string, cui: string | null) => void,
  opts: { limit?: number; concurrency?: number; isCancelled?: () => boolean } = {},
): Promise<void> {
  const { limit = 30, concurrency = 4, isCancelled = () => false } = opts;
  const queue = rows.slice(0, limit);
  let next = 0;
  async function worker() {
    while (next < queue.length && !isCancelled()) {
      const row = queue[next++];
      try {
        const cui = await resolveDrugRow(row);
        if (!isCancelled()) onResult(row.key, cui);
      } catch {
        // Network/HTTP error: leave the row un-badged; never cache, never fake a miss.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

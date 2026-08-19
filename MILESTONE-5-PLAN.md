# MILESTONE-5-PLAN.md — "The consultant deliverable" implementation plan

AUDIENCE: coding agent implementing Milestone 5 in `pipeline-radar/` during the live session.
Brief (PDF): one-click export of a clean landscape summary a consultant could put in front of a client; save a search as a watchlist; on re-run, show what changed since last time.
Decisions locked with the user (2026-08-14): **Markdown export first** (download + clipboard), print-ready view behind the cut line; **one snapshot per disease** (save overwrites, diff vs last save); **drug-level diff + trial deltas** (per-drug new-NCT lists).
Reviewed 2026-08-14; review fixes folded in: three-number scope line (fetched vs filtered vs total), **watchlist snapshots/diffs the UNFILTERED landscape** (filters are a viewing lens; the watchlist tracks the disease), diff panel lives inside the drugs view only (badges only stream there), greedy one-to-one rename matching, snapshot held in React state, `rxcuiMap` actually used in the report.
PR #11 review (2026-08-16) folded in: badge pass guarded/keyed on the unfiltered landscape (split effects; zero-yield filters can no longer suppress it), full snapshot-shape validation on load, `fdaReversed` diff bucket (approved→investigational is never swallowed), pending counter spans unfiltered ∪ filtered, one clock per export (local dates, filename = body date), PDF WinAnsi transliteration + visible PDF failure state, cross-format sentences and the three-way FDA classification each own one helper.

## Definition of done

From the Drugs view: an **Export** button downloads a client-ready Markdown landscape report (and a Copy button puts the same text on the clipboard), and a **Save watchlist** button snapshots the current disease landscape. Re-running a search that has a saved snapshot shows a **"Since <date>"** diff panel: new drugs, dropped drugs, renames, phase advances, FDA flips, and per-drug new-trial counts with NCT ids. Both the report builder and the differ are pure functions with tests.

## Prior-art contract (rely on, don't rebuild)

- `Landscape` / `DrugRow` from `src/drugs/cluster.ts`: rows carry `key`, `displayName`, `phaseLabel`, `maxPhase`, `trialCount`, `sponsors` (freq-desc), `aliases`, **`nctIds`** — everything the report and the diff need; no new fetches anywhere in M5.
- `FdaBadge` from `src/drugs/openfda.ts` (`status`, `approvalYear`, `approvalApprox`, `via`); `fdaMap`/`rxcuiMap` state in `App.tsx`. Map semantics: key absent = pending/error, `null` = definitive miss — the report and snapshot must preserve that three-way distinction.
- Both enrichment layers cache by **canon name** (module `mem` + localStorage) and key results by `row.key` — so enriching two overlapping row sets costs no extra network.
- `trialsByPhase` from `src/summarize.ts` for the by-phase breakdown line; `PHASE_LABELS` / `formatStatus` for human-readable filter names in the report meta.
- localStorage read/write-with-try pattern from `openfda.ts` — copy the pattern, not the TTL (watchlists never expire).

M5 is the first milestone with **zero new APIs** — it's pure serialization + diffing of state we already trust. Tests-first is cheap here; do it.

## Step 1 — `src/report.ts` (Markdown builder, pure) — ~12 min

```ts
export interface ReportMeta {
  disease: string;
  generatedAt: Date;        // injected, never Date.now() inside — testability
  totalTrials: number;      // registry total (state.total)
  fetchedTrials: number;    // allTrials.length — true load depth
  filteredTrials: number;   // filtered.length — what the exported landscape derives from
  filters: { phases: string[]; statuses: string[] };  // human-readable labels
  phaseBuckets: PhaseBucket[];  // trialsByPhase(filtered), computed at call site
}
export function buildMarkdownReport(
  landscape: Landscape,
  fdaMap: ReadonlyMap<string, FdaBadge | null>,
  rxcuiMap: ReadonlyMap<string, string | null>,
  meta: ReportMeta,
): string
```

Report sections, in order:
1. `# Pipeline Radar — <Disease> development landscape` + generated date.
2. **Scope line (mandatory honesty, THREE numbers when filters are active):** no filters → "Based on N of M active trials loaded from ClinicalTrials.gov"; filters → "Based on F trials matching filters (<labels>), filtered from N of M active trials loaded". Never render filtered count as load depth. Plus "<excludedCount> non-drug / unspecified interventions excluded".
3. Headline stats: unique drugs, count Approved / Investigational / **pending** (pending = key absent from `fdaMap` — never fold pending into investigational), trials-by-phase one-liner from `meta.phaseBuckets`.
4. Drug table: `| Drug | Highest phase | Trials | FDA status | Lead sponsor | Also known as |`. FDA cell mirrors the UI rules exactly: `Approved <year>`, `Approved · records since <year>` when `approvalApprox`, `Investigational`, and for pending — mirror the RxNorm hint: `rxcuiMap.get(key) === null` ⇒ `— (not in RxNorm · likely investigational)`, else `—`. Aliases capped at 3 + "+n more"; sponsors → `sponsors[0]` (+ "+n" if more). **Pipe-escape and whitespace-collapse every free-text field** — drug names are trial free text.
5. Methodology footnote: name normalization is heuristic (alias voting, no transitive merge), FDA badge = drugs@fda name match (generic + brand rounds), Investigational = "no FDA approval record found", RxNorm miss = likely-investigational signal. Three sentences, not an essay.

Filename helper in the same file: `reportFilename(disease, date)` → `pipeline-radar-<slug>-<yyyy-mm-dd>.md`.

## Step 2 — export UI in the Drugs view — ~6 min

- `ExportBar` component above `DrugTable`: **Export .md** / **Copy** / **Save watchlist**. Report text built lazily at click time (`() => string` prop) so it always reflects current maps.
- Download: `new Blob([md], { type: 'text/markdown' })` → `URL.createObjectURL` → programmatic `<a download>` click → `revokeObjectURL`.
- Copy: `navigator.clipboard.writeText(md)`; flip button label to "Copied ✓" for ~1.5s.
- If `fdaMap` hasn't covered all rows yet, still export (report renders `—`), but show "n badges still loading" next to the buttons — export is never blocked on enrichment.

## Step 3 — `src/watchlist.ts` (snapshot + diff, pure core) — ~12 min

**The snapshot is taken from the UNFILTERED landscape** (`buildDrugLandscape(allTrials)`), never the filtered one: a watchlist tracks the disease, filters are a viewing lens. This kills the false-churn-on-filter-click problem at the root instead of caveating around it, and it means `Snapshot` needs no `filters` field at all.

```ts
export type FdaStatus = 'approved' | 'investigational' | 'unknown';
export interface DrugSnap {
  key: string; displayName: string; maxPhase: number; phaseLabel: string;
  trialCount: number; nctIds: string[];
  fdaStatus: FdaStatus;     // 'unknown' = badge unresolved at save time
}
export interface Snapshot {
  disease: string;            // normalized: trim().toLowerCase() — also the storage key
  savedAt: number;            // Date.now() at call site, passed in
  fetchedTrials: number; totalTrials: number;
  drugs: DrugSnap[];
}
export function makeSnapshot(landscape, fdaMap, meta): Snapshot
export function saveSnapshot(s: Snapshot): void        // localStorage['watchlist:' + disease]
export function loadSnapshot(disease: string): Snapshot | null   // corrupted/missing → null
export function diffSnapshots(prev: Snapshot, cur: Snapshot): LandscapeDiff
```

`LandscapeDiff`:
- `added: DrugSnap[]`, `removed: DrugSnap[]` — matched by `key`, after the rename pass below.
- `renamed: {prev: DrugSnap; cur: DrugSnap}[]` — **rename pass:** cluster keys come from alias voting over the loaded data, so a drug's key can legitimately shift between runs — and clusters can merge or split, so one added row may overlap several removed rows. Matching is **greedy one-to-one by descending NCT-overlap size** (ties broken deterministically by key); each row pairs at most once, leftovers stay genuinely added/removed. NCT overlap = same underlying trials = same asset; this is exactly the messy-data triage the session is judged on.
- `phaseAdvanced: {key, displayName, from, to}[]` — `maxPhase` strictly increased (label both ends). Phase *regressions* go in a separate `phaseRegressed` list — usually load-depth noise, rendered under the caveat, never as a headline.
- `fdaFlipped: {key, displayName}[]` — **only** `investigational → approved`. `unknown` on either side never counts (an unresolved badge at save time is not a flip when it resolves later); surface those as `newlyResolved` if nonzero, worded "first FDA verdict, not a change".
- `newTrials: {key, displayName, nctIds: string[]}[]` — set difference `cur.nctIds − prev.nctIds` for surviving/renamed drugs.
- `caveats: string[]` — built by the differ itself, not the UI: `prev.fetchedTrials !== cur.fetchedTrials` ⇒ "snapshots cover different trial depths (N vs M) — added/dropped may reflect load depth, not the pipeline". Comparability warnings are data, so they get tested.
- `hasChanges: boolean`.

Inner cut (drop-safe if time runs short): `phaseRegressed` and `newlyResolved` — both refinements, the core story survives without them.

## Step 4 — diff panel UI — ~8 min

- **The diff panel renders inside the drugs view only** — enrichment streams only while that view is open (`App.tsx` effect bails on `view !== 'drugs'`), so a trials-view panel would sit permanently at all-unknown and suppress every FDA flip.
- **localStorage isn't reactive:** hold the loaded snapshot in React state — `setSnapshot(loadSnapshot(disease))` on successful search, `setSnapshot(fresh)` on save. Never call `loadSnapshot` inside a memo.
- App state: `const unfilteredLandscape = useMemo(() => buildDrugLandscape(allTrials), [allTrials])`. The enrichment effect enriches `unfilteredLandscape.drugs`, plus `landscape.drugs` when filters are active — canon-name caches make the overlap free, and this keeps both the filtered table AND the snapshot fully badged.
- Diff via `useMemo`: `snapshot ? diffSnapshots(snapshot, makeSnapshot(unfilteredLandscape, fdaMap, …)) : null` on `[snapshot, unfilteredLandscape, fdaMap]` — as badges stream in, `newlyResolved`/`fdaFlipped` settle live; safe because `unknown` never produces a false flip.
- `WatchlistDiff` panel above `DrugTable`: header "Changes since <date> (saved with N trials loaded)", caveats as an amber line, then one `<details>` per nonempty category: `+3 new drugs`, `2 phase advances (Osimertinib: Phase 2 → Phase 3)`, `1 newly approved`, `4 drugs with new trials (+7 trials)`, `1 dropped`, renames — NCT ids as links.
- No changes ⇒ "No changes since <date>." — which is also what renders right after **Save watchlist** (the fresh snapshot diffs empty against itself; no extra flag needed).

## Step 5 — print-ready view — ~5 min, **CUT LINE ABOVE**

- `@media print` CSS in `App.css`: hide search form, filters, buttons, view toggle; show a print-only header (disease + date + scope line); let `DrugTable` flow. A "Print / PDF" button calling `window.print()`. That's the whole PDF story — no PDF library, browser print-to-PDF is the client handoff. If time is short, narrate it at minute 55 instead.

## Step 6 — tests (fold into Steps 1/3, tests first)

`src/report.test.ts` (small hand-built `Landscape` fixture, 4 rows covering approved / approx / investigational / pending):
- Scope line: two numbers with no filters, THREE when filters are active (filtered ≠ fetched ≠ total all present); excluded count rendered.
- FDA cells: firm year, "records since" for `approvalApprox`, `Investigational` for `null`, `—` for absent key — pending counted separately in headline stats, and pending + RxNorm-miss renders the likely-investigational hint.
- Pipe in a drug name is escaped; table stays parseable.
- `generatedAt` injected — snapshot-stable output, no `Date.now()` in the module.

`src/watchlist.test.ts` (node env has no localStorage — shim `globalThis.localStorage` in the test file):
- Roundtrip save/load; corrupted JSON and missing key → `null`.
- Diff: added / removed / phase advance (from/to labels) / regression separated from advance.
- FDA flip only on `investigational→approved`; `unknown→approved` lands in `newlyResolved`, not `fdaFlipped`.
- New-trial delta is a set difference, order-independent.
- **Rename pass:** shifted key with overlapping nctIds → `renamed`, not added+removed; disjoint nctIds → genuinely added+removed; **merge case:** two removed rows overlapping one added row produce exactly ONE rename (larger overlap wins) + one removed.
- Caveat emitted on fetchedTrials mismatch.

## Deliberate non-goals (narrate at minute 55)

- No PDF library, no backend, no scheduled re-runs — watchlist "re-run" is the user searching again; automation is the obvious next step, say so.
- One snapshot per disease, no history/picker (locked with user); localStorage only, no cross-device.
- Diff trusts cluster keys + the NCT-overlap rename pass; a drug whose trials fully turned over between snapshots will show as dropped+added — known limit, honest to state.
- Export reflects **loaded** trials only; the scope line is the fix, not fetching everything.
- Trials-view export: skip — the drug landscape IS the consultant deliverable per the brief.

## Supersessions (same commit)

- `ARCHITECTURE.md` milestone list line 24 ("Consultant deliverable — export + watchlist diff") → link this plan.

## Demo verification script (minute-55 walkthrough)

1. `npm test` — report + watchlist suites green alongside the existing ones.
2. Search "lung cancer" → Drugs → **Export .md** → open the file: scope line ("N of ~6,000 trials loaded"), headline stats, table with Approved/Investigational/`—` cells, methodology footnote. Paste the Copy output somewhere to show it matches. Toggle a phase filter, export again → three-number scope line.
3. **Save watchlist** → re-search "lung cancer" → "No changes since <time>".
4. Fake a delta live (fastest honest demo): in DevTools, edit the stored snapshot — drop one drug, lower Osimertinib's `maxPhase`, flip Pembrolizumab's `fdaStatus` to `investigational` — re-search → panel shows `1 new drug`, `1 phase advance`, `1 newly approved`, with NCT links. Narrate that in production the delta comes from time passing, and this is exactly why the differ is a pure function you can drive with fixtures.
5. Load-more before re-running → caveat line appears ("different trial depths") — the differ refuses to over-claim.
6. Toggle filters with the panel open → diff numbers do NOT churn (unfiltered snapshot semantics) — narrate why.

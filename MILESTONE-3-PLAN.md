# MILESTONE-3-PLAN.md — "One drug, one row" implementation plan

AUDIENCE: coding agent implementing Milestone 3 in `pipeline-radar/` during the live session.
Evidence base: `research/DATA-RESEARCH.md` (all §-references below point there). Do not re-derive; copy the verified regexes/constants from it.
Fits the existing architecture: `api.ts` (fetch) → `mapStudy.ts` (raw→`Trial`) → M2's `summarize.ts` (phaseRank, reused) → NEW `src/drugs/` (pure `Trial[]`→landscape) → NEW `DrugTable.tsx` (render) → NEW `drugs/rxnorm.ts` (async enrichment, cuttable).

SUPERSESSIONS (update in the SAME commit as the M3 implementation):
- `ARCHITECTURE.md` §7 is superseded on two points by measured research: (a) "Combination arms: do not string-split" → M3 DOES split combos, with category-guard + all-category fallback (research §2.2 step 4 validated this on 262 real combo names); (b) "RxNorm fuzzy (score threshold)" → fuzzy is BANNED — measured scores cannot separate good from bad (§3.2). Edit §7 to point here.
- `FRONTEND-PLAN.md`'s M3 sketch: stamp it "superseded by MILESTONE-3-PLAN.md".
- Phase ranking: do NOT introduce a new scale — reuse M2's tested `phaseRank`/`highestPhase` from `summarize.ts` (NA/unknown/empty → 0, EARLY_PHASE1 → 1, … PHASE4 → 5; rank 0 can only "win" when every member trial is rank 0, which then correctly displays "N/A").

## Goal / definition of done

Search results gain a "Drugs" view: one row per unique drug with display name, most-advanced phase, trial count, sponsors, known aliases; non-drug interventions in a visible excluded bucket; Jest goldens green. RxNorm RxCUI enrichment is a bonus layer, not on the critical path.

## Existing code contract (already true, rely on it)

- `Trial.interventions: { type: string; name: string; otherNames: string[] }[]` — otherNames already mapped (`mapStudy.ts:30`).
- `App.tsx` state machine holds `result.trials` on `kind: 'results'` — landscape derives from it with `useMemo`, no new async state needed.
- Jest + ts-jest configured; tests colocated `src/*.test.ts`; golden style already established in `mapStudy.test.ts`.

## Step 1 — `src/drugs/canon.ts` (pure string layer) — ~10 min

Exports (implementations verbatim from DATA-RESEARCH §2.2 step 2–4 / `research/cluster3.mjs`):
- `canon(s: string): string` — NFKD accent-fold → strip `®™©` → lowercase → drop `\(.*?\)` → drop route/form words → drop dose tokens → non-alnum→space → squash spaces → trim.
- `nameKey(s: string): string` — `canon(s)` with spaces removed (`MK 3475` ≡ `mk-3475` ≡ `MK3475`).
- `isResearchCode(s)` — `^[A-Z]{1,5}[- ]?\d{2,7}[A-Za-z]?$` on trimmed raw.
- `isCombo(s)` / `splitCombo(s): string[]` — detector + split regex from §2.2 step 4 (comma-split ONLY combo-flagged names).
- `isCategoryTerm(canonForm)` — blocklist regex from §2.2 step 3 (include `steroid`, `vaccine`, `cells?` — measured leaks).

Tests (write FIRST, they encode measured reality):
- `canon('Pembrolizumab (KEYTRUDA®)') === 'pembrolizumab'`
- `canon('Osimertinib 80 mg/40 mg') === 'osimertinib'`; `canon('Adebrelimab Injection') === 'adebrelimab'`
- `nameKey('MK 3475') === nameKey('MK-3475') === 'mk3475'`
- `splitCombo('Carboplatin + Pemetrexed + Pembrolizumab')` → 3 parts
- `isCategoryTerm(canon('Placebo'))`, `isCategoryTerm(canon('Platinum-based chemotherapy'))` true; `isCategoryTerm(canon('Pembrolizumab'))` false.

## Step 2 — `src/drugs/cluster.ts` (the core) — ~15 min

```ts
export interface DrugRow {
  key: string;            // cluster key (internal — never display)
  displayName: string;    // §2.2 step 6: top-trial-count single-agent raw name.
                          // Title-case ONLY when !isResearchCode(name) — otherwise 'MK-3475' becomes 'Mk-3475'.
  trialCount: number;     // UNIQUE nctIds (dedupe! same trial may mention drug twice)
  maxPhase: number;       // = phaseRank(...) max over member trials — REUSE summarize.ts, do not redefine
  phaseLabel: string;     // 'Phase 3', 'N/A', … (reuse formatPhases/highestPhase where possible)
  sponsors: string[];     // unique, by frequency desc
  aliases: string[];      // DISPLAY-FILTERED: skip isCategoryTerm/isCombo entries here too.
                          // otherNames is poisoned (§1.3: durvalumab lists "Chemoradiotherapy, Surgery") —
                          // the vote pass already skips these for clustering; the consultant-facing
                          // "Also known as" column must apply the SAME skip rules.
  nctIds: string[];
  rxcui?: string | null;  // filled by step 5; undefined = not queried, null = queried+miss
}
export interface Landscape { drugs: DrugRow[]; excludedCount: number; excludedNames: string[] }
export function buildDrugLandscape(trials: Trial[]): Landscape
```

Algorithm (DATA-RESEARCH §2.2 — alias VOTING, explicitly NO transitive union-find, §2.1):
1. Records: for each trial, each intervention with `type ∈ {DRUG, BIOLOGICAL}` (§1.2 — BIOLOGICAL is mandatory).
2. Vote pass: records whose name is single-agent AND non-category vote `nameKey(otherName) → nameKey(name)`, weight 1 per record; skip alias if combo/category.
3. Resolve `aliasMap` with BOTH guards (measured necessary): ambiguity-drop (tie between claimants ⇒ drop alias) and count-guard (never remap a key that is itself a primary name at least as frequent as the claimant — prevents the `hlx10` hijack of carboplatin).
4. Assign pass per record: category → excluded bucket; combo → `splitCombo`, resolve each non-category part — **if ZERO parts survive the category filter (e.g. `Chemotherapy + radiotherapy` is combo-flagged), the whole record goes to the excluded bucket**, never nowhere; else resolve `nameKey(name)`. Resolve = follow `aliasMap` max 3 hops.
5. Aggregate rows; `maxPhase = max(phaseRank(trial.phases))` over member trials (reuse `summarize.ts` — already tested; NA/empty/unknown = 0). Sort trialCount desc.

Golden tests (all verified true against the real corpus, §5):
- Pembrolizumab absorbs `pembrolizumab`, `Pembrolizumab (KEYTRUDA®)`, `Pembrolizumab 200 mg`, and the component from `Carboplatin + Pemetrexed + Pembrolizumab`.
- A trial with intervention `Tagrisso` + a trial with `Osimertinib` (otherNames `[AZD9291, Tagrisso]`) → ONE row, display "Osimertinib".
- Over-merge canary: `carboplatin` and `cisplatin` rows stay SEPARATE even when a combo record's otherNames lists both.
- `Placebo` / `Chemotherapy` never become drug rows; land in excluded bucket.
- All-category combo: `Chemotherapy + radiotherapy` lands in the excluded bucket (conservation-leak canary — write this test with exactly this input).
- Conservation: every DRUG/BIOLOGICAL intervention occurrence lands in ≥1 row or the excluded bucket (no silent loss). Write the invariant as an exact count equality, not `>=`, so the all-category-combo leak would have failed it.
- Trial-count dedup: one trial mentioning `Nivolumab` and `nivolumab` counts 1.
- Display hygiene: a durvalumab record with otherNames `[Chemoradiotherapy, Surgery]` → row.aliases contains NEITHER; displayName of a research-code-only cluster stays `MK-3475`, not `Mk-3475`.

## Step 3 — UI: `src/DrugTable.tsx` + view toggle in `App.tsx` — ~10 min

- Toggle `Trials (N) | Drugs (M)` above the table; landscape via `useMemo(() => buildDrugLandscape(trials), [trials])`.
- Columns: Drug · Highest phase · Trials · Sponsors (top 2, "+n more") · Also known as (first 3 aliases, title attr for rest) · Badge (render `—` placeholder; M4 fills it).
- Below table: one muted line `Excluded: N non-drug/unspecified interventions` (transparency = verification talking point).
- Reuse existing table CSS; no new styling work.

## Step 4 — more data per search (tiny `api.ts` change) — ~3 min

Landscape over 100 trials is demoable but thin. Change `pageSize` to `'500'` in `fetchTrials` (research fetched 1000-size pages in seconds; §Corpus). Show "based on N loaded trials" in the Drugs view header. CUTTABLE — everything works on 100.

M2 collisions — resolve in the SAME commit (M2 established this discipline for the status-filter widening, api.test.ts:22):
- `api.test.ts:26` pins `pageSize === '100'` — update the assertion with the change or the suite fails mid-demo.
- M2's load-more math ("cap 2–3 pages") is denominated in pages of 100 → re-denominate the cap in TRIALS (e.g. stop at ~600 loaded), not pages.
- "Showing X of Y" copy in `App.tsx` — verify it still reads correctly when the first page is 500.

## Step 5 — `src/drugs/rxnorm.ts` enrichment — ~10 min, CUT LINE ABOVE

Rules measured in §3 — do not improvise:
- `GET https://rxnav.nlm.nih.gov/REST/rxcui.json?name=<canon(displayName)>&allsrc=1` — `allsrc=1` is the single highest-leverage flag (clean-name hits 52%→77%). Miss = HTTP 200 `{"idGroup":{}}`.
- Skip `search=2` (adds 0). Skip case variants (endpoint is case-insensitive). **NO approximateTerm/fuzzy in the live session** (scores unusable; wrong-drug risk on research codes).
- On miss: retry once with up to 2 brand-ish aliases. Select on the CANON form: `canon(alias)` matches `^[a-z]{4,13}$` AND `!isResearchCode(alias)` AND `!isCategoryTerm(canon(alias))`. (Raw-form matching like `^[A-Z][a-z]+$` is dead code — real brands arrive as `KEYTRUDA®`/`LORBRENA`, all-caps with glyphs, §1.3; canon strips both.) Query with the canon form. Still miss ⇒ `rxcui: null` ⇒ show "unregistered — likely investigational" hint (M4 bridge; §3.2 "miss is signal").
- Budget: top 30 rows only, concurrency ≤4 (p50 27ms), cache `Map` + `localStorage['rxnorm:'+key]`, no expiry.
- UI: rows render instantly from local clustering; RxCUI (link to `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=<cui>`) appears progressively. State: `Map<key, string|null>` in App, updated as promises settle.

## Step 6 — stretch (only if time)

Expandable row → member trial NCT links; alias-source tooltip; the openFDA badge is now specified in MILESTONE-4-PLAN.md (batched generic→brand rounds with a truncation guard — supersedes the §4 per-name fallback chain sketched here).

## Deliberate non-goals (say them out loud, cite measurements)

- No transitive union-find — fused 174 distinct drugs in testing (§2.1).
- No fuzzy matching — a correct typo-fix scores inside the garbage band; research codes fuzzy-match to WRONG drugs (§3.2).
- No salt-form unification (Afatinib vs Afatinib Dimaleate stay separate rows) and no full-corpus RxNorm resolution (call budget, §3.3).
- Research-code rows that never resolve are EXPECTED (14% of names, ~0% RxNorm coverage) — they are real investigational assets, shown as-is.
- The `vaccine`/`cells?` blocklist entries exclude cancer vaccines and CAR-T therapies — REAL pipeline assets, deliberately out of scope for 60 minutes because their names don't cluster by these rules (each is near-unique free text). Say this out loud before an interviewer finds one in the excluded bucket; the visible excluded count is the honest surface for it.

## Demo verification script (minute-55 walkthrough)

1. `npm test` — canon + cluster goldens green.
2. Search "lung cancer" → toggle Drugs → point at Pembrolizumab row: aliases show MK-3475/Keytruda folded in; trial count > any single raw name.
3. Point at carboplatin/cisplatin as separate rows (over-merge canary held).
4. Point at excluded bucket count (nothing silently dropped).
5. If step 5 shipped: point at an RxCUI link and one "likely investigational" miss (e.g. a research code).

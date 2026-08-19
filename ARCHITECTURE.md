# Pipeline Radar — Architecture & Source of Truth

> Enter a disease → get the drug-development landscape.
> Built for the Blue Matter working session (60 min, live, AI-assisted).
> This doc is the single source of truth for decisions, data contracts, and known risks.

---

## 1. Stack

| Choice | Decision | Why |
|---|---|---|
| Frontend | **Vite + React + TypeScript** | Fast scaffold, good fit for tables/filters/charts in later milestones; TS types double as the data contract |
| Backend | **None** | All four APIs (CT.gov, RxNorm, openFDA, PubMed) send CORS headers; browser calls them directly |
| Fallback | Vite dev proxy (`server.proxy` in `vite.config.js`) | Only if a CORS wall appears live |
| Offline parachute | `USE_SAMPLES` flag in `api.js` — fixtures **statically imported** (`import lungCancer from '../samples/lung-cancer.json'`) | Demo survives dead wifi / API outage. Static import, not `fetch('/samples/…')`: root-level `samples/` isn't served by Vite, and imports can't 404 live. Fixtures are returned at the **post-wrapper** abstraction (e.g. the openFDA miss fixture yields `{approved:false}`, since the saved body has no HTTP status attached). |

## 2. Milestone ladder (from the brief)

1. **Working search** — disease in, active-trials table out ← *build first, ~10–12 min*
2. **Make it useful** — filters, sorting, pagination, summary + chart
3. **One drug, one row** — collapse trials to a drug-level landscape (the hard one)
4. **Approved vs Investigational** — openFDA badge + detail
5. **Consultant deliverable** — export + watchlist diff → see `MILESTONE-5-PLAN.md` (Markdown export from `report.ts`, unfiltered-landscape snapshots + pure differ in `watchlist.ts`)
6. **Stretch** — PubMed counts / caching / LLM narrative

## 3. Code layout

```
pipeline-radar/           ← the Vite app (npm run dev → localhost:5173)
  src/
    types.ts              ← Trial / Intervention / SearchResult — the data contract
    api.ts                ← ALL fetch/URL logic; the only file that knows endpoints; USE_SAMPLES flag
    mapStudy.ts           ← raw study JSON → flat Trial object; the only file touching raw JSON
    App.tsx               ← search state machine (idle/loading/error/results)
    TrialsTable.tsx       ← presentational
    samples/              ← copy of lung-cancer.json for the USE_SAMPLES offline flag
samples/                  ← saved real API responses (fetched 2026-08-10); reference for all milestones
```

**Rule:** everything downstream of `mapStudy` operates on the flat `Trial` type, never raw payloads.

## 4. Data contract — the `Trial` object

```js
{
  nctId: "NCT02788461",
  title: "…",                    // briefTitle, fallback "(untitled)"
  status: "RECRUITING",          // exact enum
  phases: ["PHASE2","PHASE3"],   // ARRAY; may be [], ["NA"]; render join or "N/A"
  enrollment: 78,                // or null → render "—"
  sponsor: "…",                  // free text, fallback "Unknown"
  interventions: [
    { type: "DRUG", name: "Pembrolizumab", otherNames: ["MK-3475","Keytruda"] }
  ]                              // otherNames defaults to []
}
```

Exact JSON paths (verified against `samples/lung-cancer.json`):

| Trial field | Raw path under `study.protocolSection` |
|---|---|
| nctId, title | `identificationModule.nctId / .briefTitle` |
| status | `statusModule.overallStatus` |
| phases | `designModule.phases` |
| enrollment | `designModule.enrollmentInfo.count` |
| sponsor | `sponsorCollaboratorsModule.leadSponsor.name` |
| interventions | `armsInterventionsModule.interventions[]` (`.type`, `.name`, `.otherNames[]`) |

## 5. API endpoints

### ClinicalTrials.gov v2 (primary — milestone 1)
```
GET https://clinicaltrials.gov/api/v2/studies
  ?query.cond={disease}
  &filter.overallStatus=RECRUITING,ACTIVE_NOT_RECRUITING
  &pageSize=100&countTotal=true
  &fields=NCTId,BriefTitle,OverallStatus,Phase,EnrollmentCount,LeadSponsorName,InterventionType,InterventionName,InterventionOtherName
```
- "Active" is **defined** as `RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION` — widened for M2 so the client-side status filter has a superset to filter within (see §10). Completed/terminated stay excluded: the product is the *active* landscape.
- Pagination: response `nextPageToken` → request `pageToken`. Cap at 2–3 pages with a "load more"; never fetch all pages.
- Filter enums are exact & case-sensitive. Build URLs with `URLSearchParams`.

### RxNorm (milestone 3)
```
GET https://rxnav.nlm.nih.gov/REST/rxcui.json?name={drug}                       ← exact
GET https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term={name}&maxEntries=3 ← fuzzy
```

### openFDA (milestone 4)
```
GET https://api.fda.gov/drug/drugsfda.json?search=openfda.generic_name:("n1" "n2" …)&limit=100[&skip=100…]  ← approval badges, BATCHED (~15 names/call, paginated past 100 results — see MILESTONE-4-PLAN)
GET https://api.fda.gov/drug/event.json?search=patient.drug.openfda.generic_name:"{drug}"&count=patient.reaction.reactionmeddrapt.exact  ← side effects (on-demand drill-in)
```

### PubMed (stretch)
```
GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={drug}&retmode=json&retmax=5
```

### Rate limits
| API | Limit | Mitigation |
|---|---|---|
| openFDA | 240/min, **1,000/day per IP** | batched OR queries (~15 names/call) + 24h localStorage cache — full-row coverage in ~25 calls; supersedes the earlier "badge lazily (visible rows only)" plan |
| PubMed | ~3/sec | concurrency limit |
| CT.gov, RxNorm | none published | concurrency limit 4–6, no `Promise.all` bursts |

## 6. Verified findings (from real responses in `samples/`, 2026-08-10)

- **`MK-3475` does NOT resolve in RxNorm** (`rxcui.json?name=MK-3475&allsrc=1` → empty `idGroup`).
  ⇒ Milestone 3 strategy: the trial's own `otherNames` synonym lists are the **primary** linking signal
  (they group "MK-3475" with "pembrolizumab"); RxNorm canonicalizes generic/brand names on top.
- Fuzzy match handles messy strings: `"Pembrolizumab 200mg IV"` → RxCUI `1547545` (top score).
- **openFDA 404 = "not approved", not an error** — body is `{"error":{"code":"NOT_FOUND"}}`. Fetch wrapper must map 404 → `{approved:false}`.
- lung cancer `totalCount` (measured 2026-08-10): **3,315** under the original 2-status definition; **4,189** (+874, ~26%) under the widened 4-status set (§5/§10) — the M2 default. First study already shows `phases:["NA"]`, `RADIATION` interventions, missing `otherNames`.

## 7. Edge-case decisions

**Handle in code (milestone 1):** phases array (`NA`/empty/multi), null enrollment, empty result set, URL-encoding via `URLSearchParams`.

**Handle by design (milestones 3–4):**
- Most-advanced phase = `phaseRank` in `summarize.ts` (§10-B): max over `NA:0, EARLY_PHASE1:1, PHASE1:2, PHASE2:3, PHASE3:4, PHASE4:5`. API v2 emits `phases` as an **array** (`["PHASE2","PHASE3"]`), never `PHASE1|2` combo strings — that's v1 legacy; do not implement combo entries.
- Drug landscape filters interventions to `DRUG`/`BIOLOGICAL` only.
- Placebo/comparator denylist (`placebo`, `saline`, `standard of care`…).
- ~~Combination arms: do not string-split~~ **SUPERSEDED (M3, measured):** combos ARE split into component drugs, with a category-term guard and an all-category→excluded-bucket fallback — validated on 262 real combo names, see `MILESTONE-3-PLAN.md` + `research/DATA-RESEARCH.md` §2.2. Implemented in `src/drugs/canon.ts` / `cluster.ts`.
- ~~Name-resolution triage: … → RxNorm fuzzy (score threshold) → …~~ **SUPERSEDED (M3, measured):** fuzzy is BANNED — approximateTerm scores cannot separate correct matches from wrong-drug neighbors (DATA-RESEARCH §3.2). Actual triage: local canon + alias voting (no transitive union-find — it fused 174 drugs) → RxNorm exact with `allsrc=1` → brand-alias retry → **miss = "likely investigational", shown honestly in UI**.
- Sponsor grouping is exact-string; known to undercount (Merck LLC vs Corp) — acknowledged, not fixed.

**Say at walkthrough, don't build:** server-side cache w/ 24h TTL, nightly pre-resolution job, persisted name→RxCUI table, sponsor-name canonicalization, full pagination.

## 8. Risks, ranked

1. **Milestone-3 time sink** (combination names) → pre-decided triage order + unresolved bucket.
2. **openFDA daily-limit blowout** → dedupe + lazy badge + cache.
3. **Unguarded JSON path crashes render** → all raw access confined to `mapStudy` with `??` fallbacks.
4. **Wifi/API outage live** → `USE_SAMPLES` flag + `samples/` fixtures.

## 9. Verification checklist (per milestone)

- Click an NCT link → compare row against clinicaltrials.gov registry page.
- Cross-check `totalCount` against the registry UI for the same query — apply the same 4-status filter (§5) in the registry UI, or the numbers will disagree by design (~26% on lung cancer).
- Rare disease (small set), gibberish (empty state), multi-phase trial (render).
- Milestone 3: spot-check pembrolizumab collapses MK-3475/Keytruda into one row.
- Milestone 4: one known-approved (pembrolizumab ✓) and one known-investigational drug.

## 10. Milestone 2 implementation plan (dev 2)

Split: dev 2 owns data + pure logic (A, B); dev 1 owns UI wiring (C). Charts are whoever gets there first.

**Branching:** `feature/milestone-2` cut from `feature/milestone-1-working-search` (don't wait on PR #7); retarget the M2 PR to `main` once #7 merges. The M2 PR closes **#2** and **#8** (the widened status set is #8's resolution; measurement documented in an #8 comment).

### A. Data layer — `api.ts`
- Widen server status filter to `RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION` (fetch must be a superset of what the client-side status filter can show; §5 updated). `api.test.ts` pins the exact URL contract — update that assertion **in the same commit**.
- "Load more": thread `nextPageToken` → `pageToken` (plumbing exists and is already tested — this is pure UI wiring); append pages into one `trials` array; dedupe by `nctId` as a safety net. Keep `pageSize=100`, cap 2–3 pages.
- In-memory `Map<url, response>` cache — repeat searches instant; same pattern reused for openFDA in M4.

### B. Derived-data layer — new `summarize.ts` (pure functions, no React)
- `phaseRank(phases)`: single rank map `NA < EARLY_PHASE1 < PHASE1 < PHASE2 < PHASE3 < PHASE4`; a trial's rank = its **highest** phase, so `["PHASE2","PHASE3"]` counts once (no double-counting). Shared by sort, chart buckets, and M3's most-advanced-phase.
- `trialsByPhase(trials)` → ordered `{label, count}[]`, N/A last.
- `topSponsors(trials, n=8)` → count by exact sponsor string, descending (undercount caveat per §7 stands).
- `filterTrials(trials, {phases, statuses})` + `sortTrials(trials, key, dir)`; null enrollment always sorts last; phase sorts by rank, not string.
- Verify: **Jest tests** (ts-jest harness already in place from M1) — unit cases per function + one pass over the 100-study `lung-cancer.json` fixture with pinned expected counts. This is the M2 correctness story.

### C. UI — `App.tsx` + components
- `FiltersBar`: phase + status chip groups, multi-select, "clear"; options derived from fetched data (empty phases → N/A chip).
- Sortable headers on phase / enrollment / sponsor / status; click cycles asc→desc with ▲/▼.
- "Load more" button while `nextPageToken` exists; count line stays honest: "Showing 87 (filtered from 200 fetched) of 3,412 total".
- `SummaryPanel` above the table, driven by the **filtered** set so charts and filters agree.
- Derivation chain: `useMemo(filter → sort → summarize)` — no new state.

### D. Charts
- Plain CSS horizontal bars (div width = %), no Recharts: zero install risk live, ~20 lines, sufficient for two small bar charts.

### E. Build order & cut line (20–32 min window)
1. `summarize.ts` + fixture sanity check ∥ dev 1 starts `FiltersBar`
2. Filters wired end-to-end (highest demo value)
3. Load-more + widened status fetch
4. Charts
5. Sorting last — first thing cut if squeezed.

**Narrate:** client-side filtering over fetched pages (honest at ~100–400 rows), **sorting likewise ranks only the fetched set** — "biggest trials fetched so far," not "biggest trials"; say it on screen or cut sorting entirely — highest-phase bucketing, active-only scope.

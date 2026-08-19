# Pipeline Radar — Frontend Implementation Plan

## What the brief asks of the frontend (extracted)

| Milestone | Frontend surface |
|---|---|
| 1 — Working search | Disease search input → table of trials: title, sponsor, phase, status, enrollment |
| 2 — Make it useful | Phase/status filters, column sorting, pagination (nextPageToken), summary panel: trials-by-phase + top-sponsors charts |
| 3 — One drug, one row | Toggleable "Drug landscape" view: unique drug, most advanced phase, trial count, developers |
| 4 — Approved vs experimental | Approved/Investigational badge per drug; drill-in with approval details or side-effect counts |
| 5 — Consultant deliverable | One-click export (Markdown/HTML), watchlist save + diff on re-run |
| Ground rules | Runs locally, demoable on screen share; CORS proxy is allowed but only if needed |

## Stack decision

**Vite + React + TypeScript, single page.** Recharts for the two charts (or plain CSS bars if install friction). No router, no state library — `useState` + derived data is enough for one screen. Rationale to narrate: fastest path to demoable, and the interesting work is data normalization, not app architecture.

**CORS:** ClinicalTrials.gov v2, openFDA, and RxNorm all generally send CORS headers — try direct `fetch` from the browser first. Fallback #1: load the `samples/*.json` fixtures behind the same client interface (a `?mock=1` flag). Fallback #2: Vite dev-server proxy (`server.proxy`), which is the "thin backend proxy" the brief blesses — zero extra process.

## Architecture (3 layers, one file each to start)

```
src/
  api.ts        — fetch wrappers: searchTrials(cond, filters, pageToken),
                  rxnormLookup(name), fdaApproval(name), fdaEvents(name)
                  + in-memory Map cache keyed by URL (openFDA: 1k req/day)
  model.ts      — normalization: raw study → TrialRow; trials → DrugRow[]
  App.tsx       — SearchBar, FiltersBar, TrialsTable, SummaryPanel,
                  DrugTable, ExportButton (split into files only if time allows)
```

### TrialRow normalization (from real sample shapes)
- `nctId`, `briefTitle`, `overallStatus`, `leadSponsor.name`
- `phases` is an **array** and can be `["NA"]` → display "N/A", rank lowest
- `enrollmentInfo.count` can be missing → show "—", sort as 0
- `interventions[]`: keep `{type, name}`; every field defensively optional

### Drug rollup (milestone 3 — the judged part)

> **SUPERSEDED by `MILESTONE-3-PLAN.md`** (backed by measured data in `research/DATA-RESEARCH.md`;
> implemented in `src/drugs/`). Key deltas from the sketch below: alias VOTING over trial
> `otherNames` with ambiguity/count guards replaces plain group-by (naive merging fused 174
> drugs); RxNorm is exact-only with `allsrc=1` — fuzzy is banned (measured unusable); phase
> rank reuses `summarize.ts` (`PH1/2` combo strings don't exist in API v2).

### Phase/status display maps
`PHASE3` → "Phase 3", `ACTIVE_NOT_RECRUITING` → "Active, not recruiting", etc. One const object, used by table, filters, and chart axes.

## Timeline (55 min of build)

| Time | Goal | Cut line |
|---|---|---|
| 0–8 | Scaffold Vite app; `searchTrials` hitting real API (fields-slimmed query from Postman "build against this"); fixture fallback wired | If API fights, demo on fixtures and move on |
| 8–20 | **M1 done:** table renders, loading/empty/error states | This must work before anything else |
| 20–32 | **M2:** phase+status filters (client-side on fetched set), sort, "Load more" via pageToken, phase-distribution + top-sponsors charts | Cut sorting first, then top-sponsors chart |
| 32–47 | **M3:** drug rollup — local cleanup grouping first (demoable without RxNorm), then RxNorm merge layered on | RxNorm can stay stubbed; the rank/rollup logic is the demo |
| 47–55 | **M4:** FDA badge on drug rows (cached lookups, lazy on view toggle) | Or skip → Markdown export instead (fast, high demo value) |
| 55–60 | Walkthrough: works / stubbed / next | — |

**Explicit cuts (say them out loud):** watchlist+diff, PDF export, PubMed, server-side filter round-trips (client-side filter over ~100–200 fetched trials is honest at this scale and I'll say so).

## Correctness story (they ask "how do you know it's right")
- Fixtures in `samples/` double as test data: rollup logic runnable against `lung-cancer.json` with expected counts eyeballed once
- Show a raw-count sanity check: `totalCount` from API vs rows rendered
- Drug rows keep a expandable list of source trial NCT IDs — the rollup is auditable, not a black box

## Demo-safety
- `?mock=1` flag switches every API call to fixtures — network dies, demo doesn't
- Cache every external call in a `Map` — repeat searches are instant and rate-limit-safe

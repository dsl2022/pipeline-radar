# MILESTONE-4-PLAN.md — "Approved or experimental?" implementation plan

AUDIENCE: coding agent implementing Milestone 4 in `pipeline-radar/` during the live session.
Evidence base: `research/DATA-RESEARCH.md` §4 (handoff, 2026-08-10) and **§6 (deep-dive, 2026-08-11)** — copy verified query shapes and rules from there, do not re-derive.
Decisions locked with the user: badge + approval details on every resolved row; adverse-event counts as an on-demand drill-in BEHIND THE CUT LINE; expandable-row UI.

## Definition of done

Every drug row in the Drugs view carries an **Approved** / **Investigational** badge (or stays unbadged on transport error). Clicking a row expands it inline: approval details (year, sponsor, application, drug class, brands) for approved drugs, an honest "no FDA record" line for investigational ones, and member-trial NCT links for auditability. AE drill-in only if time allows.

## Prior-art contract (rely on, don't rebuild)

- `DrugRow` from `src/drugs/cluster.ts` has `displayName` (canon-able), `aliases` (display-filtered), `key`, `nctIds`.
- `brandishAliases()` in `src/drugs/rxnorm.ts` already selects brand-shaped aliases on the canon form — REUSE it for the brand batch round.
- Enrichment-map pattern in `App.tsx` (`rxcuiMap` + streaming `useEffect`) is the template for `fdaMap`.
- `canon()` from `src/drugs/canon.ts` is the query key everywhere; localStorage cache pattern from `rxnorm.ts`.

## Step 1 — `src/drugs/openfda.ts` (the client) — ~15 min

```ts
export interface FdaBadge {
  status: 'approved' | 'investigational';
  approvalYear?: string;      // from earliest ORIG/AP; see truncation rule below
  approvalApprox?: boolean;   // true ⇒ render "records since <year>" (§6.3 old-generic caveat)
  sponsor?: string;
  appNumber?: string;         // e.g. "BLA125514"
  appCount?: number;          // "9 applications" for multi-ANDA generics
  pharmClass?: string;        // openfda.pharm_class_epc[0], free bonus
  brands?: string[];
  via: 'generic' | 'brand';
}
export async function badgeDrugs(rows: DrugRow[], onResult: (key: string, badge: FdaBadge | null) => void): Promise<void>
```

Mechanics (all verified, §6.2/§6.3):
1. Chunk rows ~15 per call. Round 1: `GET drugsfda.json?search=openfda.generic_name:("n1" "n2" …)&limit=100` with canon display names, tagging each badge `via: 'generic'`. Round 2 for round-1 misses: same with `openfda.brand_name:(…)` using `brandishAliases(row.aliases)`, tagging `via: 'brand'`.
2. **Truncation guard (BLOCKING — measured 2026-08-13):** the real top-15 lung-cancer chunk (carboplatin, paclitaxel, gemcitabine, …) returns **115 applications** — over `limit=100` on the FIRST batch of the demo search (paclitaxel alone owns 14 applications, gemcitabine 15). openFDA silently truncates; names whose applications sort past 100 would come back "absent" and be falsely badged Investigational. Rule: absence only means MISS when the response is complete — if `meta.results.total > results.length`, paginate with `skip=100, 200, …` until all results are collected (openFDA supports `skip`; 115 total = 2 calls) before evaluating absences. Chunk-splitting is the fallback if `skip` misbehaves. Never evaluate or cache misses from a truncated, un-paginated response.
3. Correlate results→rows by case-insensitive EQUALITY against any entry of `openfda.generic_name` / `openfda.brand_name` (values are UPPERCASE arrays). **Never prefix-match** — `keytruda` batch also returns `KEYTRUDA QLEX`, a different combination product.
4. Per matched row, pick the application with the EARLIEST `submissions[].submission_status_date` where `submission_type=="ORIG" && submission_status=="AP"`; set `appCount` to the number of matched applications.
5. History-truncation rule: `approvalApprox = matched set contains ANY ANDA` (deterministic and conservative). Not "winning application is an ANDA": carboplatin's earliest ORIG/AP happening to sit on an ANDA is luck — if a truncated NDA record carried the earliest date instead, the winner-based rule would render a firm "Approved 2004" for a 1989 drug. Any-ANDA-present means the drug is old enough to have generics, which is exactly when drugsfda history is untrustworthy (§6.3). BLA/NDA-only drugs (pembrolizumab, osimertinib) keep firm years; over-caution is acceptable, a false firm year is not.
6. Miss on BOTH rounds ⇒ `onResult(key, null)` ⇒ Investigational. 404 is data (`{"error":{"code":"NOT_FOUND"}}` on whole-batch miss — a batch where SOME names hit returns 200 with only the hits; the absent ones are misses, subject to rule 2). Network/5xx ⇒ no `onResult` call at all — unknown ≠ investigational, never cached.
7. Cache per canon name in memory + `localStorage['fda:'+name]` with 24h TTL (store `{badge, ts}`; miss stored as `{badge:null, ts}`).
8. Budget check: 372 rows ≈ 25 generic calls + pagination overhead (~1 extra call per ANDA-heavy chunk) + a handful of brand calls per fresh search — fine against 240/min & 1,000/day. No per-row calls, ever.

## Step 2 — badge column + `fdaMap` state — ~8 min

- `App.tsx`: `const [fdaMap, setFdaMap] = useState<ReadonlyMap<string, FdaBadge | null>>(new Map())`; extend the existing drugs-view `useEffect` to also kick off `badgeDrugs(landscape.drugs, …)` (all rows — batching makes full coverage affordable).
- `DrugTable`: new "FDA" column. Render: absent → `—`; `FdaBadge` → green chip `Approved <year>` (or `Approved · records since <year>` when `approvalApprox`); `null` → amber chip `Investigational`.
- Coherence with the RxNorm column: FDA badge is the authority for approved/investigational; the rxnorm "unregistered · likely investigational" hint remains only where the FDA answer is still `—` (pending/error). If both resolved, RxNorm column shows just the RxCUI link.

## Step 3 — expandable row — ~10 min

- Click toggles one expanded `key` (single-expand keeps it simple). Chevron on the drug name cell; `aria-expanded`.
- Expansion row: full-width `<td>` whose colSpan is DERIVED from the header column count (a `COLUMNS.length` const, not a hand-counted literal — the table is 7 columns once FDA is added, and hand-counts go stale).
  - Approved: `Approved <year> · <sponsor> · <appNumber> (<appCount> applications) · <pharmClass>` + brand list; when `via === 'brand'`, append `matched via brand <name>` (the row's generic name wasn't in FDA data — worth saying on screen).
  - Investigational: `No FDA approval record (checked generic + brand names <date>)`.
  - Both: member trials as NCT links (`row.nctIds`, cap ~10 + "+n more") — the rollup stays auditable, M3's correctness story extended.
  - Placeholder button "Side-effect profile" (Step 4; render only if Step 4 shipped).

## Step 4 — AE drill-in — ~10 min, **CUT LINE ABOVE**

- `fetchTopReactions(canonName)` → `GET drug/event.json?search=patient.drug.openfda.generic_name:"<name>"&count=patient.reaction.reactionmeddrapt.exact`, take top 5, cache like badges. On-demand per expanded row only — never eager (§6.4).
- Render with the existing `.bar-row/.bar-track` CSS from `SummaryPanel`.
- MANDATORY caveat line under the bars: "FAERS reports, not causation — includes disease outcomes; ~93% of reports are flagged serious." (measured: osimertinib 29,795/31,866).
- Encoding trap: keep `+AND+`-style boolean glue literal; `encodeURIComponent` the VALUES only — encoding the `+` silently returns 0 results (hit live, §6.4).

## Step 5 — tests (`src/drugs/openfda.test.ts`) — fold into Step 1, tests first

- Batch URL shape: one call for ≤15 rows, generic list quoted+parenthesized, `limit=100`.
- **Truncation: fixture with `meta.results.total > results.length` → absent names get NO verdict (not `null`), a `skip=100` follow-up fires, and only the paginated union is evaluated for misses.**
- Correlation: uppercase array values match case-insensitively; `KEYTRUDA QLEX` result does NOT badge a `keytruda` query row.
- Selection: multi-application fixture → earliest ORIG/AP wins, `appCount` correct; ANY ANDA in the matched set ⇒ `approvalApprox` (including when an NDA carries the earliest date).
- Miss semantics: whole-batch 404 ⇒ every queried row gets `null`; partial batch ⇒ only absent rows `null`.
- Error semantics: 500 ⇒ no results recorded, nothing cached.
- Cache: second call for a known name fires no fetch.
- Fixtures: `samples/openfda-approved-pembrolizumab.json` (real BLA record) + `research/fixtures/openfda-m4-report.json`.

## Deliberate non-goals (narrate, cite measurements)

- No RxCUI join — tested and rejected: `openfda.rxcui` is product-level only; all 9 ingredient-CUI queries 404'd (§6.1).
- No per-row openFDA calls — batching is the design (§6.2).
- `nab-paclitaxel`-class formulation mismatches and EU-only brands (Lorviqua) stay unmatched → Investigational-looking; called out in walkthrough, fixable only with a manual alias table (§4.2).
- Label endpoint (indications text) — skip; pharm_class from drugsfda covers the "what is it" need for free.
- FAERS drill-in makes no causal claims; the caveat line is part of the deliverable, not polish.

## Supersessions (same commit)

- `ARCHITECTURE.md` §5 rate-limit table: openFDA mitigation becomes "batched OR queries (~15 names/call) + 24h localStorage cache"; §6's "badge lazily (visible rows only)" is superseded by full-coverage batching.
- `MILESTONE-3-PLAN.md` step 6 stretch note ("wire the M4 openFDA badge using §4 fallback chain") → point at this plan.

## Demo verification script (minute-55 walkthrough)

1. `npm test` — openfda goldens green alongside the 64 existing.
2. Search "lung cancer" → Drugs: Pembrolizumab expands to `Approved 2014 · MERCK SHARP DOHME · BLA125514 · PD-1 Blocking Antibody` + KEYTRUDA brands.
3. Carboplatin shows `Approved · records since 2004 (9 applications)` — narrate the truncated-history honesty rule.
4. A research-code row (e.g. an AB-106-class asset) shows Investigational — and its RxNorm column already said "unregistered".
5. If Step 4 shipped: expand Osimertinib → top-5 reaction bars with the FAERS caveat visible.
6. Network kill (offline toggle): badges already rendered stay (cache); unbadged rows show `—`, not false "Investigational".

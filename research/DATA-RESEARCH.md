# DATA-RESEARCH.md — Empirical study of drug-name messiness (Milestones 3 & 4)

AUDIENCE: coding agent implementing drug-name normalization ("one drug, one row") and FDA badging in Pipeline Radar.
All numbers below were measured 2026-08-10 against live APIs. Corpus: 3,024 trials (RECRUITING + ACTIVE_NOT_RECRUITING) across 4 diseases: lung cancer (2,000 of 3,315), multiple sclerosis (613), duchenne muscular dystrophy (97), psoriasis (314).
Reproduction scripts: `research/*.mjs`. Machine-readable results: `research/fixtures/*.json`.

---

## 1. INPUT DATA CONTRACT (ClinicalTrials.gov v2, verified field paths)

Response shape (with `fields=NCTId,BriefTitle,OverallStatus,Phase,EnrollmentCount,LeadSponsorName,InterventionType,InterventionName,InterventionOtherName`):

```
study.protocolSection.identificationModule.nctId              // always present
study.protocolSection.identificationModule.briefTitle
study.protocolSection.statusModule.overallStatus              // enum, matches filter values
study.protocolSection.designModule.phases                     // string[] — MISSING on 768/3024 (25%); observational trials have no phases key
study.protocolSection.designModule.enrollmentInfo.count       // missing on 2/3024 only
study.protocolSection.sponsorCollaboratorsModule.leadSponsor.name  // missing on 0/3024
study.protocolSection.armsInterventionsModule.interventions[] // ENTIRE module missing on 326/3024 (10.8%)
  .type        // enum, see §1.2
  .name        // free text — THE messy field
  .otherNames  // string[] — present on 36% of DRUG/BIOLOGICAL interventions; avg 2.82, max 79 entries
```

### 1.1 Phase facts (measured)
- Observed values: `EARLY_PHASE1`(36) `PHASE1`(602) `PHASE2`(863) `PHASE3`(338) `PHASE4`(77) `NA`(634). Missing key: 768 trials.
- `phases` is an ARRAY; multi-phase like `["PHASE1","PHASE2"]` is common. Rank for "most advanced phase": EARLY_PHASE1=0 < PHASE1=1 < PHASE2=2 < PHASE3=3 < PHASE4=4; NA/missing → rank -1, display "N/A", never let it win "most advanced".

### 1.2 InterventionType distribution (all 3,024 trials, 6,172 interventions)
`DRUG` 3393, `OTHER` 818, `PROCEDURE` 473, `BIOLOGICAL` 460, `BEHAVIORAL` 263, `RADIATION` 231, `DEVICE` 214, `DIAGNOSTIC_TEST` 207, `DIETARY_SUPPLEMENT` 42, `GENETIC` 36, `COMBINATION_PRODUCT` 35.
- MUST include BOTH `DRUG` and `BIOLOGICAL` (12% of drug-like interventions are BIOLOGICAL — pembrolizumab/nivolumab are frequently typed BIOLOGICAL). Filtering to DRUG only silently drops major assets.
- 1,245/2,000 lung-cancer trials (62%) have ≥1 DRUG/BIOLOGICAL intervention; per-disease drug share varies (MS: 36%, DMD: 41%, psoriasis: 62%).

### 1.3 Messiness taxonomy of intervention `.name` (2,000 unique raw names, DRUG+BIOLOGICAL)
Strata (mutually exclusive, in priority order; counts of unique names):
| category | count | share | example |
|---|---|---|---|
| clean single-agent | 673 | 34% | `Pembrolizumab`, `carboplatin` |
| other/odd | 471 | 24% | `Consolidation durvalumab`, `Rescue Medications` |
| researchCode `^[A-Z]{1,5}[- ]?\d{2,7}[A-Za-z]?$` | 288 | 14% | `MK-3475`, `PF-07934040`, `AB-106` |
| combo | 262 | 13% | `Carboplatin + Pemetrexed + Pembrolizumab`, `Pemetrexed/Cisplatin` |
| dose/route suffix | 178 | 9% | `Osimertinib 80 mg/40 mg`, `Adebrelimab Injection` |
| parenthetical | 128 | 6% | `Pembrolizumab (KEYTRUDA®)`, `HER3-DXd (FL-DP)` |

Other measured facts:
- Case/trim duplicates: 2,000 raw → 1,905 after lowercase+trim (89 collision groups, e.g. `carboplatin`/`Carboplatin`/`CARBOPLATIN`).
- Registry contains genuine TYPOS: `Loratinib` (= lorlatinib, confirmed via its otherName `LORBRENA`), `CYCLOPHOSPHAMIDE and FLUDARABIN`.
- Non-ASCII present (®, ™, accents) on ~2% of names.
- Placebo/sham arms appear AS interventions: lung 53, MS 62, DMD 15, psoriasis 68 occurrences — placebo share is much higher outside oncology. Must be excluded from the drug landscape (or shown in an excluded bucket).
- `otherNames` is the SYNONYM GOLDMINE: e.g. `Pembrolizumab → [MK-3475, KEYTRUDA®, SCH 900475]`, `Nivolumab → [BMS-936558, MDX-1106, NIVO, ONO-4538, Opdivo]`. It links generic ↔ research code ↔ brand WITHOUT any API call.
- BUT otherNames is also POISONED: some records stuff combo partners or category terms into it (`Consolidation durvalumab → [Chemoradiotherapy, Surgery]`; a Camrelizumab record lists `cisplatin, carboplatin, pemetrexed, apatinib` as "other names"). Never trust it blindly — see §2.

---

## 2. CLUSTERING ALGORITHM — validated design + measured failure modes

### 2.1 NEGATIVE RESULT (do not do this)
Naive transitive union-find on `name ∪ otherNames` catastrophically over-merges: biggest "cluster" = **174 distinct drugs fused** (pembrolizumab + bevacizumab + carboplatin + tislelizumab + …). 40 bridge records cause it; worst hubs: `Chemotherapy` (aliases: paclitaxel, carboplatin, oxaliplatin…), `Best Available Therapy (BAT)` (7 MS drugs), `Platinum-based chemotherapy`, `Escalation Therapies Group` (16 MS brand names), plus combo records whose aliases list their components. TRANSITIVITY IS THE ENEMY.

### 2.2 VALIDATED ALGORITHM (v3, measured: 2,000 raw names → 1,424 clusters; top clusters verified correct by inspection)
Pipeline order matters. Reference implementation: `research/cluster3.mjs` (lift `canon`, guards, alias voting from there).

1. **Filter** interventions to `type ∈ {DRUG, BIOLOGICAL}`.
2. **canon(s)**: NFKD-fold accents → strip `®™©` → lowercase → drop parentheticals `\(.*?\)` → drop route/form words `(injection|tablet|capsule|oral|solution|infusion|intravenous|subcutaneous|topical|cream|ointment|gel|patch|iv|sc)` → drop dose tokens `\d+(\.\d+)?\s*(mg|mcg|ug|g|ml|%|iu|units?)(\/(m2|kg|ml|day|dose))?` → non-alphanumeric → single space → trim. Key form additionally squashes spaces (`mk 3475` ≡ `mk-3475` ≡ `MK3475`).
3. **Category blocklist** (219/2000 names excluded): regex on canon form: `chemotherapy|chemoradiotherapy|immunotherapy|radiotherapy|radiation|surgery|placebo|standard of care|soc|best supportive care|targeted therapy|physician s choice|investigator s choice|treatment|therapy|regimen|platinum|doublet|steroid|vaccine|cells?` (extend as seen; `steroid` was a measured leak in v2). Route these to a visible "non-drug / unspecified" bucket, don't silently drop.
4. **Combo split** (262/2000 names): if `isCombo` (`[+]|\bplus\b|\bin combination with\b|\bcombined with\b|\band\b|\bwith\b|(\w\s*\/\s*\w` but not `\d\/\d`)`) → split on `\s*(?:\+|\/|\bplus\b|\band\b|\bwith\b|,)\s*`, canon each part, drop category-term parts, link the trial to EACH component cluster. Caveat: comma-split only combo-flagged names (IUPAC chemical names contain commas but live in otherNames, not primary names).
5. **Alias voting, NOT union-find**: only records whose primary name is single-agent AND non-category may contribute `otherName → primaryKey` votes, weighted by trial count. Skip alias if combo or category term. Resolve each alias to its top-voted primary. Then two measured guards:
   - **Ambiguity drop** (18 aliases): if top two claimants tie, drop the alias entirely.
   - **Count guard** (66 hijacks blocked): never remap key K → P if K itself occurs as a primary name at least as often as P. Without this, one sponsor's `HLX10` record that lists `carboplatin` in otherNames makes carboplatin's whole cluster key = `hlx10`.
6. **Display name**: highest-trial-count single-agent raw name in the cluster (canon form, title-cased). Never use the graph key.
7. **Cluster row** = {displayName, trialCount (mentions), most advanced phase over member trials (§1.1 ranking), sponsors set, aliases set, rxcui?, fdaStatus?}.

### 2.3 Expected output scale (for UI/perf decisions)
Lung cancer alone: 1,490 unique raw names → ≈1,050 clusters; long tail is 1-trial research codes. Top-30 clusters by trial count cover the drugs a consultant cares about. Sort default: trial count desc.

---

## 3. RXNORM — measured behavior (rxnav.nlm.nih.gov)

Latency: p50 27ms, p90 36ms, max 2.4s (n=453). No key. ~20 req/s tolerated at concurrency 5.

### 3.1 Hit rates by category (n=185 stratified real names)
| category | exact (default) | exact + `allsrc=1` | note |
|---|---|---|---|
| clean single-agent | 52% (31/60) | **77% (46/60)** | allsrc=1 adds investigational INNs (anlotinib, camrelizumab, glecirasib…) |
| brand (from otherNames) | 60% (15/25) | 60% | misses are EU brands (Lorviqua) — RxNorm is US-centric |
| researchCode | 0% (0/40) | 5% (2/40) | MK-3475, AZD9291 miss even with allsrc=1 |
| dose/route suffix | 12% | 12% | must canon() BEFORE calling |
| parenthetical | 5% | 5% | must canon() BEFORE calling |
| combo | 7% | 7% | must split BEFORE calling |

### 3.2 Endpoint rules (all verified)
- USE: `GET /REST/rxcui.json?name=<canonName>&allsrc=1` → `idGroup.rxnormId[0]`. Empty `{"idGroup":{}}` = miss (HTTP 200, not 404).
- Exact endpoint is ALREADY case-insensitive (`keytruda` ≡ `KEYTRUDA` → 1547550). Do not waste a call on case variants.
- `search=2` (normalized mode) added **0 hits over exact across all 185 names** — skip it entirely.
- FUZZY `GET /REST/approximateTerm.json?term=X&maxEntries=3`: scores are NOT percentages. Measured: perfect string match scores ≈ 9–12; garbage scores ≈ 5–9; a correct 1-char-typo match (`Loratinib`→lorlatinib rxcui 2103164) scores ≈ 10 — INSIDE the garbage band. **Score thresholds cannot separate good from bad.**
  - Fuzzy on research codes is ACTIVELY WRONG: `BMS-986340`→`BMS-830216`, `SY-5007`→`SY-5609`, `AOC 1044`→`AOC 1001` (different drugs, plausible-looking). NEVER fuzzy-match a research-code-shaped name.
  - Safe acceptance rule: accept fuzzy candidate only if canon(candidate.name) == canon(query) OR canon(candidate.name) token-set ⊆ canon(query) token-set (handles `Oral MRT-2359`→`MRT-2359`, `Adebrelimab Injection`→`Adebrelimab`, `QL1706 plus chemotherapy`→`QL1706`). Candidates may omit `name` — resolve display via `GET /REST/rxcui/{cui}/property.json?propName=RxNorm%20Name`.
- **A miss is signal, not failure**: post-canon, post-alias RxNorm miss ⇒ very likely investigational/new compound (brief says decide how to handle misses — badge it "Investigational (unregistered)" and keep local cluster identity).

### 3.3 Call-budget strategy
1,490 unique lung-cancer names ≈ 75s of sequential calls — do NOT resolve everything. Resolve top-N (30–50) clusters by trial count, on demand, cached (in-memory + localStorage keyed by canon name; entries never invalidate mid-session). Local clustering (§2) does the heavy lifting first; RxNorm only enriches/confirms.

---

## 4. OPENFDA HANDOFF (Milestone 4) — measured on 26 cases

Rate limits: 240/min, 1,000/DAY per IP — the DAILY cap is the real constraint; query cluster-level names only, cache hard, throttle ≥300ms between calls in dev loops.
Miss = **HTTP 404** with `{"error":{"code":"NOT_FOUND"}}` (matches `samples/openfda-miss-404.json`) — handle as data, not exception.

### 4.1 Fallback chain (validated)
```
1. GET drugsfda.json?search=openfda.generic_name:"<name>"&limit=1   // quote the value; multiword generics work ("sacituzumab govitecan" ✓)
2. on 404 → search=openfda.brand_name:"<name>"                      // Keytruda, Tagrisso, Lorbrena, Stelara all hit here only
3. on 404 → MISS ⇒ badge "Investigational"
```
Measured outcomes: ALL 13 US-approved generics hit via generic_name (incl. datopotamab deruxtecan, approved 2024; afatinib base name hits despite salt-form "afatinib dimaleate"). All 5 US brands hit via brand_name. All investigational (anlotinib, camrelizumab [China-approved ⇒ still "Investigational" by FDA lens — correct behavior], ivonescimab), all research codes, and ALL raw messy strings (`Pembrolizumab (KEYTRUDA®)`, `Osimertinib 80 mg`, combos) MISS. ⇒ **normalize before FDA, never query raw names.**

### 4.2 Known mismatches (document in UI as caveat, don't over-engineer)
- `nab-paclitaxel`: misses generic_name AND brand_name AND products.active_ingredients.name — FDA files it as "PACLITAXEL PROTEIN-BOUND PARTICLES…" (brand Abraxane). Fix only via tiny manual alias table if demoed.
- EU-only brands (Lorviqua) miss — US-centric, same as RxNorm.
- Useful response fields: `results[0].application_number`, `.sponsor_name`, `.products[0].marketing_status`, `.openfda.brand_name[]`, `.openfda.generic_name[]`. Older approvals may LACK the `openfda` section — that's why step-1 search can 404 for a drug that is in fact approved; acceptable known gap.
- Side-effect counts (M4 nice-to-have): `GET drug/event.json?search=patient.drug.openfda.generic_name:"X"&count=patient.reaction.reactionmeddrapt.exact` → top reactions with counts (see `samples/openfda-adverse-events.json`).

---

## 5. RECOMMENDED BUILD ORDER + VERIFICATION (for the live session)

1. Local pipeline §2 only (pure functions, no network): canon → blocklist → combo split → alias vote → cluster. Testable offline against `research/fixtures/unique-drug-names.json` (real 2,000-name corpus with otherNames + categories).
2. Wire drug-table UI from clusters (one drug, one row: name, phase, #trials, sponsors).
3. RxNorm enrichment for top-N visible clusters (§3), cached.
4. openFDA badge (§4), cached.

Golden assertions (all verified true in this corpus — use as unit tests):
- Cluster containing `Pembrolizumab` also absorbs raw mentions `pembrolizumab`, `Pembrolizumab (KEYTRUDA®)`, `Pembrolizumab 200 mg`, and combo components from `Carboplatin + Pemetrexed + Pembrolizumab`.
- `Tagrisso` folds into the osimertinib cluster (via otherNames alias voting).
- `carboplatin` and `cisplatin` remain SEPARATE clusters (over-merge canary — v1 fused them).
- `Placebo`, `Chemotherapy`, `Immunotherapy` never appear as drug rows.
- Total trial-mention count before clustering == sum over clusters + excluded bucket (no silent loss).
- RxNorm: `keytruda` → rxcui 1547550; `Anlotinib` → 1939861 only with `allsrc=1`; `MK-3475` → miss (expected).
- openFDA: `pembrolizumab` hits generic_name; `Keytruda` only brand_name; `ivonescimab` 404 ⇒ Investigational.

Failure-mode talking points (measured, citable in demo): 174-drug mega-cluster from naive union-find; carboplatin key hijack without count guard; BMS-986340→BMS-830216 wrong-drug fuzzy match; 25% of trials have no phase field.

---

## 6. MILESTONE 4 DEEP-DIVE (measured 2026-08-11; script `research/openfda-m4.mjs`, results `research/fixtures/openfda-m4-report.json`)

### 6.1 RxCUI join — TESTED AND REJECTED
`drugsfda` records DO carry `openfda.rxcui`, but it holds PRODUCT-level CUIs only (Keytruda record: `[1657746, 1657749, 1657750, 1657751]`), never the INGREDIENT-level CUI that M3's rxnorm.ts resolves (pembrolizumab = 1547545). All 9 ingredient-CUI searches (`openfda.rxcui:"<cui>"`) returned 404, including for definitively approved drugs. Bridging ingredient→product CUIs via RxNav `/rxcui/{cui}/related` would add a call chain for zero gain over name batching (§6.2). **The M3→M4 join is name-based, full stop**: canon displayName → generic_name; brandish aliases → brand_name.

### 6.2 BATCHING — the rate-limit solution (verified)
`search=openfda.generic_name:("pembrolizumab" "osimertinib" "durvalumab")&limit=100` → HTTP 200, all 4 applications in ONE call. Space-separated quoted list inside parens = OR. Same syntax verified for `openfda.brand_name:("keytruda" "tagrisso" "lorbrena")`.
- Batching by rxcui returned 404 for every syntax variant (consistent with §6.1).
- **Badge strategy: 2 calls per batch of ~15 rows** — round 1: generic batch of canon display names; round 2: brand batch of brandish aliases for round-1 misses. 372 lung-cancer rows ≈ 25–30 calls total vs 1,000/day. Chunk at ~15 names/call (URL length safety); `limit=100` (one generic can own many applications, §6.3).
- **TRUNCATION (measured 2026-08-13): the realistic top-15 lung-cancer chunk returns 115 applications — OVER limit=100 on the first batch of the demo search** (paclitaxel alone: 14 applications; gemcitabine: 15; carboplatin: 9). openFDA truncates silently. Absence from a response only means MISS when `meta.results.total <= results.length`; otherwise paginate with `skip` (supported) until complete before judging absences — else approved chemo generics get badged Investigational.
- **Correlation back to rows**: result `openfda.generic_name`/`brand_name` values are UPPERCASE arrays. Match by case-insensitive equality of ANY array entry against the queried name. Brand round needs exact-match-first: querying `keytruda` also returns brand `KEYTRUDA QLEX` — a DIFFERENT product (generic `PEMBROLIZUMAB AND BERAHYALURONIDASE ALFA-PMPH`). Never prefix-match brands.

### 6.3 One generic ≠ one application — selection rule
- carboplatin → **9 applications** (8 ANDA generics + 1 NDA). nivolumab → OPDIVO + OPDIVO QVANTIG + **OPDUALAG** (the nivolumab+relatlimab combo). pembrolizumab → 2 BLAs (original 125514 + 2025 subcutaneous 761467).
- **Rule**: group results per matched name; the drug's card uses the application with the EARLIEST ORIG/AP submission date; keep `appCount` for display ("9 applications").
- Approval date = `submissions[]` where `submission_type=="ORIG" && submission_status=="AP"` → `submission_status_date` (string `YYYYMMDD`). Verified correct: pembrolizumab `20140904`, osimertinib `20151113`, durvalumab `20170501`.
- **Old-generic caveat (measured)**: submissions history is TRUNCATED for old drugs — carboplatin's earliest ORIG/AP in the API is `20041014`, real approval 1989. Display rule: NDA/BLA with ORIG/AP → "Approved <year>"; ANDA-only or suspiciously-late earliest date on a known-old generic → "Approved (records since <year>)". Never present the earliest ANDA date as THE approval date.
- Free bonus fields in the same response: `openfda.pharm_class_epc` (e.g. "Programmed Death Receptor-1 Blocking Antibody [EPC]"), `sponsor_name`, `products[].marketing_status` ("Prescription"/"Discontinued"), full `openfda.brand_name` list.

### 6.4 Adverse events endpoint (drill-in)
- `GET /drug/event.json?search=patient.drug.openfda.generic_name:"<name>"&count=patient.reaction.reactionmeddrapt.exact` → `results: [{term, count}]` sorted desc. Osimertinib top-5: DEATH 11,462; MALIGNANT NEOPLASM PROGRESSION 3,354; DIARRHOEA 1,677; DRUG RESISTANCE 1,096; FATIGUE 1,037.
- **UI caveat is mandatory**: FAERS reactions include disease outcomes (DEATH, PROGRESSION) — reports, not causation. And reporting is serious-biased: osimertinib 29,795 of 31,866 reports (93%) flagged `serious:1`.
- AND syntax trap (hit it live): `+AND+` must keep literal `+` in the query string — `encodeURIComponent` over the whole query encodes `+`→`%2B` and silently returns 0 results. Encode values, not the boolean glue.
- One count-call per drill-in, on demand, cached — never eager.

### 6.5 Transport facts
- CORS: `access-control-allow-origin: *` on api.fda.gov (measured) — browser-direct works, no proxy.
- Miss = HTTP 404 `{"error":{"code":"NOT_FOUND"}}` (unchanged from §4). Post-normalization 404 on BOTH batch rounds ⇒ "Investigational". Network/5xx error ⇒ UNKNOWN (no badge), never cached, never conflated with a 404 miss.
- Cache badge results in localStorage with ~24h TTL (approvals change slowly; FAERS counts drift but the drill-in is per-click anyway).

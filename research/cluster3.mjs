// v2: diagnose over-merge bridges, then guarded clustering.
import { readFileSync, writeFileSync } from 'node:fs';

const names = JSON.parse(readFileSync(new URL('./unique-drug-names.json', import.meta.url)));

function canon(s) {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™©]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(injection|tablet|capsule|oral|solution|infusion|intravenous|subcutaneous|topical|cream|ointment|gel|patch|iv|sc)\b/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|ug|g|ml|%|iu|units?)(\/(m2|kg|ml|day|dose))?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const codeKey = s => canon(s).replace(/ /g, '');

const COMBO_SPLIT = /\s*(?:\+|\/|\bplus\b|\band\b|\bwith\b|\bin combination with\b|\bcombined with\b|,)\s*/i;
const isCombo = s => /[+]|\bplus\b|\bin combination with\b|\bcombined with\b|\band\b|\bwith\b/i.test(s) || (/\w\s*\/\s*\w/.test(s) && !/\d\/\d/.test(s));
const CATEGORY_TERM = /\b(chemotherapy|chemoradiotherapy|immunotherapy|radiotherapy|radiation|surgery|placebo|standard of care|soc|best supportive care|targeted therapy|car t|physician s choice|investigator s choice|treatment|therapy|drug|vaccine|cells?|regimen|platinum|doublet)\b/;

// --- diagnose v1 bridges: records whose alias set contains >=2 aliases that are ALSO primary names of other records
const primaryKeys = new Set(names.map(r => codeKey(r.name)).filter(Boolean));
const bridges = [];
for (const rec of names) {
  const aliasHits = rec.otherNames.map(codeKey).filter(k => k && k !== codeKey(rec.name) && primaryKeys.has(k));
  if (new Set(aliasHits).size >= 2) bridges.push({ name: rec.name, bridgesTo: [...new Set(aliasHits)].slice(0, 8), nAliases: rec.otherNames.length });
}
bridges.sort((a, b) => b.bridgesTo.length - a.bridgesTo.length);

// --- guarded clustering v2 ---
// Rule: NO transitive union. Build alias->canonical votes only from single-agent, non-category names.
// Then each raw name resolves: category? -> excluded bucket. combo? -> split to components, resolve each. else canon key -> canonical id via alias map.
const aliasVotes = new Map(); // aliasKey -> Map(primaryKey -> weight)
for (const rec of names) {
  const nameC = canon(rec.name);
  const nameK = codeKey(rec.name);
  if (!nameK || isCombo(rec.name) || CATEGORY_TERM.test(nameC)) continue;
  for (const o of rec.otherNames) {
    const oC = canon(o);
    const oK = codeKey(o);
    if (!oK || oK === nameK || CATEGORY_TERM.test(oC) || isCombo(o)) continue;
    if (!aliasVotes.has(oK)) aliasVotes.set(oK, new Map());
    const m = aliasVotes.get(oK);
    m.set(nameK, (m.get(nameK) ?? 0) + rec.count);
  }
}
// frequency of each key as a PRIMARY name (sum of rec.count for single-agent records)
const primaryFreq = new Map();
for (const rec of names) {
  if (isCombo(rec.name) || CATEGORY_TERM.test(canon(rec.name))) continue;
  const k = codeKey(rec.name);
  if (!k) continue;
  primaryFreq.set(k, (primaryFreq.get(k) ?? 0) + rec.count);
}

// resolve alias -> winning primary (ambiguous aliases claimed by 2+ primaries with similar weight are dropped)
// COUNT GUARD: never remap an alias that is itself a primary name at least as common as the claimant.
const aliasMap = new Map();
let ambiguousAliases = 0, countGuardBlocked = 0;
for (const [oK, votes] of aliasVotes) {
  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[1][1] >= sorted[0][1]) { ambiguousAliases++; continue; }
  const winner = sorted[0][0];
  if ((primaryFreq.get(oK) ?? 0) >= (primaryFreq.get(winner) ?? 0)) { countGuardBlocked++; continue; }
  aliasMap.set(oK, winner);
}
// canonical id: follow aliasMap once (a primary may itself be an alias of a more common primary)
function resolveKey(k) {
  let cur = k, seen = 0;
  while (aliasMap.has(cur) && aliasMap.get(cur) !== cur && seen < 3) { cur = aliasMap.get(cur); seen++; }
  return cur;
}

const clusters = new Map(); // canonicalKey -> {rawNames:[], count, displayVotes}
const excluded = { category: [], comboOnly: 0 };
let comboRecords = 0, componentLinks = 0;
for (const rec of names) {
  const nameC = canon(rec.name);
  if (!nameC) continue;
  if (CATEGORY_TERM.test(nameC) && !isCombo(rec.name)) { excluded.category.push(rec.name); continue; }
  const parts = isCombo(rec.name) ? rec.name.split(COMBO_SPLIT).map(canon).filter(p => p && !CATEGORY_TERM.test(p)) : [nameC];
  if (isCombo(rec.name)) { comboRecords++; componentLinks += parts.length; }
  for (const p of parts) {
    const key = resolveKey(p.replace(/ /g, ''));
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, { rawNames: new Set(), count: 0, displayVotes: new Map() });
    const c = clusters.get(key);
    c.rawNames.add(rec.name);
    c.count += rec.count;
    // display name: vote with the canon form of single-agent raw names only
    if (!isCombo(rec.name)) {
      const disp = canon(rec.name);
      c.displayVotes.set(disp, (c.displayVotes.get(disp) ?? 0) + rec.count);
    }
  }
}

const multi = [...clusters.entries()].filter(([, c]) => c.rawNames.size > 1)
  .sort((a, b) => b[1].rawNames.size - a[1].rawNames.size);

const out = {
  v1_bridgeRecords: bridges.length,
  v1_topBridges: bridges.slice(0, 10),
  v3: {
    uniqueRawNames: names.length,
    clusters: clusters.size,
    mergedGroups: multi.length,
    ambiguousAliasesDropped: ambiguousAliases,
    countGuardBlocked,
    categoryTermsExcluded: excluded.category.length,
    comboRecordsSplit: comboRecords,
    topClusters: multi.slice(0, 15).map(([k, c]) => ({
      key: k,
      display: [...c.displayVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? k,
      size: c.rawNames.size, trialMentions: c.count, rawNames: [...c.rawNames].slice(0, 6),
    })),
  },
};
writeFileSync(new URL('./cluster3-report.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1).slice(0, 7000));

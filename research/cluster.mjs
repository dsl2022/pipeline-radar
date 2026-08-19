// How far does LOCAL-ONLY normalization get? (no RxNorm)
// Strategy under test: canonicalize string -> union-find on (name ∪ otherNames) alias sets.
import { readFileSync, writeFileSync } from 'node:fs';

const names = JSON.parse(readFileSync(new URL('./unique-drug-names.json', import.meta.url)));

// --- canonicalizer under test ---
export function canon(s) {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')      // accents
    .replace(/[®™©]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')                                // drop parentheticals for keying
    .replace(/\b(injection|tablet|capsule|oral|solution|infusion|intravenous|subcutaneous|topical|cream|ointment|gel|patch|for|iv|sc)\b/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|ug|g|ml|%|iu|units?)(\/(m2|kg|ml|day|dose))?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')                             // unify hyphen/space: mk 3475 == mk-3475 == mk3475? no: keep spaces then squash
    .replace(/\s+/g, ' ')
    .trim();
}
// research-code squash: "mk 3475" -> "mk3475"
function codeKey(s) {
  const c = canon(s).replace(/ /g, '');
  return c;
}

// junk aliases seen in otherNames that would wrongly merge clusters
const JUNK_ALIAS = /^(chemotherapy|chemoradiotherapy|surgery|radiation|placebo|none|na|n\/a|standard of care|soc|immunotherapy|targeted therapy)$/;

// union-find
const parent = new Map();
function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
function makeset(x) { if (!parent.has(x)) parent.set(x, x); }
function union(a, b) { makeset(a); makeset(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }

// each record: key by codeKey(name); union with codeKey of each otherName
let junkSkipped = 0;
for (const rec of names) {
  const k = codeKey(rec.name);
  if (!k) continue;
  makeset(k);
  for (const o of rec.otherNames) {
    const ok = codeKey(o);
    if (!ok) continue;
    if (JUNK_ALIAS.test(canon(o))) { junkSkipped++; continue; }
    union(k, ok);
  }
}

// map each raw name -> cluster root
const clusters = new Map();
for (const rec of names) {
  const k = codeKey(rec.name);
  if (!k) continue;
  const root = find(k);
  if (!clusters.has(root)) clusters.set(root, { rawNames: [], count: 0, aliases: new Set() });
  const c = clusters.get(root);
  c.rawNames.push(rec.name);
  c.count += rec.count;
  rec.otherNames.forEach(o => c.aliases.add(o));
}

const multi = [...clusters.values()].filter(c => c.rawNames.length > 1);
const biggest = [...clusters.values()].sort((a, b) => b.rawNames.length - a.rawNames.length).slice(0, 12)
  .map(c => ({ size: c.rawNames.length, trialMentions: c.count, rawNames: c.rawNames.slice(0, 10) }));

const out = {
  uniqueRawNames: names.length,
  clustersAfterLocal: clusters.size,
  mergedGroups: multi.length,
  namesAbsorbedByMerging: names.length - clusters.size,
  junkAliasesSkipped: junkSkipped,
  biggestClusters: biggest,
};
writeFileSync(new URL('./cluster-report.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));

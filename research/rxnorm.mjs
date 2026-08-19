// RxNorm hit-rate study: stratified sample of real intervention names.
// Endpoints: rxcui.json (exact), rxcui.json?search=2 (normalized), approximateTerm.json (fuzzy).
import { readFileSync, writeFileSync } from 'node:fs';

const names = JSON.parse(readFileSync(new URL('./unique-drug-names.json', import.meta.url)));

const RESEARCH_CODE = /^[A-Z]{1,5}[- ]?\d{2,7}[A-Za-z]?$/;
const isCombo = s => /[+]|\bplus\b|\bin combination with\b|\bcombined with\b|\band\b|\bwith\b/i.test(s) || (/\w\s*\/\s*\w/.test(s) && !/\d\/\d/.test(s));
const hasDoseRoute = s => /\b\d+(\.\d+)?\s*(mg|mcg|ug|g|ml|%|iu)\b/i.test(s) || /\b(injection|tablet|oral|IV|intravenous|subcutaneous)\b/i.test(s);
const hasParen = s => /\(.+\)/.test(s);

// stratify
function categorize(n) {
  if (isCombo(n)) return 'combo';
  if (RESEARCH_CODE.test(n.trim())) return 'researchCode';
  if (hasDoseRoute(n)) return 'doseRoute';
  if (hasParen(n)) return 'parenthetical';
  if (/^[A-Za-z][a-z]+([ -][A-Za-z][a-z]+){0,2}$/.test(n.trim())) return 'clean';
  return 'other';
}

const byCat = {};
for (const r of names) {
  const c = categorize(r.name);
  (byCat[c] ??= []).push(r);
}
// deterministic spread: sort by count desc, take every kth to mix common+rare
function sample(arr, n) {
  const sorted = [...arr].sort((a, b) => b.count - a.count);
  const step = Math.max(1, Math.floor(sorted.length / n));
  return sorted.filter((_, i) => i % step === 0).slice(0, n);
}
const SAMPLE = [
  ...sample(byCat.clean ?? [], 60).map(r => ({ ...r, cat: 'clean' })),
  ...sample(byCat.researchCode ?? [], 40).map(r => ({ ...r, cat: 'researchCode' })),
  ...sample(byCat.doseRoute ?? [], 25).map(r => ({ ...r, cat: 'doseRoute' })),
  ...sample(byCat.parenthetical ?? [], 20).map(r => ({ ...r, cat: 'parenthetical' })),
  ...sample(byCat.combo ?? [], 15).map(r => ({ ...r, cat: 'combo' })),
];
// plus brand names harvested from otherNames (title-case single words that aren't codes)
const brandish = new Set();
for (const r of names) for (const o of r.otherNames) {
  const t = o.replace(/[®™]/g, '').trim();
  if (/^[A-Z][a-z]{3,12}$/.test(t) && !RESEARCH_CODE.test(t)) brandish.add(t);
}
[...brandish].slice(0, 25).forEach(b => SAMPLE.push({ name: b, count: 0, cat: 'brandFromOtherNames' }));

console.error(`sample size: ${SAMPLE.length}`, Object.entries(byCat).map(([k, v]) => `${k}:${v.length}`).join(' '));

const BASE = 'https://rxnav.nlm.nih.gov/REST';
async function timed(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) return { ms, status: res.status, json: null };
  return { ms, status: 200, json: await res.json() };
}

const results = [];
let inFlight = 0;
async function testName(rec) {
  const enc = encodeURIComponent(rec.name);
  const exact = await timed(`${BASE}/rxcui.json?name=${enc}`);
  const exactCui = exact.json?.idGroup?.rxnormId?.[0] ?? null;
  let normCui = null, norm = null, fuzzy = null, fuzzyTop = null;
  if (!exactCui) {
    norm = await timed(`${BASE}/rxcui.json?name=${enc}&search=2`);
    normCui = norm.json?.idGroup?.rxnormId?.[0] ?? null;
  }
  if (!exactCui && !normCui) {
    fuzzy = await timed(`${BASE}/approximateTerm.json?term=${enc}&maxEntries=3`);
    const cand = fuzzy.json?.approximateGroup?.candidate ?? [];
    if (cand.length) fuzzyTop = { rxcui: cand[0].rxcui, score: Number(cand[0].score), name: cand[0].name ?? null, rank: cand[0].rank };
  }
  return {
    name: rec.name, cat: rec.cat, trialCount: rec.count,
    exactCui, normCui, fuzzyTop,
    latency: { exact: exact.ms, norm: norm?.ms ?? null, fuzzy: fuzzy?.ms ?? null },
  };
}

// concurrency 5
const queue = [...SAMPLE];
async function worker() {
  while (queue.length) {
    const rec = queue.shift();
    try { results.push(await testName(rec)); }
    catch (e) { results.push({ name: rec.name, cat: rec.cat, error: String(e) }); }
  }
}
await Promise.all(Array.from({ length: 5 }, worker));

// summarize
const summary = {};
for (const r of results) {
  const s = (summary[r.cat] ??= { n: 0, exact: 0, normalized: 0, fuzzyHi: 0, fuzzyLo: 0, miss: 0, errors: 0 });
  s.n++;
  if (r.error) { s.errors++; continue; }
  if (r.exactCui) s.exact++;
  else if (r.normCui) s.normalized++;
  else if (r.fuzzyTop && r.fuzzyTop.score >= 60) s.fuzzyHi++;
  else if (r.fuzzyTop) s.fuzzyLo++;
  else s.miss++;
}
const lat = results.flatMap(r => Object.values(r.latency ?? {}).filter(Boolean));
lat.sort((a, b) => a - b);
const out = {
  summary,
  latencyMs: { n: lat.length, p50: lat[Math.floor(lat.length * .5)], p90: lat[Math.floor(lat.length * .9)], max: lat[lat.length - 1] },
  results,
};
writeFileSync(new URL('./rxnorm-report.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ summary, latencyMs: out.latencyMs }, null, 1));

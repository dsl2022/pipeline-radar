// M4 deep-dive: RxCUI join viability, batch-OR syntax, multi-ANDA selection,
// approval-date extraction, AE shape, CORS headers.
import { writeFileSync } from 'node:fs';

const B = 'https://api.fda.gov/drug';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  const ms = Math.round(performance.now() - t0);
  const cors = res.headers.get('access-control-allow-origin');
  let json = null;
  try { json = await res.json(); } catch {}
  await sleep(280);
  return { status: res.status, ms, cors, json };
}

const out = {};

// ---- Test 1: ingredient-level RxCUI join --------------------------------
// RxCUIs are what M3's rxnorm.ts actually resolved (live smoke test values).
const RXCUI = {
  carboplatin: '40048', pembrolizumab: '1547545', pemetrexed: '68446',
  durvalumab: '1919503', osimertinib: '1721560', nivolumab: '1597876',
  gemcitabine: '12574', anlotinib_INV: '1939861', camrelizumab_INV: '2169823',
};
out.rxcuiJoin = {};
for (const [name, cui] of Object.entries(RXCUI)) {
  const r = await get(`${B}/drugsfda.json?search=${encodeURIComponent(`openfda.rxcui:"${cui}"`)}&limit=1`);
  out.rxcuiJoin[name] = { cui, status: r.status, total: r.json?.meta?.results?.total ?? 0,
    matchedGeneric: r.json?.results?.[0]?.openfda?.generic_name?.[0] ?? null };
  console.log('rxcui', name, cui, '->', r.status, out.rxcuiJoin[name].total, out.rxcuiJoin[name].matchedGeneric);
}

// ---- Test 2: batch OR syntax --------------------------------------------
const batchVariants = [
  ['space-list', `openfda.rxcui:("40048" "1547545" "1721560")`],
  ['plus-OR', `openfda.rxcui:"40048"+openfda.rxcui:"1547545"+openfda.rxcui:"1721560"`],
  ['explicit-OR', `openfda.rxcui:"40048" OR openfda.rxcui:"1547545" OR openfda.rxcui:"1721560"`],
];
out.batch = {};
for (const [label, q] of batchVariants) {
  const r = await get(`${B}/drugsfda.json?search=${encodeURIComponent(q)}&limit=100`);
  const gens = new Set((r.json?.results ?? []).flatMap((x) => x.openfda?.generic_name ?? []));
  out.batch[label] = { status: r.status, total: r.json?.meta?.results?.total ?? 0, generics: [...gens].slice(0, 6) };
  console.log('batch', label, r.status, out.batch[label].total, out.batch[label].generics.join('|'));
}
// batch by generic_name too (for rows without an rxcui)
{
  const q = `openfda.generic_name:("pembrolizumab" "osimertinib" "durvalumab")`;
  const r = await get(`${B}/drugsfda.json?search=${encodeURIComponent(q)}&limit=100`);
  const gens = new Set((r.json?.results ?? []).flatMap((x) => x.openfda?.generic_name ?? []));
  out.batch['generic-space-list'] = { status: r.status, total: r.json?.meta?.results?.total ?? 0, generics: [...gens] };
  console.log('batch generic-space-list', r.status, out.batch['generic-space-list'].total);
}

// ---- Test 3: multi-application generic (carboplatin) --------------------
{
  const r = await get(`${B}/drugsfda.json?search=${encodeURIComponent('openfda.generic_name:"carboplatin"')}&limit=100`);
  const apps = (r.json?.results ?? []).map((x) => ({
    app: x.application_number, sponsor: x.sponsor_name,
    origDates: (x.submissions ?? []).filter((s) => s.submission_type === 'ORIG' && s.submission_status === 'AP').map((s) => s.submission_status_date),
  }));
  const kinds = apps.reduce((m, a) => { const k = a.app?.slice(0, 4); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const earliest = apps.flatMap((a) => a.origDates).sort()[0];
  out.carboplatin = { total: r.json?.meta?.results?.total, kinds, earliestOrigAP: earliest, sample: apps.slice(0, 3) };
  console.log('carboplatin apps:', JSON.stringify(out.carboplatin.kinds), 'earliest ORIG/AP:', earliest);
}
// sort param support?
{
  const r = await get(`${B}/drugsfda.json?search=${encodeURIComponent('openfda.generic_name:"carboplatin"')}&sort=${encodeURIComponent('submissions.submission_status_date:asc')}&limit=1`);
  out.sortSupport = { status: r.status, error: r.json?.error?.message ?? null };
  console.log('sort support:', r.status, out.sortSupport.error);
}

// ---- Test 4: approval-date extraction on single-app biologics ------------
out.approvalDates = {};
for (const g of ['pembrolizumab', 'osimertinib', 'durvalumab']) {
  const r = await get(`${B}/drugsfda.json?search=${encodeURIComponent(`openfda.generic_name:"${g}"`)}&limit=5`);
  const recs = (r.json?.results ?? []).map((x) => ({
    app: x.application_number, sponsor: x.sponsor_name,
    marketing: x.products?.[0]?.marketing_status,
    origAP: (x.submissions ?? []).filter((s) => s.submission_type === 'ORIG' && s.submission_status === 'AP').map((s) => s.submission_status_date).sort()[0] ?? null,
    hasSubmissions: !!x.submissions,
  }));
  out.approvalDates[g] = { total: r.json?.meta?.results?.total, recs };
  console.log('approval', g, JSON.stringify(recs));
}

// ---- Test 5: AE counts + serious breakdown -------------------------------
{
  const r = await get(`${B}/event.json?search=${encodeURIComponent('patient.drug.openfda.generic_name:"osimertinib"')}&count=patient.reaction.reactionmeddrapt.exact`);
  out.aeShape = { status: r.status, top5: (r.json?.results ?? []).slice(0, 5) };
  console.log('AE top5 osimertinib:', JSON.stringify(out.aeShape.top5));
  const r2 = await get(`${B}/event.json?search=${encodeURIComponent('patient.drug.openfda.generic_name:"osimertinib"+AND+serious:1')}&limit=1`);
  out.aeSerious = { status: r2.status, total: r2.json?.meta?.results?.total ?? 0 };
  const r3 = await get(`${B}/event.json?search=${encodeURIComponent('patient.drug.openfda.generic_name:"osimertinib"')}&limit=1`);
  out.aeAll = { status: r3.status, total: r3.json?.meta?.results?.total ?? 0 };
  console.log('AE serious/total:', out.aeSerious.total, '/', out.aeAll.total);
}

// ---- Test 6: combination-product noise (nivolumab → Opdualag?) ----------
{
  const r = await get(`${B}/drugsfda.json?search=${encodeURIComponent('openfda.generic_name:"nivolumab"')}&limit=10`);
  const brands = new Set((r.json?.results ?? []).flatMap((x) => x.openfda?.brand_name ?? []));
  out.comboNoise = { total: r.json?.meta?.results?.total, brands: [...brands] };
  console.log('nivolumab brands:', [...brands].join('|'));
}

// ---- Test 7: CORS header (browser viability) -----------------------------
{
  const r = await get(`${B}/drugsfda.json?search=${encodeURIComponent('openfda.generic_name:"pembrolizumab"')}&limit=1`);
  out.cors = { allowOrigin: r.cors };
  console.log('CORS allow-origin:', r.cors);
}

writeFileSync(new URL('./openfda-m4-report.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('DONE');

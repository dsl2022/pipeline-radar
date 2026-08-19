// M4 handoff: does a normalized drug name resolve in openFDA drugsfda?
// Strategy under test: generic_name -> brand_name -> active_ingredients fallback chain.
import { writeFileSync } from 'node:fs';

const CASES = [
  // approved, clean generic (expect generic_name hit)
  { name: 'pembrolizumab', expect: 'approved' },
  { name: 'osimertinib', expect: 'approved' },
  { name: 'carboplatin', expect: 'approved' },
  { name: 'lorlatinib', expect: 'approved' },
  { name: 'sacituzumab govitecan', expect: 'approved-multiword' },
  { name: 'ustekinumab', expect: 'approved' },
  { name: 'durvalumab', expect: 'approved' },
  { name: 'amivantamab', expect: 'approved' },
  { name: 'guselkumab', expect: 'approved' },
  { name: 'datopotamab deruxtecan', expect: 'approved-2024' },
  { name: 'nab-paclitaxel', expect: 'formulation-name-mismatch' },
  { name: 'temozolomide', expect: 'approved' },
  { name: 'afatinib', expect: 'salt-form: afatinib dimaleate' },
  // brand names (expect brand_name hit, generic miss)
  { name: 'Keytruda', expect: 'brand' },
  { name: 'Tagrisso', expect: 'brand' },
  { name: 'Lorbrena', expect: 'brand' },
  { name: 'Lorviqua', expect: 'EU-brand-miss' },
  { name: 'Stelara', expect: 'brand' },
  // investigational (expect total miss = Investigational badge)
  { name: 'anlotinib', expect: 'investigational (China-approved)' },
  { name: 'camrelizumab', expect: 'investigational (China-approved)' },
  { name: 'ivonescimab', expect: 'investigational' },
  { name: 'MK-3475', expect: 'research-code-miss' },
  { name: 'AZD9291', expect: 'research-code-miss' },
  // raw messy strings (expect miss -> must normalize first)
  { name: 'Pembrolizumab (KEYTRUDA®)', expect: 'messy-miss' },
  { name: 'Osimertinib 80 mg', expect: 'messy-miss' },
  { name: 'Carboplatin + Pemetrexed + Pembrolizumab', expect: 'messy-miss' },
];

const B = 'https://api.fda.gov/drug/drugsfda.json';
async function q(field, name) {
  const t0 = performance.now();
  const url = `${B}?search=${encodeURIComponent(`${field}:"${name}"`)}&limit=1`;
  const res = await fetch(url);
  const ms = Math.round(performance.now() - t0);
  if (res.status === 404) return { hit: false, ms };
  if (!res.ok) return { hit: false, ms, http: res.status };
  const j = await res.json();
  const r0 = j.results?.[0];
  return {
    hit: true, ms, total: j.meta?.results?.total,
    appNo: r0?.application_number,
    sponsor: r0?.sponsor_name,
    genericName: r0?.openfda?.generic_name?.slice(0, 2),
    brandName: r0?.openfda?.brand_name?.slice(0, 2),
    marketingStatus: r0?.products?.[0]?.marketing_status,
    hasOpenfda: !!r0?.openfda && Object.keys(r0.openfda).length > 0,
  };
}

const out = [];
for (const c of CASES) {
  const generic = await q('openfda.generic_name', c.name);
  let brand = null, ingredient = null;
  if (!generic.hit) brand = await q('openfda.brand_name', c.name);
  if (!generic.hit && !brand?.hit) ingredient = await q('products.active_ingredients.name', c.name);
  const via = generic.hit ? 'generic_name' : brand?.hit ? 'brand_name' : ingredient?.hit ? 'active_ingredients' : 'MISS';
  const winner = generic.hit ? generic : brand?.hit ? brand : ingredient?.hit ? ingredient : null;
  out.push({ name: c.name, expect: c.expect, via, detail: winner, latencies: { generic: generic.ms, brand: brand?.ms, ingredient: ingredient?.ms } });
  console.log(`${c.name.padEnd(42)} via=${via.padEnd(18)} expect=${c.expect}`);
  await new Promise(r => setTimeout(r, 300)); // stay far under 240/min
}
writeFileSync(new URL('./openfda-report.json', import.meta.url), JSON.stringify(out, null, 2));

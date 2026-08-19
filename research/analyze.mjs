// Messiness taxonomy over intervention names.
import { readFileSync, writeFileSync } from 'node:fs';

const SLUGS = ['lung-cancer', 'multiple-sclerosis', 'duchenne-muscular-dystrophy', 'psoriasis'];

const corpora = SLUGS.map(s => JSON.parse(readFileSync(new URL(`./corpus-${s}.json`, import.meta.url))));

// --- pattern detectors -------------------------------------------------
const PATTERNS = {
  combo: v => /[+]|\bplus\b|\bin combination with\b|\bcombined with\b/i.test(v) || /\w\s*\/\s*\w/.test(v) && !/\d\/\d/.test(v),
  dose: v => /\b\d+(\.\d+)?\s*(mg|mcg|µg|ug|g|ml|mL|%|iu|IU|units?)\b/i.test(v) || /\bdose\b|\bQD\b|\bBID\b|\bQ\dW\b/i.test(v),
  researchCode: v => /\b[A-Z]{1,4}[- ]?\d{2,7}\b/.test(v) && !/\bphase\b/i.test(v),
  parenthetical: v => /\(.+\)/.test(v),
  placeboArm: v => /\bplacebo\b|\bsham\b|\bvehicle\b/i.test(v),
  routeForm: v => /\b(oral|IV|intravenous|subcutaneous|SC|topical|tablet|capsule|injection|infusion|solution|cream|ointment|gel|patch)\b/i.test(v),
  trailingWhitespace: v => v !== v.trim(),
  multiSpace: v => /\s{2,}/.test(v.trim()),
  nonAscii: v => /[^\x00-\x7F]/.test(v),
  allCaps: v => v === v.toUpperCase() && /[A-Z]{4,}/.test(v),
  veryLong: v => v.length > 60,
};

const agg = {};
const allDrugNames = new Map(); // name -> {diseases:Set, count, otherNames:Set, sponsors:Set, categories:Set}
const typeCounts = {};
const phaseValues = new Map();
const statusValues = new Map();
const otherNamesStats = { withOther: 0, withoutOther: 0, totalOtherNames: 0, maxOtherNames: 0, examples: [] };
const nullStats = { noInterventions: 0, noPhase: 0, emptyPhaseArr: 0, naPhase: 0, noEnrollment: 0, noSponsor: 0, trials: 0 };

for (const corpus of corpora) {
  const dz = corpus.disease;
  const a = agg[dz] = {
    trials: corpus.studies.length,
    trialsWithDrugInterv: 0,
    interventionsTotal: 0,
    drugInterventions: 0,
    uniqueDrugNames: new Set(),
    categoryCounts: Object.fromEntries(Object.keys(PATTERNS).map(k => [k, 0])),
    categoryExamples: Object.fromEntries(Object.keys(PATTERNS).map(k => [k, []])),
  };

  for (const s of corpus.studies) {
    nullStats.trials++;
    const p = s.protocolSection ?? {};
    const design = p.designModule ?? {};
    const phases = design.phases;
    if (phases == null) nullStats.noPhase++;
    else if (phases.length === 0) nullStats.emptyPhaseArr++;
    else phases.forEach(ph => phaseValues.set(ph, (phaseValues.get(ph) ?? 0) + 1));
    if (phases?.includes('NA')) nullStats.naPhase++;
    if (design.enrollmentInfo?.count == null) nullStats.noEnrollment++;
    const sponsor = p.sponsorCollaboratorsModule?.leadSponsor?.name;
    if (!sponsor) nullStats.noSponsor++;
    const status = p.statusModule?.overallStatus;
    statusValues.set(status, (statusValues.get(status) ?? 0) + 1);

    const interventions = p.armsInterventionsModule?.interventions;
    if (!interventions || interventions.length === 0) { nullStats.noInterventions++; continue; }
    let hasDrug = false;
    for (const iv of interventions) {
      a.interventionsTotal++;
      typeCounts[iv.type] = (typeCounts[iv.type] ?? 0) + 1;
      if (iv.type !== 'DRUG' && iv.type !== 'BIOLOGICAL') continue;
      hasDrug = true;
      a.drugInterventions++;
      const name = iv.name ?? '';
      a.uniqueDrugNames.add(name);

      if (iv.otherNames?.length) {
        otherNamesStats.withOther++;
        otherNamesStats.totalOtherNames += iv.otherNames.length;
        if (iv.otherNames.length > otherNamesStats.maxOtherNames) otherNamesStats.maxOtherNames = iv.otherNames.length;
        if (otherNamesStats.examples.length < 15) otherNamesStats.examples.push({ name, otherNames: iv.otherNames });
      } else otherNamesStats.withoutOther++;

      let rec = allDrugNames.get(name);
      if (!rec) allDrugNames.set(name, rec = { diseases: new Set(), count: 0, otherNames: new Set(), sponsors: new Set(), categories: new Set() });
      rec.diseases.add(dz); rec.count++;
      (iv.otherNames ?? []).forEach(o => rec.otherNames.add(o));
      if (sponsor) rec.sponsors.add(sponsor);

      for (const [k, fn] of Object.entries(PATTERNS)) {
        if (fn(name)) {
          a.categoryCounts[k]++;
          rec.categories.add(k);
          if (a.categoryExamples[k].length < 8) a.categoryExamples[k].push(name);
        }
      }
    }
    if (hasDrug) a.trialsWithDrugInterv++;
  }
  a.uniqueDrugNames = a.uniqueDrugNames.size;
}

// case-collision check: names identical modulo case/trim
const norm = new Map();
for (const name of allDrugNames.keys()) {
  const key = name.trim().toLowerCase();
  if (!norm.has(key)) norm.set(key, []);
  norm.get(key).push(name);
}
const caseCollisions = [...norm.values()].filter(v => v.length > 1);

// same drug appearing under different raw names, detectable via shared otherNames
const report = {
  perDisease: agg,
  typeCounts,
  phaseValues: Object.fromEntries(phaseValues),
  statusValues: Object.fromEntries(statusValues),
  nullStats,
  otherNamesStats: { ...otherNamesStats, avgWhenPresent: (otherNamesStats.totalOtherNames / Math.max(1, otherNamesStats.withOther)).toFixed(2) },
  uniqueRawNames: allDrugNames.size,
  uniqueAfterCaseTrimFold: norm.size,
  caseCollisionGroups: caseCollisions.length,
  caseCollisionExamples: caseCollisions.slice(0, 10),
};
writeFileSync(new URL('./taxonomy-report.json', import.meta.url), JSON.stringify(report, null, 2));

// dump unique names + otherNames for RxNorm testing
const namesDump = [...allDrugNames.entries()].map(([name, r]) => ({
  name, count: r.count, diseases: [...r.diseases], otherNames: [...r.otherNames], categories: [...r.categories],
}));
writeFileSync(new URL('./unique-drug-names.json', import.meta.url), JSON.stringify(namesDump, null, 2));

console.log(JSON.stringify({ ...report, caseCollisionExamples: report.caseCollisionExamples.slice(0, 5) }, (k, v) => k === 'categoryExamples' ? undefined : v, 1).slice(0, 6000));

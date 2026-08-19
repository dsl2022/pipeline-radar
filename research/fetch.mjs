// Pull trial corpora for 4 diseases from ClinicalTrials.gov v2.
import { writeFileSync } from 'node:fs';

const DISEASES = [
  'lung cancer',                    // huge, drug-heavy oncology
  'multiple sclerosis',             // mixed drug/device/behavioral
  'duchenne muscular dystrophy',    // rare, research-code-heavy
  'psoriasis',                      // mid-size, many approved drugs
];

const FIELDS = [
  'NCTId', 'BriefTitle', 'OverallStatus', 'Phase', 'EnrollmentCount',
  'LeadSponsorName', 'InterventionType', 'InterventionName', 'InterventionOtherName',
].join(',');

const BASE = 'https://clinicaltrials.gov/api/v2/studies';

async function pull(disease) {
  const all = [];
  let pageToken;
  let total = 0;
  // up to 2 pages x 1000 = 2000 trials max per disease
  for (let page = 0; page < 2; page++) {
    const params = new URLSearchParams({
      'query.cond': disease,
      'filter.overallStatus': 'RECRUITING,ACTIVE_NOT_RECRUITING',
      pageSize: '1000',
      countTotal: 'true',
      fields: FIELDS,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${BASE}?${params}`);
    if (!res.ok) throw new Error(`${disease}: HTTP ${res.status}`);
    const data = await res.json();
    total = data.totalCount ?? total;
    all.push(...(data.studies ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return { disease, total, fetched: all.length, studies: all };
}

for (const d of DISEASES) {
  const out = await pull(d);
  const slug = d.replace(/\s+/g, '-');
  writeFileSync(new URL(`./corpus-${slug}.json`, import.meta.url), JSON.stringify(out));
  console.log(`${d}: totalCount=${out.total} fetched=${out.fetched}`);
}

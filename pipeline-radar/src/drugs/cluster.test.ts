import type { Trial } from '../types';
import { buildDrugLandscape } from './cluster';

// Golden assertions verified against the real 3,024-trial corpus —
// research/DATA-RESEARCH.md §5. Each test encodes a measured failure mode.

let nct = 0;
function trial(
  interventions: Array<{ name: string; otherNames?: string[]; type?: string }>,
  opts: { phases?: string[]; sponsor?: string; nctId?: string } = {},
): Trial {
  nct++;
  return {
    nctId: opts.nctId ?? `NCT${String(nct).padStart(8, '0')}`,
    title: 'A Trial',
    status: 'RECRUITING',
    phases: opts.phases ?? ['PHASE2'],
    enrollment: 100,
    sponsor: opts.sponsor ?? 'Acme Pharma',
    interventions: interventions.map((i) => ({
      type: i.type ?? 'DRUG',
      name: i.name,
      otherNames: i.otherNames ?? [],
    })),
  };
}

function row(landscape: ReturnType<typeof buildDrugLandscape>, displayName: string) {
  return landscape.drugs.find((d) => d.displayName === displayName);
}

describe('buildDrugLandscape', () => {
  it('absorbs case, dose, parenthetical, and combo-component variants of one drug', () => {
    const trials = [
      trial([{ name: 'Pembrolizumab', otherNames: ['MK-3475', 'KEYTRUDA®'] }]),
      trial([{ name: 'pembrolizumab' }]),
      trial([{ name: 'Pembrolizumab (KEYTRUDA®)' }]),
      trial([{ name: 'Pembrolizumab 200 mg' }]),
      trial([{ name: 'Carboplatin + Pemetrexed + Pembrolizumab' }]),
    ];
    const l = buildDrugLandscape(trials);
    const pembro = row(l, 'Pembrolizumab');
    expect(pembro).toBeDefined();
    expect(pembro!.trialCount).toBe(5);
    expect(pembro!.aliases).toEqual(expect.arrayContaining(['MK-3475', 'KEYTRUDA']));
  });

  it('folds a brand-name mention into the generic cluster via alias voting', () => {
    const trials = [
      trial([{ name: 'Osimertinib', otherNames: ['AZD9291', 'Tagrisso'] }]),
      trial([{ name: 'Osimertinib' }]),
      trial([{ name: 'Tagrisso' }]),
    ];
    const l = buildDrugLandscape(trials);
    const osi = row(l, 'Osimertinib');
    expect(osi!.trialCount).toBe(3);
    expect(l.drugs.find((d) => d.displayName === 'Tagrisso')).toBeUndefined();
  });

  it('over-merge canary: carboplatin and cisplatin stay separate despite shared combo mentions', () => {
    const trials = [
      trial([{ name: 'Carboplatin' }]),
      trial([{ name: 'Cisplatin' }]),
      trial([{ name: 'Pemetrexed/Cisplatin or Carboplatin', otherNames: ['Carboplatin', 'Cisplatin'] }]),
    ];
    const l = buildDrugLandscape(trials);
    expect(row(l, 'Carboplatin')).toBeDefined();
    expect(row(l, 'Cisplatin')).toBeDefined();
    expect(row(l, 'Carboplatin')!.key).not.toBe(row(l, 'Cisplatin')!.key);
  });

  it('count guard: a rare research-code record cannot hijack a common drug', () => {
    const trials = [
      trial([{ name: 'Carboplatin' }]),
      trial([{ name: 'Carboplatin' }]),
      trial([{ name: 'Carboplatin' }]),
      // One sponsor stuffs its combo partner into otherNames (measured: HLX10, §2.2).
      trial([{ name: 'HLX10', otherNames: ['Carboplatin'] }]),
    ];
    const l = buildDrugLandscape(trials);
    const carbo = row(l, 'Carboplatin');
    expect(carbo!.trialCount).toBe(3);
    expect(row(l, 'HLX10')!.trialCount).toBe(1);
  });

  it('routes category terms and placebo arms to the excluded bucket, never to rows', () => {
    const trials = [
      trial([{ name: 'Placebo' }, { name: 'Chemotherapy' }, { name: 'Immunotherapy' }]),
    ];
    const l = buildDrugLandscape(trials);
    expect(l.drugs).toHaveLength(0);
    expect(l.excludedCount).toBe(3);
    expect(l.excludedNames).toEqual(expect.arrayContaining(['Placebo', 'Chemotherapy']));
  });

  it('conservation-leak canary: an all-category combo lands in the excluded bucket', () => {
    const l = buildDrugLandscape([trial([{ name: 'Chemotherapy + radiotherapy' }])]);
    expect(l.drugs).toHaveLength(0);
    expect(l.excludedCount).toBe(1);
  });

  it('conservation invariant holds as an exact equality on a mixed fixture', () => {
    const trials = [
      trial([{ name: 'Pembrolizumab' }, { name: 'Placebo' }]),
      trial([{ name: 'Carboplatin + Pemetrexed' }]),
      trial([{ name: 'Chemotherapy + radiotherapy' }]),
      trial([{ name: 'Radiation therapy', type: 'RADIATION' }, { name: 'Nivolumab', type: 'BIOLOGICAL' }]),
      trial([{ name: '(TBD)' }]),
    ];
    const l = buildDrugLandscape(trials);
    expect(l.mentionTotal).toBe(6); // RADIATION arm never enters the pipeline
    expect(l.assignedCount + l.excludedCount).toBe(l.mentionTotal);
    expect(l.excludedCount).toBe(3); // Placebo, all-category combo, (TBD)
  });

  it('counts a trial once even when it mentions the same drug twice', () => {
    const t = trial([{ name: 'Nivolumab' }, { name: 'nivolumab' }]);
    const l = buildDrugLandscape([t]);
    expect(row(l, 'Nivolumab')!.trialCount).toBe(1);
  });

  it('includes BIOLOGICAL interventions (12% of drug-like arms, §1.2)', () => {
    const l = buildDrugLandscape([trial([{ name: 'Nivolumab', type: 'BIOLOGICAL' }])]);
    expect(row(l, 'Nivolumab')).toBeDefined();
  });

  it('display hygiene: poisoned otherNames never reach the aliases column', () => {
    const l = buildDrugLandscape([
      trial([{ name: 'Consolidation durvalumab', otherNames: ['Chemoradiotherapy', 'Surgery'] }]),
    ]);
    const d = l.drugs[0];
    expect(d.aliases).not.toEqual(expect.arrayContaining(['Chemoradiotherapy']));
    expect(d.aliases).not.toEqual(expect.arrayContaining(['Surgery']));
  });

  it('display hygiene: research-code rows keep their raw spelling', () => {
    const l = buildDrugLandscape([trial([{ name: 'MK-3475' }]), trial([{ name: 'MK-3475' }])]);
    expect(l.drugs[0].displayName).toBe('MK-3475');
  });

  it('rolls up most-advanced phase across member trials on the summarize.ts scale', () => {
    const trials = [
      trial([{ name: 'Pembrolizumab' }], { phases: ['PHASE1'] }),
      trial([{ name: 'pembrolizumab' }], { phases: ['PHASE2', 'PHASE3'] }),
      trial([{ name: 'Pembrolizumab 200 mg' }], { phases: [] }),
    ];
    const l = buildDrugLandscape(trials);
    expect(row(l, 'Pembrolizumab')!.phaseLabel).toBe('Phase 3');
  });

  it('sorts by trial count, then most advanced phase', () => {
    const trials = [
      trial([{ name: 'Aspirin' }], { phases: ['PHASE1'] }),
      trial([{ name: 'Aspirin' }]),
      trial([{ name: 'Zolpidem' }], { phases: ['PHASE4'] }),
    ];
    const l = buildDrugLandscape(trials);
    expect(l.drugs.map((d) => d.displayName)).toEqual(['Aspirin', 'Zolpidem']);
  });
});

import { mapStudy, type RawStudy } from './mapStudy';
import {
  phaseRank,
  highestPhase,
  trialsByPhase,
  topSponsors,
  filterTrials,
  sortTrials,
  mergeTrials,
} from './summarize';
import type { Trial } from './types';
import sample from './samples/lung-cancer.json';

function trial(overrides: Partial<Trial>): Trial {
  return {
    nctId: 'NCT00000000',
    title: 't',
    status: 'RECRUITING',
    phases: [],
    enrollment: null,
    sponsor: 'S',
    interventions: [],
    ...overrides,
  };
}

describe('phaseRank / highestPhase', () => {
  it('ranks a multi-phase trial by its highest phase, counted once', () => {
    expect(phaseRank(['PHASE2', 'PHASE3'])).toBe(phaseRank(['PHASE3']));
    expect(highestPhase(['PHASE2', 'PHASE3'])).toBe('PHASE3');
  });

  it('collapses empty, NA, and unknown values into NA rank 0', () => {
    expect(phaseRank([])).toBe(0);
    expect(phaseRank(['NA'])).toBe(0);
    expect(phaseRank(['SOMETHING_NEW'])).toBe(0);
    expect(highestPhase([])).toBe('NA');
  });

  it('orders the ladder NA < EARLY_PHASE1 < PHASE1 < PHASE2 < PHASE3 < PHASE4', () => {
    const ladder = ['NA', 'EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4'];
    const ranks = ladder.map((p) => phaseRank([p]));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe('trialsByPhase', () => {
  it('buckets by highest phase, most advanced first, N/A last, zero buckets omitted', () => {
    const buckets = trialsByPhase([
      trial({ phases: ['PHASE1', 'PHASE2'] }),
      trial({ phases: ['PHASE2'] }),
      trial({ phases: [] }),
    ]);
    expect(buckets).toEqual([
      { key: 'PHASE2', label: 'Phase 2', count: 2 },
      { key: 'NA', label: 'N/A', count: 1 },
    ]);
  });
});

describe('topSponsors', () => {
  it('counts by exact sponsor string, descending, capped at n', () => {
    const trials = [
      ...Array(3).fill(trial({ sponsor: 'A' })),
      ...Array(2).fill(trial({ sponsor: 'B' })),
      trial({ sponsor: 'C' }),
    ];
    expect(topSponsors(trials, 2)).toEqual([
      { name: 'A', count: 3 },
      { name: 'B', count: 2 },
    ]);
  });
});

describe('filterTrials', () => {
  const trials = [
    trial({ nctId: 'a', phases: ['PHASE3'], status: 'RECRUITING' }),
    trial({ nctId: 'b', phases: ['PHASE1'], status: 'ACTIVE_NOT_RECRUITING' }),
    trial({ nctId: 'c', phases: [], status: 'RECRUITING' }),
  ];

  it('empty filters pass everything through', () => {
    expect(filterTrials(trials, {})).toHaveLength(3);
    expect(filterTrials(trials, { phases: [], statuses: [] })).toHaveLength(3);
  });

  it('filters by highest-phase bucket and status, ANDed', () => {
    expect(filterTrials(trials, { phases: ['PHASE3', 'NA'] }).map((t) => t.nctId)).toEqual(['a', 'c']);
    expect(
      filterTrials(trials, { phases: ['PHASE3', 'PHASE1'], statuses: ['RECRUITING'] }).map((t) => t.nctId),
    ).toEqual(['a']);
  });
});

describe('sortTrials', () => {
  it('sorts phase by rank, not string', () => {
    const sorted = sortTrials(
      [trial({ nctId: 'na', phases: [] }), trial({ nctId: 'p4', phases: ['PHASE4'] }), trial({ nctId: 'p1', phases: ['PHASE1'] })],
      'phase',
      'desc',
    );
    expect(sorted.map((t) => t.nctId)).toEqual(['p4', 'p1', 'na']);
  });

  it('puts null enrollment last in both directions', () => {
    const trials = [trial({ nctId: 'none', enrollment: null }), trial({ nctId: 'big', enrollment: 500 }), trial({ nctId: 'small', enrollment: 10 })];
    expect(sortTrials(trials, 'enrollment', 'asc').map((t) => t.nctId)).toEqual(['small', 'big', 'none']);
    expect(sortTrials(trials, 'enrollment', 'desc').map((t) => t.nctId)).toEqual(['big', 'small', 'none']);
  });

  it('does not mutate the input array', () => {
    const trials = [trial({ nctId: 'b', sponsor: 'B' }), trial({ nctId: 'a', sponsor: 'A' })];
    sortTrials(trials, 'sponsor', 'asc');
    expect(trials.map((t) => t.nctId)).toEqual(['b', 'a']);
  });
});

describe('mergeTrials', () => {
  it('appends and dedupes by nctId', () => {
    const merged = mergeTrials(
      [trial({ nctId: 'a' }), trial({ nctId: 'b' })],
      [trial({ nctId: 'b' }), trial({ nctId: 'c' })],
    );
    expect(merged.map((t) => t.nctId)).toEqual(['a', 'b', 'c']);
  });
});

// The correctness story (§10-B): pinned counts over the real 100-study fixture,
// independently derived from the raw JSON before this module existed.
describe('against the real lung-cancer fixture', () => {
  const trials = (sample.studies as RawStudy[]).map(mapStudy);

  it('phase buckets match the pinned counts and sum to 100', () => {
    const buckets = trialsByPhase(trials);
    expect(Object.fromEntries(buckets.map((b) => [b.key, b.count]))).toEqual({
      PHASE4: 1,
      PHASE3: 13,
      PHASE2: 38,
      PHASE1: 16,
      NA: 32,
    });
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(trials.length);
    expect(buckets[buckets.length - 1].key).toBe('NA');
  });

  it('status filter counts match the pinned 70/30 split', () => {
    expect(filterTrials(trials, { statuses: ['RECRUITING'] })).toHaveLength(70);
    expect(filterTrials(trials, { statuses: ['ACTIVE_NOT_RECRUITING'] })).toHaveLength(30);
  });

  it('top sponsor is AstraZeneca with 4 trials', () => {
    expect(topSponsors(trials, 1)).toEqual([{ name: 'AstraZeneca', count: 4 }]);
  });
});

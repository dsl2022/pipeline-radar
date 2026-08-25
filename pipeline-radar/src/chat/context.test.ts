import { MAX_CONTEXT_CHARS, validateContext } from '@pipeline-radar/shared/chat';
import type { DrugSnap, LandscapeDiff } from '@pipeline-radar/shared/watchlist';
import { buildChatContext, compactWatchlistDiff } from './context';

const snap = (name: string, ncts = 2): DrugSnap => ({
  key: name,
  displayName: name,
  maxPhase: 3,
  phaseLabel: 'Phase 3',
  trialCount: 4,
  nctIds: Array.from({ length: ncts }, (_, i) => `NCT0000000${i}`),
  fdaStatus: 'investigational',
});

const emptyDiff = (): LandscapeDiff => ({
  added: [],
  removed: [],
  renamed: [],
  phaseAdvanced: [],
  phaseRegressed: [],
  fdaFlipped: [],
  fdaReversed: [],
  newlyResolved: [],
  newTrials: [],
  caveats: [],
  hasChanges: false,
});

describe('compactWatchlistDiff', () => {
  it('keeps names and phases, drops keys and heavy fields', () => {
    const diff = { ...emptyDiff(), hasChanges: true, added: [snap('examplemab')] };
    const out = compactWatchlistDiff(diff) as { added: { rows: unknown[] } };
    expect(out.added.rows).toEqual([{ drug: 'examplemab', phase: 'Phase 3' }]);
    expect(JSON.stringify(out)).not.toContain('trialCount');
  });

  it('caps every list and reports what it dropped', () => {
    const diff = {
      ...emptyDiff(),
      hasChanges: true,
      added: Array.from({ length: 40 }, (_, i) => snap(`drug-${i}`)),
    };
    const out = compactWatchlistDiff(diff) as { added: { rows: unknown[]; omitted?: number } };
    expect(out.added.rows).toHaveLength(15);
    expect(out.added.omitted).toBe(25);
  });

  // The guarantee the wire needs: even a pathological diff, compacted, passes
  // the server's own validator.
  it('always fits the shared context budget', () => {
    const diff = {
      ...emptyDiff(),
      hasChanges: true,
      added: Array.from({ length: 500 }, (_, i) => snap(`a-very-long-drug-name-${i}`, 40)),
      removed: Array.from({ length: 500 }, (_, i) => snap(`another-long-name-${i}`, 40)),
      newTrials: Array.from({ length: 500 }, (_, i) => ({
        key: `k${i}`,
        displayName: `drug-${i}`,
        nctIds: Array.from({ length: 60 }, (_, j) => `NCT${String(j).padStart(8, '0')}`),
      })),
    };
    const compact = compactWatchlistDiff(diff);
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(validateContext({ watchlistDiff: compact }).ok).toBe(true);
  });
});

describe('buildChatContext', () => {
  it('produces a context the server validator accepts', () => {
    const ctx = buildChatContext({
      disease: 'melanoma',
      view: 'drugs',
      phases: ['PHASE3'],
      statuses: [],
      watchlistDiff: { ...emptyDiff(), hasChanges: true, added: [snap('examplemab')] },
    });
    expect(ctx?.disease).toBe('melanoma');
    expect(ctx?.watchlistDiff).toBeDefined();
    expect(validateContext(ctx).ok).toBe(true);
  });

  it('omits empty filters and missing pieces', () => {
    const ctx = buildChatContext({ view: 'trials', phases: [], statuses: [], watchlistDiff: null });
    expect(ctx).toEqual({ view: 'trials' });
  });
});

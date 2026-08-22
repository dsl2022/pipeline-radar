import {
  diffSnapshots,
  diseaseKey,
  loadSnapshot,
  makeSnapshot,
  saveSnapshot,
  type DrugSnap,
  type Snapshot,
} from './watchlist';
import type { Landscape } from './drugs/cluster';
import type { FdaBadge } from './drugs/openfda';

// Jest runs in node — shim just enough localStorage for the roundtrip tests.
const store = new Map<string, string>();
beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
beforeEach(() => store.clear());

function snap(over: Partial<DrugSnap> & { key: string }): DrugSnap {
  return {
    displayName: over.key,
    maxPhase: 3,
    phaseLabel: 'Phase 2',
    trialCount: 1,
    nctIds: ['NCT1'],
    fdaStatus: 'unknown',
    ...over,
  };
}

function snapshot(drugs: DrugSnap[], over: Partial<Snapshot> = {}): Snapshot {
  return { disease: 'lung cancer', savedAt: 1, fetchedTrials: 1000, totalTrials: 6000, drugs, ...over };
}

describe('makeSnapshot', () => {
  it('maps the three-way fda state and normalizes the disease', () => {
    const landscape = {
      drugs: [
        { key: 'a', displayName: 'A', maxPhase: 4, phaseLabel: 'Phase 3', trialCount: 2, sponsors: [], aliases: [], nctIds: ['NCT1', 'NCT2'] },
        { key: 'b', displayName: 'B', maxPhase: 0, phaseLabel: 'N/A', trialCount: 1, sponsors: [], aliases: [], nctIds: ['NCT3'] },
        { key: 'c', displayName: 'C', maxPhase: 2, phaseLabel: 'Phase 1', trialCount: 1, sponsors: [], aliases: [], nctIds: ['NCT4'] },
      ],
      excludedCount: 0,
      excludedNames: [],
      assignedCount: 4,
      mentionTotal: 4,
    } as Landscape;
    const fdaMap = new Map<string, FdaBadge | null>([
      ['a', { status: 'approved', via: 'generic' }],
      ['b', null],
      // c absent = unknown
    ]);
    const s = makeSnapshot(landscape, fdaMap, { disease: '  Lung Cancer ', savedAt: 42, fetchedTrials: 10, totalTrials: 100 });
    expect(s.disease).toBe('lung cancer');
    expect(s.drugs.map((d) => d.fdaStatus)).toEqual(['approved', 'investigational', 'unknown']);
  });
});

describe('save/load roundtrip', () => {
  it('persists and restores a snapshot', () => {
    const s = snapshot([snap({ key: 'a' })]);
    saveSnapshot(s);
    expect(loadSnapshot('Lung Cancer')).toEqual(s); // diseaseKey normalization on load
  });
  it('returns null for a missing disease', () => {
    expect(loadSnapshot('melanoma')).toBeNull();
  });
  it('returns null for corrupted or wrong-shaped JSON', () => {
    store.set(`watchlist:${diseaseKey('x')}`, 'not json {{{');
    expect(loadSnapshot('x')).toBeNull();
    store.set(`watchlist:${diseaseKey('y')}`, JSON.stringify({ savedAt: 'nope', drugs: 3 }));
    expect(loadSnapshot('y')).toBeNull();
  });
  it('returns null for parseable-but-partial snapshots — schema drift must never crash render', () => {
    const base = snapshot([snap({ key: 'a' })]);
    // Missing fetchedTrials (the field the differ and panel dereference).
    const { fetchedTrials: _dropped, ...noDepth } = base;
    store.set(`watchlist:${diseaseKey('z')}`, JSON.stringify(noDepth));
    expect(loadSnapshot('z')).toBeNull();
    // Empty-object drug entry (the classic partial write).
    store.set(`watchlist:${diseaseKey('w')}`, JSON.stringify({ ...base, drugs: [{}] }));
    expect(loadSnapshot('w')).toBeNull();
    // Unknown fdaStatus value.
    store.set(
      `watchlist:${diseaseKey('v')}`,
      JSON.stringify({ ...base, drugs: [{ ...base.drugs[0], fdaStatus: 'maybe' }] }),
    );
    expect(loadSnapshot('v')).toBeNull();
    // Non-string nctIds.
    store.set(
      `watchlist:${diseaseKey('u')}`,
      JSON.stringify({ ...base, drugs: [{ ...base.drugs[0], nctIds: [1, 2] }] }),
    );
    expect(loadSnapshot('u')).toBeNull();
  });
});

describe('diffSnapshots', () => {
  it('reports added and removed drugs when nctIds are disjoint', () => {
    const prev = snapshot([snap({ key: 'gone', nctIds: ['NCT1'] })]);
    const cur = snapshot([snap({ key: 'fresh', nctIds: ['NCT9'] })]);
    const d = diffSnapshots(prev, cur);
    expect(d.added.map((x) => x.key)).toEqual(['fresh']);
    expect(d.removed.map((x) => x.key)).toEqual(['gone']);
    expect(d.renamed).toHaveLength(0);
    expect(d.hasChanges).toBe(true);
  });

  it('classifies a key shift with overlapping nctIds as a rename, and still field-diffs the pair', () => {
    const prev = snapshot([snap({ key: 'mk3475', maxPhase: 3, phaseLabel: 'Phase 2', nctIds: ['NCT1', 'NCT2'] })]);
    const cur = snapshot([snap({ key: 'pembrolizumab', maxPhase: 4, phaseLabel: 'Phase 3', nctIds: ['NCT1', 'NCT2', 'NCT3'] })]);
    const d = diffSnapshots(prev, cur);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.renamed).toHaveLength(1);
    expect(d.renamed[0].prev.key).toBe('mk3475');
    expect(d.renamed[0].cur.key).toBe('pembrolizumab');
    expect(d.phaseAdvanced).toEqual([{ key: 'pembrolizumab', displayName: 'pembrolizumab', from: 'Phase 2', to: 'Phase 3' }]);
    expect(d.newTrials).toEqual([{ key: 'pembrolizumab', displayName: 'pembrolizumab', nctIds: ['NCT3'] }]);
  });

  it('merge case: two removed rows overlapping one added row yield ONE rename (larger overlap wins) + one removed', () => {
    const prev = snapshot([
      snap({ key: 'a', nctIds: ['NCT1', 'NCT2'] }),
      snap({ key: 'b', nctIds: ['NCT3'] }),
    ]);
    const cur = snapshot([snap({ key: 'merged', nctIds: ['NCT1', 'NCT2', 'NCT3'] })]);
    const d = diffSnapshots(prev, cur);
    expect(d.renamed).toHaveLength(1);
    expect(d.renamed[0].prev.key).toBe('a'); // overlap 2 beats overlap 1
    expect(d.removed.map((x) => x.key)).toEqual(['b']);
    expect(d.added).toHaveLength(0);
  });

  it('separates phase advances from regressions', () => {
    const prev = snapshot([
      snap({ key: 'up', maxPhase: 2, phaseLabel: 'Phase 1' }),
      snap({ key: 'down', maxPhase: 4, phaseLabel: 'Phase 3' }),
    ]);
    const cur = snapshot([
      snap({ key: 'up', maxPhase: 4, phaseLabel: 'Phase 3' }),
      snap({ key: 'down', maxPhase: 3, phaseLabel: 'Phase 2' }),
    ]);
    const d = diffSnapshots(prev, cur);
    expect(d.phaseAdvanced).toEqual([{ key: 'up', displayName: 'up', from: 'Phase 1', to: 'Phase 3' }]);
    expect(d.phaseRegressed).toEqual([{ key: 'down', displayName: 'down', from: 'Phase 3', to: 'Phase 2' }]);
  });

  it('flips only on investigational→approved; unknown→resolved is newlyResolved, never a flip', () => {
    const prev = snapshot([
      snap({ key: 'flip', fdaStatus: 'investigational' }),
      snap({ key: 'late', fdaStatus: 'unknown' }),
      snap({ key: 'lost', fdaStatus: 'approved' }),
    ]);
    const cur = snapshot([
      snap({ key: 'flip', fdaStatus: 'approved' }),
      snap({ key: 'late', fdaStatus: 'approved' }),
      snap({ key: 'lost', fdaStatus: 'unknown' }), // resolved→unknown: reported nowhere
    ]);
    const d = diffSnapshots(prev, cur);
    expect(d.fdaFlipped).toEqual([{ key: 'flip', displayName: 'flip' }]);
    expect(d.fdaReversed).toHaveLength(0);
    expect(d.newlyResolved).toEqual([{ key: 'late', displayName: 'late', status: 'approved' }]);
  });

  it('reports approved→investigational as fdaReversed — a resolved-to-resolved change is never swallowed', () => {
    const prev = snapshot([snap({ key: 'rev', fdaStatus: 'approved' })]);
    const cur = snapshot([snap({ key: 'rev', fdaStatus: 'investigational' })]);
    const d = diffSnapshots(prev, cur);
    expect(d.fdaReversed).toEqual([{ key: 'rev', displayName: 'rev' }]);
    expect(d.fdaFlipped).toHaveLength(0);
    expect(d.newlyResolved).toHaveLength(0);
    expect(d.hasChanges).toBe(true); // the "No changes" banner must not cover this
  });

  it('new-trial delta is a set difference, order-independent', () => {
    const prev = snapshot([snap({ key: 'a', nctIds: ['NCT2', 'NCT1'] })]);
    const cur = snapshot([snap({ key: 'a', nctIds: ['NCT1', 'NCT3', 'NCT2'] })]);
    const d = diffSnapshots(prev, cur);
    expect(d.newTrials).toEqual([{ key: 'a', displayName: 'a', nctIds: ['NCT3'] }]);
    // Dropped NCT ids are not reported as anything.
    expect(diffSnapshots(cur, prev).newTrials).toHaveLength(0);
  });

  it('emits a depth caveat when fetchedTrials differ, and none when equal', () => {
    const prev = snapshot([snap({ key: 'a' })], { fetchedTrials: 500 });
    const cur = snapshot([snap({ key: 'a' })], { fetchedTrials: 1000 });
    expect(diffSnapshots(prev, cur).caveats).toHaveLength(1);
    expect(diffSnapshots(prev, cur).caveats[0]).toContain('500');
    expect(diffSnapshots(prev, prev).caveats).toHaveLength(0);
  });

  it('identical snapshots produce hasChanges=false', () => {
    const s = snapshot([snap({ key: 'a', fdaStatus: 'approved' })]);
    const d = diffSnapshots(s, s);
    expect(d.hasChanges).toBe(false);
  });
});

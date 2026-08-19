import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchTrials } from './api';
import { TrialsTable, type SortState } from './TrialsTable';
import { FiltersBar, type FilterOption } from './FiltersBar';
import { SummaryPanel } from './SummaryPanel';
import { DrugTable } from './DrugTable';
import { buildDrugLandscape } from './drugs/cluster';
import { enrichTopRows } from './drugs/rxnorm';
import { badgeDrugs, fdaStatusOf, type FdaBadge } from './drugs/openfda';
import { filterTrials, sortTrials, mergeTrials, trialsByPhase, PHASE_LABELS, type SortKey } from './summarize';
import { formatStatus } from './mapStudy';
import {
  buildHtmlReport,
  buildMarkdownReport,
  buildTrialsHtmlReport,
  buildTrialsMarkdownReport,
  reportFilenameFor,
  type ReportMeta,
} from './report';
import { diffSnapshots, loadSnapshot, makeSnapshot, saveSnapshot, type Snapshot } from './watchlist';
import { ExportBar } from './ExportBar';
import { WatchlistDiff } from './WatchlistDiff';
import type { Trial } from './types';
import './App.css';

// §5's page cap, re-denominated in TRIALS now that pages are 500 (M3 step 4);
// past this, narrowing with filters is the honest tool.
const MAX_TRIALS = 1000;

// Stable reference for the no-results case: a fresh [] each render would make
// every downstream useMemo/useEffect that depends on it re-run every render.
const NO_TRIALS: Trial[] = [];

// Enrichment callbacks fire synchronously per row for cached names; one
// setState-with-full-Map-copy per row is O(n²) element copies on a replay over
// a few hundred drugs. Buffer results and flush once per microtask instead —
// one Map copy per flush, same streaming feel.
function batchedMapWriter<V>(
  set: Dispatch<SetStateAction<ReadonlyMap<string, V>>>,
): (key: string, value: V) => void {
  let buf: [string, V][] = [];
  let scheduled = false;
  return (key, value) => {
    buf.push([key, value]);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const entries = buf;
      buf = [];
      set((prev) => {
        const next = new Map(prev);
        for (const [k, v] of entries) next.set(k, v);
        return next;
      });
    });
  };
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'results';
      disease: string;
      trials: Trial[];
      total: number;
      nextPageToken?: string;
      pages: number;
    };

export default function App() {
  const [query, setQuery] = useState('lung cancer');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [selectedPhases, setSelectedPhases] = useState<string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [view, setView] = useState<'trials' | 'drugs'>('trials');
  const [rxcuiMap, setRxcuiMap] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [fdaMap, setFdaMap] = useState<ReadonlyMap<string, FdaBadge | null>>(new Map());
  // Last-saved watchlist snapshot for the current disease. localStorage isn't
  // reactive, so the loaded snapshot lives in state: refreshed on search, on save.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  async function search() {
    const disease = query.trim();
    if (!disease) return;
    setState({ kind: 'loading' });
    setSelectedPhases([]);
    setSelectedStatuses([]);
    setSort(null);
    try {
      const result = await fetchTrials(disease);
      setState({
        kind: 'results',
        disease,
        trials: result.trials,
        total: result.total,
        nextPageToken: result.nextPageToken,
        pages: 1,
      });
      setSnapshot(loadSnapshot(disease));
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function loadMore() {
    if (state.kind !== 'results' || !state.nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchTrials(state.disease, state.nextPageToken);
      setState({
        ...state,
        trials: mergeTrials(state.trials, result.trials),
        nextPageToken: result.nextPageToken,
        pages: state.pages + 1,
      });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleIn(list: string[], key: string): string[] {
    return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  }

  function onSort(key: SortKey) {
    setSort((prev) => {
      if (prev?.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      // Numeric-ish columns are most useful biggest-first on first click.
      return { key, dir: key === 'phase' || key === 'enrollment' ? 'desc' : 'asc' };
    });
  }

  const allTrials = state.kind === 'results' ? state.trials : NO_TRIALS;

  const filtered = useMemo(
    () => filterTrials(allTrials, { phases: selectedPhases, statuses: selectedStatuses }),
    [allTrials, selectedPhases, selectedStatuses],
  );

  const visible = useMemo(
    () => (sort ? sortTrials(filtered, sort.key, sort.dir) : filtered),
    [filtered, sort],
  );

  // Milestone 3: drug rollup is pure + derived — respects the active filters, no async.
  const landscape = useMemo(() => buildDrugLandscape(filtered), [filtered]);

  // Milestone 5: the watchlist snapshots the UNFILTERED landscape — a watchlist
  // tracks the disease, filters are a viewing lens (diffing the filtered view
  // would report every filter click as pipeline churn). In the common no-filter
  // case filterTrials returns the input array itself, so the filtered landscape
  // is reused instead of clustering the same trials twice.
  const unfilteredLandscape = useMemo(
    () => (filtered === allTrials ? landscape : buildDrugLandscape(allTrials)),
    [filtered, allTrials, landscape],
  );

  // Enrichment streams in only while the drug view is open; module-level caches
  // make re-runs (toggle, filter change) free for known names.
  // RxNorm follows the VISIBLE (filtered) rows.
  useEffect(() => {
    if (view !== 'drugs' || landscape.drugs.length === 0) return;
    let cancelled = false;
    enrichTopRows(landscape.drugs, batchedMapWriter(setRxcuiMap), { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [view, landscape]);

  // FDA badges cover the UNFILTERED landscape (batching makes full coverage
  // affordable — ~2 calls per 15 rows, DATA-RESEARCH §6.2): the watchlist
  // snapshot and diff need every drug, and the emptiness guard checks THIS set,
  // so zero-yield filters can never suppress the pass. Keyed on
  // unfilteredLandscape, NOT landscape — a filter click must not cancel and
  // replay a full badge pass.
  useEffect(() => {
    if (view !== 'drugs' || unfilteredLandscape.drugs.length === 0) return;
    let cancelled = false;
    badgeDrugs(unfilteredLandscape.drugs, batchedMapWriter(setFdaMap), { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [view, unfilteredLandscape]);

  // Filtered-view rows whose cluster key shifted under alias voting are absent
  // from the unfiltered set — badge just those extras (usually zero rows, and
  // cached canon names resolve without network, so filter-click replays are cheap).
  useEffect(() => {
    if (view !== 'drugs') return;
    const unfilteredKeys = new Set(unfilteredLandscape.drugs.map((d) => d.key));
    const extras = landscape.drugs.filter((d) => !unfilteredKeys.has(d.key));
    if (extras.length === 0) return;
    let cancelled = false;
    badgeDrugs(extras, batchedMapWriter(setFdaMap), { isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [view, landscape, unfilteredLandscape]);

  // Watchlist diff: recomputes as badges stream in — safe because 'unknown'
  // never produces a false flip (watchlist.ts invariant).
  const watchDiff = useMemo(() => {
    if (!snapshot || state.kind !== 'results') return null;
    const current = makeSnapshot(unfilteredLandscape, fdaMap, {
      disease: state.disease,
      savedAt: 0, // irrelevant to the diff
      fetchedTrials: state.trials.length,
      totalTrials: state.total,
    });
    return diffSnapshots(snapshot, current);
  }, [snapshot, unfilteredLandscape, fdaMap, state]);

  // Meta for the export renderers, built fresh at click time (all three formats
  // share it). Only reachable from the drugs view, where results exist.
  function currentReportMeta(): ReportMeta {
    if (state.kind !== 'results') throw new Error('report meta requested outside results state');
    return {
      disease: state.disease,
      generatedAt: new Date(),
      totalTrials: state.total,
      fetchedTrials: allTrials.length,
      filteredTrials: filtered.length,
      filters: {
        phases: selectedPhases.map((p) => PHASE_LABELS[p] ?? p),
        statuses: selectedStatuses.map(formatStatus),
      },
      phaseBuckets: trialsByPhase(filtered),
    };
  }

  function saveWatchlist() {
    if (state.kind !== 'results') return;
    const fresh = makeSnapshot(unfilteredLandscape, fdaMap, {
      disease: state.disease,
      savedAt: Date.now(),
      fetchedTrials: state.trials.length,
      totalTrials: state.total,
    });
    saveSnapshot(fresh);
    setSnapshot(fresh); // panel now diffs empty against itself → "No changes"
  }

  // Pending counter covers EVERY set an export or save can touch: the
  // unfiltered landscape (what a watchlist save persists) plus the filtered one
  // (what the exports render). Counting only visible rows let the warning read
  // 0 while filter-hidden drugs were still streaming — and a save would then
  // silently record them as unresolved.
  const pendingCount = useMemo(() => {
    const keys = new Set([...unfilteredLandscape.drugs, ...landscape.drugs].map((d) => d.key));
    let n = 0;
    for (const key of keys) if (fdaStatusOf(key, fdaMap) === 'unknown') n++;
    return n;
  }, [landscape, unfilteredLandscape, fdaMap]);

  // Filter chips are derived from the FETCHED set (with counts), never hardcoded.
  const phaseOptions: FilterOption[] = useMemo(
    () => trialsByPhase(allTrials).map((b) => ({ key: b.key, label: b.label, count: b.count })),
    [allTrials],
  );

  const statusOptions: FilterOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of allTrials) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, label: formatStatus(key), count }));
  }, [allTrials]);

  const filtersActive = selectedPhases.length > 0 || selectedStatuses.length > 0;

  return (
    <main>
      <h1>Pipeline Radar</h1>
      <p className="tagline">Enter a disease → see the active clinical-trial landscape.</p>

      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. lung cancer"
          autoFocus
        />
        <button type="submit" disabled={state.kind === 'loading'}>
          Search
        </button>
      </form>

      {state.kind === 'loading' && <p className="info">Searching ClinicalTrials.gov…</p>}

      {state.kind === 'error' && <p className="error">Something went wrong: {state.message}</p>}

      {state.kind === 'results' && state.trials.length === 0 && (
        <p className="info">No active trials found for “{state.disease}”.</p>
      )}

      {state.kind === 'results' && state.trials.length > 0 && (
        <>
          <FiltersBar
            phaseOptions={phaseOptions}
            statusOptions={statusOptions}
            selectedPhases={selectedPhases}
            selectedStatuses={selectedStatuses}
            onTogglePhase={(k) => setSelectedPhases((p) => toggleIn(p, k))}
            onToggleStatus={(k) => setSelectedStatuses((s) => toggleIn(s, k))}
            onClear={() => {
              setSelectedPhases([]);
              setSelectedStatuses([]);
            }}
          />

          <p className="info">
            Showing <strong>{visible.length}</strong>
            {filtersActive && <> (filtered from {allTrials.length} fetched)</>} of{' '}
            <strong>{state.total.toLocaleString()}</strong> active trials for “{state.disease}”
          </p>

          <div className="view-toggle">
            <button type="button" className={view === 'trials' ? 'on' : ''} onClick={() => setView('trials')}>
              Trials ({visible.length})
            </button>
            <button type="button" className={view === 'drugs' ? 'on' : ''} onClick={() => setView('drugs')}>
              Drugs ({landscape.drugs.length})
            </button>
          </div>

          {view === 'trials' ? (
            <>
              <SummaryPanel trials={filtered} />
              <ExportBar
                buildMarkdown={() => {
                  const meta = currentReportMeta();
                  return { content: buildTrialsMarkdownReport(visible, meta), filename: reportFilenameFor(meta, 'md', 'trials') };
                }}
                buildHtml={() => {
                  const meta = currentReportMeta();
                  return { content: buildTrialsHtmlReport(visible, meta), filename: reportFilenameFor(meta, 'html', 'trials') };
                }}
                exportPdf={async () => {
                  const { buildTrialsPdfReport } = await import('./pdfReport');
                  const meta = currentReportMeta();
                  buildTrialsPdfReport(visible, meta).save(reportFilenameFor(meta, 'pdf', 'trials'));
                }}
              />
              <TrialsTable trials={visible} sort={sort} onSort={onSort} />
            </>
          ) : (
            <>
              <p className="info drug-note">
                One row per unique drug, rolled up from {filtered.length} loaded trials.
                {landscape.excludedCount > 0 && (
                  <> Excluded: {landscape.excludedCount} non-drug / unspecified interventions.</>
                )}
              </p>
              <ExportBar
                buildMarkdown={() => {
                  const meta = currentReportMeta();
                  return { content: buildMarkdownReport(landscape, fdaMap, rxcuiMap, meta), filename: reportFilenameFor(meta, 'md') };
                }}
                buildHtml={() => {
                  const meta = currentReportMeta();
                  return { content: buildHtmlReport(landscape, fdaMap, rxcuiMap, meta), filename: reportFilenameFor(meta, 'html') };
                }}
                exportPdf={async () => {
                  // jspdf loads on first click only — keeps it out of the app bundle.
                  const { buildPdfReport } = await import('./pdfReport');
                  const meta = currentReportMeta();
                  buildPdfReport(landscape, fdaMap, rxcuiMap, meta).save(reportFilenameFor(meta, 'pdf'));
                }}
                onSaveWatchlist={saveWatchlist}
                pendingCount={pendingCount}
              />
              {snapshot && watchDiff && <WatchlistDiff snapshot={snapshot} diff={watchDiff} />}
              <DrugTable drugs={landscape.drugs} rxcuiMap={rxcuiMap} fdaMap={fdaMap} />
            </>
          )}

          {state.nextPageToken && state.trials.length < MAX_TRIALS && (
            <button type="button" className="load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more trials'}
            </button>
          )}
          {state.nextPageToken && state.trials.length >= MAX_TRIALS && (
            <p className="info page-cap">
              Trial cap reached — first {allTrials.length} trials fetched of {state.total.toLocaleString()}.
              Narrow with filters or a more specific disease.
            </p>
          )}
        </>
      )}
    </main>
  );
}

import { Fragment, useEffect, useState } from 'react';
import type { DrugRow } from '@pipeline-radar/shared/drugs/cluster';
import { canon } from '@pipeline-radar/shared/drugs/canon';
import { fetchTopReactions, type FdaBadge, type Reaction } from '@pipeline-radar/shared/drugs/openfda';

// One drug, one row (milestone 3) + FDA approval badges and an expandable
// detail row (milestone 4). Rows render instantly from local clustering; the
// RxNorm and FDA columns fill in progressively as enrichment settles.
//
// Map semantics (both maps): key + value = resolved; key + null = definitive
// miss; key absent = not answered yet (pending or transport error) — render
// '—', never a false verdict.
//
// The FDA badge is the authority on approved/investigational once resolved;
// the RxNorm "unregistered · likely investigational" hint only shows while the
// FDA answer is still pending.

// Header list is the single source for colSpan — hand-counted literals go
// stale the moment a column is added.
const COLUMNS = ['Drug', 'Highest phase', 'Trials', 'Sponsors', 'Also known as', 'RxNorm', 'FDA'];

const NCT_LINK_CAP = 10;

function FdaChip({ badge, resolved }: { badge: FdaBadge | null | undefined; resolved: boolean }) {
  if (!resolved) return <span className="rx-pending">—</span>;
  if (!badge) return <span className="fda-chip fda-inv">Investigational</span>;
  return (
    <span className="fda-chip fda-approved">
      {!badge.approvalYear
        ? 'Approved'
        : badge.approvalApprox
          ? `Approved · records since ${badge.approvalYear}`
          : `Approved ${badge.approvalYear}`}
    </span>
  );
}

function AePanel({ canonName }: { canonName: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; reactions: Reaction[] }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchTopReactions(canonName)
      .then((reactions) => !cancelled && setState({ kind: 'ready', reactions }))
      .catch(() => !cancelled && setState({ kind: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [canonName]);

  if (state.kind === 'loading') return <p className="ae-note">Loading FAERS reports…</p>;
  if (state.kind === 'error') return <p className="ae-note">FAERS lookup failed — try again later.</p>;
  if (state.reactions.length === 0) return <p className="ae-note">No FAERS reports for this name.</p>;

  const max = state.reactions[0].count;
  return (
    <div className="ae-panel">
      {state.reactions.map((r) => (
        <div className="bar-row" key={r.term}>
          <span className="bar-label" title={r.term}>
            {r.term.toLowerCase()}
          </span>
          <span className="bar-track">
            <span className="bar" style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <span className="bar-count">{r.count.toLocaleString()}</span>
        </div>
      ))}
      <p className="ae-caveat">
        FAERS reports, not causation — includes disease outcomes; ~93% of reports are flagged serious.
      </p>
    </div>
  );
}

function ExpansionRow({ d, badge, resolved }: { d: DrugRow; badge: FdaBadge | null | undefined; resolved: boolean }) {
  const [showAe, setShowAe] = useState(false);
  return (
    <tr className="expansion-row">
      <td colSpan={COLUMNS.length}>
        {!resolved ? (
          <p className="fda-detail muted">FDA record check pending (or unavailable — network error, not a verdict).</p>
        ) : !badge ? (
          <p className="fda-detail">
            No FDA approval record (checked generic + brand names {new Date().toLocaleDateString()}).
          </p>
        ) : (
          <>
            <p className="fda-detail">
              {!badge.approvalYear
                ? 'Approved'
                : badge.approvalApprox
                  ? `Approved · records since ${badge.approvalYear}`
                  : `Approved ${badge.approvalYear}`}
              {badge.sponsor && <> · {badge.sponsor}</>}
              {badge.appNumber && <> · {badge.appNumber}</>}
              {(badge.appCount ?? 0) > 1 && <> ({badge.appCount} applications)</>}
              {badge.pharmClass && <> · {badge.pharmClass}</>}
            </p>
            {badge.brands && badge.brands.length > 0 && (
              <p className="fda-detail muted">
                Brands: {badge.brands.join(', ')}
                {badge.via === 'brand' && <> — matched via brand {badge.brands[0]} (generic name absent from FDA data)</>}
              </p>
            )}
          </>
        )}
        <p className="nct-links">
          Trials:{' '}
          {d.nctIds.slice(0, NCT_LINK_CAP).map((nct, i) => (
            <span key={nct}>
              {i > 0 && ', '}
              <a href={`https://clinicaltrials.gov/study/${nct}`} target="_blank" rel="noreferrer">
                {nct}
              </a>
            </span>
          ))}
          {d.nctIds.length > NCT_LINK_CAP && <span className="more"> +{d.nctIds.length - NCT_LINK_CAP} more</span>}
        </p>
        <button type="button" className="ae-toggle" onClick={() => setShowAe((s) => !s)}>
          {showAe ? 'Hide side-effect profile' : 'Side-effect profile'}
        </button>
        {showAe && <AePanel canonName={canon(d.displayName)} />}
      </td>
    </tr>
  );
}

export function DrugTable({
  drugs,
  rxcuiMap,
  fdaMap,
}: {
  drugs: DrugRow[];
  rxcuiMap: ReadonlyMap<string, string | null>;
  fdaMap: ReadonlyMap<string, FdaBadge | null>;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <table>
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th key={c} className={c === 'Trials' ? 'num' : undefined}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {drugs.map((d) => {
          const expanded = expandedKey === d.key;
          const fdaResolved = fdaMap.has(d.key);
          const badge = fdaMap.get(d.key);
          return (
            <Fragment key={d.key}>
              <tr
                className="drug-row"
                aria-expanded={expanded}
                onClick={() => setExpandedKey(expanded ? null : d.key)}
              >
                <td className="drug-name">
                  <span className="chevron">{expanded ? '▾' : '▸'}</span> {d.displayName}
                </td>
                <td>
                  <span className={`phase-badge ${d.maxPhase === 0 ? 'phase-na' : ''}`}>{d.phaseLabel}</span>
                </td>
                <td className="num">{d.trialCount}</td>
                <td>
                  {d.sponsors.slice(0, 2).join(', ')}
                  {d.sponsors.length > 2 && (
                    <span className="more" title={d.sponsors.slice(2).join(', ')}>
                      {' '}
                      +{d.sponsors.length - 2} more
                    </span>
                  )}
                </td>
                <td className="aliases" title={d.aliases.join(', ')}>
                  {d.aliases.slice(0, 3).join(', ') || '—'}
                  {d.aliases.length > 3 && <span className="more"> +{d.aliases.length - 3}</span>}
                </td>
                <td>
                  {!rxcuiMap.has(d.key) ? (
                    <span className="rx-pending">—</span>
                  ) : rxcuiMap.get(d.key) ? (
                    <a
                      href={`https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${rxcuiMap.get(d.key)}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      RxCUI {rxcuiMap.get(d.key)}
                    </a>
                  ) : fdaResolved ? (
                    <span className="rx-pending" title="Not in RxNorm — the FDA column is the verdict.">
                      —
                    </span>
                  ) : (
                    <span
                      className="rx-miss"
                      title="No RxNorm concept even including investigational sources — typical for new compounds and research codes."
                    >
                      unregistered · likely investigational
                    </span>
                  )}
                </td>
                <td>
                  <FdaChip badge={badge} resolved={fdaResolved} />
                </td>
              </tr>
              {expanded && <ExpansionRow d={d} badge={badge} resolved={fdaResolved} />}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

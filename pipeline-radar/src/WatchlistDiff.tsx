import type { ReactNode } from 'react';
import type { LandscapeDiff, Snapshot } from '@pipeline-radar/shared/watchlist';

// Milestone 5: "what changed since last time" panel. Renders ONLY inside the
// drugs view — FDA badges stream only while that view is open, so anywhere else
// the current side of the diff would sit permanently at all-unknown.
// Caveats come from the differ itself (they're data, and tested there).
//
// Layout: one compact card; each change category is an expandable row with a
// color-coded dot and a count badge, and the expanded list scrolls past ~7
// items so a big delta can never take over the page.

const NCT_LINK_CAP = 10;

function NctLinks({ ids }: { ids: string[] }) {
  return (
    <span className="nct-list">
      {ids.slice(0, NCT_LINK_CAP).map((nct, i) => (
        <span key={nct}>
          {i > 0 && ', '}
          <a href={`https://clinicaltrials.gov/study/${nct}`} target="_blank" rel="noreferrer">
            {nct}
          </a>
        </span>
      ))}
      {ids.length > NCT_LINK_CAP && <span className="more"> +{ids.length - NCT_LINK_CAP} more</span>}
    </span>
  );
}

type Tone = 'add' | 'up' | 'fda' | 'trials' | 'drop' | 'muted';

// Section owns its zero-guard: an empty category renders nothing, so a caller
// can never forget the length check and show an empty expandable row.
function Section({
  count,
  label,
  tone,
  children,
}: {
  count: number;
  label: string;
  tone: Tone;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <details className={`diff-section tone-${tone}`}>
      <summary>
        <span className="dot" aria-hidden="true" />
        <span className="count">{count}</span>
        <span className="label">{label}</span>
        <span className="chev" aria-hidden="true">
          ▸
        </span>
      </summary>
      <ul>{children}</ul>
    </details>
  );
}

// "3 trials" — count + pluralized word together.
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Just the pluralized word, for Section labels (the count badge renders separately).
const pl = (word: string, n: number) => `${word}${n === 1 ? '' : 's'}`;

export function WatchlistDiff({ snapshot, diff }: { snapshot: Snapshot; diff: LandscapeDiff }) {
  const when = new Date(snapshot.savedAt).toLocaleString();
  const newTrialTotal = diff.newTrials.reduce((n, t) => n + t.nctIds.length, 0);

  return (
    <section className="diff-panel">
      <header className="diff-header">
        <span className="diff-title">Watchlist</span>
        <span className="diff-when">
          changes since {when} · saved with {snapshot.fetchedTrials.toLocaleString()} trials loaded
        </span>
      </header>
      {diff.caveats.map((c) => (
        <p className="diff-caveat" key={c}>
          {c}
        </p>
      ))}
      {!diff.hasChanges ? (
        <p className="diff-none">No changes since last save.</p>
      ) : (
        <div className="diff-sections">
          <Section count={diff.added.length} label={pl('new drug', diff.added.length)} tone="add">
            {diff.added.map((d) => (
              <li key={d.key}>
                <strong>{d.displayName}</strong>
                <span className="li-detail">
                  {d.phaseLabel} · {plural(d.trialCount, 'trial')} · <NctLinks ids={d.nctIds} />
                </span>
              </li>
            ))}
          </Section>
          <Section count={diff.phaseAdvanced.length} label={pl('phase advance', diff.phaseAdvanced.length)} tone="up">
            {diff.phaseAdvanced.map((p) => (
              <li key={p.key}>
                <strong>{p.displayName}</strong>
                <span className="li-detail">
                  {p.from} → {p.to}
                </span>
              </li>
            ))}
          </Section>
          <Section count={diff.fdaFlipped.length} label="newly FDA-approved" tone="fda">
            {diff.fdaFlipped.map((f) => (
              <li key={f.key}>
                <strong>{f.displayName}</strong>
                <span className="li-detail">was Investigational at last save</span>
              </li>
            ))}
          </Section>
          <Section count={diff.fdaReversed.length} label="FDA approval no longer found" tone="drop">
            {diff.fdaReversed.map((f) => (
              <li key={f.key}>
                <strong>{f.displayName}</strong>
                <span className="li-detail">was Approved at last save — often a name-match shift, worth verifying</span>
              </li>
            ))}
          </Section>
          <Section
            count={diff.newTrials.length}
            label={`${pl('drug', diff.newTrials.length)} with new trials (+${newTrialTotal})`}
            tone="trials"
          >
            {diff.newTrials.map((t) => (
              <li key={t.key}>
                <strong>{t.displayName}</strong>
                <span className="li-detail">
                  <NctLinks ids={t.nctIds} />
                </span>
              </li>
            ))}
          </Section>
          <Section count={diff.removed.length} label={pl('dropped drug', diff.removed.length)} tone="drop">
            {diff.removed.map((d) => (
              <li key={d.key}>
                <strong>{d.displayName}</strong>
                <span className="li-detail">no longer in the loaded trial set</span>
              </li>
            ))}
          </Section>
          <Section
            count={diff.renamed.length}
            label={`${pl('renamed cluster', diff.renamed.length)} — re-keyed, not a pipeline change`}
            tone="muted"
          >
            {diff.renamed.map((r) => (
              <li key={r.cur.key}>
                <strong>{r.cur.displayName}</strong>
                <span className="li-detail">was “{r.prev.displayName}” — same underlying trials</span>
              </li>
            ))}
          </Section>
          <Section
            count={diff.newlyResolved.length}
            label={`${pl('first FDA verdict', diff.newlyResolved.length)} — not a change`}
            tone="muted"
          >
            {diff.newlyResolved.map((r) => (
              <li key={r.key}>
                <strong>{r.displayName}</strong>
                <span className="li-detail">{r.status} — badge was unresolved at last save</span>
              </li>
            ))}
          </Section>
          <Section
            count={diff.phaseRegressed.length}
            label={`${pl('phase regression', diff.phaseRegressed.length)} — usually load-depth noise`}
            tone="muted"
          >
            {diff.phaseRegressed.map((p) => (
              <li key={p.key}>
                <strong>{p.displayName}</strong>
                <span className="li-detail">
                  {p.from} → {p.to}
                </span>
              </li>
            ))}
          </Section>
        </div>
      )}
    </section>
  );
}

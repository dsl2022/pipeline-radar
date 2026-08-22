import type { Trial } from '@pipeline-radar/shared/types';
import { trialsByPhase, topSponsors } from '@pipeline-radar/shared/summarize';

// Plain CSS bars, no chart lib (ARCHITECTURE §10-D). Driven by the FILTERED set
// so the charts always agree with the table below them.
function BarChart({ title, data }: { title: string; data: { label: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="chart">
      <h3>{title}</h3>
      {data.length === 0 && <p className="chart-empty">No trials match.</p>}
      {data.map((d) => (
        <div className="bar-row" key={d.label} title={`${d.label}: ${d.count}`}>
          <span className="bar-label">{d.label}</span>
          <span className="bar-track">
            <span className="bar" style={{ width: `${(d.count / max) * 100}%` }} />
          </span>
          <span className="bar-count">{d.count}</span>
        </div>
      ))}
    </div>
  );
}

export function SummaryPanel({ trials }: { trials: Trial[] }) {
  const phases = trialsByPhase(trials).map((b) => ({ label: b.label, count: b.count }));
  const sponsors = topSponsors(trials, 8).map((s) => ({ label: s.name, count: s.count }));
  return (
    <section className="charts">
      <BarChart title="Trials by phase" data={phases} />
      <BarChart title="Most active sponsors" data={sponsors} />
    </section>
  );
}

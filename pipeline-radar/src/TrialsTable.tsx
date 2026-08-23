import { ClampCell } from './ClampCell';
import type { Trial } from '@pipeline-radar/shared/types';
import { formatPhases, formatStatus } from '@pipeline-radar/shared/mapStudy';
import type { SortKey, SortDir } from '@pipeline-radar/shared/summarize';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

const COLUMNS: { label: string; sortKey?: SortKey; className?: string }[] = [
  { label: 'NCT ID' },
  { label: 'Title' },
  { label: "What's tested" },
  { label: 'Sponsor', sortKey: 'sponsor' },
  { label: 'Phase', sortKey: 'phase' },
  { label: 'Status', sortKey: 'status' },
  { label: 'Enrollment', sortKey: 'enrollment', className: 'num' },
];

export function TrialsTable({
  trials,
  sort,
  onSort,
}: {
  trials: Trial[];
  sort: SortState | null;
  onSort: (key: SortKey) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          {COLUMNS.map((c) =>
            c.sortKey ? (
              <th
                key={c.label}
                className={`sortable ${c.className ?? ''}`}
                onClick={() => onSort(c.sortKey!)}
                title="Sorts the fetched pages only"
              >
                {c.label}
                <span className="sort-ind">{sort?.key === c.sortKey ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
              </th>
            ) : (
              <th key={c.label} className={c.className}>
                {c.label}
              </th>
            ),
          )}
        </tr>
      </thead>
      <tbody>
        {trials.map((t) => (
          <tr key={t.nctId}>
            <td>
              <a href={`https://clinicaltrials.gov/study/${t.nctId}`} target="_blank" rel="noreferrer">
                {t.nctId}
              </a>
            </td>
            <td className="title">
              <ClampCell>{t.title}</ClampCell>
            </td>
            <td className="tested">
              <Interventions names={t.interventions.map((i) => i.name)} />
            </td>
            <td>
              <ClampCell>{t.sponsor}</ClampCell>
            </td>
            <td>{formatPhases(t.phases)}</td>
            <td>
              <span className={`status status-${t.status.toLowerCase()}`}>{formatStatus(t.status)}</span>
            </td>
            <td className="num">{t.enrollment ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Registry entries repeat intervention names across arms (REMAP-CAP lists
 * "Tocilizumab" twice), so dedupe first -- otherwise the count overstates what
 * is actually being tested.
 *
 * The label carries the total rather than a hidden count: clamping is by
 * height, so how many names are visible depends on the column width, and any
 * fixed "+38 more" would be wrong at some viewport. "Show all 42" is true at
 * every width.
 */
function Interventions({ names }: { names: string[] }) {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return <>—</>;
  return <ClampCell label={`Show all ${unique.length}`}>{unique.join(', ')}</ClampCell>;
}

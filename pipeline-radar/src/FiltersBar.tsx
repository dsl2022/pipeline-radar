export interface FilterOption {
  key: string;
  label: string;
  count: number;
}

interface Props {
  phaseOptions: FilterOption[];
  statusOptions: FilterOption[];
  selectedPhases: string[];
  selectedStatuses: string[];
  onTogglePhase: (key: string) => void;
  onToggleStatus: (key: string) => void;
  onClear: () => void;
}

function ChipGroup({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: FilterOption[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="chip-group">
      <span className="chip-group-title">{title}</span>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={selected.includes(o.key) ? 'chip on' : 'chip'}
          onClick={() => onToggle(o.key)}
        >
          {o.label} <span className="chip-count">{o.count}</span>
        </button>
      ))}
    </div>
  );
}

export function FiltersBar({
  phaseOptions,
  statusOptions,
  selectedPhases,
  selectedStatuses,
  onTogglePhase,
  onToggleStatus,
  onClear,
}: Props) {
  const anySelected = selectedPhases.length > 0 || selectedStatuses.length > 0;
  return (
    <div className="filters">
      <ChipGroup title="Phase" options={phaseOptions} selected={selectedPhases} onToggle={onTogglePhase} />
      <ChipGroup title="Status" options={statusOptions} selected={selectedStatuses} onToggle={onToggleStatus} />
      {anySelected && (
        <button type="button" className="clear-filters" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}

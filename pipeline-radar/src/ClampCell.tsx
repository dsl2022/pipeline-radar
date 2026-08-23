import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * Table cell that stays a fixed number of lines tall until asked to expand.
 *
 * Why height and not character count: what actually breaks the table is a row
 * that is ten lines deep while its neighbours are one. Column widths change
 * with the viewport, so the same text clips at 900px and fits at 1600px --
 * measuring the rendered box is the only way to know. Cells that fit get no
 * control at all, which matters because most of them do (in the lung-cancer
 * fixture, 81 of 100 trials list three interventions or fewer).
 */
export function ClampCell({
  children,
  lines = 3,
  label = 'Show more',
}: {
  children: ReactNode;
  lines?: number;
  /** Overridden for list-shaped cells, where "+38 more" beats "Show more". */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Only meaningful while clamped; once expanded scrollHeight === clientHeight
    // and we would wrongly conclude the cell fits, hiding the collapse control.
    if (open) return;
    setClipped(el.scrollHeight - el.clientHeight > 4);
  }, [open]);

  useLayoutEffect(measure, [measure, children]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <>
      <div
        ref={ref}
        className={open ? 'clamp is-open' : 'clamp'}
        style={open ? undefined : ({ '--clamp-lines': lines } as CSSProperties)}
      >
        {children}
      </div>
      {clipped && (
        <button type="button" className="clamp-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : label}
        </button>
      )}
    </>
  );
}
